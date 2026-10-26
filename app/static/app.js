/* Logic ứng dụng Mic to Mindmap (không phụ thuộc thư viện ngoài). */
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ------------------------------------------------------------------ API
  // Bản di động (Capacitor) gọi tới máy chủ AI trong mạng LAN; bản web dùng cùng origin.
  const IS_MOBILE = !!window.M2M_MOBILE;
  let API_BASE = '';
  try { API_BASE = IS_MOBILE ? (localStorage.getItem('m2m.server') || '') : ''; } catch (_) { API_BASE = ''; }
  API_BASE = API_BASE.replace(/\/+$/, '');
  function apiUrl(path) { return path.startsWith('/') ? API_BASE + path : path; }

  async function request(method, url, body, isForm) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      if (isForm) options.body = body;
      else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    }
    let resp;
    try {
      resp = await fetch(apiUrl(url), options);
    } catch (err) {
      throw new Error(IS_MOBILE ? `Không kết nối được máy chủ ${API_BASE || '(chưa cấu hình)'}: ${err.message}` : `Không kết nối được server: ${err.message}`);
    }
    if (resp.status === 204) return null;
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!resp.ok) {
      const detail = data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : resp.statusText;
      throw new Error(detail || `Lỗi ${resp.status}`);
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
  const state = {
    meetings: [], current: null, health: null, blob: null, blobExt: 'webm', duration: 0,
    liveTranscript: '', pollTimer: null, rating: 0, mindmap: null,
  };

  // ---------------------------------------------------------------- utils
  let toastTimer = null;
  function toast(message, isError) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3200);
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
      transcribed: 'Đã có transcript', analyzing: 'Đang tóm tắt & vẽ mind map', done: 'Hoàn tất', error: 'Lỗi' })[status] || status;
  }
  function statusClass(status) {
    if (status === 'done') return 'done';
    if (status === 'error') return 'error';
    if (['queued', 'transcribing', 'analyzing'].includes(status)) return 'working';
    return '';
  }

  // ----------------------------------------------------------------- tabs
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (name === 'learning') loadLearning();
    if (name === 'result' && state.mindmap && state.current) state.mindmap.fit();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // --------------------------------------------------------------- health
  async function loadHealth() {
    try {
      const h = await api.get('/api/health');
      state.health = h;
      const w = $('#badge-whisper'), o = $('#badge-ollama'), m = $('#badge-memory');
      w.className = `badge ${h.whisper.available ? 'ok' : 'off'}`;
      w.textContent = h.whisper.available ? `Whisper: ${h.whisper.model}` : 'Whisper: chưa cài';
      if (h.ollama.available && h.ollama.model_ready) {
        o.className = 'badge ok'; o.textContent = `LLM: ${h.ollama.model}`;
      } else if (h.ollama.available) {
        o.className = 'badge off'; o.textContent = `LLM: thiếu model ${h.ollama.model}`;
      } else {
        o.className = 'badge off'; o.textContent = 'LLM: heuristic (chưa có Ollama)';
      }
      m.className = 'badge ok'; m.textContent = `Trí nhớ: ${h.embedder}`;
    } catch (err) {
      state.health = null;
      $('#badge-whisper').className = 'badge off'; $('#badge-whisper').textContent = 'Whisper: ?';
      $('#badge-ollama').className = 'badge off'; $('#badge-ollama').textContent = IS_MOBILE ? 'Chưa kết nối máy chủ' : 'Không kết nối được server';
      $('#badge-memory').className = 'badge off'; $('#badge-memory').textContent = 'Trí nhớ: ?';
      if (IS_MOBILE) $('#server-box').classList.add('warn');
    }
  }
  function setupServerBox() {
    const box = $('#server-box');
    if (!IS_MOBILE) return;
    box.hidden = false;
    $('#server-url').value = API_BASE;
    $('#btn-server-save').addEventListener('click', () => {
      let value = $('#server-url').value.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\//i.test(value)) value = `http://${value}`;
      try { localStorage.setItem('m2m.server', value); } catch (_) {}
      location.reload();
    });
  }

  // ------------------------------------------------------------- meetings
  async function loadMeetings() {
    const q = $('#search-meetings').value.trim();
    state.meetings = await api.get(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const list = $('#meeting-list');
    list.innerHTML = '';
    if (!state.meetings.length) {
      list.innerHTML = '<li class="muted small" style="cursor:default">Chưa có cuộc họp nào.</li>';
      return;
    }
    for (const m of state.meetings) {
      const li = document.createElement('li');
      li.className = state.current && state.current.id === m.id ? 'active' : '';
      li.innerHTML = `<span class="title"></span><span class="sub"><span>${fmtDate(m.created_at)}</span><span class="status-pill ${statusClass(m.status)}">${statusLabel(m.status)}</span></span>`;
      li.querySelector('.title').textContent = m.title;
      li.addEventListener('click', () => openMeeting(m.id));
      list.appendChild(li);
    }
  }
  $('#search-meetings').addEventListener('input', () => loadMeetings().catch(() => {}));

  async function openMeeting(id) {
    try {
      const m = await api.get(`/api/meetings/${id}`);
      renderMeeting(m);
      showTab('result');
      loadMeetings();
      if (['queued', 'transcribing', 'analyzing'].includes(m.status) || m.processing) startPolling(id);
    } catch (err) { toast(err.message, true); }
  }

  $('#btn-new-meeting').addEventListener('click', () => {
    state.current = null;
    if (rec.recorder) cancelRecording();
    discardRecording();
    $('#meeting-title').value = '';
    $('#meeting-participants').value = '';
    showTab('record');
    loadMeetings();
    $('#meeting-title').focus();
  });

  // ------------------------------------------------------------ recording
  const rec = { recorder: null, stream: null, chunks: [], ctx: null, analyser: null, raf: null, timer: null,
    startedAt: 0, accumulated: 0, paused: false, recognition: null, mime: '', discard: false };

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
    const data = new Uint8Array(rec.analyser.frequencyBinCount);
    const draw = () => {
      rec.raf = requestAnimationFrame(draw);
      rec.analyser.getByteFrequencyData(data);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 48, step = Math.floor(data.length / bars);
      for (let i = 0; i < bars; i++) {
        const v = data[i * step] / 255;
        const h = Math.max(2, v * canvas.height);
        ctx2d.fillStyle = rec.paused ? '#d1d5db' : `hsl(${240 - v * 120}, 70%, 55%)`;
        ctx2d.fillRect(i * (canvas.width / bars) + 1, canvas.height - h, canvas.width / bars - 2, h);
      }
    };
    draw();
  }
  function startRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Trình duyệt này không hỗ trợ phụ đề trực tiếp', true); return; }
    const box = $('#live-transcript');
    box.hidden = false;
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = $('#meeting-language').value === 'en' ? 'en-US' : 'vi-VN';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) state.liveTranscript += `${r[0].transcript.trim()}. `;
        else interim += r[0].transcript;
      }
      box.innerHTML = '';
      box.append(document.createTextNode(state.liveTranscript));
      const span = document.createElement('span'); span.className = 'interim'; span.textContent = interim;
      box.appendChild(span);
      box.scrollTop = box.scrollHeight;
    };
    recognition.onend = () => { if (rec.recorder && rec.recorder.state === 'recording') { try { recognition.start(); } catch (_) {} } };
    recognition.onerror = () => {};
    try { recognition.start(); } catch (_) {}
    rec.recognition = recognition;
  }
  function stopRecognition() {
    if (rec.recognition) { const r = rec.recognition; rec.recognition = null; try { r.onend = null; r.stop(); } catch (_) {} }
  }
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Trình duyệt không hỗ trợ ghi âm (cần HTTPS hoặc localhost)', true); return;
    }
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) { toast(`Không truy cập được micro: ${err.message}`, true); return; }
    rec.mime = pickMime();
    rec.chunks = [];
    rec.recorder = new MediaRecorder(rec.stream, rec.mime ? { mimeType: rec.mime } : undefined);
    rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.recorder.onstop = finishRecording;
    rec.recorder.start(1000);
    rec.accumulated = 0; rec.startedAt = Date.now(); rec.paused = false;
    state.liveTranscript = '';
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
    rec.analyser = rec.ctx.createAnalyser();
    rec.analyser.fftSize = 256;
    rec.ctx.createMediaStreamSource(rec.stream).connect(rec.analyser);
    drawMeter();
    rec.timer = setInterval(() => { $('#rec-timer').textContent = fmtTime(elapsed()); }, 250);
    if ($('#live-captions').checked) startRecognition();
    $('#btn-record').classList.add('recording');
    $('#btn-pause').disabled = false; $('#btn-stop').disabled = false;
    $('#rec-state').textContent = 'Đang ghi âm…';
    $('#preview').hidden = true;
  }
  function togglePause() {
    if (!rec.recorder) return;
    if (rec.recorder.state === 'recording') {
      stopRecognition();
      rec.recorder.pause(); rec.accumulated = elapsed(); rec.paused = true; rec.startedAt = 0;
      $('#btn-pause').textContent = '▶ Tiếp tục'; $('#rec-state').textContent = 'Tạm dừng';
      $('#btn-record').classList.add('paused');
    } else if (rec.recorder.state === 'paused') {
      rec.recorder.resume(); rec.paused = false; rec.startedAt = Date.now();
      if ($('#live-captions').checked) startRecognition();
      $('#btn-pause').textContent = '⏸ Tạm dừng'; $('#rec-state').textContent = 'Đang ghi âm…';
      $('#btn-record').classList.remove('paused');
    }
  }
  function stopRecording() {
    if (!rec.recorder) return;
    state.duration = elapsed();
    stopRecognition();
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(rec.raf); clearInterval(rec.timer);
    if (rec.ctx) { rec.ctx.close().catch(() => {}); rec.ctx = null; }
    $('#btn-record').classList.remove('recording', 'paused');
    $('#btn-pause').disabled = true; $('#btn-stop').disabled = true; $('#btn-pause').textContent = '⏸ Tạm dừng';
    $('#rec-state').textContent = 'Đã dừng. Nghe lại bên dưới rồi nhấn "Xử lý bằng AI".';
  }
  function cancelRecording() {
    rec.discard = true;
    stopRecording();
  }
  function finishRecording() {
    const blob = new Blob(rec.chunks, { type: rec.mime || 'audio/webm' });
    rec.recorder = null;
    if (rec.discard) { rec.discard = false; rec.chunks = []; return; }
    if (!blob.size) { toast('Bản ghi trống', true); return; }
    setBlob(blob, extForMime(blob.type), state.duration);
  }
  function setBlob(blob, ext, duration) {
    state.blob = blob; state.blobExt = ext; state.duration = duration || 0;
    const audio = $('#audio-preview');
    audio.src = URL.createObjectURL(blob);
    $('#preview').hidden = false;
    $('#preview-info').textContent = `${(blob.size / 1024 / 1024).toFixed(2)} MB${duration ? ` · ${fmtTime(duration)}` : ''}`;
    audio.onloadedmetadata = () => { if (isFinite(audio.duration) && audio.duration > 0) state.duration = audio.duration; };
  }
  function discardRecording() {
    state.blob = null; state.liveTranscript = ''; state.duration = 0;
    $('#preview').hidden = true; $('#audio-preview').removeAttribute('src');
    $('#live-transcript').hidden = true; $('#live-transcript').textContent = '';
    $('#rec-timer').textContent = '00:00'; $('#rec-state').textContent = 'Sẵn sàng. Nhấn nút đỏ để bắt đầu.';
    $('#audio-file').value = '';
  }
  $('#btn-record').addEventListener('click', () => {
    if (rec.recorder) stopRecording(); else startRecording();
  });
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-stop').addEventListener('click', stopRecording);
  $('#btn-discard').addEventListener('click', discardRecording);
  $('#audio-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = (file.name.split('.').pop() || 'webm').toLowerCase();
    setBlob(file, ext, 0);
    $('#rec-state').textContent = `Đã chọn file: ${file.name}`;
    if (!$('#meeting-title').value) $('#meeting-title').value = file.name.replace(/\.[^.]+$/, '');
  });

  // ----------------------------------------------------------- processing
  function meetingPayload() {
    return {
      title: $('#meeting-title').value.trim(),
      participants: $('#meeting-participants').value.split(',').map((s) => s.trim()).filter(Boolean),
      language: $('#meeting-language').value || 'auto',
    };
  }
  function setProgress(text) {
    $('#progress').hidden = !text;
    $('#progress-text').textContent = text || '';
    $('#btn-process').disabled = !!text;
    $('#btn-analyze-text').disabled = !!text;
  }
  async function processRecording() {
    if (!state.blob) { toast('Chưa có bản ghi âm', true); return; }
    try {
      setProgress('Đang tạo cuộc họp…');
      const meeting = await api.post('/api/meetings', meetingPayload());
      setProgress('Đang tải âm thanh lên…');
      const form = new FormData();
      form.append('audio', state.blob, `recording.${state.blobExt}`);
      if (state.duration) form.append('duration_sec', String(state.duration));
      if (state.liveTranscript.trim()) form.append('live_transcript', state.liveTranscript.trim());
      await api.upload(`/api/meetings/${meeting.id}/audio`, form);
      await api.post(`/api/meetings/${meeting.id}/process`, { transcribe: true });
      setProgress('Đang xử lý…');
      await loadMeetings();
      startPolling(meeting.id, true);
    } catch (err) { setProgress(''); toast(err.message, true); }
  }
  async function analyzeText() {
    const text = $('#manual-transcript').value.trim();
    if (!text) { toast('Hãy dán transcript trước', true); return; }
    try {
      setProgress('Đang tạo cuộc họp…');
      const meeting = await api.post('/api/meetings', meetingPayload());
      await api.put(`/api/meetings/${meeting.id}/transcript`, { transcript: text });
      await api.post(`/api/meetings/${meeting.id}/process`, { transcribe: false });
      setProgress('Đang tóm tắt…');
      await loadMeetings();
      startPolling(meeting.id, true);
    } catch (err) { setProgress(''); toast(err.message, true); }
  }
  $('#btn-process').addEventListener('click', processRecording);
  $('#btn-analyze-text').addEventListener('click', analyzeText);

  function startPolling(id, fromRecorder) {
    clearInterval(state.pollTimer);
    const tick = async () => {
      let m;
      try { m = await api.get(`/api/meetings/${id}`); } catch (err) { clearInterval(state.pollTimer); setProgress(''); toast(err.message, true); return; }
      const working = ['queued', 'transcribing', 'analyzing'].includes(m.status) || m.processing;
      if (fromRecorder) setProgress(working ? `${statusLabel(m.status)}…` : '');
      if (state.current && state.current.id === id) renderStatus(m);
      if (!working) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        loadMeetings();
        if (fromRecorder) { discardRecording(); $('#manual-transcript').value = ''; }
        if (!fromRecorder && state.current && state.current.id !== id) {
          toast(m.status === 'error' ? `Cuộc họp "${m.title}" xử lý lỗi: ${m.error}` : `Cuộc họp "${m.title}" đã xử lý xong`, m.status === 'error');
          return;
        }
        renderMeeting(m);
        showTab('result');
        if (m.status === 'error') toast(`Xử lý lỗi: ${m.error}`, true);
        else toast(`Xong! Engine: ${m.engine || (m.analysis && m.analysis.engine) || ''}`);
      }
    };
    tick();
    state.pollTimer = setInterval(tick, 1500);
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
    tr.innerHTML = '<td><input type="text" class="a-task"></td><td><input type="text" class="a-owner"></td><td><input type="text" class="a-due"></td><td><button class="icon-btn" title="Xóa">✕</button></td>';
    tr.querySelector('.a-task').value = item.task || '';
    tr.querySelector('.a-owner').value = item.owner || '';
    tr.querySelector('.a-due').value = item.due || '';
    tr.querySelector('button').addEventListener('click', () => tr.remove());
    return tr;
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
    if (a.engine) metaParts.push(`⚙ ${a.engine}${a.edited ? ' (đã sửa)' : ''}`);
    if (a.context_used) metaParts.push(`🧠 bối cảnh: ${ctx.glossary_terms || 0} thuật ngữ, ${ctx.past_meetings || 0} họp trước, ${ctx.examples || 0} ví dụ`);
    $('#result-meta').textContent = metaParts.join('  ·  ');
    renderStatus(m);
    $('#edit-summary').value = (a.summary || []).map((s) => `- ${s}`).join('\n');
    $('#edit-decisions').value = (a.decisions || []).map((s) => `- ${s}`).join('\n');
    const tbody = $('#actions-table tbody');
    tbody.innerHTML = '';
    (a.action_items || []).forEach((item) => tbody.appendChild(actionRow(item)));
    $('#edit-keywords').value = (a.keywords || []).join(', ');
    $('#edit-transcript').value = m.transcript || '';
    $('#transcript-source').textContent = m.transcript_source ? `(nguồn: ${m.transcript_source})` : '';
    const audio = $('#result-audio');
    if (m.has_audio) { audio.hidden = false; audio.src = apiUrl(`/api/meetings/${m.id}/audio?t=${Date.now()}`); } else { audio.hidden = true; audio.removeAttribute('src'); }
    $('#btn-export-md').href = apiUrl(`/api/meetings/${m.id}/export.md`);
    $('#btn-export-md').download = `${m.title}.md`;
    state.mindmap.setTree(a.mindmap || { title: m.title, children: [] });
    state.rating = 0; renderStars();
    $('#rating-comment').value = ''; $('#rating-msg').textContent = ''; $('#save-analysis-msg').textContent = ''; $('#save-transcript-msg').textContent = '';
  }
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
      $('#save-analysis-msg').textContent = learned ? 'Đã lưu. AI đã ghi nhận bản sửa này làm ví dụ mẫu.' : 'Đã lưu (không có thay đổi).';
      toast(learned ? 'Đã lưu và học từ chỉnh sửa của bạn' : 'Đã lưu');
    } catch (err) { toast(err.message, true); }
  });
  $('#result-title').addEventListener('change', async () => {
    if (!state.current) return;
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
        : 'Đã lưu transcript.';
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
    if (!state.current || !confirm(`Xóa cuộc họp "${state.current.title}"? Trí nhớ liên quan cũng bị xóa.`)) return;
    try {
      await api.del(`/api/meetings/${state.current.id}`);
      state.current = null;
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
  state.mindmap = new MindMap($('#mindmap'), { onChange: () => { $('#save-analysis-msg').textContent = 'Mind map có thay đổi chưa lưu.'; } });
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
    return `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  }
  async function loadLearning() {
    try {
      const [stats, glossary, events] = await Promise.all([
        api.get('/api/learning/stats'), api.get('/api/glossary'), api.get('/api/learning/events?limit=60'),
      ]);
      $('#stats').innerHTML = [
        statCard(stats.analyzed, 'cuộc họp đã phân tích'),
        statCard(stats.memory.meetings + stats.memory.chunks, 'mảnh trí nhớ'),
        statCard(stats.memory.examples, 'ví dụ mẫu đã học'),
        statCard(`${stats.glossary.active}/${stats.glossary.total}`, 'thuật ngữ đang áp dụng'),
        statCard(stats.glossary.hits, 'lần tự sửa transcript'),
        statCard(stats.feedback.edits, 'lần học từ chỉnh sửa'),
        statCard(stats.feedback.avg_rating != null ? `${stats.feedback.avg_rating}★` : '–', `đánh giá TB (${stats.feedback.ratings})`),
      ].join('');
      const h = state.health || await api.get('/api/health');
      const hints = [];
      if (!h.whisper.available) hints.push('<div class="hint">🎧 <b>Chưa có nhận dạng giọng nói offline.</b> Cài: <code>pip install faster-whisper</code> rồi khởi động lại. Model được tải lần đầu (WHISPER_MODEL=small ≈ 500MB). Tạm thời bạn có thể bật "Phụ đề trực tiếp" khi ghi âm hoặc dán transcript thủ công.</div>');
      if (!h.ollama.available) hints.push(`<div class="hint">🤖 <b>Chưa kết nối được Ollama</b> (${h.ollama.url}) nên đang dùng tóm tắt heuristic. Cài Ollama tại <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>, rồi chạy <code>ollama pull ${h.ollama.model}</code> và <code>ollama pull ${h.ollama.embed_model}</code>.</div>`);
      else {
        if (!h.ollama.model_ready) hints.push(`<div class="hint">🤖 Ollama đang chạy nhưng thiếu model LLM. Chạy: <code>ollama pull ${h.ollama.model}</code> (hoặc đổi OLLAMA_MODEL sang một model đã có: ${h.ollama.models.join(', ') || 'chưa có'}).</div>`);
        if (!h.ollama.embed_ready) hints.push(`<div class="hint">🧠 Thiếu model nhúng để tìm trí nhớ theo ngữ nghĩa. Chạy: <code>ollama pull ${h.ollama.embed_model}</code> rồi nhấn "Nhúng lại trí nhớ".</div>`);
      }
      const styleHints = (stats.style_hints || []).map((s) => `<li>${s}</li>`).join('');
      $('#ai-setup').innerHTML = `<p>Engine tóm tắt hiện tại: <b>${stats.engine}</b> · Nhúng: <b>${stats.memory.embedder}</b></p>` +
        (styleHints ? `<p>Phong cách đã học từ bạn:</p><ul>${styleHints}</ul>` : '') + hints.join('');
      const tbody = $('#glossary-table tbody');
      tbody.innerHTML = '';
      if (!glossary.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">Chưa có thuật ngữ nào.</td></tr>';
      for (const g of glossary) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td></td><td></td><td>${g.source === 'user' ? 'bạn thêm' : 'AI suy ra'}</td><td>${g.count} (dùng ${g.hits})</td><td>${g.active ? '✅' : '⏳'}</td><td><button class="icon-btn" title="Xóa">✕</button></td>`;
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
        li.innerHTML = `<time>${fmtDate(e.created_at)}</time><span class="kind ${e.kind}">${e.kind}</span><span></span>`;
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
    box.hidden = false; box.textContent = 'Đang tìm trong trí nhớ…';
    try {
      const r = await api.post('/api/learning/ask', { question: q });
      box.textContent = r.answer;
      const ul = $('#ask-sources');
      ul.innerHTML = '';
      for (const s of r.sources) {
        const li = document.createElement('li');
        const p = s.payload || {};
        li.innerHTML = `<span class="src-title"></span> <span class="muted">(${(p.date || '').slice(0, 10)}, độ liên quan ${Math.round(s.score * 100)}%)</span><br><span class="muted"></span>`;
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

  // ----------------------------------------------------------------- init
  setupServerBox();
  $('#link-export-jsonl').href = apiUrl('/api/learning/export');
  loadHealth();
  loadMeetings().catch((err) => toast(err.message, true));
  setInterval(loadHealth, 30000);
})();
