/* Chế độ ĐỘC LẬP: toàn bộ dữ liệu và xử lý nằm ngay trên máy này, không cần máy chủ, không cần AI.

   - Lưu trữ: IndexedDB của trình duyệt/ứng dụng (cuộc họp, âm thanh, thuật ngữ, đánh giá, nhật ký).
   - Xử lý: bộ máy engine.js (tóm tắt, việc cần làm, sơ đồ tư duy), sửa thuật ngữ đã học, tìm lại trong các bản ghi cũ.

   Lớp này trả lời đúng các đường API mà giao diện vẫn gọi tới máy chủ (/api/meetings, /api/glossary, ...) với cùng
   hình dạng dữ liệu, nên app.js không cần biết mình đang nói chuyện với máy chủ hay với chính thiết bị. */
(function (root) {
  'use strict';
  const engine = root.M2MEngine;
  const DB_NAME = 'mic-to-mindmap';
  const DB_VERSION = 1;
  const STORES = ['meetings', 'audio', 'glossary', 'feedback', 'events', 'prefs'];
  const CORRECTION_THRESHOLD = 2;     // số lần một cặp sửa lỗi suy ra phải lặp lại trước khi tự áp dụng
  const MAX_SPAN = 4;
  const MAX_CHANGE_RATIO = 0.35;      // sửa quá tỉ lệ này là viết lại, không phải sửa lỗi nhận dạng
  const CHUNK_CHARS = 700;
  const MAX_EVENTS = 500;

  function apiError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }
  function nowIso() {
    return new Date().toISOString();
  }
  function newId() {
    const bytes = new Uint8Array(6);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  }
  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function text(value) {
    return typeof value === 'string' ? engine.nfc(value) : '';
  }

  // ------------------------------------------------------------- kho dữ liệu
  /* Kho trong bộ nhớ: dùng khi trình duyệt không cho IndexedDB (chế độ riêng tư, bị tắt). Dữ liệu mất khi đóng trang. */
  function memoryStore() {
    const tables = {};
    const counters = {};
    for (const name of STORES) { tables[name] = new Map(); counters[name] = 0; }
    return {
      kind: 'memory',
      get: (store, key) => Promise.resolve(tables[store].get(key)),
      all: (store) => Promise.resolve(Array.from(tables[store].values())),
      put(store, value, keyField) {
        const field = keyField || 'id';
        if (value[field] === undefined) value[field] = ++counters[store];
        tables[store].set(value[field], value);
        return Promise.resolve(value[field]);
      },
      del: (store, key) => { tables[store].delete(key); return Promise.resolve(); },
    };
  }
  function idbStore() {
    let opening = null;
    function open() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const request = root.indexedDB.open(DB_NAME, DB_VERSION);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
            for (const name of ['glossary', 'feedback', 'events']) {
              if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            // tab khác nâng cấp cấu trúc: nhả kết nối để không chặn, lần gọi sau sẽ mở lại
            db.onversionchange = () => { db.close(); opening = null; };
            resolve(db);
          };
          request.onerror = () => reject(request.error || new Error('Không mở được kho dữ liệu trên máy'));
          request.onblocked = () => reject(new Error('Kho dữ liệu đang bị một tab khác giữ'));
        });
        opening.catch(() => { opening = null; });
      }
      return opening;
    }
    function run(store, mode, work) {
      return open().then((db) => new Promise((resolve, reject) => {
        let result;
        const tx = db.transaction(store, mode);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('Lỗi kho dữ liệu'));
        tx.onabort = () => reject(tx.error || new Error('Không ghi được (có thể máy đã hết dung lượng)'));
        const request = work(tx.objectStore(store));
        if (request) request.onsuccess = () => { result = request.result; };
      }));
    }
    return {
      kind: 'indexeddb',
      ready: () => open(),
      get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
      all: (store) => run(store, 'readonly', (s) => s.getAll()),
      put: (store, value) => run(store, 'readwrite', (s) => s.put(value)).then((key) => {
        if (value.id === undefined && store !== 'prefs') value.id = key;
        return key;
      }),
      del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    };
  }
  let store = null;
  function db() {
    if (!store) {
      let usable = false;
      try { usable = !!root.indexedDB && typeof root.indexedDB.open === 'function'; } catch (_) { usable = false; }
      store = usable ? idbStore() : memoryStore();
      if (usable) {
        // xin trình duyệt đừng tự dọn dữ liệu của ứng dụng khi máy thiếu dung lượng
        try { if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist().catch(() => {}); } catch (_) { /* không bắt buộc */ }
      }
    }
    return store;
  }
  /* Gọi kho. Trình duyệt không cho mở IndexedDB (chế độ riêng tư, bị tắt) thì chuyển sang kho trong bộ nhớ để ứng dụng
     vẫn chạy; lỗi của một thao tác cụ thể (hết dung lượng...) thì báo ra cho người dùng. */
  function io(op) {
    const current = db();
    if (current.kind !== 'indexeddb') return op(current);
    return current.ready().then(() => op(current), () => {
      if (store === current) store = memoryStore();
      return op(store);
    });
  }
  const get = (name, key) => io((s) => s.get(name, key));
  const all = (name) => io((s) => s.all(name));
  const put = (name, value, keyField) => io((s) => s.put(name, value, keyField));
  const del = (name, key) => io((s) => s.del(name, key));

  async function getPref(key, fallback) {
    const row = await get('prefs', key);
    return row && row.value !== undefined ? row.value : fallback;
  }
  function setPref(key, value) {
    return put('prefs', { key, value, updated_at: nowIso() }, 'key');
  }
  async function logEvent(kind, detail, meetingId) {
    await put('events', { kind, detail, meeting_id: meetingId || null, created_at: nowIso() });
    const events = await all('events');
    if (events.length > MAX_EVENTS) {
      events.sort((a, b) => a.id - b.id);
      for (const old of events.slice(0, events.length - MAX_EVENTS)) await del('events', old.id);
    }
  }

  // ----------------------------------------------------------------- cuộc họp
  function publicMeeting(m, includeText) {
    const out = {
      id: m.id, title: m.title, participants: m.participants || [], language: m.language, status: m.status,
      error: m.error || null, duration_sec: m.duration_sec || null, transcript_source: m.transcript_source || null,
      engine: m.engine || null, created_at: m.created_at, updated_at: m.updated_at, has_audio: !!m.has_audio,
      audio_mime: m.audio_mime || null,
    };
    if (includeText) {
      out.transcript = m.transcript || '';
      out.segments = [];
      out.analysis = m.analysis || null;
      out.processing = false;
    } else {
      out.transcript_preview = (m.transcript || '').slice(0, 160);
      out.summary_preview = (m.analysis && m.analysis.summary && m.analysis.summary[0]) || '';
    }
    return out;
  }
  async function meetingOr404(id) {
    const m = await get('meetings', id);
    if (!m) throw apiError(404, 'Không tìm thấy cuộc họp');
    return m;
  }
  function saveMeeting(m) {
    m.updated_at = nowIso();
    return put('meetings', m);
  }
  function cleanList(value) {
    return (Array.isArray(value) ? value : []).filter((p) => typeof p === 'string').map((p) => engine.nfc(p).trim()).filter(Boolean);
  }
  function cleanLanguage(value) {
    const lang = String(value || '').trim().toLowerCase();
    return lang || 'vi';
  }
  async function listMeetings(query) {
    const q = engine.nfc(query || '').trim().toLowerCase();
    let meetings = await all('meetings');
    if (q) {
      meetings = meetings.filter((m) => (m.title || '').toLowerCase().includes(q) || (m.transcript || '').toLowerCase().includes(q)
        || JSON.stringify(m.analysis || '').toLowerCase().includes(q));
    }
    meetings.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.seq || 0) < (b.seq || 0) ? 1 : -1));
    return meetings.slice(0, 200).map((m) => publicMeeting(m, false));
  }
  let seq = Date.now();
  async function createMeeting(body) {
    const ts = nowIso();
    const meeting = {
      id: newId(), seq: seq++, title: Array.from(text(body.title).trim()).slice(0, 200).join('').trim() || 'Cuộc họp',
      participants: cleanList(body.participants), language: cleanLanguage(body.language), status: 'new', error: null,
      duration_sec: null, transcript: '', transcript_source: null, analysis: null, engine: null, has_audio: false,
      created_at: ts, updated_at: ts,
    };
    if (typeof body.duration_sec === 'number' && isFinite(body.duration_sec) && body.duration_sec > 0) meeting.duration_sec = body.duration_sec;
    await put('meetings', meeting);
    return publicMeeting(meeting, true);
  }
  async function updateMeeting(id, body) {
    const m = await meetingOr404(id);
    if (typeof body.title === 'string' && body.title.trim()) m.title = Array.from(engine.nfc(body.title).trim()).slice(0, 200).join('');
    if (Array.isArray(body.participants)) m.participants = cleanList(body.participants);
    if (body.language) m.language = cleanLanguage(body.language);
    await saveMeeting(m);
    return publicMeeting(m, true);
  }
  async function deleteMeeting(id) {
    await meetingOr404(id);
    await del('meetings', id);
    await del('audio', id);
    for (const row of await all('feedback')) if (row.meeting_id === id) await del('feedback', row.id);
    return null;
  }
  const TEXT_SOURCES = ['device', 'file', 'browser'];   // văn bản do thiết bị nhận dạng: lúc nói, từ file, trình duyệt
  async function uploadAudio(id, form) {
    const m = await meetingOr404(id);
    const blob = form.get('audio');
    if (!blob || !blob.size) throw apiError(400, 'File âm thanh rỗng');
    await put('audio', { id, blob, mime: blob.type || 'audio/webm' });
    m.has_audio = true;
    m.audio_mime = blob.type || 'audio/webm';
    m.status = 'recorded';
    const duration = Number(form.get('duration_sec'));
    if (isFinite(duration) && duration > 0 && duration < 30 * 24 * 3600) m.duration_sec = duration;
    const live = form.get('live_transcript');
    if (typeof live === 'string' && live.trim()) {
      const source = form.get('transcript_source');
      m.transcript = engine.nfc(live).trim();
      m.transcript_source = TEXT_SOURCES.indexOf(source) >= 0 ? source : 'device';
    }
    await saveMeeting(m);
    return publicMeeting(m, true);
  }
  async function audioUrl(id) {
    const row = await get('audio', id);
    return row && row.blob ? URL.createObjectURL(row.blob) : '';
  }

  // ---------------------------------------------------------------- thuật ngữ
  const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*|[^\p{L}\p{N}_\s]/gu;
  const WORDY_RE = /\p{L}/u;
  const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
  function isActive(row) {
    return row.source === 'user' || Number(row.count) >= CORRECTION_THRESHOLD;
  }
  async function glossaryEntries() {
    const rows = await all('glossary');
    rows.sort((a, b) => ((a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1)) || (b.count - a.count)
      || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    return rows.map((row) => Object.assign({}, row, { active: isActive(row) }));
  }
  async function upsertGlossary(term, variant, source) {
    const rows = await all('glossary');
    const ts = nowIso();
    let row = rows.find((r) => r.term === term && r.variant === variant);
    if (row) {
      row.count = Number(row.count) + 1;
      if (source === 'user' || row.source === 'user') row.source = 'user';
      row.updated_at = ts;
    } else {
      row = { term, variant, source, count: 1, hits: 0, created_at: ts, updated_at: ts };
    }
    await put('glossary', row);
    return row;
  }
  async function addGlossary(body) {
    const term = Array.from(engine.normalizeWs(text(body.term))).slice(0, 120).join('');
    let variant = Array.from(engine.normalizeWs(text(body.variant))).slice(0, 120).join('');
    if (!term) throw apiError(400, 'Thuật ngữ không được để trống');
    if (variant.toLowerCase() === term.toLowerCase()) variant = '';
    const row = await upsertGlossary(term, variant, 'user');
    await logEvent('glossary', `Thêm thuật ngữ '${term}'` + (variant ? ` (sửa từ '${variant}')` : ''));
    return Object.assign({}, row, { active: true });
  }
  async function removeGlossary(id) {
    const key = Number(id);
    const row = isFinite(key) ? await get('glossary', key) : null;
    if (!row) throw apiError(404, 'Không tìm thấy thuật ngữ');
    await del('glossary', key);
    return null;
  }
  /* Thay mọi chỗ "dạng sai" (nguyên từ, không phân biệt hoa thường) bằng từ đúng. Trả về [văn bản, số chỗ đã sửa]. */
  function replaceWhole(haystack, variant, term) {
    const low = haystack.toLowerCase();
    const needle = variant.toLowerCase();
    if (!needle || low.length !== haystack.length) return [haystack, 0];
    let out = '';
    let from = 0;
    let hits = 0;
    for (;;) {
      const at = low.indexOf(needle, from);
      if (at < 0) break;
      const before = at > 0 ? haystack.charAt(at - 1) : '';
      const after = haystack.charAt(at + needle.length);
      if ((before && WORD_CHAR_RE.test(before)) || (after && WORD_CHAR_RE.test(after))) {
        out += haystack.slice(from, at + 1);
        from = at + 1;
        continue;
      }
      out += haystack.slice(from, at) + term;
      from = at + needle.length;
      hits += 1;
    }
    return [out + haystack.slice(from), hits];
  }
  async function applyGlossary(transcript) {
    if (!transcript) return [transcript, 0];
    const rows = (await all('glossary')).filter((r) => r.variant && isActive(r));
    rows.sort((a, b) => b.variant.length - a.variant.length);
    let applied = 0;
    for (const row of rows) {
      const result = replaceWhole(transcript, row.variant, row.term);
      if (result[1]) {
        transcript = result[0];
        applied += result[1];
        row.hits = Number(row.hits || 0) + 1;
        await put('glossary', row);
      }
    }
    return [transcript, applied];
  }
  /* So hai dãy từ (thuật toán Myers), trả về các đoạn bị thay: [[a1, a2, b1, b2], ...]. null nếu khác nhau quá nhiều. */
  function replacedSpans(a, b) {
    const n = a.length, m = b.length;
    const max = Math.min(n + m, 1500);
    const offset = max;
    const trace = [];
    let v = new Int32Array(2 * max + 2);
    let found = -1;
    for (let d = 0; d <= max && found < 0; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) return null;
    // lần ngược để lấy các bước xóa/chèn
    const steps = [];
    let x = n, y = m;
    for (let d = found; d > 0; d--) {
      const prev = trace[d];
      const k = x - y;
      const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
      const prevK = down ? k + 1 : k - 1;
      const prevX = prev[offset + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; }
      steps.push(down ? ['ins', prevX, prevY] : ['del', prevX, prevY]);
      x = prevX; y = prevY;
    }
    steps.reverse();
    // gom các bước liền nhau thành một đoạn thay thế
    const spans = [];
    let current = null;
    for (const step of steps) {
      const ax = step[1], by = step[2];
      if (current && current[1] === ax && current[3] === by) {
        if (step[0] === 'del') current[1] += 1; else current[3] += 1;
      } else {
        current = step[0] === 'del' ? [ax, ax + 1, by, by] : [ax, ax, by, by + 1];
        spans.push(current);
      }
    }
    return spans;
  }
  function stripPunctTokens(tokens) {
    let start = 0, end = tokens.length;
    while (start < end && !/[\p{L}\p{N}_]/u.test(tokens[start])) start++;
    while (end > start && !/[\p{L}\p{N}_]/u.test(tokens[end - 1])) end--;
    return tokens.slice(start, end);
  }
  /* So transcript trước/sau khi người dùng sửa, ghi nhận các cặp "nhận sai -> đúng" (tên riêng, thuật ngữ). */
  async function learnFromEdit(original, edited) {
    const a = original.match(TOKEN_RE) || [];
    const b = edited.match(TOKEN_RE) || [];
    if (!a.length || !b.length) return [];
    const spans = replacedSpans(a.map((t) => t.toLowerCase()), b.map((t) => t.toLowerCase()));
    if (!spans || !spans.length) return [];
    let changed = 0;
    for (const s of spans) changed += Math.max(s[1] - s[0], s[3] - s[2]);
    if (a.length >= 20 && changed / a.length > MAX_CHANGE_RATIO) return [];
    const learned = [];
    for (const s of spans) {
      if (s[1] === s[0] || s[3] === s[2]) continue;   // chỉ thêm hoặc chỉ xóa: không phải sửa lỗi nhận dạng
      const wrong = stripPunctTokens(a.slice(s[0], s[1]));
      const right = stripPunctTokens(b.slice(s[2], s[3]));
      if (!wrong.length || !right.length || wrong.length > MAX_SPAN || right.length > MAX_SPAN) continue;
      if (!wrong.some((t) => WORDY_RE.test(t)) || !right.some((t) => WORDY_RE.test(t))) continue;
      const variant = wrong.join(' ');
      const term = right.join(' ');
      if (variant.toLowerCase() === term.toLowerCase()) continue;
      const row = await upsertGlossary(term, variant, 'inferred');
      learned.push(row);
      if (Number(row.count) === CORRECTION_THRESHOLD && row.source !== 'user') {
        await logEvent('glossary', `Đã học sửa lỗi '${variant}' → '${term}' (thấy ${row.count} lần, sẽ tự áp dụng)`);
      }
    }
    return learned;
  }

  // --------------------------------------------------------- phong cách đã học
  const DEFAULT_STYLE = { edits: 0, avg_summary_items: null, avg_words_per_item: null, avg_mindmap_nodes: null,
    avg_branches: null, keeps_decisions: null, keeps_action_items: null, ratings: [] };
  function ema(old, value) {
    return old === null || old === undefined ? value : Math.round((old * 0.7 + value * 0.3) * 100) / 100;
  }
  async function getStyle() {
    return Object.assign({}, DEFAULT_STYLE, await getPref('style', {}));
  }
  /* Số ý chính và số nhánh người dùng hay giữ, đưa cho bộ máy để các lần sau tóm tắt đúng cỡ đó. */
  function styleNumbers(style) {
    if (Number(style.edits || 0) < 2) return null;
    const out = {};
    if (style.avg_summary_items) out.summary_items = style.avg_summary_items;
    if (style.avg_branches) out.branches = style.avg_branches;
    return Object.keys(out).length ? out : null;
  }
  function styleHints(style) {
    const hints = [];
    const numbers = styleNumbers(style);
    if (numbers && numbers.summary_items) hints.push(`Bạn thường giữ khoảng ${Math.max(3, Math.min(12, Math.round(numbers.summary_items)))} ý chính: các lần sau sẽ tóm tắt đúng cỡ đó.`);
    if (numbers && numbers.branches) hints.push(`Sơ đồ tư duy của bạn thường có khoảng ${Math.max(3, Math.min(8, Math.round(numbers.branches)))} nhánh chính.`);
    return hints;
  }
  async function recordAnalysisEdit(meeting, original, edited) {
    const changed = {};
    for (const key of ['summary', 'decisions', 'action_items', 'mindmap', 'keywords']) {
      changed[key] = JSON.stringify(original[key] || null) !== JSON.stringify(edited[key] || null);
    }
    if (!Object.keys(changed).some((k) => changed[k])) return { changed, learned: false };
    const style = await getStyle();
    style.edits = Number(style.edits || 0) + 1;
    const summary = edited.summary || [];
    if (summary.length) {
      style.avg_summary_items = ema(style.avg_summary_items, summary.length);
      style.avg_words_per_item = ema(style.avg_words_per_item, summary.reduce((sum, s) => sum + s.split(/\s+/).filter(Boolean).length, 0) / summary.length);
    }
    if (edited.mindmap) {
      style.avg_mindmap_nodes = ema(style.avg_mindmap_nodes, engine.countNodes(edited.mindmap));
      style.avg_branches = ema(style.avg_branches, (edited.mindmap.children || []).length);
    }
    style.keeps_decisions = ema(style.keeps_decisions, (edited.decisions || []).length ? 1 : 0);
    style.keeps_action_items = ema(style.keeps_action_items, (edited.action_items || []).length ? 1 : 0);
    await setPref('style', style);
    const names = { summary: 'ý chính', decisions: 'quyết định', action_items: 'việc cần làm', mindmap: 'sơ đồ tư duy', keywords: 'từ khóa' };
    const parts = Object.keys(changed).filter((k) => changed[k]).map((k) => names[k]);
    await put('feedback', { meeting_id: meeting.id, kind: 'analysis_edit', created_at: nowIso() });
    await logEvent('feedback', `Ghi nhận cách bạn chỉnh kết quả (${parts.join(', ')}) ở cuộc họp '${meeting.title}'`, meeting.id);
    return { changed, learned: true };
  }
  async function recordRating(id, body) {
    const m = await meetingOr404(id);
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw apiError(422, 'Số sao phải từ 1 đến 5');
    const comment = typeof body.comment === 'string' ? Array.from(engine.nfc(body.comment)).slice(0, 1000).join('') : null;
    await put('feedback', { meeting_id: id, kind: 'rating', rating, comment, created_at: nowIso() });
    const style = await getStyle();
    style.ratings = (style.ratings || []).slice(-49).concat([rating]);
    await setPref('style', style);
    await logEvent('feedback', `Đánh giá ${rating}/5 cho '${m.title}'` + (comment ? ` - góp ý: ${comment}` : ''), id);
    return { rating, learned: false };
  }

  // ------------------------------------------------------------------ xử lý
  function chunkText(transcript) {
    const chunks = [];
    let current = '';
    for (const sentence of engine.splitSentences(transcript)) {
      if (current.length + sentence.length + 1 > CHUNK_CHARS && current) { chunks.push(current.trim()); current = ''; }
      current += ' ' + sentence;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }
  /* Sửa thuật ngữ -> tóm tắt -> vẽ sơ đồ tư duy, tất cả ngay trên máy. */
  async function processMeeting(id) {
    const m = await meetingOr404(id);
    let transcript = (m.transcript || '').trim();
    if (!transcript) {
      if (!m.has_audio) throw apiError(400, 'Cuộc họp chưa có âm thanh hoặc văn bản');
      m.status = 'error';
      m.error = 'Bản ghi này chỉ có âm thanh, chưa có văn bản. Hãy nhập lại file bằng nút "Nhập bản ghi âm có sẵn" để máy '
        + 'chuyển thành văn bản, ghi lại bằng nút ghi âm (văn bản hiện ra khi bạn nói), hoặc dán văn bản vào ô bên dưới.';
      await saveMeeting(m);
      return { started: true, meeting: publicMeeting(m, true) };
    }
    try {
      const fixed = await applyGlossary(transcript);
      transcript = fixed[0];
      if (fixed[1]) await logEvent('glossary', `Tự động sửa ${fixed[1]} chỗ trong văn bản theo thuật ngữ đã học`, id);
      const style = await getStyle();
      const analysis = engine.analyze(transcript, { title: m.title, participants: m.participants, language: m.language, style: styleNumbers(style) });
      m.transcript = transcript;
      m.transcript_source = m.transcript_source || 'manual';
      m.analysis = analysis;
      m.engine = analysis.engine;
      m.memory_chunks = chunkText(transcript).length;
      m.status = 'done';
      m.error = null;
      await saveMeeting(m);
      await logEvent('memory', `Đã tóm tắt và vẽ sơ đồ tư duy cho '${m.title}' (không cần AI)`, id);
    } catch (err) {
      m.status = 'error';
      m.error = String((err && err.message) || err);
      await saveMeeting(m);
    }
    return { started: true, meeting: publicMeeting(m, true) };
  }
  async function updateTranscript(id, body) {
    const m = await meetingOr404(id);
    const original = m.transcript || '';
    const edited = engine.nfc(String(body.transcript === undefined || body.transcript === null ? '' : body.transcript)).trim();
    const learned = original ? await learnFromEdit(original, edited) : [];
    let source = m.transcript_source || (body.source === 'device' || body.source === 'file' ? body.source : 'manual');
    if (original.trim() && edited !== original) {
      await put('feedback', { meeting_id: id, kind: 'transcript_edit', created_at: nowIso() });
      if (!/\+edited$/.test(source)) source += '+edited';
    }
    m.transcript = edited;
    m.transcript_source = source;
    if (!m.analysis) m.status = 'transcribed';
    await saveMeeting(m);
    if (learned.length) await logEvent('glossary', `Ghi nhận ${learned.length} cặp sửa lỗi từ chỉnh sửa văn bản`, id);
    let result = publicMeeting(m, true);
    if (body.reanalyze) result = (await processMeeting(id)).meeting;
    result.learned_corrections = learned.map((e) => ({ variant: e.variant, term: e.term, count: e.count }));
    return result;
  }
  function strList(value, limit, maxLen) {
    if (typeof value === 'string') value = [value];
    if (!Array.isArray(value)) return [];
    const out = [];
    for (let item of value) {
      if (item && typeof item === 'object') item = item.text || item.title || item.task || '';
      const clean = engine.normalizeWs(String(item === null || item === undefined ? '' : item));
      if (clean && out.indexOf(clean) < 0) out.push(Array.from(clean).slice(0, maxLen).join(''));
      if (out.length >= limit) break;
    }
    return out;
  }
  function actionItems(value, limit) {
    if (!Array.isArray(value)) return [];
    const items = [];
    for (let item of value) {
      if (typeof item === 'string') item = { task: item };
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const task = engine.normalizeWs(String(item.task || item.title || item.text || ''));
      if (!task) continue;
      items.push({
        task: Array.from(task).slice(0, 300).join(''),
        owner: Array.from(engine.normalizeWs(String(item.owner || item.assignee || ''))).slice(0, 80).join(''),
        due: Array.from(engine.normalizeWs(String(item.due || item.deadline || item.due_date || ''))).slice(0, 80).join(''),
      });
      if (items.length >= limit) break;
    }
    return items;
  }
  async function updateAnalysis(id, body) {
    const m = await meetingOr404(id);
    const original = m.analysis || {};
    const edited = Object.assign({}, original);
    // bản người dùng tự sửa: chỉ làm sạch, không cắt theo giới hạn của bản tự động
    if (body.summary !== undefined && body.summary !== null) edited.summary = strList(body.summary, 500, 2000);
    if (body.decisions !== undefined && body.decisions !== null) edited.decisions = strList(body.decisions, 500, 2000);
    if (body.keywords !== undefined && body.keywords !== null) edited.keywords = strList(body.keywords, 500, 200);
    if (body.action_items !== undefined && body.action_items !== null) edited.action_items = actionItems(body.action_items, 500);
    if (body.mindmap !== undefined && body.mindmap !== null) {
      const tree = engine.normalizeMindmap(body.mindmap, m.title, { maxDepth: engine.USER_MAX_DEPTH, maxChildren: engine.USER_MAX_CHILDREN });
      if (tree) edited.mindmap = tree;
    }
    edited.engine = original.engine || 'manual';
    edited.edited = true;
    m.analysis = edited;
    await saveMeeting(m);
    const result = publicMeeting(m, true);
    result.learning = await recordAnalysisEdit(m, original, edited);
    return result;
  }

  // ----------------------------------------------------- tìm lại trong bản ghi cũ
  function vector(source) {
    const tokens = engine.tokenize(source).filter((t) => !engine.STOPWORDS.has(t) && engine.cpLen(t) > 1);
    const counts = new Map();
    for (let i = 0; i < tokens.length; i++) {
      counts.set(tokens[i], (counts.get(tokens[i]) || 0) + 1);
      if (i + 1 < tokens.length) {
        const pair = tokens[i] + '_' + tokens[i + 1];
        counts.set(pair, (counts.get(pair) || 0) + 1);
      }
    }
    let norm = 0;
    for (const [key, value] of counts) {
      const weight = 1 + Math.log(value);
      counts.set(key, weight);
      norm += weight * weight;
    }
    return { counts, norm: Math.sqrt(norm) };
  }
  function cosine(a, b) {
    if (!a.norm || !b.norm) return 0;
    let dot = 0;
    const small = a.counts.size <= b.counts.size ? a : b;
    const large = small === a ? b : a;
    for (const [key, value] of small.counts) {
      const other = large.counts.get(key);
      if (other) dot += value * other;
    }
    return dot / (a.norm * b.norm);
  }
  async function searchMemory(query, limit) {
    const q = engine.normalizeWs(query);
    if (!q) return [];
    const qv = vector(q);
    const results = [];
    for (const m of await all('meetings')) {
      if (!m.analysis) continue;
      const a = m.analysis;
      const head = [m.title].concat(a.summary || [], a.decisions || [], (a.action_items || []).map((i) => i.task || ''), a.keywords || []).filter(Boolean).join(' . ');
      const payload = { title: m.title, date: m.created_at, summary: (a.summary || []).slice(0, 8) };
      const docs = [{ kind: 'meeting', text: head }].concat(chunkText(m.transcript || '').slice(0, 60).map((c) => ({ kind: 'chunk', text: c })));
      docs.forEach((doc, index) => {
        const score = cosine(qv, vector(doc.text));
        if (score >= 0.02) {
          results.push({ id: `${m.id}-${index}`, meeting_id: m.id, kind: doc.kind, text: doc.text, payload,
            score: Math.round(score * 10000) / 10000, created_at: m.created_at });
        }
      });
    }
    results.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : 1));
    const perMeeting = new Map();
    const picked = [];
    for (const r of results) {
      const seen = perMeeting.get(r.meeting_id) || 0;
      if (seen >= 2) continue;      // mỗi cuộc họp tối đa hai đoạn để kết quả đa dạng
      perMeeting.set(r.meeting_id, seen + 1);
      picked.push(r);
      if (picked.length >= limit) break;
    }
    return picked;
  }
  async function ask(body) {
    const question = Array.from(text(body.question)).slice(0, 1000).join('').trim();
    if (!question) throw apiError(422, 'Hãy nhập câu hỏi');
    const sources = await searchMemory(question, 6);
    return {
      answer: sources.length ? 'Các đoạn liên quan nhất trong những bản ghi đã lưu:' : 'Chưa có bản ghi nào liên quan.',
      sources, engine: 'heuristic',
    };
  }
  async function stats() {
    const meetings = await all('meetings');
    const glossary = await all('glossary');
    const style = await getStyle();
    const events = await all('events');
    const analyzed = meetings.filter((m) => m.status === 'done');
    const ratings = style.ratings || [];
    const edits = (await all('feedback')).filter((f) => f.kind === 'transcript_edit').length;
    return {
      standalone: true,
      meetings: meetings.length,
      analyzed: analyzed.length,
      memory: { meetings: analyzed.length, chunks: analyzed.reduce((sum, m) => sum + (m.memory_chunks || 0), 0), examples: 0, embedder: 'local' },
      glossary: { total: glossary.length, user: glossary.filter((g) => g.source === 'user').length,
        inferred: glossary.filter((g) => g.source !== 'user').length, active: glossary.filter(isActive).length,
        hits: glossary.reduce((sum, g) => sum + Number(g.hits || 0), 0) },
      feedback: { edits: style.edits || 0, transcript_edits: edits, ratings: ratings.length,
        avg_rating: ratings.length ? Math.round(ratings.reduce((s, r) => s + r, 0) / ratings.length * 100) / 100 : null,
        avg_summary_items: style.avg_summary_items, avg_words_per_item: style.avg_words_per_item, avg_branches: style.avg_branches },
      events: events.length,
      engine: 'heuristic',
      style_hints: styleHints(style),
    };
  }
  async function listEvents(limit) {
    const events = await all('events');
    events.sort((a, b) => b.id - a.id);
    return events.slice(0, Math.max(1, Math.min(limit || 50, 500)));
  }
  async function health() {
    // đọc thử một lần: nếu trình duyệt không cho mở IndexedDB thì lúc này kho đã chuyển sang bộ nhớ tạm
    await get('prefs', 'style').catch(() => {});
    return {
      version: root.M2M_VERSION || '', standalone: true, storage: db().kind,
      whisper: { available: false, loaded: false, model: null, error: 'Chế độ độc lập không dùng Whisper' },
      ollama: { enabled: false, available: false, model_ready: false, embed_ready: false, model: '', embed_model: '', models: [], url: '' },
      engine: 'heuristic', embedder: 'local', language: 'vi', data_dir: 'thiết bị này',
    };
  }
  async function exportMarkdown(id) {
    return engine.meetingMarkdown(publicMeeting(await meetingOr404(id), true));
  }

  // --------------------------------------------------------------- định tuyến
  async function request(method, url, body, isForm) {
    const [path, queryString] = String(url).split('?');
    const query = new URLSearchParams(queryString || '');
    const seg = path.replace(/^\/api\//, '').split('/').filter(Boolean).map(decodeURIComponent);
    const data = body && !isForm ? body : {};
    const route = `${method} ${seg[0]}${seg.length > 1 ? '/' + (seg[0] === 'meetings' || seg[0] === 'glossary' ? ':id' : seg[1]) : ''}${seg.length > 2 ? '/' + seg[2] : ''}`;
    switch (route) {
      case 'GET health': return health();
      case 'GET meetings': return listMeetings(query.get('q'));
      case 'POST meetings': return createMeeting(data);
      case 'GET meetings/:id': return publicMeeting(await meetingOr404(seg[1]), true);
      case 'PATCH meetings/:id': return updateMeeting(seg[1], data);
      case 'DELETE meetings/:id': return deleteMeeting(seg[1]);
      case 'POST meetings/:id/audio': return uploadAudio(seg[1], body);
      case 'POST meetings/:id/process': return processMeeting(seg[1]);
      case 'PUT meetings/:id/transcript': return updateTranscript(seg[1], data);
      case 'PUT meetings/:id/analysis': return updateAnalysis(seg[1], data);
      case 'POST meetings/:id/rating': return recordRating(seg[1], data);
      case 'GET learning/stats': return stats();
      case 'GET learning/events': return listEvents(Number(query.get('limit')) || 50);
      case 'POST learning/ask': return ask(data);
      case 'POST learning/reindex': return { updated: 0, embedder: 'local' };
      case 'GET glossary': return glossaryEntries();
      case 'POST glossary': return addGlossary(data);
      case 'DELETE glossary/:id': return removeGlossary(seg[1]);
      default: throw apiError(404, `Chế độ độc lập không hỗ trợ: ${method} ${path}`);
    }
  }

  root.M2MLocal = {
    /* Trả về bản sao sâu để nơi gọi sửa đối tượng cũng không đụng tới dữ liệu đang lưu. */
    request: (method, url, body, isForm) => request(method, url, body, isForm).then(clone),
    audioUrl, exportMarkdown,
    storageKind: () => db().kind,
    _replaceWhole: replaceWhole, _replacedSpans: replacedSpans,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
