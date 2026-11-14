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
   onError({code, message, fatal}): fatal = phiên đã dừng hẳn. */
(function (root) {
  'use strict';

  const RESTART_DELAY_MS = 250;
  const MAX_QUICK_ENDS = 5;       // dịch vụ tắt ngay sau khi bật quá số lần này thì coi như không dùng được
  const MAX_NETWORK_ERRORS = 3;
  const STOP_TIMEOUT_MS = 2500;

  const MESSAGES = {
    permission: 'Chưa được cấp quyền micro hoặc quyền nhận dạng giọng nói. Hãy cấp quyền trong phần cài đặt rồi thử lại.',
    network: 'Dịch vụ nhận dạng giọng nói của thiết bị không kết nối được. Kiểm tra mạng (hoặc tải gói nhận dạng ngoại tuyến cho ngôn ngữ này trong cài đặt của máy) rồi thử lại.',
    language: 'Thiết bị chưa hỗ trợ nhận dạng ngôn ngữ đã chọn. Hãy cài gói ngôn ngữ trong cài đặt của máy hoặc đổi ngôn ngữ.',
    audio: 'Không thu được âm thanh từ micro (micro đang bị ứng dụng khác dùng hoặc đã bị ngắt).',
    unavailable: 'Thiết bị hoặc trình duyệt này không có dịch vụ nhận dạng giọng nói.',
    background: 'Nhận dạng giọng nói tạm dừng vì ứng dụng không còn ở phía trước.',
    unknown: 'Nhận dạng giọng nói gặp lỗi và đã dừng.',
  };

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

  root.M2MSpeech = { support, create, langTag, formatUtterance, keepAwake, describe, MESSAGES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
