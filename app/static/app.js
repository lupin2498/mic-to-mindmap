/* Logic ứng dụng Mic to Mindmap (không phụ thuộc thư viện ngoài).

   Hai cách chạy, cùng một giao diện:
   - ĐỘC LẬP (bản đóng gói cho điện thoại, chưa nhập địa chỉ máy chủ): mọi thứ nằm trên máy này. Lời nói được chuyển
     thành văn bản ngay khi nói (speech.js), tóm tắt và sơ đồ tư duy do engine.js làm, dữ liệu lưu bằng local.js.
   - MÁY CHỦ (mở từ ./run.sh hoặc nhập địa chỉ máy chủ): gọi API; máy chủ có Whisper/LLM thì dùng, không có thì cũng
     tóm tắt bằng đúng thuật toán không cần AI đó. */
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const engine = window.M2MEngine;
  const speech = window.M2MSpeech;
  const local = window.M2MLocal;

  // ------------------------------------------------------------------ API
  const IS_MOBILE = !!window.M2M_MOBILE;     // bản đóng gói: chạy độc lập được, máy chủ AI là tùy chọn
  let API_BASE = '';
  try { API_BASE = IS_MOBILE ? (localStorage.getItem('m2m.server') || '') : ''; } catch (_) { API_BASE = ''; }
  API_BASE = API_BASE.replace(/\/+$/, '');
  const LOCAL = IS_MOBILE && !API_BASE;      // chế độ độc lập: không gọi mạng
  function apiUrl(path) { return path.startsWith('/') ? API_BASE + path : path; }

  async function request(method, url, body, isForm) {
    if (LOCAL) return local.request(method, url, body, isForm);
    const options = { method, headers: {} };
    if (body !== undefined) {
      if (isForm) options.body = body;
      else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    }
    let resp;
    try {
      resp = await fetch(apiUrl(url), options);
    } catch (err) {
      const error = new Error(IS_MOBILE ? `Không kết nối được máy chủ ${API_BASE}: ${err.message}` : `Không kết nối được server: ${err.message}`);
      error.network = true;
      throw error;
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const detail = data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : resp.statusText;
      const error = new Error(detail || `Lỗi ${resp.status}`);
      error.status = resp.status;
      throw error;
    }
    return data;
  }
  const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del: (url) => request('DELETE', url),
    upload: (url, form) => request('POST', url, form, true),
  };

  // ---------------------------------------------------------------- state
  /* capture: bản ghi vừa dừng (hoặc file vừa chọn) chưa xử lý xong: {blob, ext, duration, text}.
     live: văn bản đang nhận dạng trong lúc nói: các câu đã chốt + phần đang nói dở. */
  const state = {
    meetings: [], current: null, health: null, capture: null, rating: 0, mindmap: null, liveMap: null,
    live: { finals: [], interim: '' }, audioUrl: '',
  };

  // ---------------------------------------------------------------- utils
  let toastTimer = null;
  function toast(message, isError) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 7000 : 3200);
  }
  // Mọi dữ liệu từ máy chủ (tên model, góp ý, ngày giờ...) phải qua esc() trước khi ghép vào innerHTML
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function lines(text) {
    return text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  }
  function download(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function statusLabel(status) {
    return ({ new: 'Mới', recorded: 'Đã ghi âm', queued: 'Đang chờ', transcribing: 'Đang nhận dạng giọng nói',
      transcribed: 'Đã có văn bản', analyzing: 'Đang tóm tắt & vẽ sơ đồ tư duy', done: 'Hoàn tất', error: 'Lỗi' })[status] || status;
  }
  function statusClass(status) {
    if (status === 'done') return 'done';
    if (status === 'error') return 'error';
    if (['queued', 'transcribing', 'analyzing'].includes(status)) return 'working';
    return '';
  }
  /* Tên dễ hiểu của cách tóm tắt ("heuristic" -> thuật toán không cần AI, "ollama:qwen2.5:7b" -> AI qwen2.5:7b). */
  function engineLabel(name) {
    if (!name) return '';
    if (name.indexOf('ollama:') === 0) return `AI ${name.slice(7)}`;
    if (name.indexOf('heuristic') === 0) return name.length > 9 ? `thuật toán không cần AI${name.slice(9)}` : 'thuật toán không cần AI';
    return name;
  }
  function sourceLabel(source) {
    if (!source) return '';
    const edited = /\+edited$/.test(source);
    const base = source.replace(/\+edited$/, '');
    let label = base;
    if (base === 'browser' || base === 'device') label = 'nhận dạng trực tiếp khi nói';
    else if (base === 'file') label = 'nhận dạng từ file ghi âm';
    else if (base === 'manual') label = 'nhập tay';
    else if (base.indexOf('whisper:') === 0) label = `Whisper ${base.slice(8)}`;
    return label + (edited ? ', đã sửa' : '');
  }
  function wordCount(text) {
    return text ? text.split(/\s+/).filter(Boolean).length : 0;
  }

  // ----------------------------------------------------------------- tabs
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'learning') loadLearning();
    if (name === 'result' && state.mindmap && state.current) state.mindmap.fit();
    if (name === 'record' && state.liveMap && !$('#live-preview').hidden) state.liveMap.fit();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ------------------------------------------- cách chuyển lời nói thành văn bản
  let captionsTouched = false;
  function sttSupport() {
    return speech ? speech.support() : { provider: null, recordAudio: true, label: '' };
  }
  function whisperReady() {
    return !LOCAL && !!(state.health && state.health.whisper && state.health.whisper.available);
  }
  /* Bản ghi sắp tới sẽ: live = chuyển thành văn bản ngay khi nói; audio = ghi kèm file âm thanh. */
  function capturePlan() {
    const support = sttSupport();
    const wantLive = $('#live-captions').checked;
    // Whisper trên máy chủ nhận dạng từ file âm thanh; nhận dạng trực tiếp lúc đó chỉ là phụ đề xem thêm
    if (whisperReady()) return { audio: true, live: wantLive && !!support.provider && support.recordAudio };
    const live = !!support.provider && (LOCAL || wantLive);
    // điện thoại chỉ cho một bên dùng micro: đã nhận dạng trực tiếp thì không ghi kèm file âm thanh
    return { audio: support.recordAudio || !live, live };
  }
  function renderSttLine() {
    const support = sttSupport();
    const plan = capturePlan();
    const line = $('#stt-line');
    let text, cls;
    if (whisperReady()) {
      text = `Âm thanh sẽ được Whisper (${state.health.whisper.model}) trên máy chủ chuyển thành văn bản sau khi bạn dừng ghi.`;
      cls = 'ok';
    } else if (plan.live) {
      text = `🎙 Lời nói được chuyển thành văn bản ngay khi bạn nói, bằng nhận dạng giọng nói có sẵn của ${support.label}.`
        + (plan.audio ? '' : ' Trên điện thoại ứng dụng không lưu kèm file âm thanh.');
      cls = 'ok';
    } else if (!support.provider) {
      text = 'Trình duyệt/thiết bị này không có nhận dạng giọng nói nên bản ghi chỉ nghe lại được. Hãy mở bằng Chrome, Edge hoặc Safari, hoặc dán văn bản vào ô bên dưới.';
      cls = 'warn';
    } else {
      text = 'Đang tắt chuyển lời nói thành văn bản: bản ghi sẽ chỉ có âm thanh, không tóm tắt được.';
      cls = 'warn';
    }
    line.textContent = text;
    line.className = `stt-line ${cls}`;
    // chế độ độc lập luôn nhận dạng trực tiếp (không còn cách nào khác); máy không có nhận dạng thì ô chọn vô nghĩa
    $('#live-captions-row').hidden = LOCAL || !support.provider;
    renderFileNote();
  }
  /* File ghi âm có sẵn sẽ được chuyển thành văn bản bằng: 'server' (Whisper), 'native' (plugin của app), 'web'
     (trình duyệt nghe file), hoặc null (không cách nào). */
  function filePlan() {
    if (whisperReady()) return 'server';
    return fileInfo.provider || null;
  }
  function renderFileNote() {
    const plan = filePlan();
    let note = '';
    if (plan === 'server') note = 'Whisper trên máy chủ chuyển file thành văn bản, rồi tự tóm tắt và vẽ sơ đồ tư duy.';
    else if (plan === 'native') note = 'Bộ nhận dạng giọng nói của máy chuyển file thành văn bản ngay trên điện thoại, không cần máy chủ, rồi tự tóm tắt và vẽ sơ đồ tư duy.';
    else if (plan === 'web') note = 'Trình duyệt nghe file (không phát ra loa) và chuyển thành văn bản, rồi tự tóm tắt và vẽ sơ đồ tư duy. File dài bao nhiêu thì mất chừng ấy thời gian.';
    else if (!fileInfoReady) note = '';
    else if (LOCAL) note = 'Máy này chưa chuyển được file ghi âm thành văn bản (cần Android 13 trở lên hoặc iPhone). Hãy ghi trực tiếp bằng nút ghi âm hoặc dán văn bản.';
    else if (state.health) note = 'Trình duyệt này chưa chuyển được file ghi âm thành văn bản và máy chủ chưa cài Whisper: hãy mở bằng Chrome hoặc Edge bản mới, hoặc dùng ứng dụng trên điện thoại. File chọn ở đây chỉ lưu lại để nghe.';
    $('#file-note').textContent = note;
    $('#file-pick').hidden = LOCAL && fileInfoReady && !plan;
  }
  $('#live-captions').addEventListener('change', () => { captionsTouched = true; renderSttLine(); });
  try { $('#auto-process').checked = localStorage.getItem('m2m.auto') !== '0'; } catch (_) { /* giữ mặc định */ }
  $('#auto-process').addEventListener('change', () => {
    try { localStorage.setItem('m2m.auto', $('#auto-process').checked ? '1' : '0'); } catch (_) { /* không lưu được cũng không sao */ }
  });

  // --------------------------------------------------------------- health
  function setBadge(id, ok, text) {
    const node = $(id);
    node.className = `badge ${ok ? 'ok' : 'off'}`;
    node.textContent = text;
  }
  async function loadHealth() {
    const support = sttSupport();
    try {
      const h = await api.get('/api/health');
      state.health = h;
      if (h.whisper.available) setBadge('#badge-whisper', true, `Whisper: ${h.whisper.model}`);
      else if (support.provider) setBadge('#badge-whisper', true, 'Giọng nói: nhận dạng trực tiếp');
      else setBadge('#badge-whisper', false, 'Giọng nói: máy không hỗ trợ');
      if (h.ollama.available && h.ollama.model_ready) setBadge('#badge-ollama', true, `LLM: ${h.ollama.model}`);
      else if (h.ollama.available) setBadge('#badge-ollama', false, `LLM: thiếu model ${h.ollama.model}`);
      else setBadge('#badge-ollama', true, 'Tóm tắt: không cần AI');
      if (h.standalone) setBadge('#badge-memory', h.storage !== 'memory', h.storage !== 'memory' ? 'Lưu trên máy này' : 'Lưu tạm (trình duyệt chặn bộ nhớ)');
      else setBadge('#badge-memory', true, `Trí nhớ: ${h.embedder}`);
      if (IS_MOBILE) $('#server-box').classList.remove('warn');
    } catch (err) {
      state.health = null;
      setBadge('#badge-whisper', false, 'Giọng nói: ?');
      setBadge('#badge-ollama', false, IS_MOBILE ? 'Chưa kết nối máy chủ' : 'Không kết nối được server');
      setBadge('#badge-memory', false, 'Lưu trữ: ?');
      if (IS_MOBILE) { $('#server-box').classList.add('warn'); $('#server-box').open = true; }
    }
    // chưa có Whisper thì mặc định chuyển lời nói thành văn bản ngay khi nói (người dùng tự đổi thì giữ lựa chọn của họ)
    if (!captionsTouched) $('#live-captions').checked = !whisperReady();
    renderSttLine();
  }
  function setupServerBox() {
    const box = $('#server-box');
    if (!IS_MOBILE) return;
    box.hidden = false;
    $('#server-url').value = API_BASE;
    $('#server-summary').textContent = API_BASE ? `⚙ Máy chủ AI: ${API_BASE}` : '⚙ Máy chủ AI (tùy chọn): đang chạy độc lập';
    $('#btn-server-clear').hidden = !API_BASE;
    const save = (value) => {
      try { if (value) localStorage.setItem('m2m.server', value); else localStorage.removeItem('m2m.server'); } catch (_) { /* bộ nhớ bị chặn */ }
      location.reload();
    };
    $('#btn-server-save').addEventListener('click', () => {
      let value = $('#server-url').value.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\//i.test(value)) value = `http://${value}`;
      save(value);
    });
    $('#btn-server-clear').addEventListener('click', () => save(''));
  }

  // ------------------------------------------------------------- meetings
  let listSeq = 0;
  async function loadMeetings() {
    const q = $('#search-meetings').value.trim();
    const seq = ++listSeq;
    const meetings = await api.get(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (seq !== listSeq) return; // đã có lần tải mới hơn: bỏ kết quả cũ về muộn
    state.meetings = meetings;
    const list = $('#meeting-list');
    list.innerHTML = '';
    if (!state.meetings.length) {
      list.innerHTML = `<li class="muted small" style="cursor:default">${q ? 'Không tìm thấy cuộc họp nào khớp.' : 'Chưa có cuộc họp nào.'}</li>`;
      return;
    }
    for (const m of state.meetings) {
      const li = document.createElement('li');
      li.className = state.current && state.current.id === m.id ? 'active' : '';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.innerHTML = `<span class="title"></span><span class="sub"><span>${esc(fmtDate(m.created_at))}</span><span class="status-pill ${statusClass(m.status)}">${esc(statusLabel(m.status))}</span></span>`;
      li.querySelector('.title').textContent = m.title;
      li.addEventListener('click', () => openMeeting(m.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeeting(m.id); }
      });
      list.appendChild(li);
    }
  }
  $('#search-meetings').addEventListener('input', () => loadMeetings().catch(() => {}));

  let openSeq = 0;
  async function openMeeting(id) {
    const seq = ++openSeq;
    // Người dùng chủ động mở cuộc họp khác: bản ghi đang xử lý xong sau đó chỉ báo, không kéo họ đi
    pollers.forEach((p, pid) => { if (pid !== id) p.navigated = true; });
    try {
      const m = await api.get(`/api/meetings/${id}`);
      if (seq !== openSeq) return; // bấm nhanh nhiều cuộc họp: chỉ hiện cuộc họp bấm sau cùng
      renderMeeting(m);
      showTab('result');
      loadMeetings();
      if (['queued', 'transcribing', 'analyzing'].includes(m.status) || m.processing) startPolling(id);
    } catch (err) { toast(err.message, true); }
  }

  $('#btn-new-meeting').addEventListener('click', () => {
    state.current = null;
    openSeq += 1; // hủy lần mở cuộc họp còn đang chờ trả lời
    if (isRecording()) stopRecording({ discard: true });
    discardRecording();
    $('#meeting-title').value = '';
    $('#meeting-participants').value = '';
    showTab('record');
    loadMeetings();
    $('#meeting-title').focus();
  });

  // ------------------------------------------------- văn bản trực tiếp khi nói
  function liveText() {
    return state.live.finals.join(' ');
  }
  function renderLive() {
    const box = $('#live-transcript');
    box.innerHTML = '';
    box.append(document.createTextNode(liveText() + (state.live.finals.length ? ' ' : '')));
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = state.live.interim;
    box.appendChild(span);
    box.scrollTop = box.scrollHeight;
  }
  let liveTimer = null;
  let liveShown = '';
  /* Tóm tắt và vẽ sơ đồ tư duy ngay trong lúc nói (bằng engine.js, không gọi máy chủ). */
  function runLiveAnalysis() {
    liveTimer = null;
    if (!engine) return;
    const text = liveText();
    if (text === liveShown) return;
    liveShown = text;
    const preview = $('#live-preview');
    if (wordCount(text) < 12) { preview.hidden = true; return; }
    let analysis;
    try {
      analysis = engine.analyze(text, {
        title: $('#meeting-title').value.trim(), participants: participantList(), language: $('#meeting-language').value || 'auto',
      });
    } catch (err) { return; }
    const list = $('#live-summary');
    list.innerHTML = '';
    for (const item of analysis.summary.slice(0, 5)) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    const wasHidden = preview.hidden;
    preview.hidden = false;
    state.liveMap.setTree(analysis.mindmap);
    if (wasHidden) state.liveMap.fit();
  }
  function scheduleLiveAnalysis() {
    if (liveTimer) return;
    // văn bản càng dài càng thưa nhịp cập nhật để không tốn pin
    liveTimer = setTimeout(runLiveAnalysis, Math.min(8000, 900 + wordCount(liveText()) * 2));
  }
  function resetLive() {
    clearTimeout(liveTimer);
    liveTimer = null;
    liveShown = '';
    state.live = { finals: [], interim: '' };
    $('#live-transcript').hidden = true;
    $('#live-transcript').textContent = '';
    $('#live-preview').hidden = true;
    $('#live-summary').innerHTML = '';
  }

  // ------------------------------------------------------------ recording
  const rec = { recorder: null, stream: null, chunks: [], ctx: null, analyser: null, raf: null, timer: null,
    startedAt: 0, accumulated: 0, paused: false, mime: '', starting: false, active: false, stopping: null,
    speech: null, live: false, level: 0, levels: [] };
  function isRecording() {
    return rec.active;
  }
  function setRecordLabel(recording) {
    const label = recording ? 'Dừng ghi âm' : 'Bắt đầu ghi âm';
    $('#btn-record').title = label;
    $('#btn-record').setAttribute('aria-label', label);
  }
  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    if (!window.MediaRecorder) return '';
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }
  function extForMime(mime) {
    if (!mime) return 'webm';
    if (mime.includes('mp4')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mpeg')) return 'mp3';
    return 'webm';
  }
  function elapsed() {
    return rec.accumulated + (rec.paused || !rec.startedAt ? 0 : (Date.now() - rec.startedAt) / 1000);
  }
  function drawMeter() {
    const canvas = $('#level-meter');
    const ctx2d = canvas.getContext('2d');
    const bars = 48;
    const data = rec.analyser ? new Uint8Array(rec.analyser.frequencyBinCount) : null;
    rec.levels = [];
    let lastSample = 0;
    const draw = (now) => {
      rec.raf = requestAnimationFrame(draw);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      let values;
      if (data) {
        rec.analyser.getByteFrequencyData(data);
        const step = Math.floor(data.length / bars);
        values = [];
        for (let i = 0; i < bars; i++) values.push(data[i * step] / 255);
      } else {
        // không có luồng âm thanh riêng (điện thoại nhận dạng trực tiếp): vẽ mức âm gần đây do bộ nhận dạng báo về
        if (now - lastSample > 80) {
          lastSample = now;
          rec.levels.push(rec.paused ? 0 : rec.level);
          if (rec.levels.length > bars) rec.levels.shift();
          rec.level *= 0.8;
        }
        values = new Array(bars - rec.levels.length).fill(0).concat(rec.levels);
      }
      for (let i = 0; i < bars; i++) {
        const v = values[i] || 0;
        const h = Math.max(2, v * canvas.height);
        ctx2d.fillStyle = rec.paused ? '#d1d5db' : `hsl(${240 - v * 120}, 70%, 55%)`;
        ctx2d.fillRect(i * (canvas.width / bars) + 1, canvas.height - h, canvas.width / bars - 2, h);
      }
    };
    rec.raf = requestAnimationFrame(draw);
  }
  function releaseAudio() {
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    if (rec.ctx) { rec.ctx.close().catch(() => {}); }
    rec.stream = null; rec.ctx = null; rec.analyser = null; rec.recorder = null; rec.chunks = [];
  }
  /* Mở micro và bộ ghi file âm thanh. Trả về false (kèm thông báo lỗi) nếu không ghi được. */
  async function openAudio() {
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      rec.stream = null;
      return `Không truy cập được micro: ${err.message}`;
    }
    rec.mime = pickMime();
    rec.chunks = [];
    try {
      rec.recorder = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime } : undefined);
    } catch (err) {
      releaseAudio();
      return `Trình duyệt không ghi âm được: ${err.message}`;
    }
    // Micro bị rút/thu hồi/app khác chiếm giữa chừng: dừng và giữ phần đã ghi, đừng để đồng hồ chạy tiếp trên bản ghi câm
    const activeRecorder = rec.recorder;
    rec.stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
      if (rec.recorder !== activeRecorder || !rec.active) return;
      const at = fmtTime(elapsed());
      stopRecording({ auto: false, note: `Micro bị ngắt lúc ${at}. Phần đã ghi được giữ lại bên dưới.` });
      toast(`Micro bị ngắt lúc ${at}, bản ghi đã dừng. Phần đã ghi vẫn được giữ.`, true);
    }));
    rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.recorder.start(1000);
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    rec.analyser = rec.ctx.createAnalyser();
    rec.analyser.fftSize = 256;
    rec.ctx.createMediaStreamSource(rec.stream).connect(rec.analyser);
    return '';
  }
  /* Bật nhận dạng giọng nói trực tiếp. Ném lỗi nếu máy không cho (thiếu quyền, không có dịch vụ). */
  function openSpeech() {
    const session = speech.create({
      lang: speech.langTag($('#meeting-language').value),
      onPartial: (text) => {
        if (rec.speech !== session) return;
        state.live.interim = text;
        if (text) rec.level = Math.max(rec.level, 0.55);
        renderLive();
      },
      onFinal: (text) => {
        if (rec.speech !== session) return;
        const sentence = speech.formatUtterance(text);
        if (!sentence) return;
        state.live.finals.push(sentence);
        state.live.interim = '';
        renderLive();
        scheduleLiveAnalysis();
      },
      onLevel: (value) => { if (rec.speech === session) rec.level = value; },
      onState: (info) => {
        if (rec.speech !== session || !rec.active || rec.paused) return;
        if (info.listening) $('#rec-state').textContent = recordingLabel();
        else if (info.reason === 'background') $('#rec-state').textContent = 'Tạm ngừng nhận dạng vì ứng dụng không ở phía trước. Quay lại ứng dụng để tiếp tục.';
      },
      onError: (error) => {
        if (rec.speech !== session || !rec.active) return;
        if (!error.fatal) { $('#rec-state').textContent = error.message; return; }
        rec.live = false;
        if (rec.recorder) {
          // vẫn còn bản ghi âm chạy song song: giữ bản ghi, chỉ báo là hết chuyển thành văn bản
          $('#rec-state').textContent = 'Đang ghi âm (đã ngừng chuyển thành văn bản)…';
          toast(`${error.message} Bản ghi âm vẫn tiếp tục.`, true);
        } else {
          const at = fmtTime(elapsed());
          stopRecording({ auto: false, note: `Nhận dạng giọng nói dừng lúc ${at}. Phần văn bản đã có được giữ lại.` });
          toast(error.message, true);
        }
      },
    });
    rec.speech = session;
    return session.start().catch((err) => {
      if (rec.speech === session) rec.speech = null;
      throw err;
    });
  }
  function recordingLabel() {
    return rec.live ? 'Đang ghi và chuyển thành văn bản…' : 'Đang ghi âm…';
  }
  async function startRecording() {
    // Bấm lặp khi hộp thoại xin quyền chưa trả lời: không mở luồng micro thứ hai (luồng đầu sẽ không bao giờ tắt)
    if (rec.starting || rec.active || rec.stopping) return;
    if (fileJob) { toast('Đang chuyển file ghi âm thành văn bản. Hãy chờ xong hoặc bấm Hủy rồi mới ghi.', true); return; }
    const plan = capturePlan();
    const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (plan.audio && !canCapture) {
      if (!plan.live) { toast('Trình duyệt không hỗ trợ ghi âm (cần HTTPS hoặc localhost)', true); return; }
      plan.audio = false; // không ghi được file âm thanh nhưng vẫn chuyển lời nói thành văn bản được
    }
    rec.starting = true;
    try {
      if (plan.audio) {
        const problem = await openAudio();
        if (problem) {
          if (!plan.live) { toast(problem, true); return; }
          plan.audio = false;
        }
      }
      state.capture = null;
      resetLive();
      rec.live = false;
      if (plan.live) {
        try {
          await openSpeech();
          rec.live = true;
        } catch (err) {
          if (!plan.audio) { toast(err.message, true); return; }
          toast(`${err.message} Vẫn ghi âm bình thường.`, true);
        }
      }
      rec.active = true;
      rec.accumulated = 0; rec.startedAt = Date.now(); rec.paused = false; rec.level = 0;
      drawMeter();
      rec.timer = setInterval(() => { $('#rec-timer').textContent = fmtTime(elapsed()); }, 250);
      if (speech) speech.keepAwake(true);
      $('#btn-record').classList.add('recording');
      setRecordLabel(true);
      $('#btn-pause').disabled = false; $('#btn-stop').disabled = false;
      $('#rec-state').textContent = recordingLabel();
      $('#preview').hidden = true;
      if (rec.live) { $('#live-transcript').hidden = false; renderLive(); }
    } finally {
      rec.starting = false;
    }
  }
  function togglePause() {
    if (!rec.active) return;
    if (!rec.paused) {
      rec.accumulated = elapsed(); rec.paused = true; rec.startedAt = 0;
      if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.pause();
      if (rec.speech) rec.speech.pause().catch(() => {});
      $('#btn-pause').textContent = '▶ Tiếp tục'; $('#rec-state').textContent = 'Tạm dừng';
      $('#btn-record').classList.add('paused');
    } else {
      rec.paused = false; rec.startedAt = Date.now();
      if (rec.recorder && rec.recorder.state === 'paused') rec.recorder.resume();
      if (rec.speech && rec.live) rec.speech.resume().catch((err) => toast(err.message, true));
      $('#btn-pause').textContent = '⏸ Tạm dừng'; $('#rec-state').textContent = recordingLabel();
      $('#btn-record').classList.remove('paused');
    }
  }
  /* Dừng ghi. options: {discard: bỏ luôn bản ghi, auto: false = không tự xử lý, note: câu hiện ở dòng trạng thái}. */
  function stopRecording(options) {
    if (!rec.active) return rec.stopping || Promise.resolve();
    const opts = options || {};
    rec.active = false;
    const duration = elapsed();
    const session = rec.speech, recorder = rec.recorder, mime = rec.mime;
    cancelAnimationFrame(rec.raf); clearInterval(rec.timer);
    if (speech) speech.keepAwake(false);
    $('#btn-record').classList.remove('recording', 'paused');
    setRecordLabel(false);
    $('#btn-pause').disabled = true; $('#btn-stop').disabled = true; $('#btn-pause').textContent = '⏸ Tạm dừng';
    $('#rec-state').textContent = opts.note || 'Đã dừng.';
    // chờ cả hai phía trả nốt phần cuối: file âm thanh và câu đang nói dở
    const audioDone = recorder ? new Promise((resolve) => {
      const finish = () => resolve(new Blob(rec.chunks, { type: mime || 'audio/webm' }));
      recorder.onstop = finish;
      if (recorder.state !== 'inactive') recorder.stop(); else finish();
    }) : Promise.resolve(null);
    const speechDone = session ? session.stop().catch(() => {}) : Promise.resolve();
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    if (rec.ctx) { rec.ctx.close().catch(() => {}); rec.ctx = null; }
    rec.stopping = Promise.all([audioDone, speechDone]).then((done) => {
      rec.stopping = null;
      rec.recorder = null; rec.stream = null; rec.analyser = null; rec.chunks = []; rec.speech = null; rec.live = false;
      if (opts.discard) { resetLive(); return; }
      finishRecording(done[0], duration, opts, !!session);
    });
    return rec.stopping;
  }
  function finishRecording(blob, duration, opts, listened) {
    const text = liveText().trim();
    state.live.interim = '';
    if (blob && !blob.size) blob = null;
    if (!blob && !text) {
      // không có file âm thanh lẫn văn bản: không có gì để giữ
      const message = listened ? 'Không nhận dạng được lời nói nào. Hãy thử lại và nói gần micro hơn.' : 'Bản ghi trống';
      if (!opts.note) $('#rec-state').textContent = message;
      toast(message, true);
      resetLive();
      return;
    }
    setCapture({ blob, ext: blob ? extForMime(blob.type) : '', duration, text });
    const canProcess = !!text || whisperReady();
    if (opts.auto !== false && $('#auto-process').checked && canProcess) {
      $('#rec-state').textContent = 'Đã dừng. Đang tóm tắt và vẽ sơ đồ tư duy…';
      processRecording();
    } else if (!opts.note) {
      $('#rec-state').textContent = canProcess
        ? 'Đã dừng. Nhấn "Tóm tắt & vẽ sơ đồ tư duy" để xử lý.'
        : 'Đã dừng. Bản ghi chỉ có âm thanh, chưa có văn bản để tóm tắt.';
    }
  }
  function setCapture(capture) {
    state.capture = capture;
    const audio = $('#audio-preview');
    if (capture.blob) {
      audio.hidden = false;
      audio.src = URL.createObjectURL(capture.blob);
      audio.onloadedmetadata = () => {
        if (state.capture === capture && isFinite(audio.duration) && audio.duration > 0) capture.duration = audio.duration;
      };
    } else {
      audio.hidden = true;
      audio.removeAttribute('src');
    }
    const info = [];
    if (capture.blob) info.push(`${(capture.blob.size / 1024 / 1024).toFixed(2)} MB`);
    if (capture.duration) info.push(fmtTime(capture.duration));
    if (capture.text) info.push(`${wordCount(capture.text)} từ đã nhận dạng`);
    $('#preview-info').textContent = info.join(' · ');
    $('#preview').hidden = false;
  }
  function discardRecording() {
    state.capture = null;
    resetLive();
    $('#preview').hidden = true; $('#audio-preview').removeAttribute('src');
    $('#rec-timer').textContent = '00:00'; $('#rec-state').textContent = 'Sẵn sàng. Nhấn nút đỏ để bắt đầu.';
    $('#audio-file').value = '';
  }
  $('#btn-record').addEventListener('click', () => {
    if (isRecording()) stopRecording(); else startRecording();
  });
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-stop').addEventListener('click', () => stopRecording());
  $('#btn-discard').addEventListener('click', discardRecording);
  $('#audio-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';   // chọn lại đúng file đó lần nữa vẫn được
    if (file) importFile(file);
  });
  $('#file-pick').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!fileJob) $('#audio-file').click(); }
  });
  $('#btn-file-cancel').addEventListener('click', () => { if (fileJob) fileJob.job.cancel(); });

  // ------------------------------------------------- nhập bản ghi âm có sẵn
  const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
  let fileInfo = { provider: null, label: '', realtime: false };
  let fileInfoReady = false;
  let fileJob = null;   // {job, file, ext, duration, provider}
  function refreshFileSupport() {
    if (!speech) { fileInfoReady = true; renderFileNote(); return; }
    speech.fileSupport().then((info) => { fileInfo = info || fileInfo; }, () => {}).then(() => {
      fileInfoReady = true;
      renderFileNote();
    });
  }
  function fileExt(file) {
    const dot = (file.name || '').lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : extForMime(file.type || '');
  }
  /* Tên file có nghĩa ("Họp dự án A.m4a") thì dùng làm tiêu đề; tên máy tự đặt ("Recording 12", "AUD-2024...",
     "Ghi âm 2024-11-14") thì bỏ, để tiêu đề lấy từ nội dung. */
  function titleFromFileName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) return '';
    const letters = (base.match(/\p{L}/gu) || []).length;
    const digits = (base.match(/\p{N}/gu) || []).length;
    if (letters < 3 || digits > letters) return '';
    if (/^(new recording|recording|record|rec|audio|voice memo|voice|memo|sound|track|ptt|aud|vn|ghi âm mới|ghi âm|ghi am|bản ghi mới|bản ghi|ban ghi|tệp ghi âm|cuộc gọi|call)(?=$|[\s\d._-])/iu.test(base)) return '';
    return base.slice(0, 200);
  }
  function probeDuration(file) {
    return new Promise((resolve) => {
      let url = '';
      try { url = URL.createObjectURL(file); } catch (_) { resolve(0); return; }
      const probe = document.createElement('audio');
      let timer = null;
      const done = (value) => {
        clearTimeout(timer);
        probe.onloadedmetadata = null; probe.onerror = null;
        URL.revokeObjectURL(url);
        resolve(value);
      };
      timer = setTimeout(() => done(0), 4000);
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => done(isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 0);
      probe.onerror = () => done(0);
      probe.src = url;
    });
  }
  function setFileBusy(busy) {
    $('#file-pick').classList.toggle('disabled', busy);
    $('#audio-file').disabled = busy;
    $('#btn-record').disabled = busy;
  }
  let fileProgress = null;
  function showFileProgress(progress) {
    if (progress) fileProgress = progress;
    const p = fileProgress || { phase: 'recognize', value: 0 };
    const value = Math.max(0, Math.min(1, Number(p.value) || 0));
    $('#file-progress').hidden = false;
    $('#file-progress-bar').style.width = `${Math.round(value * 100)}%`;
    let text;
    if (p.phase === 'transfer') text = `Đang chuẩn bị file… ${Math.round(value * 100)}%`;
    else if (p.duration) text = `Đang nghe và nhận dạng… ${fmtTime(p.current)} / ${fmtTime(p.duration)}`;
    else text = `Đang nhận dạng… ${Math.round(value * 100)}%`;
    const words = wordCount(liveText());
    if (words) text += ` · ${words} từ`;
    $('#file-progress-text').textContent = text;
  }
  async function importFile(file) {
    if (isRecording() || rec.starting || rec.stopping) { toast('Hãy dừng ghi âm trước khi nhập file.', true); return; }
    if (fileJob) { toast('Đang chuyển một file khác thành văn bản. Hãy chờ xong hoặc bấm Hủy.', true); return; }
    if (!file.size) { toast('File rỗng.', true); return; }
    const plan = filePlan();
    if (plan !== 'server' && file.size > MAX_IMPORT_BYTES) {
      toast(`File quá lớn (${Math.round(file.size / 1024 / 1024)} MB). Hãy chọn file dưới ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`, true);
      return;
    }
    if (!plan && LOCAL) { toast($('#file-note').textContent || speech.describe('unsupported'), true); return; }
    // bản ghi micro trước đó (và văn bản của nó) không thuộc về file này
    resetLive();
    state.capture = null;
    $('#preview').hidden = true;
    const ext = fileExt(file);
    const named = titleFromFileName(file.name);
    if (named && !$('#meeting-title').value.trim()) $('#meeting-title').value = named;
    const duration = await probeDuration(file);
    if (fileJob || isRecording()) return;   // trong lúc đọc thời lượng người dùng đã làm việc khác
    if (plan === 'server' || !plan) {
      setCapture({ blob: file, ext, duration, text: '', source: 'file' });
      if (plan === 'server' && $('#auto-process').checked) {
        $('#rec-state').textContent = `Đã chọn file: ${file.name}. Đang gửi cho máy chủ…`;
        processRecording();
      } else {
        $('#rec-state').textContent = plan
          ? `Đã chọn file: ${file.name}. Nhấn "Tóm tắt & vẽ sơ đồ tư duy" để xử lý.`
          : `Đã chọn file: ${file.name}. File chỉ lưu lại để nghe, chưa chuyển thành văn bản được.`;
      }
      return;
    }
    transcribeImported(file, ext, duration, plan);
  }
  function transcribeImported(file, ext, duration, provider) {
    let current = null;
    const job = speech.transcribeFile(file, {
      provider,
      lang: speech.langTag($('#meeting-language').value),
      onPartial: (text) => {
        if (fileJob !== current) return;
        state.live.interim = text;
        renderLive();
      },
      onFinal: (text) => {
        if (fileJob !== current) return;
        const sentence = speech.formatUtterance(text);
        if (!sentence) return;
        state.live.finals.push(sentence);
        state.live.interim = '';
        renderLive();
        scheduleLiveAnalysis();
        showFileProgress();
      },
      onProgress: (progress) => { if (fileJob === current) showFileProgress(progress); },
    });
    current = { job, file, ext, duration, provider };
    fileJob = current;
    fileProgress = null;
    setFileBusy(true);
    speech.keepAwake(true);
    $('#live-transcript').hidden = false;
    renderLive();
    showFileProgress({ phase: provider === 'native' ? 'transfer' : 'recognize', value: 0 });
    $('#rec-state').textContent = `Đang chuyển "${file.name}" thành văn bản…`;
    return job.promise.then((result) => finishImport(current, null, result), (err) => finishImport(current, err, null));
  }
  function finishImport(current, err, result) {
    if (fileJob !== current) return;
    fileJob = null;
    speech.keepAwake(false);
    setFileBusy(false);
    $('#file-progress').hidden = true;
    state.live.interim = '';
    let text = liveText().trim();
    if (!text && result && result.text) text = speech.formatUtterance(result.text);
    if (err && err.code === 'cancelled') {
      resetLive();
      $('#rec-state').textContent = 'Đã hủy chuyển file thành văn bản.';
      return;
    }
    const duration = current.duration || (result && result.duration) || 0;
    if (!text) {
      const message = err ? err.message : 'Không nhận dạng được lời nói nào trong file.';
      resetLive();
      $('#rec-state').textContent = message;
      toast(message, true);
      // trên máy chủ vẫn lưu được file để nghe lại; chế độ độc lập không có văn bản thì không có gì để làm
      if (!LOCAL) setCapture({ blob: current.file, ext: current.ext, duration, text: '', source: 'file' });
      return;
    }
    setCapture({ blob: current.file, ext: current.ext, duration, text, source: 'file' });
    if (err) {
      toast(`${err.message} Đã giữ phần chuyển được thành văn bản.`, true);
      $('#rec-state').textContent = 'Mới chuyển được một phần file. Nhấn "Tóm tắt & vẽ sơ đồ tư duy" để xử lý phần đã có.';
    } else if ($('#auto-process').checked) {
      $('#rec-state').textContent = 'Đã chuyển xong file thành văn bản. Đang tóm tắt và vẽ sơ đồ tư duy…';
      processRecording();
    } else {
      $('#rec-state').textContent = 'Đã chuyển xong file thành văn bản. Nhấn "Tóm tắt & vẽ sơ đồ tư duy" để xử lý.';
    }
  }

  // ----------------------------------------------------------- processing
  function participantList() {
    return $('#meeting-participants').value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  function meetingPayload() {
    return { title: $('#meeting-title').value.trim(), participants: participantList(), language: $('#meeting-language').value || 'auto' };
  }
  /* Người dùng không đặt tiêu đề: lấy chủ đề của chính nội dung, không có thì đặt theo ngày giờ. */
  function autoTitle(text, kind) {
    let title = '';
    try { title = text && engine ? engine.titleFor(text, $('#meeting-language').value || 'auto') : ''; } catch (_) { title = ''; }
    if (title) return title;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${kind} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function setProgress(text) {
    $('#progress').hidden = !text;
    $('#progress-text').textContent = text || '';
    $('#btn-process').disabled = !!text;
    $('#btn-analyze-text').disabled = !!text;
  }
  async function processRecording() {
    const capture = state.capture;
    if (!capture) { toast('Chưa có bản ghi âm', true); return; }
    try {
      setProgress('Đang tạo cuộc họp…');
      const nav = openSeq;   // để biết người dùng có mở cuộc họp khác trong lúc đang gửi hay không
      const payload = meetingPayload();
      if (!payload.title) payload.title = autoTitle(capture.text, capture.source === 'file' ? 'Bản ghi' : 'Ghi âm');
      if (capture.duration) payload.duration_sec = capture.duration;
      const meeting = await api.post('/api/meetings', payload);
      const textSource = capture.source === 'file' ? 'file' : 'device';
      let audioSaved = false;
      if (capture.blob) {
        setProgress(LOCAL ? 'Đang lưu âm thanh…' : 'Đang tải âm thanh lên…');
        const form = new FormData();
        form.append('audio', capture.blob, `recording.${capture.ext}`);
        if (capture.duration) form.append('duration_sec', String(capture.duration));
        if (capture.text) {
          form.append('live_transcript', capture.text);
          form.append('transcript_source', capture.source === 'file' ? 'file' : (LOCAL ? 'device' : 'browser'));
        }
        try {
          await api.upload(`/api/meetings/${meeting.id}/audio`, form);
          audioSaved = true;
        } catch (err) {
          // không lưu được âm thanh (máy hết chỗ, file quá lớn...) nhưng đã có văn bản: vẫn tóm tắt, chỉ không nghe lại được
          if (!capture.text || err.status === 404) throw err;
          toast(`Không lưu được file âm thanh (${err.message}). Vẫn tóm tắt từ văn bản đã có.`, true);
        }
      }
      if (!audioSaved) await api.put(`/api/meetings/${meeting.id}/transcript`, { transcript: capture.text, source: textSource });
      await api.post(`/api/meetings/${meeting.id}/process`, { transcribe: audioSaved });
      setProgress('Đang xử lý…');
      await loadMeetings();
      startPolling(meeting.id, { capture, nav });
    } catch (err) { setProgress(''); toast(err.message, true); }
  }
  async function analyzeText() {
    const text = $('#manual-transcript').value.trim();
    if (!text) { toast('Hãy dán văn bản trước', true); return; }
    try {
      setProgress('Đang tạo cuộc họp…');
      const nav = openSeq;
      const payload = meetingPayload();
      if (!payload.title) payload.title = autoTitle(text, 'Ghi chú');
      const meeting = await api.post('/api/meetings', payload);
      await api.put(`/api/meetings/${meeting.id}/transcript`, { transcript: text });
      await api.post(`/api/meetings/${meeting.id}/process`, { transcribe: false });
      setProgress('Đang tóm tắt…');
      await loadMeetings();
      startPolling(meeting.id, { text, nav });
    } catch (err) { setProgress(''); toast(err.message, true); }
  }
  $('#btn-process').addEventListener('click', processRecording);
  $('#btn-analyze-text').addEventListener('click', analyzeText);

  // Mỗi cuộc họp đang xử lý có một bộ hỏi trạng thái riêng: mở/phân tích lại cuộc họp khác không làm
  // bộ của bản ghi vừa gửi bị hủy (thanh tiến trình kẹt mãi).
  const pollers = new Map();
  const MAX_POLL_FAILURES = 20; // ~30 giây mất mạng liên tục mới bỏ cuộc
  function stopPolling(id) {
    const p = pollers.get(id);
    if (p) { clearInterval(p.timer); pollers.delete(id); }
  }
  /* submitted: thứ người dùng vừa gửi đi từ tab Ghi âm ({capture} hoặc {text}, kèm nav = openSeq lúc bấm gửi);
     bỏ trống khi phân tích lại. */
  function startPolling(id, submitted) {
    const prev = pollers.get(id);
    stopPolling(id);
    const p = { submitted: submitted || (prev && prev.submitted) || null, busy: false, failures: 0, navigated: false, timer: null };
    // Người dùng đã mở cuộc họp khác ngay trong lúc đang gửi (trước khi có bộ hỏi trạng thái này): cũng tính là đã rời đi
    if (prev && prev.navigated) p.navigated = true;
    if (submitted && submitted.nav !== undefined && submitted.nav !== openSeq) p.navigated = true;
    const fromRecorder = !!p.submitted;
    const tick = async () => {
      if (p.busy || pollers.get(id) !== p) return;
      p.busy = true;
      let m;
      try {
        m = await api.get(`/api/meetings/${id}`);
      } catch (err) {
        p.busy = false;
        if (pollers.get(id) !== p) return;
        // Mất mạng thoáng qua: thử lại ở nhịp sau. Lỗi HTTP (vd: cuộc họp đã bị xóa) hay mất mạng kéo dài: dừng và báo.
        if (err.network && ++p.failures <= MAX_POLL_FAILURES) return;
        stopPolling(id);
        if (fromRecorder) setProgress('');
        toast(err.message, true);
        return;
      }
      p.busy = false; p.failures = 0;
      if (pollers.get(id) !== p) return;
      const working = ['queued', 'transcribing', 'analyzing'].includes(m.status) || m.processing;
      if (fromRecorder && working) setProgress(`${statusLabel(m.status)}…`);
      if (state.current && state.current.id === id) renderStatus(m);
      if (working) return;
      stopPolling(id);
      loadMeetings().catch(() => {});
      // Người dùng đang ghi âm hoặc có bản ghi mới chưa gửi: không đụng tới, không kéo họ đi
      const busyRecording = isRecording() || rec.starting || !!rec.stopping
        || (!!state.capture && !(p.submitted && p.submitted.capture === state.capture));
      if (fromRecorder) {
        setProgress('');
        // Chỉ dọn đúng thứ đã gửi đi; bản ghi/ghi chú người dùng làm thêm trong lúc chờ phải còn nguyên
        if (p.submitted.capture && state.capture === p.submitted.capture && !isRecording() && !rec.starting && !rec.stopping) discardRecording();
        if (p.submitted.text && $('#manual-transcript').value.trim() === p.submitted.text) $('#manual-transcript').value = '';
      }
      const viewingOther = !!state.current && state.current.id !== id;
      if (busyRecording || (viewingOther && (!fromRecorder || p.navigated))) {
        if (state.current && state.current.id === id) renderMeeting(m); // cập nhật nội dung nhưng không chuyển tab
        toast(m.status === 'error' ? `Cuộc họp "${m.title}" xử lý lỗi: ${m.error}` : `Cuộc họp "${m.title}" đã xử lý xong`, m.status === 'error');
        return;
      }
      renderMeeting(m);
      showTab('result');
      if (m.status === 'error') toast(`Xử lý lỗi: ${m.error}`, true);
      else toast(`Xong! Tóm tắt bằng ${engineLabel(m.engine || (m.analysis && m.analysis.engine) || '')}`);
    };
    p.timer = setInterval(tick, 1500);
    pollers.set(id, p);
    tick();
  }

  // --------------------------------------------------------------- result
  function renderStatus(m) {
    const line = $('#result-status');
    if (m.status === 'done') { line.hidden = true; return; }
    line.hidden = false;
    line.className = `status-line ${m.status === 'error' ? 'error' : ''}`;
    line.innerHTML = m.status === 'error' ? '' : '<div class="spinner"></div>';
    line.append(document.createTextNode(m.status === 'error' ? `Lỗi: ${m.error || 'không rõ'}` : `${statusLabel(m.status)}…`));
  }
  function actionRow(item) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input type="text" class="a-task" aria-label="Việc cần làm"></td><td><input type="text" class="a-owner" aria-label="Người phụ trách"></td><td><input type="text" class="a-due" aria-label="Hạn"></td><td><button class="icon-btn" title="Xóa việc này" aria-label="Xóa việc này">✕</button></td>';
    tr.querySelector('.a-task').value = item.task || '';
    tr.querySelector('.a-owner').value = item.owner || '';
    tr.querySelector('.a-due').value = item.due || '';
    tr.querySelector('button').addEventListener('click', () => tr.remove());
    return tr;
  }
  function showResultAudio(m) {
    const audio = $('#result-audio');
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = ''; }
    if (!m.has_audio) { audio.hidden = true; audio.removeAttribute('src'); return; }
    if (!LOCAL) { audio.hidden = false; audio.src = apiUrl(`/api/meetings/${m.id}/audio?t=${Date.now()}`); return; }
    audio.hidden = true;
    audio.removeAttribute('src');
    local.audioUrl(m.id).then((url) => {
      if (!url) return;
      if (!state.current || state.current.id !== m.id) { URL.revokeObjectURL(url); return; }
      state.audioUrl = url;
      audio.src = url;
      audio.hidden = false;
    }).catch(() => {});
  }
  function renderMeeting(m) {
    state.current = m;
    $('#result-empty').hidden = true;
    $('#result-body').hidden = false;
    $('#result-title').value = m.title;
    const a = m.analysis || {};
    const ctx = a.context_used || {};
    const metaParts = [fmtDate(m.created_at)];
    if (m.duration_sec) metaParts.push(`⏱ ${fmtTime(m.duration_sec)}`);
    if (m.participants && m.participants.length) metaParts.push(`👥 ${m.participants.join(', ')}`);
    if (a.engine) metaParts.push(`⚙ ${engineLabel(a.engine)}${a.edited ? ' (đã sửa)' : ''}`);
    if (a.context_used) metaParts.push(`🧠 đã học: ${ctx.glossary_terms || 0} thuật ngữ, ${ctx.past_meetings || 0} họp trước, ${ctx.examples || 0} ví dụ`);
    $('#result-meta').textContent = metaParts.join('  ·  ');
    renderStatus(m);
    $('#edit-summary').value = (a.summary || []).map((s) => `- ${s}`).join('\n');
    $('#edit-decisions').value = (a.decisions || []).map((s) => `- ${s}`).join('\n');
    const tbody = $('#actions-table tbody');
    tbody.innerHTML = '';
    (a.action_items || []).forEach((item) => tbody.appendChild(actionRow(item)));
    $('#edit-keywords').value = (a.keywords || []).join(', ');
    $('#edit-transcript').value = m.transcript || '';
    $('#transcript-source').textContent = m.transcript_source ? `(${sourceLabel(m.transcript_source)})` : '';
    showResultAudio(m);
    $('#btn-export-md').href = LOCAL ? '#' : apiUrl(`/api/meetings/${m.id}/export.md`);
    $('#btn-export-md').download = `${m.title}.md`;
    state.mindmap.setTree(a.mindmap || { title: m.title, children: [] });
    state.rating = 0; renderStars();
    $('#rating-comment').value = ''; $('#rating-msg').textContent = ''; $('#save-analysis-msg').textContent = ''; $('#save-transcript-msg').textContent = '';
  }
  // Chế độ độc lập không có máy chủ để tải file về: tự dựng biên bản Markdown ngay trên máy
  $('#btn-export-md').addEventListener('click', async (e) => {
    if (!LOCAL) return;
    e.preventDefault();
    if (!state.current) return;
    try {
      const markdown = await local.exportMarkdown(state.current.id);
      download(`${state.current.title}.md`, new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    } catch (err) { toast(err.message, true); }
  });
  function collectAnalysis() {
    const items = $$('#actions-table tbody tr').map((tr) => ({
      task: tr.querySelector('.a-task').value.trim(), owner: tr.querySelector('.a-owner').value.trim(), due: tr.querySelector('.a-due').value.trim(),
    })).filter((it) => it.task);
    return {
      summary: lines($('#edit-summary').value),
      decisions: lines($('#edit-decisions').value),
      action_items: items,
      keywords: $('#edit-keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
      mindmap: state.mindmap.getTree(),
    };
  }
  $('#btn-add-action').addEventListener('click', () => { $('#actions-table tbody').appendChild(actionRow({})); });
  $('#btn-save-analysis').addEventListener('click', async () => {
    if (!state.current) return;
    try {
      const m = await api.put(`/api/meetings/${state.current.id}/analysis`, collectAnalysis());
      const learned = m.learning && m.learning.learned;
      renderMeeting(m);
      const learnedMsg = LOCAL ? 'Đã lưu. Ứng dụng ghi nhận cách trình bày bạn thích cho các lần sau.'
        : 'Đã lưu. Bản sửa này được ghi nhận làm ví dụ mẫu cho các lần sau.';
      $('#save-analysis-msg').textContent = learned ? learnedMsg : 'Đã lưu (không có thay đổi).';
      toast(learned ? 'Đã lưu và học từ chỉnh sửa của bạn' : 'Đã lưu');
    } catch (err) { toast(err.message, true); }
  });
  $('#result-title').addEventListener('change', async () => {
    if (!state.current) return;
    if (!$('#result-title').value.trim()) { $('#result-title').value = state.current.title; return; } // tiêu đề trống: giữ tên cũ
    try {
      const m = await api.patch(`/api/meetings/${state.current.id}`, { title: $('#result-title').value });
      state.current.title = m.title; loadMeetings();
    } catch (err) { toast(err.message, true); }
  });
  async function saveTranscript(reanalyze) {
    if (!state.current) return;
    try {
      const m = await api.put(`/api/meetings/${state.current.id}/transcript`, { transcript: $('#edit-transcript').value, reanalyze });
      const learned = m.learned_corrections || [];
      $('#save-transcript-msg').textContent = learned.length
        ? `Đã lưu. Ghi nhận ${learned.length} cặp sửa lỗi: ${learned.map((l) => `"${l.variant}"→"${l.term}"`).join(', ')}`
        : 'Đã lưu văn bản.';
      if (reanalyze) { state.current = m; startPolling(m.id); } else { state.current = m; }
    } catch (err) { toast(err.message, true); }
  }
  $('#btn-save-transcript').addEventListener('click', () => saveTranscript(false));
  $('#btn-save-transcript-reanalyze').addEventListener('click', () => saveTranscript(true));
  $('#btn-reanalyze').addEventListener('click', async () => {
    if (!state.current) return;
    try {
      await api.post(`/api/meetings/${state.current.id}/process`, { transcribe: false });
      startPolling(state.current.id);
    } catch (err) { toast(err.message, true); }
  });
  $('#btn-delete').addEventListener('click', async () => {
    if (!state.current || !confirm(`Xóa cuộc họp "${state.current.title}"? Dữ liệu đã học từ cuộc họp này cũng bị xóa.`)) return;
    try {
      await api.del(`/api/meetings/${state.current.id}`);
      stopPolling(state.current.id);
      state.current = null;
      if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = ''; }
      $('#result-body').hidden = true; $('#result-empty').hidden = false;
      await loadMeetings();
      toast('Đã xóa');
    } catch (err) { toast(err.message, true); }
  });

  function renderStars() {
    $$('#stars button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) <= state.rating));
  }
  $$('#stars button').forEach((b) => b.addEventListener('click', () => { state.rating = Number(b.dataset.v); renderStars(); }));
  $('#btn-rate').addEventListener('click', async () => {
    if (!state.current) return;
    if (!state.rating) { toast('Hãy chọn số sao', true); return; }
    try {
      const r = await api.post(`/api/meetings/${state.current.id}/rating`, { rating: state.rating, comment: $('#rating-comment').value.trim() || null });
      $('#rating-msg').textContent = r.learned ? 'Cảm ơn! Kết quả này được dùng làm ví dụ mẫu cho lần sau.' : 'Đã ghi nhận đánh giá.';
    } catch (err) { toast(err.message, true); }
  });

  // -------------------------------------------------------------- mindmap
  state.mindmap = new MindMap($('#mindmap'), { onChange: () => { $('#save-analysis-msg').textContent = 'Sơ đồ tư duy có thay đổi chưa lưu.'; } });
  state.liveMap = new MindMap($('#live-mindmap'), { readOnly: true });
  $('#mm-zoom-in').addEventListener('click', () => state.mindmap.zoom(1.25));
  $('#mm-zoom-out').addEventListener('click', () => state.mindmap.zoom(0.8));
  $('#mm-fit').addEventListener('click', () => state.mindmap.fit());
  $('#mm-add-child').addEventListener('click', () => state.mindmap.addChild());
  $('#mm-delete').addEventListener('click', () => { if (!state.mindmap.deleteSelected()) toast('Hãy chọn một nút (không phải nút gốc)', true); });
  $('#mm-export-svg').addEventListener('click', () => {
    if (!state.current) return;
    download(`${state.current.title}-mindmap.svg`, new Blob([state.mindmap.exportSVG()], { type: 'image/svg+xml;charset=utf-8' }));
  });
  $('#mm-export-png').addEventListener('click', async () => {
    if (!state.current) return;
    try { download(`${state.current.title}-mindmap.png`, await state.mindmap.exportPNG(2)); } catch (err) { toast(err.message, true); }
  });

  // ------------------------------------------------------------- learning
  function statCard(value, label) {
    return `<div class="stat"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`;
  }
  function renderSetup(stats, h) {
    const support = sttSupport();
    const hints = [];
    if (LOCAL) {
      hints.push('<div class="hint">📱 <b>Đang chạy độc lập trên máy này</b>: không cần máy chủ, không cần AI. Muốn dùng thêm Whisper/LLM, mở mục "Máy chủ AI (tùy chọn)" ở đầu trang.</div>');
      if (!support.provider) hints.push('<div class="hint">🎙 <b>Máy này không có nhận dạng giọng nói.</b> Bạn vẫn dán văn bản để tóm tắt và vẽ sơ đồ tư duy được.</div>');
    } else {
      if (!h.whisper.available) {
        hints.push(support.provider
          ? '<div class="hint">🎙 <b>Giọng nói đang được chuyển thành văn bản ngay khi nói</b> bằng nhận dạng của trình duyệt/thiết bị. Muốn nhận dạng offline từ file ghi âm: <code>pip install faster-whisper</code> rồi khởi động lại (tùy chọn).</div>'
          : '<div class="hint">🎙 <b>Trình duyệt này không có nhận dạng giọng nói.</b> Hãy dùng Chrome/Edge/Safari, dán văn bản, hoặc cài <code>pip install faster-whisper</code> trên máy chủ.</div>');
      }
      if (!h.ollama.available) {
        hints.push(`<div class="hint">🧩 <b>Đang tóm tắt bằng thuật toán, không cần AI.</b> Muốn dùng LLM local (tùy chọn): cài Ollama tại <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a> (${esc(h.ollama.url)}), rồi chạy <code>ollama pull ${esc(h.ollama.model)}</code> và <code>ollama pull ${esc(h.ollama.embed_model)}</code>.</div>`);
      } else {
        if (!h.ollama.model_ready) hints.push(`<div class="hint">🤖 Ollama đang chạy nhưng thiếu model LLM. Chạy: <code>ollama pull ${esc(h.ollama.model)}</code> (hoặc đổi OLLAMA_MODEL sang một model đã có: ${esc(h.ollama.models.join(', ') || 'chưa có')}).</div>`);
        if (!h.ollama.embed_ready) hints.push(`<div class="hint">🧠 Thiếu model nhúng để tìm trí nhớ theo ngữ nghĩa. Chạy: <code>ollama pull ${esc(h.ollama.embed_model)}</code> rồi nhấn "Nhúng lại trí nhớ".</div>`);
      }
    }
    const styleHints = (stats.style_hints || []).map((s) => `<li>${esc(s)}</li>`).join('');
    const head = LOCAL
      ? `<p>Cách tóm tắt hiện tại: <b>${esc(engineLabel(stats.engine))}</b></p>`
      : `<p>Cách tóm tắt hiện tại: <b>${esc(engineLabel(stats.engine))}</b> · Tìm trong trí nhớ bằng: <b>${esc(stats.memory.embedder)}</b></p>`;
    $('#ai-setup').innerHTML = head + (styleHints ? `<p>Phong cách đã học từ bạn:</p><ul>${styleHints}</ul>` : '') + hints.join('');
  }
  async function loadLearning() {
    try {
      const [stats, glossary, events] = await Promise.all([
        api.get('/api/learning/stats'), api.get('/api/glossary'), api.get('/api/learning/events?limit=60'),
      ]);
      const cards = [
        statCard(stats.analyzed, 'bản ghi đã tóm tắt'),
        statCard(stats.memory.meetings + stats.memory.chunks, LOCAL ? 'đoạn tìm lại được' : 'mảnh trí nhớ'),
      ];
      if (!LOCAL) cards.push(statCard(stats.memory.examples, 'ví dụ mẫu đã học'));
      cards.push(
        statCard(`${stats.glossary.active}/${stats.glossary.total}`, 'thuật ngữ đang áp dụng'),
        statCard(stats.glossary.hits, 'lần tự sửa văn bản'),
        statCard(stats.feedback.edits, 'lần học từ chỉnh sửa'),
        statCard(stats.feedback.avg_rating != null ? `${stats.feedback.avg_rating}★` : '–', `đánh giá TB (${stats.feedback.ratings})`),
      );
      $('#stats').innerHTML = cards.join('');
      const h = state.health || await api.get('/api/health');
      renderSetup(stats, h);
      const tbody = $('#glossary-table tbody');
      tbody.innerHTML = '';
      if (!glossary.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">Chưa có thuật ngữ nào.</td></tr>';
      for (const g of glossary) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td></td><td></td><td>${g.source === 'user' ? 'bạn thêm' : 'tự suy ra'}</td><td>${esc(g.count)} (dùng ${esc(g.hits)})</td><td>${g.active ? '✅' : '⏳'}</td><td><button class="icon-btn" title="Xóa thuật ngữ" aria-label="Xóa thuật ngữ">✕</button></td>`;
        tr.children[0].textContent = g.term;
        tr.children[1].textContent = g.variant || '—';
        tr.querySelector('button').addEventListener('click', async () => {
          try { await api.del(`/api/glossary/${g.id}`); loadLearning(); } catch (err) { toast(err.message, true); }
        });
        tbody.appendChild(tr);
      }
      const ul = $('#events');
      ul.innerHTML = events.length ? '' : '<li class="muted">Chưa có gì được học. Hãy xử lý một cuộc họp và sửa kết quả!</li>';
      for (const e of events) {
        const li = document.createElement('li');
        li.innerHTML = `<time>${esc(fmtDate(e.created_at))}</time><span class="kind ${esc(e.kind)}">${esc(e.kind)}</span><span></span>`;
        li.children[2].textContent = e.detail;
        ul.appendChild(li);
      }
    } catch (err) { toast(err.message, true); }
  }
  $('#glossary-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/glossary', { term: $('#glossary-term').value.trim(), variant: $('#glossary-variant').value.trim() });
      $('#glossary-term').value = ''; $('#glossary-variant').value = '';
      toast('Đã thêm thuật ngữ'); loadLearning();
    } catch (err) { toast(err.message, true); }
  });
  $('#ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#ask-input').value.trim();
    if (!q) return;
    const box = $('#ask-answer');
    box.hidden = false; box.textContent = 'Đang tìm trong các bản ghi…';
    try {
      const r = await api.post('/api/learning/ask', { question: q });
      box.textContent = r.answer;
      const ul = $('#ask-sources');
      ul.innerHTML = '';
      for (const s of r.sources) {
        const li = document.createElement('li');
        const p = s.payload || {};
        li.innerHTML = `<span class="src-title"></span> <span class="muted">(${esc((p.date || '').slice(0, 10))}, độ liên quan ${Math.round(s.score * 100)}%)</span><br><span class="muted"></span>`;
        li.querySelector('.src-title').textContent = p.title || s.kind;
        li.querySelectorAll('.muted')[1].textContent = s.text.slice(0, 220) + (s.text.length > 220 ? '…' : '');
        li.querySelector('.src-title').style.cursor = 'pointer';
        li.querySelector('.src-title').addEventListener('click', () => { if (s.meeting_id) openMeeting(s.meeting_id); });
        ul.appendChild(li);
      }
    } catch (err) { box.textContent = `Lỗi: ${err.message}`; }
  });
  $('#btn-reindex').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/learning/reindex');
      $('#learning-msg').textContent = `Đã nhúng lại ${r.updated} mảnh bằng ${r.embedder}.`;
      loadLearning();
    } catch (err) { toast(err.message, true); }
  });

  // Đóng/tải lại trang khi đang ghi âm hoặc còn bản ghi chưa gửi: hỏi lại để không mất bản ghi
  window.addEventListener('beforeunload', (e) => {
    if (isRecording() || rec.stopping || state.capture) { e.preventDefault(); e.returnValue = ''; }
  });

  // ----------------------------------------------------------------- init
  setupServerBox();
  $('#link-export-jsonl').href = apiUrl('/api/learning/export');
  // xuất JSONL và nhúng lại trí nhớ là việc của máy chủ AI: chế độ độc lập không có
  $('#link-export-jsonl').hidden = LOCAL;
  $('#btn-reindex').hidden = LOCAL;
  $('#live-captions').checked = true;   // mặc định cho tới khi biết máy chủ có Whisper hay không
  renderSttLine();
  refreshFileSupport();
  loadHealth();
  loadMeetings().catch((err) => toast(err.message, true));
  if (!LOCAL) setInterval(loadHealth, 30000);
})();
