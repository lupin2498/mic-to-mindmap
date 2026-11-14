/* Nhận dạng giọng nói TRỰC TIẾP bằng dịch vụ có sẵn của thiết bị, không cần Whisper hay máy chủ AI.

   Hai nguồn, cùng một giao diện:
   - "native": plugin M2MSpeech của ứng dụng di động (Android: SpeechRecognizer, iOS: SFSpeechRecognizer);
   - "web":    Web Speech API của trình duyệt (Chrome, Edge, Safari).

   Dịch vụ của thiết bị tự ngắt sau mỗi quãng im lặng hoặc sau khoảng một phút, nên phiên ở đây tự chạy lại cho tới khi
   người dùng dừng: với người dùng đó là một lần ghi liên tục.

   Dùng:
     const session = M2MSpeech.create({ lang: 'vi-VN', onPartial, onFinal, onState, onError, onLevel });
     await session.start();  ...  await session.pause(); await session.resume();  ...  await session.stop();
   onPartial(text): phần đang nói dở (thay thế phần dở trước đó). onFinal(text): một câu/đoạn đã chốt.
   onError({code, message, fatal}): fatal = phiên đã dừng hẳn.

   Nhận dạng từ FILE GHI ÂM CÓ SẴN (cũng không cần máy chủ):
     const info = await M2MSpeech.fileSupport();     // {provider: 'native' | 'web' | null, realtime}
     const job = M2MSpeech.transcribeFile(file, { lang, provider: info.provider, onPartial, onFinal, onProgress });
     const { text } = await job.promise;             // job.cancel() để hủy; lỗi có err.code và err.partialText
   - "native": app chuyển file sang plugin M2MSpeech (từng khúc base64), plugin giải mã rồi đưa cho bộ nhận dạng của
     máy (Android 13+: SpeechRecognizer đọc âm thanh từ file; iOS: SFSpeechRecognizer theo từng đoạn dưới một phút);
   - "web": Chrome/Edge 133+ nhận dạng từ một MediaStreamTrack: trang phát file trong im lặng qua Web Audio và đưa
     luồng đó cho Web Speech API, nên mất đúng bằng thời lượng file. */
(function (root) {
  'use strict';

  const RESTART_DELAY_MS = 250;
  const MAX_QUICK_ENDS = 5;       // dịch vụ tắt ngay sau khi bật quá số lần này thì coi như không dùng được
  const MAX_NETWORK_ERRORS = 3;
  const STOP_TIMEOUT_MS = 2500;

  const MESSAGES = {
    permission: 'Chưa được cấp quyền micro hoặc quyền nhận dạng giọng nói. Hãy cấp quyền trong phần cài đặt rồi thử lại.',
    // Android: ứng dụng đã có quyền nhưng chính dịch vụ nhận dạng của máy (thường là ứng dụng Google) thì chưa
    'service-permission': 'Dịch vụ nhận dạng giọng nói của máy chưa được cấp quyền micro. Mở Cài đặt → Ứng dụng → Google → Quyền → Micro, chọn cho phép rồi thử lại.',
    network: 'Dịch vụ nhận dạng giọng nói của thiết bị không kết nối được. Kiểm tra mạng (hoặc tải gói nhận dạng ngoại tuyến cho ngôn ngữ này trong cài đặt của máy) rồi thử lại.',
    language: 'Thiết bị chưa hỗ trợ nhận dạng ngôn ngữ đã chọn. Hãy cài gói ngôn ngữ trong cài đặt của máy hoặc đổi ngôn ngữ.',
    audio: 'Không thu được âm thanh từ micro (micro đang bị ứng dụng khác dùng hoặc đã bị ngắt).',
    unavailable: 'Thiết bị hoặc trình duyệt này không có dịch vụ nhận dạng giọng nói.',
    background: 'Nhận dạng giọng nói tạm dừng vì ứng dụng không còn ở phía trước.',
    unknown: 'Nhận dạng giọng nói gặp lỗi và đã dừng.',
    // nhận dạng từ file ghi âm có sẵn
    unsupported: 'Máy này chưa chuyển được file ghi âm thành văn bản: bộ nhận dạng giọng nói của máy không nhận âm thanh từ file. Hãy ghi trực tiếp bằng nút ghi âm hoặc dùng máy chủ có Whisper.',
    format: 'Không đọc được file âm thanh này. Hãy dùng file m4a, mp3, wav, aac hoặc ogg.',
    cancelled: 'Đã hủy nhận dạng file.',
    busy: 'Bộ nhận dạng giọng nói đang bận (đang ghi âm hoặc đang nhận dạng file khác). Hãy thử lại sau.',
  };
  const FILE_CHUNK_BYTES = 512 * 1024;     // mỗi lần chuyển file sang plugin của app
  const FILE_END_GRACE_MS = 1200;          // file phát hết: chờ bộ nhận dạng trả nốt câu cuối
  const FILE_END_TIMEOUT_MS = 6000;

  function userAgent() {
    return (root.navigator && root.navigator.userAgent) || '';
  }
  function isAndroid() {
    return /Android/i.test(userAgent());
  }
  function isIOS() {
    const nav = root.navigator || {};
    return /iPad|iPhone|iPod/.test(userAgent()) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  }
  function nativePlugin() {
    const cap = root.Capacitor;
    return cap && cap.Plugins && cap.Plugins.M2MSpeech ? cap.Plugins.M2MSpeech : null;
  }
  function webCtor() {
    return root.SpeechRecognition || root.webkitSpeechRecognition || null;
  }

  /* Nguồn nhận dạng dùng được trên máy này.
     recordAudio: có thể vừa nhận dạng vừa ghi file âm thanh hay không (điện thoại chỉ cho một bên dùng micro). */
  function support() {
    if (nativePlugin()) return { provider: 'native', recordAudio: false, label: 'thiết bị' };
    if (webCtor()) return { provider: 'web', recordAudio: !(isAndroid() || isIOS()), label: 'trình duyệt' };
    return { provider: null, recordAudio: true, label: '' };
  }

  /* 'vi' -> 'vi-VN', 'en' -> 'en-US'; "tự nhận dạng" thì theo ngôn ngữ của máy nếu là Việt/Anh, còn lại dùng tiếng Việt. */
  function langTag(language) {
    const lang = String(language || '').toLowerCase();
    if (lang.indexOf('vi') === 0) return 'vi-VN';
    if (lang.indexOf('en') === 0) return lang.length > 2 && lang.indexOf('-') === 2 ? language : 'en-US';
    const device = String((root.navigator && root.navigator.language) || '').toLowerCase();
    if (device.indexOf('en') === 0) return 'en-US';
    return 'vi-VN';
  }

  /* Một đoạn vừa nhận dạng -> một câu của transcript: viết hoa chữ đầu, thêm dấu chấm nếu chưa có dấu kết câu. */
  function formatUtterance(text) {
    let out = String(text || '').replace(/\s+/g, ' ').trim();
    if (!out) return '';
    const first = String.fromCodePoint(out.codePointAt(0));
    out = first.toUpperCase() + out.slice(first.length);
    if (!/[.!?…]$/.test(out)) out += '.';
    return out;
  }

  function describe(code, detail) {
    return MESSAGES[code] || (detail ? `${MESSAGES.unknown} (${detail})` : MESSAGES.unknown);
  }
  function makeError(code, detail) {
    const error = new Error(describe(code, detail));
    error.code = code;
    return error;
  }
  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, ms);
      Promise.resolve(promise).then(() => { clearTimeout(timer); finish(); }, () => { clearTimeout(timer); finish(); });
    });
  }
  function call(fn, arg) {
    if (typeof fn === 'function') { try { fn(arg); } catch (err) { if (root.console) root.console.error(err); } }
  }

  // ------------------------------------------------------------ Web Speech API
  function createWeb(opts) {
    const SR = webCtor();
    // Chrome trên Android lặp lại kết quả khi bật continuous: ở đó nhận từng câu rồi tự chạy lại
    const continuous = !isAndroid();
    let rec = null;          // bộ nhận dạng đang chạy
    let active = false;      // người dùng muốn phiên tiếp tục chạy
    let fatal = false;
    let pending = '';        // phần đang nói dở chưa được chốt
    let startedAt = 0;
    let quickEnds = 0;
    let networkErrors = 0;
    let restartTimer = null;
    let onEnded = null;      // resolve của lời hứa đang chờ bộ nhận dạng dừng hẳn
    let listening = false;

    function setListening(value, reason) {
      if (listening === value) return;
      listening = value;
      call(opts.onState, { listening: value, reason: reason || '' });
    }
    function flushPending() {
      const text = pending.trim();
      pending = '';
      if (text) {
        call(opts.onFinal, text);
        call(opts.onPartial, '');
      }
    }
    function fail(code, detail) {
      if (fatal) return;
      fatal = true;
      active = false;
      clearTimeout(restartTimer);
      call(opts.onError, { code, message: describe(code, detail), fatal: true });
    }
    function handleError(code) {
      if (code === 'no-speech' || code === 'aborted') return;            // im lặng hoặc do chính ta dừng: bình thường
      if (code === 'not-allowed' || code === 'service-not-allowed') return fail('permission');
      if (code === 'audio-capture') return fail('audio');
      if (code === 'language-not-supported') return fail('language');
      if (code === 'network') {
        networkErrors += 1;
        if (networkErrors >= MAX_NETWORK_ERRORS) return fail('network');
        call(opts.onError, { code: 'network', message: describe('network'), fatal: false });
      }
    }
    function startRec() {
      restartTimer = null;
      if (!active || fatal) return;
      const r = new SR();
      r.continuous = continuous;
      r.interimResults = true;
      r.lang = opts.lang;
      try { r.maxAlternatives = 1; } catch (_) { /* thuộc tính không bắt buộc */ }
      r.onstart = () => { if (rec === r) setListening(true); };   // báo "đã bật" đến muộn sau khi đã tắt thì bỏ qua
      r.onresult = (event) => {
        if (rec !== r) return;
        quickEnds = 0;
        networkErrors = 0;
        let interim = '';
        const results = event.results || [];
        for (let i = event.resultIndex || 0; i < results.length; i++) {
          const result = results[i];
          const text = result && result[0] ? String(result[0].transcript || '') : '';
          if (result && result.isFinal) {
            const final = text.trim();
            if (final) call(opts.onFinal, final);
          } else {
            interim += text;
          }
        }
        pending = interim;
        call(opts.onPartial, interim.trim());
      };
      r.onerror = (event) => { if (rec === r) handleError(event && event.error); };
      r.onend = () => {
        if (rec !== r) return;
        rec = null;
        flushPending();   // phần nói dở chưa kịp chốt khi dịch vụ ngắt: giữ lại, đừng để mất chữ
        if (active && !fatal) {
          quickEnds = Date.now() - startedAt < 1000 ? quickEnds + 1 : 0;
          if (quickEnds >= MAX_QUICK_ENDS) {
            fail('unknown', 'dịch vụ tắt ngay sau khi bật');
          } else {
            restartTimer = setTimeout(startRec, quickEnds ? 400 * quickEnds : RESTART_DELAY_MS);
            return;
          }
        }
        setListening(false, fatal ? 'error' : '');
        if (onEnded) { const done = onEnded; onEnded = null; done(); }
      };
      rec = r;
      startedAt = Date.now();
      try {
        r.start();
        setListening(true);
      } catch (err) {
        rec = null;
        fail('unknown', err && err.message);
        setListening(false, 'error');
      }
    }
    function halt() {
      active = false;
      clearTimeout(restartTimer);
      restartTimer = null;
      if (!rec) {
        flushPending();
        setListening(false);
        return Promise.resolve();
      }
      const r = rec;
      const ended = new Promise((resolve) => { onEnded = resolve; });
      try { r.stop(); } catch (_) { /* đã dừng */ }
      return withTimeout(ended, STOP_TIMEOUT_MS).then(() => {
        if (rec === r) {          // dịch vụ không báo onend: tự dọn
          rec = null;
          onEnded = null;
          flushPending();
          setListening(false);
        }
      });
    }
    return {
      provider: 'web',
      start() {
        if (active) return Promise.resolve();
        active = true; fatal = false; quickEnds = 0; networkErrors = 0;
        startRec();
        return fatal ? Promise.reject(makeError('unknown')) : Promise.resolve();
      },
      stop: halt,
      pause: halt,
      resume() {
        if (active) return Promise.resolve();
        active = true; fatal = false; quickEnds = 0;
        startRec();
        return Promise.resolve();
      },
      isActive() { return active; },
    };
  }

  // ---------------------------------------------------- plugin của ứng dụng di động
  function createNative(opts) {
    const plugin = nativePlugin();
    let handles = [];
    let active = false;
    let bound = false;

    function bind() {
      if (bound) return;
      bound = true;
      const on = (name, fn) => {
        try { handles.push(plugin.addListener(name, fn)); } catch (err) { if (root.console) root.console.error(err); }
      };
      on('partial', (data) => { if (active) call(opts.onPartial, String((data && data.text) || '').trim()); });
      on('final', (data) => {
        const text = String((data && data.text) || '').trim();
        if (text) call(opts.onFinal, text);
        call(opts.onPartial, '');
      });
      on('state', (data) => call(opts.onState, { listening: !!(data && data.listening), reason: (data && data.reason) || '' }));
      on('level', (data) => call(opts.onLevel, Math.max(0, Math.min(1, Number(data && data.value) || 0))));
      on('error', (data) => {
        const code = (data && data.code) || 'unknown';
        const isFatal = !!(data && data.fatal);
        if (isFatal) active = false;
        call(opts.onError, { code, message: describe(code, data && data.message), fatal: isFatal });
      });
    }
    function unbind() {
      const old = handles;
      handles = [];
      bound = false;
      for (const handle of old) {
        Promise.resolve(handle).then((h) => { if (h && typeof h.remove === 'function') h.remove(); }).catch(() => {});
      }
    }
    function begin() {
      bind();
      active = true;
      return Promise.resolve(plugin.start({ language: opts.lang })).then(() => undefined, (err) => {
        active = false;
        const code = (err && err.code) || 'unknown';
        throw makeError(MESSAGES[code] ? code : 'unknown', err && err.message);
      });
    }
    function halt() {
      active = false;
      return withTimeout(Promise.resolve().then(() => plugin.stop()), STOP_TIMEOUT_MS);
    }
    return {
      provider: 'native',
      start() { return active ? Promise.resolve() : begin().catch((err) => { unbind(); throw err; }); },
      stop() { return halt().then(unbind); },
      pause: halt,
      resume() { return active ? Promise.resolve() : begin(); },
      isActive() { return active; },
    };
  }

  /* Tạo một phiên nhận dạng. Ném lỗi (code = 'unavailable') nếu máy không có nguồn nhận dạng nào. */
  function create(options) {
    const opts = Object.assign({ lang: 'vi-VN' }, options || {});
    if (nativePlugin()) {
      const native = createNative(opts);
      if (!webCtor()) return native;
      // plugin báo không dùng được (máy không có dịch vụ nhận dạng) mà trình duyệt nhúng có Web Speech: thử nguồn đó
      let current = native;
      return {
        get provider() { return current.provider; },
        start() {
          return native.start().catch((err) => {
            if (err && err.code !== 'unavailable') throw err;
            current = createWeb(opts);
            return current.start();
          });
        },
        stop() { return current.stop(); },
        pause() { return current.pause(); },
        resume() { return current.resume(); },
        isActive() { return current.isActive(); },
      };
    }
    if (webCtor()) return createWeb(opts);
    throw makeError('unavailable');
  }

  // ------------------------------------------------- nhận dạng từ file ghi âm có sẵn
  function clamp01(value) {
    const v = Number(value);
    return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }
  function nativeFilePlugin() {
    const plugin = nativePlugin();
    return plugin && typeof plugin.fileTranscribe === 'function' ? plugin : null;
  }
  let trackProbe = null;
  /* Chrome/Edge 133+ nhận dạng được từ một MediaStreamTrack (SpeechRecognition.start(track)). Bản cũ hơn và Safari bỏ
     qua đối số rồi mở micro, nên phải dò cẩn thận: bản hỗ trợ ném TypeError ngay khi đối số không phải track. */
  function webTrackSupport() {
    if (trackProbe !== null) return trackProbe;
    trackProbe = false;
    const SR = webCtor();
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!SR || !Ctx || typeof root.MediaStreamTrack === 'undefined' || !root.document || isIOS()) return false;
    const version = /Chrom(?:e|ium)\/(\d+)/.exec(userAgent());
    if (!version || Number(version[1]) < 133) return false;
    let probe = null;
    try {
      probe = new SR();
      probe.start({});
    } catch (err) {
      trackProbe = !!err && err.name === 'TypeError';
      return trackProbe;
    }
    try { probe.abort(); } catch (_) { /* đã dừng */ }   // không ném lỗi: bản này đã mở micro, tắt ngay
    return false;
  }
  function webFileSupport(reason) {
    if (webTrackSupport()) return { provider: 'web', label: 'trình duyệt', realtime: true };
    return { provider: null, label: '', realtime: false, reason: reason || '' };
  }
  /* Máy này chuyển được file ghi âm có sẵn thành văn bản bằng cách nào (không tính Whisper trên máy chủ). */
  function fileSupport() {
    const plugin = nativeFilePlugin();
    if (!plugin) return Promise.resolve(webFileSupport());
    return Promise.resolve()
      .then(() => (typeof plugin.fileSupport === 'function' ? plugin.fileSupport() : { available: true }))
      .then((info) => (info && info.available
        ? { provider: 'native', label: 'thiết bị', realtime: false, onDevice: !!info.onDevice }
        : webFileSupport(info && info.reason)), () => webFileSupport());
  }
  function readBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(reader.error || new Error('không đọc được file'));
      reader.readAsDataURL(blob);
    });
  }
  function fileError(code, detail, segments) {
    const error = makeError(MESSAGES[code] ? code : 'unknown', detail);
    error.partialText = segments.join(' ');
    return error;
  }

  function transcribeFileNative(file, opts) {
    const plugin = nativeFilePlugin();
    const segments = [];
    const handles = [];
    let id = null;
    let cancelled = false;
    function listen(name, fn) {
      try {
        handles.push(plugin.addListener(name, (data) => { if (data && id && data.id === id) fn(data); }));
      } catch (err) { if (root.console) root.console.error(err); }
    }
    function unlisten() {
      for (const handle of handles.splice(0)) {
        Promise.resolve(handle).then((h) => { if (h && typeof h.remove === 'function') h.remove(); }).catch(() => {});
      }
    }
    function release() {
      if (id) { const old = id; Promise.resolve().then(() => plugin.fileCancel({ id: old })).catch(() => {}); }
    }
    listen('fileProgress', (data) => call(opts.onProgress, { phase: 'recognize', value: clamp01(data.value) }));
    listen('filePartial', (data) => call(opts.onPartial, String(data.text || '').trim()));
    listen('fileSegment', (data) => {
      const text = String(data.text || '').trim();
      if (text) { segments.push(text); call(opts.onFinal, text); }
      call(opts.onPartial, '');
    });
    const promise = (async () => {
      const begun = await plugin.fileBegin({ name: file.name || 'audio', size: file.size, mime: file.type || '' });
      id = begun && begun.id ? String(begun.id) : null;
      if (!id) throw makeError('unknown', 'plugin không mở được file tạm');
      for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
        if (cancelled) throw makeError('cancelled');
        const data = await readBase64(file.slice(offset, offset + FILE_CHUNK_BYTES));
        await plugin.fileChunk({ id, data });
        call(opts.onProgress, { phase: 'transfer', value: Math.min(1, (offset + FILE_CHUNK_BYTES) / file.size) });
      }
      if (cancelled) throw makeError('cancelled');
      call(opts.onProgress, { phase: 'recognize', value: 0 });
      const result = await plugin.fileTranscribe({ id, language: opts.lang });
      const text = String((result && result.text) || '').trim() || segments.join(' ');
      return { text, segments: segments.slice(), duration: Number(result && result.duration) || 0 };
    })().then((result) => {
      unlisten();
      release();
      return result;
    }, (err) => {
      unlisten();
      release();
      const code = cancelled ? 'cancelled' : (err && err.code) || 'unknown';
      throw fileError(code, err && err.message, segments);
    });
    return {
      provider: 'native',
      promise,
      cancel() {
        if (cancelled) return;
        cancelled = true;
        release();
      },
    };
  }

  function transcribeFileWeb(file, opts) {
    const SR = webCtor();
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const segments = [];
    let finished = false;
    let settle = null;
    let audio = null, ctx = null, track = null, url = '', rec = null;
    let pending = '';
    let timers = [];
    let networkErrors = 0, quickEnds = 0, startedAt = 0;
    const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

    function cleanup() {
      finished = true;
      timers.forEach(clearTimeout);
      timers = [];
      if (rec) { const r = rec; rec = null; try { r.abort(); } catch (_) { /* đã dừng */ } }
      if (audio) {
        audio.onerror = null; audio.onended = null; audio.ontimeupdate = null; audio.onloadedmetadata = null;
        try { audio.pause(); } catch (_) { /* đã dừng */ }
      }
      if (track) { try { track.stop(); } catch (_) { /* đã dừng */ } }
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }
      if (url) { root.URL.revokeObjectURL(url); url = ''; }
    }
    function flushPending() {
      const text = pending.trim();
      pending = '';
      if (text) {
        segments.push(text);
        call(opts.onFinal, text);
        call(opts.onPartial, '');
      }
    }
    function done() {
      if (finished) return;
      flushPending();
      const duration = audio && isFinite(audio.duration) ? audio.duration : 0;
      cleanup();
      settle.resolve({ text: segments.join(' '), segments: segments.slice(), duration });
    }
    function fail(code, detail) {
      if (finished) return;
      flushPending();
      cleanup();
      settle.reject(fileError(code, detail, segments));
    }
    function playAudio() {
      if (finished || !audio || audio.ended || !audio.paused) return;
      const playing = audio.play();
      if (playing && typeof playing.catch === 'function') {
        playing.catch((err) => { if (!finished && audio && !audio.ended) fail('unknown', err && err.message); });
      }
    }
    function startRec() {
      if (finished) return;
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = opts.lang;
      try { r.maxAlternatives = 1; } catch (_) { /* thuộc tính không bắt buộc */ }
      // bộ nhận dạng sẵn sàng mới phát file, để câu đầu không bị mất
      r.onstart = () => { if (rec === r) playAudio(); };
      r.onresult = (event) => {
        if (rec !== r) return;
        quickEnds = 0;
        networkErrors = 0;
        let interim = '';
        const results = event.results || [];
        for (let i = event.resultIndex || 0; i < results.length; i++) {
          const result = results[i];
          const text = result && result[0] ? String(result[0].transcript || '') : '';
          if (result && result.isFinal) {
            const final = text.trim();
            if (final) { segments.push(final); call(opts.onFinal, final); }
          } else {
            interim += text;
          }
        }
        pending = interim;
        call(opts.onPartial, interim.trim());
      };
      r.onerror = (event) => {
        if (rec !== r) return;
        const code = event && event.error;
        if (code === 'no-speech' || code === 'aborted') return;
        if (code === 'not-allowed' || code === 'service-not-allowed') { fail('permission'); return; }
        if (code === 'language-not-supported') { fail('language'); return; }
        if (code === 'audio-capture') { fail('unsupported'); return; }
        if (code === 'network') {
          networkErrors += 1;
          if (networkErrors >= MAX_NETWORK_ERRORS) fail('network');
        }
      };
      r.onend = () => {
        if (rec !== r) return;
        rec = null;
        flushPending();
        if (finished) return;
        if (audio.ended) { done(); return; }
        // dịch vụ tự ngắt giữa chừng: tạm dừng phát, mở lượt nghe mới rồi phát tiếp để không mất câu nào
        try { audio.pause(); } catch (_) { /* đã dừng */ }
        quickEnds = Date.now() - startedAt < 1000 ? quickEnds + 1 : 0;
        if (quickEnds >= MAX_QUICK_ENDS) { fail('unknown', 'dịch vụ tắt ngay sau khi bật'); return; }
        later(startRec, quickEnds ? 400 * quickEnds : RESTART_DELAY_MS);
      };
      rec = r;
      startedAt = Date.now();
      try {
        r.start(track);
      } catch (err) {
        rec = null;
        fail('unsupported', err && err.message);
        return;
      }
      later(playAudio, 800);   // phòng khi dịch vụ không báo onstart
    }
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
      if (!SR || !Ctx || !root.document) { fail('unsupported'); return; }
      try {
        url = root.URL.createObjectURL(file);
      } catch (err) {
        fail('format', err && err.message);
        return;
      }
      audio = root.document.createElement('audio');
      audio.preload = 'auto';
      audio.onerror = () => fail('format');
      audio.onloadedmetadata = () => {
        if (finished) return;
        try {
          ctx = new Ctx();
          const source = ctx.createMediaElementSource(audio);
          const dest = ctx.createMediaStreamDestination();
          source.connect(dest);   // không nối ra loa: nhận dạng trong im lặng
          track = dest.stream.getAudioTracks()[0] || null;
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
        } catch (err) {
          fail('unsupported', err && err.message);
          return;
        }
        if (!track) { fail('unsupported'); return; }
        startRec();
      };
      audio.ontimeupdate = () => {
        if (finished || !isFinite(audio.duration) || audio.duration <= 0) return;
        call(opts.onProgress, { phase: 'recognize', value: clamp01(audio.currentTime / audio.duration),
          current: audio.currentTime, duration: audio.duration });
      };
      audio.onended = () => {
        if (finished) return;
        call(opts.onProgress, { phase: 'recognize', value: 1 });
        later(() => {
          if (!rec) { done(); return; }
          try { rec.stop(); } catch (_) { done(); }
        }, FILE_END_GRACE_MS);
        later(done, FILE_END_TIMEOUT_MS);   // dịch vụ không báo dừng: thôi chờ
      };
      audio.src = url;
    });
    return {
      provider: 'web',
      promise,
      cancel() { fail('cancelled'); },
    };
  }

  /* Chuyển một file ghi âm có sẵn thành văn bản. Trả về {provider, promise, cancel}. options.provider: kết quả của
     fileSupport() (bỏ trống thì tự chọn). onFinal(text): một đoạn đã chốt; onPartial(text): đoạn đang dở;
     onProgress({phase: 'transfer' | 'recognize', value 0..1, current?, duration?}). */
  function transcribeFile(file, options) {
    const opts = Object.assign({ lang: 'vi-VN', provider: null }, options || {});
    const provider = opts.provider || (nativeFilePlugin() ? 'native' : webTrackSupport() ? 'web' : null);
    if (provider === 'native' && nativeFilePlugin()) return transcribeFileNative(file, opts);
    if (provider === 'web' && webCtor()) return transcribeFileWeb(file, opts);
    return { provider: null, promise: Promise.reject(fileError('unsupported', '', [])), cancel() {} };
  }

  // ------------------------------------------------------------ giữ màn hình sáng
  let wakeLock = null;
  let wantAwake = false;
  function requestWakeLock() {
    const nav = root.navigator;
    if (!wantAwake || wakeLock || !nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
    nav.wakeLock.request('screen').then((lock) => {
      if (!wantAwake) { lock.release().catch(() => {}); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    }).catch(() => { /* trình duyệt từ chối (pin yếu, tab ẩn): bỏ qua */ });
  }
  if (root.document && typeof root.document.addEventListener === 'function') {
    // khóa màn hình bị nhả khi tab ẩn đi: xin lại khi quay về
    root.document.addEventListener('visibilitychange', () => { if (root.document.visibilityState === 'visible') requestWakeLock(); });
  }
  /* Giữ màn hình sáng trong lúc ghi (màn hình tắt là micro và nhận dạng giọng nói bị ngắt). */
  function keepAwake(on) {
    wantAwake = !!on;
    const plugin = nativePlugin();
    if (plugin && typeof plugin.keepAwake === 'function') {
      const on = wantAwake;   // chốt giá trị ngay: gọi bật rồi tắt liền nhau thì phải gửi đủ cả hai
      Promise.resolve().then(() => plugin.keepAwake({ on })).catch(() => {});
      return;
    }
    if (wantAwake) {
      requestWakeLock();
    } else if (wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  root.M2MSpeech = { support, create, langTag, formatUtterance, keepAwake, describe, fileSupport, transcribeFile, MESSAGES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
