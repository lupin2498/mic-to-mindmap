#!/usr/bin/env node
/* Kiểm thử giao diện thật bằng Playwright (Chromium, micro giả, nhận dạng giọng nói giả).
   - Tự bật máy chủ FastAPI trên thư mục dữ liệu tạm (không Ollama, không Whisper).
   - Tự dựng mobile/www và phục vụ ở origin khác: đó là bản ĐỘC LẬP (không máy chủ, lưu IndexedDB), cũng dùng để kiểm
     bản di động gọi API chéo origin khi người dùng nhập địa chỉ máy chủ.
   - Nhận dạng giọng nói: trang nào cũng được gắn một Web Speech API giả điều khiển được (window.__say...), hoặc một
     plugin M2MSpeech giả của ứng dụng di động; không bước nào gọi dịch vụ nhận dạng thật.
   Chạy:  node tests/e2e/run.js                 (tất cả)
          node tests/e2e/run.js --grep ghi-am   (lọc theo tên bước; không khớp bước nào là lỗi)
          E2E_OUT=<thư mục> để lưu ảnh chụp. In PASS/FAIL từng bước, thoát mã khác 0 khi có bước đỏ. */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'm2m-e2e');
const grepIdx = process.argv.indexOf('--grep');
const GREP = grepIdx > -1 ? process.argv[grepIdx + 1] : '';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const VI = 'Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới. Kế hoạch ra mắt dự kiến vào tháng 12. ' +
  'Khách hàng đã phản hồi tốt về bản thử nghiệm. Bộ phận marketing cần chuẩn bị chiến dịch quảng cáo cho sản phẩm mới. ' +
  'An sẽ phụ trách liên hệ khách hàng lớn trước thứ sáu. Chúng ta thống nhất chốt ngân sách 500 triệu cho chiến dịch. ' +
  'Bình phải gửi báo cáo tiến độ vào ngày 15/11. Mọi người đồng ý tổ chức demo tại văn phòng.';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function assert(cond, message) { if (!cond) throw new Error(`Khẳng định sai: ${message}`); }
function eq(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: nhận ${JSON.stringify(actual)}, mong ${JSON.stringify(expected)}`);
}
async function until(fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (err) { last = err.message; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Hết thời gian chờ: ${message} (giá trị cuối: ${JSON.stringify(last)})`);
}

const steps = [];
function step(name, fn, opts) { steps.push({ name, fn, opts: opts || {} }); }

let API = '';      // origin của máy chủ FastAPI
let WWW = '';      // origin của bản di động (mobile/www)
let browser;

async function api(method, url, body) {
  const resp = await fetch(API + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: resp.status, data };
}
async function seedMeeting(title, transcript) {
  const m = (await api('POST', '/api/meetings', { title, participants: ['An', 'Bình'] })).data;
  await api('PUT', `/api/meetings/${m.id}/transcript`, { transcript: transcript || VI });
  await api('POST', `/api/meetings/${m.id}/process`, { transcribe: false });
  await until(async () => (await api('GET', `/api/meetings/${m.id}`)).data.status === 'done', `cuộc họp ${title} xử lý xong`);
  return m.id;
}
async function findMeeting(title) {
  return ((await api('GET', '/api/meetings')).data || []).find((m) => m.title === title);
}

/* Web Speech API giả: mỗi lần start() ghi lại, kết quả do bài test bơm vào (window.__say/__partial/__srEnd/__srError).
   window.__sr.auto: các câu tự phát ra ngay sau mỗi lần start(). stop() KHÔNG tự chốt phần đang nói dở (như vài
   trình duyệt thật), để kiểm ứng dụng tự giữ phần đó. */
function fakeWebSpeech(auto) {
  window.__sr = { starts: 0, stops: 0, active: null, auto: auto || [], lang: '', continuous: null, failStart: false };
  class FakeSR {
    start() {
      if (window.__sr.failStart) throw new Error('InvalidStateError');
      window.__sr.starts += 1; window.__sr.active = this; window.__sr.lang = this.lang; window.__sr.continuous = this.continuous;
      setTimeout(() => { if (this.onstart) this.onstart(); for (const text of window.__sr.auto) this._final(text); }, 20);
    }
    _emit(text, isFinal) { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }); }
    _final(text) { this._emit(text, true); }
    _partial(text) { this._emit(text, false); }
    _end() { if (window.__sr.active === this) window.__sr.active = null; if (this.onend) this.onend(); }
    _error(code) { if (this.onerror) this.onerror({ error: code }); }
    stop() { window.__sr.stops += 1; setTimeout(() => this._end(), 10); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__say = (text) => { if (!window.__sr.active) throw new Error('bộ nhận dạng giả chưa chạy'); window.__sr.active._final(text); };
  window.__partial = (text) => { if (!window.__sr.active) throw new Error('bộ nhận dạng giả chưa chạy'); window.__sr.active._partial(text); };
  window.__srEnd = () => window.__sr.active && window.__sr.active._end();
  window.__srError = (code) => window.__sr.active && window.__sr.active._error(code);
}
/* Trình duyệt không có nhận dạng giọng nói (Firefox, WebView Android). */
function noWebSpeech() {
  window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
}
/* Plugin M2MSpeech giả của ứng dụng di động (Capacitor): ghi lại lời gọi, bài test bơm sự kiện bằng window.__nativeEmit. */
function fakeNativeSpeech() {
  window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;   // WebView không có Web Speech API
  const native = window.__native = { calls: [], listeners: {}, startError: null, pending: '', awake: null, running: false };
  const emit = window.__nativeEmit = (name, data) => { (native.listeners[name] || []).slice().forEach((fn) => fn(data)); };
  window.__nativeSay = (text) => { if (!native.running) throw new Error('plugin giả chưa start'); emit('final', { text }); };
  window.Capacitor = { Plugins: { M2MSpeech: {
    addListener(name, fn) {
      (native.listeners[name] = native.listeners[name] || []).push(fn);
      return { remove() { const list = native.listeners[name]; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } };
    },
    available() { return Promise.resolve({ available: true }); },
    start(options) {
      native.calls.push(['start', options]);
      if (native.startError) return Promise.reject(Object.assign(new Error(native.startError.message || 'lỗi'), { code: native.startError.code }));
      native.running = true;
      setTimeout(() => emit('state', { listening: true }), 5);
      return Promise.resolve({ started: true });
    },
    stop() {
      native.calls.push(['stop']);
      native.running = false;
      if (native.pending) { emit('final', { text: native.pending }); native.pending = ''; }
      emit('state', { listening: false });
      return Promise.resolve();
    },
    keepAwake(options) { native.calls.push(['keepAwake', options]); native.awake = options.on; return Promise.resolve(); },
  } } };
}
const SPEECH = { web: fakeWebSpeech, none: noWebSpeech, native: fakeNativeSpeech };

/* Mở một trang mới kèm bộ gom lỗi console/pageerror. extra.speech: 'web' (mặc định) | 'none' | 'native';
   extra.auto: các câu bộ nhận dạng giả tự phát ra mỗi lần bật. */
async function open(url, viewport, extra) {
  const opts = Object.assign({}, extra || {});
  const speech = opts.speech || 'web';
  const auto = opts.auto || [];
  delete opts.speech; delete opts.auto;
  const context = await browser.newContext(Object.assign({ viewport, permissions: ['microphone'], acceptDownloads: true,
    hasTouch: viewport.width < 600, isMobile: viewport.width < 600, locale: 'vi-VN' }, opts));
  await context.addInitScript(SPEECH[speech], auto);
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => page.errors.push(`pageerror: ${err.message}`));
  page.on('response', (resp) => { if (resp.status() >= 400) page.errors.push(`http ${resp.status()}: ${resp.request().method()} ${resp.url()}`); });
  page.apiCalls = [];
  page.requests = [];
  page.on('request', (req) => {
    page.requests.push(req.url());
    if (req.url().includes('/api/')) page.apiCalls.push(`${req.method()} ${req.url()}`);
  });
  if (url) {
    await page.goto(url);
    await page.waitForSelector('#btn-new-meeting');
  }
  return page;
}
/* Giữ các cuộc họp có tiêu đề nằm trong held.titles ở trạng thái "đang phân tích" cho tới khi bỏ khỏi tập. */
async function holdProcessing(page) {
  const held = { titles: new Set() };
  await page.route(/\/api\/meetings\/[0-9a-f]{12}$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const json = await resp.json();
    if (resp.status() === 200 && held.titles.has(json.title)) { json.status = 'analyzing'; json.processing = true; json.analysis = null; }
    return route.fulfill({ response: resp, json });
  });
  return held;
}
async function analyzeText(page, title, text) {
  await page.click('.tab[data-tab="record"]');
  await page.fill('#meeting-title', title);
  await page.fill('#manual-transcript', text || VI);
  await page.click('#btn-analyze-text');
}
async function waitResult(page, title) {
  await until(() => page.evaluate((t) => document.querySelector('#tab-result').classList.contains('active')
    && document.querySelector('#result-title').value === t && document.querySelector('#result-status').hidden, title), `hiện kết quả của "${title}"`);
}
const activeTab = (page) => page.evaluate(() => document.querySelector('.tab.active').dataset.tab);
const noOverflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

// =============================================================== các bước
step('khoi-dong: trạng thái rỗng, huy hiệu cho biết đang chạy không cần AI, không lỗi console', async (ctx) => {
  // trình duyệt không có nhận dạng giọng nói (Firefox): nói rõ, và chỉ đường khác
  const bare = await open(API + '/', DESKTOP, { speech: 'none' });
  await until(() => bare.evaluate(() => document.querySelector('#badge-whisper').textContent === 'Giọng nói: máy không hỗ trợ'), 'huy hiệu khi không có nhận dạng');
  assert(/không có nhận dạng giọng nói/.test(await bare.textContent('#stt-line')) && await bare.isHidden('#live-captions-row'), 'dòng hướng dẫn khi không có nhận dạng');
  eq(bare.errors, [], 'lỗi console khi không có nhận dạng giọng nói');
  await bare.context().close();
  const page = ctx.page = await open(API + '/', DESKTOP);
  await until(() => page.evaluate(() => document.querySelector('#badge-ollama').textContent === 'Tóm tắt: không cần AI'), 'huy hiệu tóm tắt');
  eq(await page.textContent('#badge-whisper'), 'Giọng nói: nhận dạng trực tiếp', 'huy hiệu giọng nói');
  eq(await page.getAttribute('#badge-ollama', 'class'), 'badge ok', 'không cần AI không phải là trạng thái lỗi');
  assert(/chuyển thành văn bản ngay khi bạn nói/.test(await page.textContent('#stt-line')), 'dòng cho biết lời nói được chuyển thành văn bản');
  assert(await page.isChecked('#live-captions') && await page.isChecked('#auto-process'), 'mặc định: chuyển thành văn bản ngay và tự tóm tắt');
  assert((await page.textContent('#meeting-list')).includes('Chưa có cuộc họp nào'), 'danh sách rỗng có nội dung');
  await page.click('.tab[data-tab="result"]');
  assert(await page.isVisible('#result-empty'), 'tab kết quả có trạng thái rỗng');
  assert(await page.isHidden('#server-box'), 'bản web không hiện ô địa chỉ máy chủ');
  await page.click('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelectorAll('#stats .stat').length === 7), 'thống kê học hỏi');
  assert((await page.textContent('#events')).includes('Chưa có gì được học'), 'nhật ký rỗng có nội dung');
  assert((await page.textContent('#glossary-table')).includes('Chưa có thuật ngữ nào'), 'bảng thuật ngữ rỗng có nội dung');
});

step('van-ban: dán văn bản → tóm tắt → sơ đồ tư duy (máy tính)', async (ctx) => {
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.selectOption('#meeting-language', 'auto');
  await page.fill('#meeting-participants', 'An, Bình');
  await analyzeText(page, 'Họp kế hoạch e2e');
  await waitResult(page, 'Họp kế hoạch e2e');
  assert((await page.inputValue('#edit-summary')).split('\n').length >= 3, 'có ít nhất 3 ý chính');
  assert((await page.locator('#mindmap .mm-node').count()) >= 4, 'mind map có nút');
  assert((await page.inputValue('#edit-transcript')).startsWith('Hôm nay'), 'transcript hiển thị');
  assert((await page.textContent('#result-meta')).includes('thuật toán không cần AI'), 'meta ghi cách tóm tắt');
  assert(/Xong! Tóm tắt bằng thuật toán không cần AI/.test(await page.textContent('#toast')), 'thông báo xong');
  // việc cần làm được tách thành đầu việc / người / hạn, không chép nguyên câu
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#actions-table tbody tr')).map((tr) =>
    [tr.querySelector('.a-task').value, tr.querySelector('.a-owner').value, tr.querySelector('.a-due').value]));
  assert(rows.some((r) => r[0] === 'Phụ trách liên hệ khách hàng lớn' && r[1] === 'An' && r[2] === 'trước thứ sáu'), `việc cần làm đã tách: ${JSON.stringify(rows)}`);
  // sơ đồ tư duy: có nhánh chủ đề, Quyết định và Việc cần làm, không lặp câu giữa các nhánh
  const nodes = await page.evaluate(() => Array.from(document.querySelectorAll('#mindmap .mm-node > text')).map((n) => n.textContent));
  assert(nodes.includes('Quyết định') && nodes.includes('Việc cần làm') && nodes.includes('Kế hoạch ra mắt'), `các nhánh: ${nodes.slice(0, 8).join(' | ')}`);
  eq(nodes.length, new Set(nodes).size, 'nút trùng nhau trong sơ đồ');
  const m = await findMeeting('Họp kế hoạch e2e');
  eq(m.language, 'auto', 'ngôn ngữ "Tự nhận dạng" được giữ nguyên');
  eq((await api('GET', `/api/meetings/${m.id}`)).data.transcript_source, 'manual', 'nguồn transcript');
  assert(await page.isHidden('#progress'), 'thanh tiến trình đã tắt');
  assert(await page.isEnabled('#btn-analyze-text'), 'nút tóm tắt bật lại');
  eq(await page.inputValue('#manual-transcript'), '', 'ô dán transcript được dọn');
  // bấm lặp nhanh không tạo trùng cuộc họp
  await page.click('.tab[data-tab="record"]');
  await page.fill('#meeting-title', 'Bấm đúp');
  await page.fill('#manual-transcript', VI);
  await page.dblclick('#btn-analyze-text');
  await waitResult(page, 'Bấm đúp');
  eq(((await api('GET', '/api/meetings')).data).filter((x) => x.title === 'Bấm đúp').length, 1, 'bấm đúp chỉ tạo một cuộc họp');
  // không đặt tiêu đề: lấy chủ đề nêu ở câu mở đầu, không còn một dãy "Cuộc họp" giống nhau
  await page.click('.tab[data-tab="record"]');
  await page.fill('#meeting-title', '');
  await page.fill('#manual-transcript', VI);
  await page.click('#btn-analyze-text');
  await waitResult(page, 'Kế hoạch ra mắt sản phẩm mới');
  eq(await page.locator('#mindmap .mm-node.root > text').textContent(), 'Kế hoạch ra mắt sản phẩm mới', 'gốc sơ đồ là tiêu đề tự đặt');
  await api('DELETE', `/api/meetings/${(await findMeeting('Kế hoạch ra mắt sản phẩm mới')).id}`);
});

step('xss: dữ liệu chứa HTML không được chạy ở bất kỳ màn hình nào', async (ctx) => {
  const id = await seedMeeting(XSS, `${VI} ${XSS} cần chuẩn bị ${XSS}.`);
  await api('PUT', `/api/meetings/${id}/analysis`, { summary: [XSS], decisions: [XSS], keywords: [XSS],
    action_items: [{ task: XSS, owner: XSS, due: XSS }], mindmap: { title: XSS, children: [{ title: XSS, children: [] }] } });
  await api('PUT', `/api/meetings/${id}/analysis`, { summary: [XSS, 'hai'] });
  for (let i = 0; i < 2; i++) await api('POST', `/api/meetings/${id}/rating`, { rating: 5, comment: XSS });
  await api('POST', '/api/glossary', { term: XSS, variant: `${XSS} sai` });
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.click('#meeting-list li');
  await page.waitForSelector('#result-body:not([hidden])');
  await page.click('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelector('#ai-setup').textContent.includes('Góp ý trước đây')), 'gợi ý phong cách chứa góp ý');
  await page.fill('#ask-input', 'kế hoạch ra mắt sản phẩm');
  await page.click('#ask-form button');
  await until(() => page.evaluate(() => document.querySelectorAll('#ask-sources li').length > 0), 'có nguồn trả lời');
  await page.waitForTimeout(300);
  eq(await page.evaluate(() => window.__xss || 0), 0, 'số lần script chèn vào được chạy');
  eq(await page.evaluate(() => document.querySelectorAll('img[src="x"]').length), 0, 'số thẻ img bị chèn vào DOM');
  assert((await page.textContent('#ai-setup')).includes('<img src=x'), 'góp ý hiện dưới dạng chữ');
}, { allow: /Failed to load resource.*\/x\b|ERR_FILE_NOT_FOUND/ });

step('ket-qua: sửa tóm tắt, đánh giá, sửa transcript, thông báo "đã lưu" còn nguyên', async (ctx) => {
  await seedMeeting('Họp để sửa');
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.click('#meeting-list li:has-text("Họp để sửa")');
  await page.waitForSelector('#result-body:not([hidden])');
  await page.fill('#edit-summary', '- Ý thứ nhất đã sửa\n- Ý thứ hai đã sửa');
  await page.click('#btn-add-action');
  await page.locator('#actions-table tbody tr').last().locator('.a-task').fill('Việc mới thêm');
  await page.click('#btn-save-analysis');
  await until(() => page.evaluate(() => document.querySelector('#save-analysis-msg').textContent.includes('ví dụ mẫu')), 'thông báo đã lưu');
  await page.waitForTimeout(400);
  assert((await page.textContent('#save-analysis-msg')).includes('Đã lưu'), 'thông báo đã lưu không bị xóa');
  eq(await page.inputValue('#edit-summary'), '- Ý thứ nhất đã sửa\n- Ý thứ hai đã sửa', 'ý chính sau khi lưu');
  assert((await page.textContent('#result-meta')).includes('(đã sửa)'), 'meta ghi đã sửa');
  await page.click('#btn-rate');
  await until(() => page.evaluate(() => !document.querySelector('#toast').hidden), 'nhắc chọn số sao');
  await page.click('#stars button[data-v="4"]');
  await page.fill('#rating-comment', 'ghi rõ con số');
  await page.click('#btn-rate');
  await until(() => page.evaluate(() => document.querySelector('#rating-msg').textContent.includes('ví dụ mẫu')), 'thông báo đánh giá');
  const old = await page.inputValue('#edit-transcript');
  await page.fill('#edit-transcript', old.replace('bản thử nghiệm', 'bản beta'));
  await page.click('#btn-save-transcript');
  await until(() => page.evaluate(() => document.querySelector('#save-transcript-msg').textContent.includes('"thử nghiệm"→"beta"')), 'thông báo học thuật ngữ');
  await page.click('#btn-save-transcript-reanalyze');
  await until(() => page.evaluate(() => document.querySelector('#result-status').hidden && !!document.querySelector('#result-meta').textContent), 'phân tích lại xong');
  // đổi tiêu đề; để trống thì trả về tiêu đề cũ thay vì hiện ô rỗng
  await page.fill('#result-title', 'Họp đã đổi tên');
  await page.press('#result-title', 'Tab');
  await until(async () => !!(await findMeeting('Họp đã đổi tên')), 'tiêu đề mới được lưu');
  await page.fill('#result-title', '   ');
  await page.press('#result-title', 'Tab');
  await until(() => page.evaluate(() => document.querySelector('#result-title').value === 'Họp đã đổi tên'), 'tiêu đề trống được trả về giá trị cũ');
  // xóa
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-delete');
  await until(() => page.isVisible('#result-empty'), 'về trạng thái rỗng sau khi xóa');
  assert(!(await findMeeting('Họp đã đổi tên')), 'cuộc họp đã bị xóa trên máy chủ');
});

step('mindmap: chọn, sửa chữ, thêm, xóa, thu gọn, zoom, xuất SVG và PNG', async (ctx) => {
  await seedMeeting('Họp mind map');
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.click('#meeting-list li:has-text("Họp mind map")');
  await page.waitForSelector('#mindmap .mm-node');
  const count = () => page.locator('#mindmap .mm-node').count();
  const before = await count();
  const box = await page.locator('#mindmap').boundingBox();
  const inside = await page.evaluate(() => Array.from(document.querySelectorAll('#mindmap .mm-node')).filter((n) => {
    const r = n.getBoundingClientRect(), c = document.querySelector('#mindmap').getBoundingClientRect();
    return r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom;
  }).length);
  eq(inside, before, 'mọi nút nằm trong khung sau khi vừa khung');
  await page.locator('#mindmap .mm-node:not(.root)').first().click();
  eq(await page.locator('#mindmap .mm-node.selected').count(), 1, 'nhấp chọn một nút');
  await page.locator('#mindmap .mm-node.selected').dblclick();
  await page.waitForSelector('.mm-editor');
  await page.fill('.mm-editor', 'Nhánh đã sửa');
  await page.press('.mm-editor', 'Enter');
  assert((await page.textContent('#mindmap')).includes('Nhánh đã sửa'), 'sửa chữ nút');
  assert((await page.textContent('#save-analysis-msg')).includes('chưa lưu'), 'báo có thay đổi chưa lưu');
  await page.locator('#mindmap .mm-node:has-text("Nhánh đã sửa")').click();
  await page.click('#mm-add-child');
  await page.waitForSelector('.mm-editor');
  // chữ dài phải xuống dòng với mọi phông (máy CI dùng phông rộng hơn máy phát triển) mà đọc ra vẫn nguyên văn
  const longTitle = 'Ý con mới dài tới mức chắc chắn phải xuống dòng với mọi phông chữ trên mọi máy';
  await page.fill('.mm-editor', longTitle);
  await page.press('.mm-editor', 'Enter');
  eq(await count(), before + 1, 'thêm một nút');
  const longNode = page.locator('#mindmap .mm-node:has-text("Ý con mới")');
  assert(await longNode.locator('tspan').count() >= 2, 'nút dài được xuống dòng');
  eq(await longNode.locator('> text').textContent(), longTitle, 'chữ của nút nhiều dòng đọc ra không dính liền');
  await longNode.click();
  await page.click('#mm-delete');
  eq(await count(), before, 'xóa nút vừa thêm');
  await page.click('#mm-delete');
  await until(() => page.evaluate(() => !document.querySelector('#toast').hidden), 'nhắc chọn nút trước khi xóa');
  await page.locator('#mindmap .mm-toggle').first().click();
  assert(await count() < before, 'thu gọn nhánh giảm số nút');
  await page.locator('#mindmap .mm-toggle').first().click();
  eq(await count(), before, 'mở lại nhánh');
  const scale = () => page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector('#mindmap svg > g').getAttribute('transform'))[1]));
  const s0 = await scale();
  await page.click('#mm-zoom-in');
  assert(await scale() > s0, 'phóng to');
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 90, { steps: 4 }); await page.mouse.up();
  await page.click('#mm-fit');
  assert(Math.abs(await scale() - s0) < 0.01, 'vừa khung trả về tỉ lệ ban đầu');
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mm-export-svg')]);
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  eq(dl.suggestedFilename(), 'Họp mind map-mindmap.svg', 'tên file SVG');
  assert(svg.startsWith('<svg') && svg.includes('viewBox'), `SVG có thẻ gốc và viewBox: ${svg.slice(0, 120)}`);
  assert(svg.includes('Nhánh đã sửa'), 'SVG chứa chữ của nút đã sửa');
  assert(!svg.includes('mm-editor') && (svg.match(/<tspan/g) || []).length >= before, 'SVG đủ nút, không lẫn ô sửa chữ');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mm-export-png')]);
  const png = fs.readFileSync(await dl.path());
  assert(png.length > 3000 && png.subarray(1, 4).toString() === 'PNG', `file PNG hợp lệ (${png.length} byte)`);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert(w > 400 && h > 100, `PNG có kích thước hợp lý ${w}x${h}`);
  // lưu mind map đã sửa và đọc lại từ máy chủ
  await page.click('#btn-save-analysis');
  const m = await findMeeting('Họp mind map');
  await until(async () => JSON.stringify((await api('GET', `/api/meetings/${m.id}`)).data.analysis.mindmap).includes('Nhánh đã sửa'), 'mind map đã sửa được lưu');
  const [md] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-md')]);
  const text = fs.readFileSync(await md.path(), 'utf8');
  assert(text.startsWith('# Họp mind map') && text.includes('Nhánh đã sửa') && text.includes('## Sơ đồ tư duy') && text.includes('## Văn bản'), 'file Markdown xuất ra đúng nội dung');
});

/* Theo dõi các luồng micro trang đã mở. Hộp thoại xin quyền thật luôn có độ trễ: giả lập để lộ lỗi bấm lặp. */
async function withFakeMic(page) {
  await page.addInitScript(() => {
    window.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { await new Promise((r) => setTimeout(r, 200)); const s = await orig(c); window.__streams.push(s); return s; };
  });
}
const RECORDING = /^Đang ghi/;   // "Đang ghi và chuyển thành văn bản…" hoặc "Đang ghi âm…"
const recState = (page) => page.textContent('#rec-state');
const waitRecording = (page, message) => until(async () => RECORDING.test(await recState(page)), message || 'bắt đầu ghi');
const say = (page, text) => page.evaluate((t) => window.__say(t), text);
const liveTracks = (page) => page.evaluate(() => window.__streams.reduce((n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0));

const SPOKEN = ['hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới', 'kế hoạch ra mắt dự kiến vào tháng 12',
  'khách hàng đã phản hồi tốt về bản thử nghiệm', 'an sẽ phụ trách liên hệ khách hàng lớn trước thứ sáu',
  'chúng ta thống nhất chốt ngân sách 500 triệu cho chiến dịch', 'bình phải gửi báo cáo tiến độ vào ngày 15 tháng 11',
  'bộ phận marketing cần chuẩn bị chiến dịch quảng cáo cho sản phẩm mới'];

step('ghi-am: nói → văn bản hiện ngay → xem trước → dừng là tự tóm tắt và vẽ sơ đồ tư duy', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.fill('#meeting-participants', 'An, Bình');
  await page.click('#btn-record');
  await waitRecording(page);
  eq(await recState(page), 'Đang ghi và chuyển thành văn bản…', 'dòng trạng thái khi vừa ghi vừa nhận dạng');
  assert(await page.isEnabled('#btn-pause') && await page.isEnabled('#btn-stop'), 'nút tạm dừng và dừng bật');
  eq(await page.evaluate(() => [window.__sr.lang, window.__sr.continuous]), ['vi-VN', true], 'ngôn ngữ và chế độ nhận dạng');
  // phần đang nói dở hiện màu nhạt, câu đã chốt thành văn bản có viết hoa và dấu chấm
  await page.evaluate(() => window.__partial('hôm nay chúng ta'));
  eq(await page.textContent('#live-transcript .interim'), 'hôm nay chúng ta', 'phần đang nói dở');
  await say(page, SPOKEN[0]);
  eq(await page.textContent('#live-transcript'), 'Hôm nay chúng ta họp về kế hoạch ra mắt sản phẩm mới. ', 'câu đầu tiên');
  assert(await page.isHidden('#live-preview'), 'mới một câu thì chưa xem trước');
  for (const sentence of SPOKEN.slice(1, 5)) await say(page, sentence);
  // xem trước tự cập nhật trong lúc nói, không gọi máy chủ
  const calls = page.apiCalls.length;
  await until(() => page.evaluate(() => !document.querySelector('#live-preview').hidden && document.querySelectorAll('#live-summary li').length >= 3
    && document.querySelectorAll('#live-mindmap .mm-node').length >= 5), 'xem trước ý chính và sơ đồ tư duy');
  eq(await page.locator('#live-mindmap .mm-node.root > text').textContent(), 'Kế hoạch ra mắt sản phẩm mới', 'gốc sơ đồ xem trước lấy từ câu mở đầu');
  eq(page.apiCalls.length, calls, 'số lời gọi máy chủ khi xem trước');
  await page.locator('#live-mindmap .mm-node:not(.root)').first().dblclick();
  eq(await page.locator('.mm-editor').count(), 0, 'sơ đồ xem trước chỉ để xem, không sửa được');
  // dịch vụ nhận dạng tự ngắt (im lặng, hết phiên): tự chạy lại, không mất chữ, người dùng không phải làm gì
  await page.evaluate(() => { window.__partial('bình phải gửi'); window.__srEnd(); });
  await until(() => page.evaluate(() => window.__sr.starts === 2 && !!window.__sr.active), 'bộ nhận dạng tự chạy lại');
  assert((await page.textContent('#live-transcript')).includes('Bình phải gửi.'), 'phần đang nói dở lúc dịch vụ ngắt được giữ lại');
  eq(await recState(page), 'Đang ghi và chuyển thành văn bản…', 'vẫn đang ghi sau khi dịch vụ tự chạy lại');
  await until(async () => (await page.textContent('#rec-timer')) >= '00:01', 'đồng hồ chạy', 5000);
  // tạm dừng: đồng hồ đứng, nhận dạng dừng; tiếp tục: chạy lại
  await page.click('#btn-pause');
  const t1 = await page.textContent('#rec-timer');
  await until(() => page.evaluate(() => !window.__sr.active), 'nhận dạng dừng khi tạm dừng');
  await page.waitForTimeout(1300);
  eq(await page.textContent('#rec-timer'), t1, 'đồng hồ đứng yên khi tạm dừng');
  eq(await page.textContent('#btn-pause'), '▶ Tiếp tục', 'nhãn nút khi tạm dừng');
  await page.click('#btn-pause');
  await until(() => page.evaluate(() => window.__sr.starts === 3 && !!window.__sr.active), 'nhận dạng chạy lại sau khi tiếp tục');
  await say(page, SPOKEN[5]);
  await page.evaluate(() => window.__partial('bộ phận marketing cần chuẩn bị chiến dịch'));   // đang nói dở thì bấm dừng
  await page.click('#btn-stop');
  // dừng là tự xử lý: không phải bấm thêm nút nào
  await until(() => page.evaluate(() => document.querySelector('#tab-result').classList.contains('active')
    && document.querySelector('#result-status').hidden && !document.querySelector('#result-body').hidden), 'tự mở kết quả sau khi dừng', 10000);
  eq(await liveTracks(page), 0, 'micro đã tắt sau khi dừng');
  eq(await page.inputValue('#result-title'), 'Kế hoạch ra mắt sản phẩm mới', 'tiêu đề tự đặt theo nội dung');
  const transcript = await page.inputValue('#edit-transcript');
  assert(transcript.startsWith('Hôm nay chúng ta họp về') && transcript.endsWith('Bộ phận marketing cần chuẩn bị chiến dịch.'), `văn bản đủ từ đầu tới câu nói dở cuối: ${transcript.slice(-80)}`);
  eq(await page.textContent('#transcript-source'), '(nhận dạng trực tiếp khi nói)', 'nguồn văn bản');
  assert((await page.inputValue('#edit-summary')).split('\n').length >= 3, 'có ý chính');
  assert((await page.inputValue('#edit-decisions')).includes('500 triệu'), 'có quyết định');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#actions-table tbody tr')).map((tr) =>
    [tr.querySelector('.a-task').value, tr.querySelector('.a-owner').value, tr.querySelector('.a-due').value]));
  assert(rows.some((r) => r[1] === 'An' && r[2] === 'trước thứ sáu') && rows.some((r) => r[1] === 'Bình' && r[2] === 'ngày 15 tháng 11'), `việc cần làm có người và hạn: ${JSON.stringify(rows)}`);
  assert((await page.locator('#mindmap .mm-node').count()) >= 6, 'sơ đồ tư duy có nút');
  // máy tính: vẫn ghi kèm file âm thanh để nghe lại
  const m = await findMeeting('Kế hoạch ra mắt sản phẩm mới');
  const full = (await api('GET', `/api/meetings/${m.id}`)).data;
  eq([full.status, full.has_audio, full.transcript_source, full.engine], ['done', true, 'browser', 'heuristic'], 'cuộc họp trên máy chủ');
  assert(full.duration_sec > 1 && full.duration_sec < 60, `thời lượng hợp lý (${full.duration_sec})`);
  const audio = await fetch(`${API}/api/meetings/${m.id}/audio`);
  eq(audio.headers.get('content-type'), 'audio/webm', 'kiểu nội dung âm thanh phát lại');
  assert((await audio.arrayBuffer()).byteLength > 1000, 'âm thanh trên máy chủ có dữ liệu');
  await page.click('.tab[data-tab="record"]');
  assert(await page.isHidden('#progress') && await page.isHidden('#preview') && await page.isHidden('#live-preview') && await page.isHidden('#live-transcript'), 'tab ghi âm được dọn sau khi xử lý xong');
  eq(await recState(page), 'Sẵn sàng. Nhấn nút đỏ để bắt đầu.', 'dòng trạng thái về ban đầu');
});

step('ghi-am-tay: tắt tự động thì dừng xong được nghe lại rồi mới bấm xử lý; không nhận dạng được gì thì báo rõ', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.uncheck('#auto-process');
  await page.fill('#meeting-title', 'Bản ghi xử lý tay');
  await page.click('#btn-record');
  await waitRecording(page);
  for (const sentence of SPOKEN.slice(0, 3)) await say(page, sentence);
  await page.waitForTimeout(1200);
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  eq(await liveTracks(page), 0, 'micro đã tắt sau khi dừng');
  assert(/MB · 00:0\d · 32 từ đã nhận dạng/.test(await page.textContent('#preview-info')), `thông tin bản ghi: ${await page.textContent('#preview-info')}`);
  eq(await recState(page), 'Đã dừng. Nhấn "Tóm tắt & vẽ sơ đồ tư duy" để xử lý.', 'hướng dẫn sau khi dừng');
  const size = await page.evaluate(async () => (await (await fetch(document.querySelector('#audio-preview').src)).blob()).size);
  assert(size > 1000, `bản ghi nghe lại được (${size} byte)`);
  assert(!(await findMeeting('Bản ghi xử lý tay')), 'chưa bấm xử lý thì chưa gửi gì đi');
  await page.reload();
  await page.waitForSelector('#btn-new-meeting');
  assert(!(await page.isChecked('#auto-process')), 'lựa chọn tắt tự động được nhớ sau khi tải lại trang');
  // ghi lại rồi bấm xử lý
  await page.fill('#meeting-title', 'Bản ghi xử lý tay');
  await page.click('#btn-record');
  await waitRecording(page);
  for (const sentence of SPOKEN.slice(0, 4)) await say(page, sentence);
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  await page.click('#btn-process');
  await waitResult(page, 'Bản ghi xử lý tay');
  // ghi mà không nói gì: không tạo cuộc họp rỗng
  await page.click('.tab[data-tab="record"]');
  await page.fill('#meeting-title', 'Im lặng');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('không có micro')); });
  await page.click('#btn-record');     // không mở được micro để ghi file nhưng nhận dạng vẫn chạy
  await waitRecording(page);
  await page.click('#btn-stop');
  await until(async () => /Không nhận dạng được lời nói nào/.test(await recState(page)), 'báo không nhận dạng được gì');
  assert(await page.isHidden('#preview') && !(await findMeeting('Im lặng')), 'không tạo cuộc họp rỗng');
});

step('ghi-am-loi: dịch vụ nhận dạng lỗi thì báo bằng câu dễ hiểu, bản ghi âm vẫn được giữ', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.fill('#meeting-title', 'Nhận dạng bị lỗi');
  await page.click('#btn-record');
  await waitRecording(page);
  await say(page, SPOKEN[0]);
  // trình duyệt thu hồi quyền nhận dạng giữa chừng
  await page.evaluate(() => { window.__srError('not-allowed'); window.__srEnd(); });
  await until(() => page.evaluate(() => document.querySelector('#toast').classList.contains('error') && /quyền/.test(document.querySelector('#toast').textContent)), 'báo thiếu quyền');
  assert((await page.textContent('#toast')).includes('Bản ghi âm vẫn tiếp tục'), 'cho biết bản ghi âm vẫn chạy');
  eq(await recState(page), 'Đang ghi âm (đã ngừng chuyển thành văn bản)…', 'dòng trạng thái sau khi nhận dạng dừng');
  eq(await page.evaluate(() => window.__sr.starts), 1, 'không tự chạy lại sau lỗi quyền');
  await page.waitForTimeout(1100);
  await page.click('#btn-stop');
  // câu đã nhận dạng trước khi lỗi vẫn được dùng
  await waitResult(page, 'Nhận dạng bị lỗi');
  assert((await page.inputValue('#edit-transcript')).startsWith('Hôm nay chúng ta họp về'), 'văn bản trước khi lỗi được giữ');
  // mạng chập chờn: thử lại vài lần rồi mới bỏ cuộc
  await page.click('.tab[data-tab="record"]');
  await page.fill('#meeting-title', 'Mất mạng nhận dạng');
  await page.click('#btn-record');
  await waitRecording(page);
  for (let i = 1; i <= 2; i++) {
    const before = await page.evaluate(() => window.__sr.starts);
    await page.evaluate(() => { window.__srError('network'); window.__srEnd(); });
    await until(() => page.evaluate((b) => window.__sr.starts === b + 1 && !!window.__sr.active, before), `tự thử lại lần ${i} khi lỗi mạng`);
  }
  await page.evaluate(() => { window.__srError('network'); window.__srEnd(); });
  await until(() => page.evaluate(() => /không kết nối được/.test(document.querySelector('#toast').textContent)), 'báo dịch vụ nhận dạng không kết nối được');
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  eq(await recState(page), 'Đã dừng. Bản ghi chỉ có âm thanh, chưa có văn bản để tóm tắt.', 'không có văn bản thì không tự xử lý');
  await page.click('#btn-discard');
});

step('ghi-am-mp4: trình duyệt chỉ ghi được audio/mp4 (như iOS) vẫn tải lên và phát lại đúng kiểu', async (ctx) => {
  const page = ctx.page = await open(null, PHONE, { speech: 'none' });
  await page.addInitScript(() => {
    // iOS (WKWebView/Safari) không ghi được webm/ogg, chỉ có audio/mp4
    const orig = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    window.__mp4Supported = orig('audio/mp4');
    MediaRecorder.isTypeSupported = (t) => !/webm|ogg/.test(t) && orig(t);
  });
  await page.goto(API + '/');
  if (!(await page.evaluate(() => window.__mp4Supported))) { ctx.skip = 'Chromium này không ghi được audio/mp4'; return; }
  await page.fill('#meeting-title', 'Bản ghi mp4');
  await page.tap('#btn-record');
  await waitRecording(page, 'bắt đầu ghi mp4');
  eq(await recState(page), 'Đang ghi âm…', 'không có nhận dạng thì chỉ ghi âm');
  await page.waitForTimeout(1500);
  await page.tap('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  const local = await page.evaluate(async () => { const b = await (await fetch(document.querySelector('#audio-preview').src)).blob(); return { size: b.size, type: b.type }; });
  assert(local.size > 500 && local.type.startsWith('audio/mp4'), `bản ghi là audio/mp4 có dữ liệu (${JSON.stringify(local)})`);
  // không Whisper, không nhận dạng trực tiếp: không tự gửi đi; người dùng vẫn bấm xử lý được và nhận lời giải thích
  eq(await recState(page), 'Đã dừng. Bản ghi chỉ có âm thanh, chưa có văn bản để tóm tắt.', 'không tự xử lý bản ghi không có văn bản');
  await page.tap('#btn-process');
  await until(() => page.evaluate(() => document.querySelector('#tab-result').classList.contains('active') && /faster-whisper/.test(document.querySelector('#result-status').textContent)), 'giải thích vì sao chưa có văn bản');
  const m = await findMeeting('Bản ghi mp4');
  eq([m.status, m.has_audio], ['error', true], 'trạng thái cuộc họp trên máy chủ');
  const audio = await fetch(`${API}/api/meetings/${m.id}/audio`);
  eq(audio.headers.get('content-type'), 'audio/mp4', 'kiểu nội dung phát lại');
  const bytes = Buffer.from(await audio.arrayBuffer());
  eq(bytes.length, local.size, 'kích thước file trên máy chủ');
  eq(bytes.subarray(4, 8).toString('latin1'), 'ftyp', 'file trên máy chủ là MP4 thật (hộp ftyp)');
  assert(m.duration_sec > 1 && m.duration_sec < 30, `thời lượng hợp lý (${m.duration_sec})`);
});

step('ghi-am-bam-lap: bấm đúp nút ghi không mở hai luồng micro', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.dblclick('#btn-record');
  await page.waitForTimeout(900);
  eq(await page.evaluate(() => window.__streams.length), 1, 'số lần mở micro sau khi bấm đúp');
  // dù đang ghi hay đã dừng, không được còn luồng micro mồ côi
  if (await page.isEnabled('#btn-stop')) await page.click('#btn-stop');
  await page.waitForTimeout(300);
  eq(await liveTracks(page), 0, 'micro còn bật sau khi dừng');
  eq(await page.evaluate(() => !!window.__sr.active), false, 'bộ nhận dạng còn chạy sau khi dừng');
  // tạo cuộc họp mới giữa lúc ghi: hủy bản ghi, tắt micro và nhận dạng, không hiện bản xem trước, không tự gửi đi
  await page.click('#btn-record');
  await waitRecording(page, 'ghi lần hai');
  await say(page, SPOKEN[0]);
  const before = ((await api('GET', '/api/meetings')).data || []).length;
  await page.click('#btn-new-meeting');
  await page.waitForTimeout(500);
  eq(await liveTracks(page), 0, 'micro tắt khi tạo cuộc họp mới');
  eq(await page.evaluate(() => !!window.__sr.active), false, 'nhận dạng tắt khi tạo cuộc họp mới');
  assert(await page.isHidden('#preview') && await page.isHidden('#live-transcript'), 'bản ghi dở bị hủy');
  eq(((await api('GET', '/api/meetings')).data || []).length, before, 'bản ghi đã hủy không được gửi đi');
});

step('ghi-am-ngat: micro bị ngắt giữa chừng thì dừng và giữ phần đã ghi; đóng trang khi còn bản ghi thì hỏi lại', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  // chưa có gì để mất: rời trang không bị hỏi
  let asked = 0;
  page.on('dialog', async (d) => { if (d.type() === 'beforeunload') { asked += 1; await d.dismiss(); } else await d.accept(); });
  await page.click('#btn-record');
  await waitRecording(page);
  await say(page, SPOKEN[0]);
  await page.waitForTimeout(1300);
  // hệ điều hành thu hồi micro (rút tai nghe, app khác chiếm, thu hồi quyền)
  await page.evaluate(() => window.__streams[0].getAudioTracks()[0].dispatchEvent(new Event('ended')));
  await page.waitForSelector('#preview:not([hidden])');
  assert(/Micro bị ngắt lúc 00:0\d/.test(await recState(page)), 'báo micro bị ngắt kèm thời điểm');
  assert(await page.isDisabled('#btn-stop') && await page.isDisabled('#btn-pause'), 'giao diện về trạng thái đã dừng');
  eq(await page.evaluate(() => !!window.__sr.active), false, 'nhận dạng dừng theo');
  const t = await page.textContent('#rec-timer');
  await page.waitForTimeout(700);
  eq(await page.textContent('#rec-timer'), t, 'đồng hồ không chạy tiếp');
  const size = await page.evaluate(async () => (await (await fetch(document.querySelector('#audio-preview').src)).blob()).size);
  assert(size > 500, `phần đã ghi được giữ (${size} byte)`);
  assert(/từ đã nhận dạng/.test(await page.textContent('#preview-info')), 'phần văn bản đã nhận dạng được giữ');
  // bị ngắt ngoài ý muốn thì không tự gửi đi: để người dùng quyết định
  await page.waitForTimeout(600);
  eq(await activeTab(page), 'record', 'không tự xử lý bản ghi bị ngắt');
  // còn bản ghi chưa gửi: đóng trang phải hỏi lại
  await page.close({ runBeforeUnload: true });
  await until(() => asked === 1, 'hộp thoại xác nhận rời trang');
  assert(!page.isClosed(), 'trang còn mở sau khi người dùng chọn ở lại');
  await page.click('#btn-discard');
  await page.close({ runBeforeUnload: true });
  await until(() => page.isClosed(), 'không còn gì để mất thì đóng trang ngay');
  eq(asked, 1, 'số lần bị hỏi');
});

step('phu-de: văn bản của bản ghi trước không dính vào file tải lên sau', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP, { auto: ['phụ đề của bản ghi trước'] });
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.uncheck('#auto-process');
  await page.click('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#live-transcript').textContent.includes('Phụ đề của bản ghi trước.')), 'văn bản trực tiếp hiện');
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  await page.setInputFiles('#audio-file', { name: 'họp tuần 45.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3-fake-mp3-data') });
  eq(await page.inputValue('#meeting-title'), 'họp tuần 45', 'tiêu đề lấy từ tên file');
  assert(await page.isHidden('#live-transcript'), 'ẩn văn bản của bản ghi trước khi chọn file khác');
  assert(/chỉ lưu lại để nghe/.test(await page.textContent('#file-note')), 'nói rõ file có sẵn không tự chuyển thành văn bản khi chưa có Whisper');
  await page.click('#btn-process');
  await until(async () => { const m = await findMeeting('họp tuần 45'); return m && ['error', 'done'].includes(m.status); }, 'file tải lên được xử lý xong');
  const m = await findMeeting('họp tuần 45');
  const full = (await api('GET', `/api/meetings/${m.id}`)).data;
  eq(full.transcript || '', '', 'văn bản của file tải lên (không được là văn bản của bản ghi trước)');
  eq(full.status, 'error', 'không có Whisper và không có văn bản thì phải báo lỗi, không tóm tắt nội dung của bản ghi khác');
});

step('nen-xong-muon: bản ghi mới không bị xóa khi cuộc họp trước xử lý xong', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  const held = await holdProcessing(page);
  await page.goto(API + '/');
  await page.uncheck('#auto-process');
  held.titles.add('Họp xử lý lâu');
  await analyzeText(page, 'Họp xử lý lâu');
  await until(() => page.evaluate(() => /Đang tóm tắt/.test(document.querySelector('#progress-text').textContent)), 'đang xử lý cuộc họp đầu');
  // trong lúc chờ, ghi âm cuộc họp tiếp theo và gõ ghi chú mới
  await page.fill('#meeting-title', 'Họp thứ hai');
  await page.click('#btn-record');
  await waitRecording(page, 'ghi bản thứ hai');
  await say(page, SPOKEN[2]);
  await page.waitForTimeout(1200);
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  await page.fill('#manual-transcript', 'ghi chú đang gõ dở cho cuộc họp thứ hai');
  held.titles.delete('Họp xử lý lâu');
  await until(() => page.isHidden('#progress'), 'cuộc họp đầu xử lý xong');
  await page.waitForTimeout(300);
  eq(await activeTab(page), 'record', 'không bị kéo khỏi tab ghi âm khi còn bản ghi chưa gửi');
  assert(/Họp xử lý lâu.*xử lý xong/.test(await page.textContent('#toast')), 'có thông báo cuộc họp trước đã xong');
  assert(await page.isVisible('#preview'), 'bản ghi thứ hai còn nguyên');
  assert((await page.textContent('#live-transcript')).includes('Khách hàng đã phản hồi tốt'), 'văn bản của bản ghi thứ hai còn nguyên');
  eq(await page.inputValue('#manual-transcript'), 'ghi chú đang gõ dở cho cuộc họp thứ hai', 'ghi chú đang gõ còn nguyên');
  assert(await page.isEnabled('#btn-process'), 'xử lý được bản ghi thứ hai');
  await page.click('#btn-process');
  await until(async () => { const m = await findMeeting('Họp thứ hai'); return m && m.has_audio && m.status === 'done'; }, 'bản ghi thứ hai được tải lên và xử lý');
});

step('polling: hai cuộc họp xử lý cùng lúc không làm kẹt thanh tiến trình', async (ctx) => {
  await seedMeeting('Họp cũ để phân tích lại');
  const page = ctx.page = await open(null, DESKTOP);
  const held = await holdProcessing(page);
  await page.goto(API + '/');
  held.titles.add('Họp đang chạy');
  await analyzeText(page, 'Họp đang chạy');
  await until(() => page.evaluate(() => /Đang tóm tắt/.test(document.querySelector('#progress-text').textContent)), 'đang xử lý');
  await page.click('#meeting-list li:has-text("Họp cũ để phân tích lại")');
  await waitResult(page, 'Họp cũ để phân tích lại');
  await page.fill('#edit-summary', '- đang sửa dở, đừng kéo tôi đi');
  await page.click('#btn-reanalyze');
  await until(() => page.evaluate(() => document.querySelector('#result-status').hidden && document.querySelector('#edit-summary').value.split('\n').length >= 3), 'phân tích lại cuộc họp cũ xong');
  await page.fill('#edit-summary', '- đang sửa dở, đừng kéo tôi đi');
  held.titles.delete('Họp đang chạy');
  await until(() => page.evaluate(() => /Họp đang chạy.*xử lý xong/.test(document.querySelector('#toast').textContent)), 'báo cuộc họp kia đã xong');
  eq(await page.inputValue('#result-title'), 'Họp cũ để phân tích lại', 'vẫn ở cuộc họp đang xem');
  eq(await page.inputValue('#edit-summary'), '- đang sửa dở, đừng kéo tôi đi', 'nội dung đang sửa còn nguyên');
  await page.click('.tab[data-tab="record"]');
  assert(await page.isHidden('#progress'), 'thanh tiến trình không kẹt');
  assert(await page.isEnabled('#btn-analyze-text') && await page.isEnabled('#btn-process'), 'các nút xử lý bật lại');
  eq(await page.inputValue('#manual-transcript'), '', 'ô transcript đã xử lý được dọn');
});

step('mang: mất mạng thoáng qua lúc polling không làm kẹt, mất hẳn thì báo lỗi', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  const held = await holdProcessing(page);
  let dropNext = 0;
  await page.route(/\/api\/meetings\/[0-9a-f]{12}$/, (route) => {
    if (route.request().method() === 'GET' && dropNext > 0) { dropNext -= 1; return route.abort('internetdisconnected'); }
    return route.fallback();
  });
  await page.goto(API + '/');
  held.titles.add('Họp mạng chập chờn');
  await analyzeText(page, 'Họp mạng chập chờn');
  await until(() => page.evaluate(() => /Đang tóm tắt/.test(document.querySelector('#progress-text').textContent)), 'đang xử lý');
  dropNext = 2;
  await until(() => dropNext === 0, 'hai lần hỏi trạng thái bị rớt', 10000);
  held.titles.delete('Họp mạng chập chờn');
  await waitResult(page, 'Họp mạng chập chờn');
  assert(await page.isHidden('#progress'), 'thanh tiến trình tắt sau khi mạng có lại');
  // mất hẳn: tạo cuộc họp thất bại -> báo lỗi, không kẹt nút
  await page.route(/\/api\//, (route) => route.abort('internetdisconnected'));
  await analyzeText(page, 'Họp không có mạng');
  await until(() => page.evaluate(() => document.querySelector('#toast').classList.contains('error') && /Không kết nối được server/.test(document.querySelector('#toast').textContent)), 'báo lỗi kết nối');
  assert(await page.isHidden('#progress') && await page.isEnabled('#btn-analyze-text'), 'không kẹt trạng thái đang xử lý');
  eq(await page.inputValue('#manual-transcript'), VI, 'giữ nguyên nội dung người dùng đã dán');
}, { allow: /ERR_INTERNET_DISCONNECTED|Failed to load resource/ });

step('dieu-huong: bấm nhanh hai cuộc họp thì hiện cuộc họp bấm sau', async (ctx) => {
  const a = await seedMeeting('Họp A trả lời chậm');
  await seedMeeting('Họp B trả lời nhanh');
  const page = ctx.page = await open(null, DESKTOP);
  await page.route(new RegExp(`/api/meetings/${a}$`), async (route) => { await new Promise((r) => setTimeout(r, 700)); return route.fallback(); });
  await page.goto(API + '/');
  await page.waitForSelector('#meeting-list li:has-text("Họp A trả lời chậm")');
  await page.click('#meeting-list li:has-text("Họp A trả lời chậm")');
  await page.click('#meeting-list li:has-text("Họp B trả lời nhanh")');
  await page.waitForTimeout(1200);
  eq(await page.inputValue('#result-title'), 'Họp B trả lời nhanh', 'cuộc họp đang hiển thị');
  eq(await page.textContent('#meeting-list li.active .title'), 'Họp B trả lời nhanh', 'mục đang chọn trong danh sách');
  // tìm kiếm: có kết quả, không có kết quả (trạng thái rỗng nói rõ)
  await page.fill('#search-meetings', 'trả lời nhanh');
  await until(() => page.evaluate(() => document.querySelectorAll('#meeting-list li .title').length === 1), 'lọc còn một cuộc họp');
  await page.fill('#search-meetings', 'chuỗi-không-tồn-tại');
  await until(() => page.evaluate(() => /Không tìm thấy/.test(document.querySelector('#meeting-list').textContent)), 'trạng thái rỗng của tìm kiếm');
});

step('ban-phim: dùng được bằng bàn phím, nút có tên trợ năng', async (ctx) => {
  await seedMeeting('Họp bàn phím');
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.waitForSelector('#meeting-list li:has-text("Họp bàn phím")');
  await page.focus('#meeting-list li:has-text("Họp bàn phím")');
  await page.keyboard.press('Enter');
  await waitResult(page, 'Họp bàn phím');
  const unnamed = await page.evaluate(() => Array.from(document.querySelectorAll('button, input:not([type=hidden]), select, textarea'))
    .filter((n) => n.offsetParent !== null)
    .filter((n) => {
      const text = n.tagName === 'BUTTON' ? n.textContent.replace(/[^\p{L}\p{N}]/gu, '') : '';
      const label = n.getAttribute('aria-label') || n.getAttribute('aria-labelledby') || n.getAttribute('title') || (n.labels && n.labels.length ? 'x' : '');
      return !text && !label;
    }).map((n) => n.id || n.className || n.outerHTML.slice(0, 60)));
  eq(unnamed, [], 'phần tử tương tác thiếu tên trợ năng ở tab kết quả');
  await page.click('.tab[data-tab="record"]');
  eq(await page.getAttribute('#btn-record', 'aria-label'), 'Bắt đầu ghi âm', 'nhãn nút ghi âm');
  eq(await page.getAttribute('#toast', 'role'), 'status', 'thông báo có role để trình đọc màn hình đọc');
  // Enter trong ô hỏi trí nhớ gửi câu hỏi; phím tắt không ăn vào ô nhập
  await page.click('.tab[data-tab="learning"]');
  await page.fill('#ask-input', 'ngân sách chiến dịch');
  await page.press('#ask-input', 'Enter');
  await until(() => page.evaluate(() => !document.querySelector('#ask-answer').hidden && document.querySelectorAll('#ask-sources li').length > 0), 'Enter gửi câu hỏi');
  await page.fill('#glossary-term', 'Nguyễn Minh Quang');
  await page.press('#glossary-term', 'Enter');
  await until(() => page.evaluate(() => document.querySelector('#glossary-table').textContent.includes('Nguyễn Minh Quang')), 'Enter thêm thuật ngữ');
  await page.locator('#glossary-table tr:has-text("Nguyễn Minh Quang") button').click();
  await until(() => page.evaluate(() => !document.querySelector('#glossary-table').textContent.includes('Nguyễn Minh Quang')), 'xóa thuật ngữ');
});

step('chu-dai: chữ rất dài không dấu cách không đẩy nút ra khỏi thẻ, không tràn ngang', async (ctx) => {
  const long = 'Thuậtngữrấtdàikhôngcódấucách'.repeat(4).slice(0, 110);
  await api('POST', '/api/glossary', { term: `${long}-đúng`, variant: `${long}-sai` });
  const id = await seedMeeting('Tiêuđềrấtdàikhôngcódấucách'.repeat(7));
  await api('PUT', `/api/meetings/${id}/analysis`, { summary: ['Ýchínhkhôngcódấucách'.repeat(12)], keywords: ['từkhóadài'.repeat(6)],
    action_items: [{ task: 'Việc'.repeat(60), owner: 'Ngườiphụtrách'.repeat(5), due: 'hạn'.repeat(20) }] });
  await api('POST', `/api/meetings/${id}/rating`, { rating: 5, comment: 'gópýkhôngdấucách'.repeat(40) });
  for (const viewport of [DESKTOP, PHONE]) {
    const page = ctx.page = await open(API + '/', viewport);
    await page.click('.tab[data-tab="learning"]');
    const btn = page.locator(`#glossary-table tr:has-text("${long}-đúng") button`);
    await btn.waitFor();
    const reachable = await btn.evaluate((b) => {
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect(), card = b.closest('.card').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { insideCard: r.right <= card.right + 1 && r.left >= card.left - 1, hit: hit === b };
    });
    eq(reachable, { insideCard: true, hit: true }, `nút xóa thuật ngữ bấm được (${viewport.width}px)`);
    assert(await noOverflow(page), `tab học hỏi không tràn ngang (${viewport.width}px)`);
    await page.click('#meeting-list li >> nth=0');
    await page.waitForSelector('#result-body:not([hidden])');
    assert(await noOverflow(page), `tab kết quả không tràn ngang (${viewport.width}px)`);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#tab-result .card')).filter((c) => c.scrollWidth > c.clientWidth + 1).length);
    eq(cards, 0, `số thẻ bị nội dung đẩy tràn (${viewport.width}px)`);
    if (viewport === DESKTOP) await page.context().close();
  }
  await api('DELETE', `/api/meetings/${id}`);
  for (const g of (await api('GET', '/api/glossary')).data) if (g.term.startsWith(long)) await api('DELETE', `/api/glossary/${g.id}`);
});

step('gioi-han: nhập dài quá giới hạn của máy chủ thì ô nhập tự chặn, không hiện lỗi JSON thô', async (ctx) => {
  const page = ctx.page = await open(API + '/', DESKTOP);
  // Giới hạn của API: tiêu đề 200, góp ý 1000, thuật ngữ 120, câu hỏi 1000 ký tự
  await analyzeText(page, 'Tiêu đề rất dài '.repeat(30));
  const toastText = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t.hidden ? '' : t.textContent; });
  await until(async () => (await activeTab(page)) === 'result' || (await toastText()) !== '', 'có kết quả hoặc thông báo');
  const shown = await toastText();
  assert(!/string_too_long|"loc"/.test(shown), `không hiện lỗi kiểm tra dữ liệu dạng JSON thô: ${shown.slice(0, 120)}`);
  await until(() => page.evaluate(() => document.querySelector('#result-status').hidden && !document.querySelector('#result-body').hidden), 'hiện kết quả');
  const kept = (await page.inputValue('#result-title')).length;   // máy chủ bỏ dấu cách cuối nên có thể là 199
  assert(kept >= 199 && kept <= 200, `tiêu đề được cắt ở 200 ký tự (nhận ${kept})`);
  await page.fill('#result-title', 'Đổi tên dài '.repeat(40));
  await page.locator('#result-title').blur();
  await page.click('#stars button[data-v="5"]');
  await page.fill('#rating-comment', 'góp ý dài '.repeat(200));
  await page.click('#btn-rate');
  await until(() => page.evaluate(() => document.querySelector('#rating-msg').textContent.trim() !== ''), 'đánh giá kèm góp ý dài được ghi nhận');
  await page.click('.tab[data-tab="learning"]');
  await page.fill('#glossary-term', 'Thuật ngữ dài '.repeat(20));
  await page.fill('#glossary-variant', 'dạng sai dài '.repeat(20));
  await page.press('#glossary-term', 'Enter');
  await until(async () => (await api('GET', '/api/glossary')).data.some((g) => g.term.startsWith('Thuật ngữ dài') && g.term.length <= 120 && g.variant.length <= 120),
    'thuật ngữ dài được thêm sau khi ô nhập chặn ở 120 ký tự');
  await page.fill('#ask-input', 'ngân sách chiến dịch '.repeat(80));
  await page.press('#ask-input', 'Enter');
  await until(() => page.evaluate(() => !document.querySelector('#ask-answer').hidden), 'câu hỏi dài vẫn có trả lời');
  assert(!(await page.textContent('#ask-answer')).startsWith('Lỗi'), 'trả lời không phải thông báo lỗi');
  const renamed = await findMeeting('Đổi tên dài '.repeat(40).slice(0, 200).trim());
  assert(renamed, 'tiêu đề mới (cắt ở 200 ký tự) đã được lưu');
  await api('DELETE', `/api/meetings/${renamed.id}`);
  for (const g of (await api('GET', '/api/glossary')).data) if (g.term.startsWith('Thuật ngữ dài')) await api('DELETE', `/api/glossary/${g.id}`);
});

step('ngon-ngu: tiếng Anh và transcript không dấu câu vẫn ra kết quả', async (ctx) => {
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.selectOption('#meeting-language', 'en');
  await analyzeText(page, 'English sync', 'Today we reviewed the launch plan for the new product. The launch plan is scheduled for December. ' +
    'Anna will contact the key customers by Friday. We agreed to approve the marketing budget. The marketing team should prepare the campaign next week.');
  await waitResult(page, 'English sync');
  assert(/launch plan/i.test(await page.inputValue('#edit-keywords')), 'từ khóa tiếng Anh');
  assert((await page.inputValue('#edit-decisions')).includes('agreed'), 'quyết định tiếng Anh');
  eq(await page.locator('#actions-table tbody tr .a-owner').first().inputValue(), 'Anna', 'người phụ trách');
  await page.click('.tab[data-tab="record"]');
  await page.selectOption('#meeting-language', 'vi');
  const flat = VI.replace(/[.,]/g, '').toLowerCase().repeat(3);
  await analyzeText(page, 'Không dấu câu', flat);
  await waitResult(page, 'Không dấu câu');
  const summary = (await page.inputValue('#edit-summary')).split('\n');
  assert(summary.length >= 3 && summary.every((s) => s.length < 200), `tóm tắt được tách thành ý ngắn (${summary.length} ý)`);
  assert((await page.locator('#mindmap .mm-node').count()) >= 4, 'mind map có nút');
});

step('dien-thoai: bố cục 390px không tràn ngang, mind map đọc được', async (ctx) => {
  await seedMeeting('Họp trên điện thoại');
  const page = ctx.page = await open(API + '/', PHONE);
  assert(await noOverflow(page), 'tab ghi âm không tràn ngang');
  await page.tap('#meeting-list li:has-text("Họp trên điện thoại")');
  await waitResult(page, 'Họp trên điện thoại');
  assert(await noOverflow(page), 'tab kết quả không tràn ngang');
  const mm = await page.evaluate(() => {
    const t = document.querySelector('#mindmap svg > g').getAttribute('transform');
    const root = document.querySelector('#mindmap .mm-node.root').getBoundingClientRect(), c = document.querySelector('#mindmap').getBoundingClientRect();
    const nodes = Array.from(document.querySelectorAll('#mindmap .mm-node')).map((n) => n.getBoundingClientRect());
    return { scale: Number(/scale\(([\d.]+)\)/.exec(t)[1]), nodes: nodes.length,
      rootInside: root.left >= c.left && root.right <= c.right && root.top >= c.top && root.bottom <= c.bottom,
      rootOnTop: root.top - c.top < c.height / 3,   // không khẳng định từng pixel: phông trên CI rộng hơn máy phát triển
      widthFits: nodes.every((r) => r.left >= c.left - 1 && r.right <= c.right + 1) };
  });
  assert(mm.scale >= 0.55 && mm.rootInside, `mind map đủ lớn và nút gốc nằm trong khung (${JSON.stringify(mm)})`);
  // điện thoại cầm dọc: cả ba cấp vừa bề ngang (không phải kéo sang hai bên), đọc từ nút gốc ở trên cùng xuống
  assert(mm.nodes >= 8 && mm.widthFits && mm.rootOnTop, `sơ đồ vừa bề ngang màn hình, nút gốc ở trên cùng (${JSON.stringify(mm)})`);
  assert(await page.isHidden('#result-status'), 'không hiện thanh trạng thái rỗng');
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('.tab, #btn-new-meeting, #btn-reanalyze, #btn-save-analysis, #btn-delete'))
    .filter((n) => n.offsetParent !== null).map((n) => ({ id: n.id || n.dataset.tab, h: Math.round(n.getBoundingClientRect().height) })).filter((x) => x.h < 32));
  eq(small, [], 'nút chính đủ cao để chạm');
  await page.tap('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelectorAll('#stats .stat').length === 7), 'thống kê');
  assert(await noOverflow(page), 'tab học hỏi không tràn ngang');
  // xoay ngang
  await page.setViewportSize({ width: 844, height: 390 });
  await page.tap('.tab[data-tab="result"]');
  assert(await noOverflow(page), 'xoay ngang không tràn');
});

// ===================================================== bản độc lập (mobile/www)
/* Đếm số lần trang xin micro: ứng dụng di động nhận dạng trực tiếp thì không được mở micro lần thứ hai. */
async function countMic(page) {
  await page.addInitScript(() => {
    window.__gum = 0;
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__gum += 1; return orig(c); };
  });
}
const offOrigin = (page) => page.requests.filter((u) => !u.startsWith(WWW) && !u.startsWith('data:') && !u.startsWith('blob:'));
const nativeCalls = (page, name) => page.evaluate((n) => window.__native.calls.filter((c) => c[0] === n).map((c) => c[1] || null), name);
const nativeSay = (page, text) => page.evaluate((t) => window.__nativeSay(t), text);

step('doc-lap-khoi-dong: bản đóng gói tự chạy trên máy, không cần máy chủ, không gọi mạng', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', PHONE, { speech: 'native' });
  await until(() => page.evaluate(() => document.querySelector('#badge-memory').textContent === 'Lưu trên máy này'), 'huy hiệu lưu trữ');
  eq(await page.textContent('#badge-whisper'), 'Giọng nói: nhận dạng trực tiếp', 'huy hiệu giọng nói');
  eq(await page.textContent('#badge-ollama'), 'Tóm tắt: không cần AI', 'huy hiệu tóm tắt');
  assert((await page.textContent('#meeting-list')).includes('Chưa có cuộc họp nào'), 'danh sách rỗng, không còn bắt nhập địa chỉ máy chủ');
  assert(await page.isVisible('#server-box') && !(await page.evaluate(() => document.querySelector('#server-box').open)), 'mục máy chủ AI có sẵn nhưng đóng, không chắn đường');
  assert((await page.textContent('#server-summary')).includes('đang chạy độc lập'), 'cho biết đang chạy độc lập');
  assert(await page.isHidden('#file-row') && await page.isHidden('#live-captions-row'), 'ẩn các lựa chọn chỉ dùng được khi có máy chủ');
  assert(/ngay khi bạn nói.*không lưu kèm file âm thanh/.test(await page.textContent('#stt-line')), 'dòng giải thích cách nhận dạng trên điện thoại');
  assert(await noOverflow(page), 'tab ghi âm không tràn ngang');
  await page.tap('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelectorAll('#stats .stat').length === 6), 'thống kê của chế độ độc lập');
  assert((await page.textContent('#ai-setup')).includes('Đang chạy độc lập trên máy này'), 'tab học hỏi nói rõ chế độ');
  assert(await page.isHidden('#link-export-jsonl') && await page.isHidden('#btn-reindex'), 'ẩn nút chỉ dành cho máy chủ AI');
  assert(await noOverflow(page), 'tab học hỏi không tràn ngang');
  eq(offOrigin(page), [], 'request ra ngoài gói ứng dụng');
  eq(page.apiCalls, [], 'lời gọi API qua mạng');
});

step('doc-lap-ghi-am: điện thoại nói → văn bản → tóm tắt → sơ đồ tư duy bằng nhận dạng của máy, không mở micro lần hai', async (ctx) => {
  const page = ctx.page = await open(null, PHONE, { speech: 'native' });
  await countMic(page);
  await page.goto(WWW + '/');
  await page.waitForSelector('#btn-new-meeting');
  await page.fill('#meeting-participants', 'An, Bình');
  await page.tap('#btn-record');
  await until(async () => (await recState(page)) === 'Đang ghi và chuyển thành văn bản…', 'bắt đầu ghi');
  eq(await nativeCalls(page, 'start'), [{ language: 'vi-VN' }], 'gọi plugin nhận dạng với tiếng Việt');
  eq(await nativeCalls(page, 'keepAwake'), [{ on: true }], 'giữ màn hình sáng khi ghi');
  eq(await page.evaluate(() => window.__gum), 0, 'số lần trang tự mở micro (plugin đã giữ micro)');
  await page.evaluate(() => { window.__nativeEmit('level', { value: 0.8 }); window.__nativeEmit('partial', { text: 'hôm nay chúng ta' }); });
  eq(await page.textContent('#live-transcript .interim'), 'hôm nay chúng ta', 'phần đang nói dở');
  for (const sentence of SPOKEN.slice(0, 5)) await nativeSay(page, sentence);
  eq(await page.textContent('#live-transcript .interim'), '', 'câu đã chốt thì hết phần nói dở');
  await until(() => page.evaluate(() => !document.querySelector('#live-preview').hidden && document.querySelectorAll('#live-mindmap .mm-node').length >= 5), 'xem trước sơ đồ tư duy trong lúc nói');
  assert(await noOverflow(page), 'xem trước không làm tràn ngang');
  ctx.shot = await page.screenshot({ path: path.join(OUT, 'doc-lap-ghi-am-dang-noi.png'), fullPage: true });
  // chuyển sang app khác: báo đang tạm ngừng; quay lại thì ghi tiếp
  await page.evaluate(() => window.__nativeEmit('state', { listening: false, reason: 'background' }));
  assert(/không ở phía trước/.test(await recState(page)), 'báo tạm ngừng khi ứng dụng chạy nền');
  await page.evaluate(() => window.__nativeEmit('state', { listening: true }));
  eq(await recState(page), 'Đang ghi và chuyển thành văn bản…', 'ghi tiếp khi quay lại');
  // tạm dừng / tiếp tục điều khiển plugin
  await page.tap('#btn-pause');
  await until(async () => (await nativeCalls(page, 'stop')).length === 1, 'tạm dừng thì dừng plugin');
  await page.tap('#btn-pause');
  await until(async () => (await nativeCalls(page, 'start')).length === 2, 'tiếp tục thì bật lại plugin');
  await nativeSay(page, SPOKEN[5]);
  await page.waitForTimeout(1100);
  // đang nói dở thì bấm dừng: plugin trả nốt câu cuối trước khi xong
  await page.evaluate(() => { window.__native.pending = 'bộ phận marketing cần chuẩn bị chiến dịch quảng cáo cho sản phẩm mới'; });
  await page.tap('#btn-stop');
  await until(() => page.evaluate(() => document.querySelector('#tab-result').classList.contains('active')
    && document.querySelector('#result-status').hidden && !document.querySelector('#result-body').hidden), 'tự mở kết quả sau khi dừng', 10000);
  eq((await nativeCalls(page, 'keepAwake')).pop(), { on: false }, 'thôi giữ màn hình sáng khi dừng');
  eq(await page.inputValue('#result-title'), 'Kế hoạch ra mắt sản phẩm mới', 'tiêu đề tự đặt theo nội dung');
  const transcript = await page.inputValue('#edit-transcript');
  assert(transcript.startsWith('Hôm nay chúng ta họp về') && transcript.endsWith('cho sản phẩm mới.'), `văn bản đủ tới câu cuối: ${transcript.slice(-60)}`);
  eq(await page.textContent('#transcript-source'), '(nhận dạng trực tiếp khi nói)', 'nguồn văn bản');
  const meta = await page.textContent('#result-meta');
  assert(/⏱ 00:0\d/.test(meta) && meta.includes('thuật toán không cần AI') && meta.includes('An, Bình'), `meta: ${meta}`);
  assert((await page.inputValue('#edit-summary')).split('\n').length >= 3 && (await page.inputValue('#edit-decisions')).includes('500 triệu'), 'ý chính và quyết định');
  const owners = await page.evaluate(() => Array.from(document.querySelectorAll('#actions-table .a-owner')).map((i) => i.value));
  assert(owners.includes('An') && owners.includes('Bình') && owners.includes('Bộ phận marketing'), `người phụ trách: ${owners.join(', ')}`);
  assert((await page.locator('#mindmap .mm-node').count()) >= 6, 'sơ đồ tư duy có nút');
  assert(await page.isHidden('#result-audio'), 'điện thoại không lưu kèm file âm thanh');
  assert(await noOverflow(page), 'kết quả không tràn ngang');
  eq(await page.evaluate(() => window.__gum), 0, 'cả phiên không mở micro từ trang');
  // dữ liệu nằm trên máy: tải lại trang vẫn còn
  await page.reload();
  await page.waitForSelector('#meeting-list li .title');
  eq(await page.textContent('#meeting-list li .title'), 'Kế hoạch ra mắt sản phẩm mới', 'cuộc họp còn sau khi tải lại');
  await page.tap('#meeting-list li');
  await waitResult(page, 'Kế hoạch ra mắt sản phẩm mới');
  assert((await page.inputValue('#edit-transcript')) === transcript, 'văn bản còn nguyên sau khi tải lại');
  eq(offOrigin(page), [], 'request ra ngoài gói ứng dụng');
});

step('doc-lap-loi: thiếu quyền hoặc dịch vụ nhận dạng dừng giữa chừng thì báo rõ và giữ phần đã có', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', PHONE, { speech: 'native' });
  // người dùng từ chối quyền micro
  await page.evaluate(() => { window.__native.startError = { code: 'permission', message: 'denied' }; });
  await page.tap('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#toast').classList.contains('error') && /Chưa được cấp quyền micro/.test(document.querySelector('#toast').textContent)), 'báo thiếu quyền bằng câu dễ hiểu');
  assert(await page.isDisabled('#btn-stop') && (await recState(page)) === 'Sẵn sàng. Nhấn nút đỏ để bắt đầu.', 'không vào trạng thái đang ghi');
  eq(await page.evaluate(() => Object.values(window.__native.listeners).reduce((n, l) => n + l.length, 0)), 0, 'không để lại bộ nghe sự kiện mồ côi');
  // cấp quyền rồi ghi lại; giữa chừng mất mạng (lỗi không chết thì chỉ nhắc, lỗi chết thì dừng và giữ chữ)
  await page.evaluate(() => { window.__native.startError = null; });
  await page.fill('#meeting-title', 'Nhận dạng dừng giữa chừng');
  await page.tap('#btn-record');
  await until(async () => (await recState(page)) === 'Đang ghi và chuyển thành văn bản…', 'ghi sau khi cấp quyền');
  for (const sentence of SPOKEN.slice(0, 4)) await nativeSay(page, sentence);
  await page.waitForTimeout(60);   // chờ plugin giả báo xong "đang nghe" (báo muộn sẽ ghi đè dòng nhắc lỗi, như lúc nhận dạng chạy lại)
  await page.evaluate(() => window.__nativeEmit('error', { code: 'network', fatal: false }));
  assert(/không kết nối được/.test(await recState(page)) && await page.isEnabled('#btn-stop'), `lỗi tạm thời: nhắc trên dòng trạng thái, vẫn ghi (${await recState(page)})`);
  await page.waitForTimeout(1100);
  await page.evaluate(() => { window.__native.running = false; window.__nativeEmit('error', { code: 'network', fatal: true }); });
  await page.waitForSelector('#preview:not([hidden])');
  assert(/Nhận dạng giọng nói dừng lúc 00:0\d\. Phần văn bản đã có được giữ lại\./.test(await recState(page)), `dòng trạng thái: ${await recState(page)}`);
  assert(/từ đã nhận dạng/.test(await page.textContent('#preview-info')), 'phần văn bản đã nhận dạng còn đó');
  eq(await activeTab(page), 'record', 'dừng ngoài ý muốn thì không tự gửi đi');
  await page.tap('#btn-process');
  await waitResult(page, 'Nhận dạng dừng giữa chừng');
  assert((await page.inputValue('#edit-transcript')).includes('An sẽ phụ trách liên hệ khách hàng lớn trước thứ sáu.'), 'tóm tắt từ phần đã nhận dạng được');
});

step('doc-lap-ket-qua: sửa, đánh giá, học thuật ngữ, xuất file, tìm, xóa đều chạy trên máy (kể cả âm thanh trên máy tính)', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(WWW + '/');
  await page.waitForSelector('#btn-new-meeting');
  await page.fill('#meeting-title', 'Họp lưu trên máy');
  await page.click('#btn-record');
  await waitRecording(page);
  for (const sentence of SPOKEN) await say(page, sentence);
  await page.waitForTimeout(1200);
  await page.click('#btn-stop');
  await waitResult(page, 'Họp lưu trên máy');
  // máy tính ghi kèm âm thanh và lưu ngay trong trình duyệt
  await until(() => page.evaluate(() => !document.querySelector('#result-audio').hidden && document.querySelector('#result-audio').src.startsWith('blob:')), 'âm thanh nghe lại được từ kho trên máy');
  const size = await page.evaluate(async () => (await (await fetch(document.querySelector('#result-audio').src)).blob()).size);
  assert(size > 1000, `âm thanh đã lưu có dữ liệu (${size} byte)`);
  // sửa kết quả
  await page.fill('#edit-summary', '- Ý thứ nhất đã sửa\n- Ý thứ hai đã sửa');
  await page.click('#btn-add-action');
  await page.locator('#actions-table tbody tr').last().locator('.a-task').fill('Việc mới thêm');
  await page.click('#btn-save-analysis');
  await until(() => page.evaluate(() => document.querySelector('#save-analysis-msg').textContent.includes('cách trình bày bạn thích')), 'thông báo đã lưu');
  eq(await page.inputValue('#edit-summary'), '- Ý thứ nhất đã sửa\n- Ý thứ hai đã sửa', 'ý chính sau khi lưu');
  assert((await page.textContent('#result-meta')).includes('(đã sửa)'), 'meta ghi đã sửa');
  await page.click('#stars button[data-v="4"]');
  await page.fill('#rating-comment', 'ghi rõ con số');
  await page.click('#btn-rate');
  await until(() => page.evaluate(() => document.querySelector('#rating-msg').textContent === 'Đã ghi nhận đánh giá.'), 'thông báo đánh giá');
  // sửa văn bản: học cặp "nhận sai → đúng"
  const old = await page.inputValue('#edit-transcript');
  await page.fill('#edit-transcript', old.replace('bản thử nghiệm', 'bản beta'));
  await page.click('#btn-save-transcript');
  await until(() => page.evaluate(() => document.querySelector('#save-transcript-msg').textContent.includes('"thử nghiệm"→"beta"')), 'thông báo học thuật ngữ');
  await page.click('#btn-save-transcript-reanalyze');
  await until(() => page.evaluate(() => document.querySelector('#result-status').hidden && /không cần AI$/.test(document.querySelector('#result-meta').textContent.trim())), 'phân tích lại xong (kết quả mới, hết nhãn đã sửa)');
  eq(await page.textContent('#transcript-source'), '(nhận dạng trực tiếp khi nói, đã sửa)', 'nguồn văn bản sau khi sửa');
  // đổi tiêu đề; để trống thì giữ tên cũ
  await page.fill('#result-title', 'Họp đã đổi tên');
  await page.press('#result-title', 'Tab');
  await until(() => page.evaluate(() => document.querySelector('#meeting-list li .title').textContent === 'Họp đã đổi tên'), 'tiêu đề mới hiện trong danh sách');
  await page.fill('#result-title', '   ');
  await page.press('#result-title', 'Tab');
  eq(await page.inputValue('#result-title'), 'Họp đã đổi tên', 'tiêu đề trống được trả về giá trị cũ');
  // xuất file: Markdown do chính ứng dụng dựng, SVG và PNG của sơ đồ
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-md')]);
  eq(dl.suggestedFilename(), 'Họp đã đổi tên.md', 'tên file Markdown');
  const markdown = fs.readFileSync(await dl.path(), 'utf8');
  assert(markdown.startsWith('# Họp đã đổi tên\n') && markdown.includes('## Ý chính') && markdown.includes('## Sơ đồ tư duy') && markdown.includes('## Văn bản\n\nHôm nay'), `Markdown: ${markdown.slice(0, 80)}`);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mm-export-svg')]);
  assert(fs.readFileSync(await dl.path(), 'utf8').startsWith('<svg'), 'xuất SVG');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mm-export-png')]);
  eq(fs.readFileSync(await dl.path()).subarray(1, 4).toString(), 'PNG', 'xuất PNG');
  // dữ liệu chứa HTML không được chạy
  await analyzeText(page, XSS, `${VI} ${XSS} cần chuẩn bị ${XSS}.`);
  await waitResult(page, XSS);
  await page.click('.tab[data-tab="learning"]');
  await page.fill('#glossary-term', XSS);
  await page.press('#glossary-term', 'Enter');
  await until(() => page.evaluate(() => document.querySelector('#glossary-table').textContent.includes('<img src=x')), 'thuật ngữ hiện dưới dạng chữ');
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => [window.__xss || 0, document.querySelectorAll('img[src="x"]').length]), [0, 0], 'script chèn vào được chạy / thẻ img bị chèn');
  // tìm kiếm và xóa
  await page.fill('#search-meetings', 'đổi tên');
  await until(() => page.evaluate(() => document.querySelectorAll('#meeting-list li .title').length === 1), 'lọc còn một cuộc họp');
  await page.fill('#search-meetings', 'chuỗi-không-tồn-tại');
  await until(() => page.evaluate(() => /Không tìm thấy/.test(document.querySelector('#meeting-list').textContent)), 'trạng thái rỗng của tìm kiếm');
  await page.fill('#search-meetings', '');
  await page.click('#meeting-list li:has-text("Họp đã đổi tên")');
  await waitResult(page, 'Họp đã đổi tên');
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-delete');
  await until(() => page.isVisible('#result-empty'), 'về trạng thái rỗng sau khi xóa');
  await page.reload();
  await page.waitForSelector('#meeting-list li');
  assert(!(await page.textContent('#meeting-list')).includes('Họp đã đổi tên'), 'cuộc họp đã xóa không sống lại sau khi tải lại');
  eq(offOrigin(page), [], 'request ra ngoài gói ứng dụng');
}, { allow: /Failed to load resource.*\/x\b|ERR_FILE_NOT_FOUND/ });

step('doc-lap-hoc: thuật ngữ tự sửa, cỡ tóm tắt theo thói quen người dùng, tìm lại trong bản ghi cũ', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', DESKTOP);
  const count = async () => (await page.inputValue('#edit-summary')).split('\n').filter(Boolean).length;
  await analyzeText(page, 'Họp một');
  await waitResult(page, 'Họp một');
  eq(await count(), 4, 'số ý chính mặc định cho văn bản này');
  // hai lần sửa còn 3 ý: lần sau tự tóm tắt đúng cỡ đó
  for (const title of ['Họp một', 'Họp hai']) {
    if (title !== 'Họp một') { await analyzeText(page, title); await waitResult(page, title); }
    await page.fill('#edit-summary', '- ý một\n- ý hai\n- ý ba');
    await page.click('#btn-save-analysis');
    await until(() => page.evaluate(() => document.querySelector('#save-analysis-msg').textContent.includes('Đã lưu')), 'lưu chỉnh sửa');
  }
  // thuật ngữ: thêm dạng hay bị nhận sai, văn bản sau tự được sửa
  await page.click('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => /Bạn thường giữ khoảng 3 ý chính/.test(document.querySelector('#ai-setup').textContent)), 'hiện thói quen đã học');
  await page.fill('#glossary-term', 'Zalo');
  await page.fill('#glossary-variant', 'gia lô');
  await page.press('#glossary-variant', 'Enter');
  await until(() => page.evaluate(() => document.querySelector('#glossary-table').textContent.includes('Zalo')), 'thuật ngữ đã thêm');
  await analyzeText(page, 'Họp ba', `${VI} Mọi người gửi tài liệu qua gia lô nhé. Nhóm Gia Lô của công ty đã có đủ người.`);
  await waitResult(page, 'Họp ba');
  eq(await count(), 3, 'số ý chính theo thói quen đã học');
  const fixed = await page.inputValue('#edit-transcript');
  assert(fixed.includes('gửi tài liệu qua Zalo nhé') && fixed.includes('Nhóm Zalo của công ty') && !/gia lô/i.test(fixed), `văn bản đã tự sửa thuật ngữ: ${fixed.slice(-90)}`);
  // tìm lại trong các bản ghi
  await page.click('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelector('#events').textContent.includes('Tự động sửa 2 chỗ')), 'nhật ký ghi việc tự sửa');
  await page.fill('#ask-input', 'ngân sách chiến dịch');
  await page.press('#ask-input', 'Enter');
  await until(() => page.evaluate(() => document.querySelectorAll('#ask-sources li').length >= 2), 'có đoạn liên quan');
  eq(await page.textContent('#ask-answer'), 'Các đoạn liên quan nhất trong những bản ghi đã lưu:', 'câu dẫn kết quả');
  await page.locator('#ask-sources .src-title').first().click();
  await until(() => page.evaluate(() => document.querySelector('#tab-result').classList.contains('active') && /^Họp /.test(document.querySelector('#result-title').value)), 'bấm vào nguồn mở đúng cuộc họp');
  await page.click('.tab[data-tab="learning"]');
  await page.fill('#ask-input', 'xyzkhôngcó');
  await page.press('#ask-input', 'Enter');
  await until(() => page.evaluate(() => document.querySelector('#ask-answer').textContent === 'Chưa có bản ghi nào liên quan.'), 'không có kết quả thì nói rõ');
  eq(offOrigin(page), [], 'request ra ngoài gói ứng dụng');
});

step('doc-lap-luu-tam: trình duyệt chặn bộ nhớ thì vẫn chạy được và báo dữ liệu chỉ lưu tạm', async (ctx) => {
  for (const mode of ['missing', 'denied']) {
    const page = ctx.page = await open(null, PHONE);
    await page.addInitScript((kind) => {
      if (kind === 'missing') { Object.defineProperty(window, 'indexedDB', { value: undefined }); return; }
      // chế độ riêng tư của vài trình duyệt: có indexedDB nhưng mở là lỗi
      window.indexedDB.open = () => { const request = {}; setTimeout(() => request.onerror && request.onerror(), 0); return request; };
    }, mode);
    await page.goto(WWW + '/');
    await until(() => page.evaluate(() => document.querySelector('#badge-memory').textContent === 'Lưu tạm (trình duyệt chặn bộ nhớ)'), `huy hiệu lưu tạm (${mode})`);
    await analyzeText(page, `Lưu tạm ${mode}`);
    await waitResult(page, `Lưu tạm ${mode}`);
    assert((await page.locator('#mindmap .mm-node').count()) >= 6, `vẫn tóm tắt và vẽ sơ đồ được (${mode})`);
    if (mode === 'missing') { eq(page.errors, [], 'lỗi console khi không có IndexedDB'); await page.context().close(); }
  }
});

step('di-dong-www: máy chủ AI là tùy chọn, nhập địa chỉ thì chạy chéo origin, bỏ đi thì về độc lập', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', PHONE, { speech: 'native' });
  await analyzeText(page, 'Ghi chú trên máy');
  await waitResult(page, 'Ghi chú trên máy');
  eq(page.apiCalls, [], 'các lời gọi API khi chạy độc lập');
  // nhập địa chỉ không kèm http://
  await page.tap('#server-summary');
  await page.fill('#server-url', `${new URL(API).host}/`);
  await Promise.all([page.waitForNavigation(), page.tap('#btn-server-save')]);
  await until(() => page.evaluate(() => /hash-512/.test(document.querySelector('#badge-memory').textContent)), 'kết nối được máy chủ chéo origin');
  eq(await page.textContent('#server-summary'), `⚙ Máy chủ AI: ${API}`, 'địa chỉ đã chuẩn hóa');
  assert(!(await page.textContent('#meeting-list')).includes('Ghi chú trên máy'), 'dữ liệu của máy chủ tách riêng với dữ liệu trên máy');
  await analyzeText(page, 'Họp từ app di động');
  await waitResult(page, 'Họp từ app di động');
  assert((await page.getAttribute('#btn-export-md', 'href')).startsWith(`${API}/api/meetings/`), 'link xuất Markdown trỏ về máy chủ');
  assert((await page.getAttribute('#link-export-jsonl', 'href')).startsWith(`${API}/api/learning/export`), 'link xuất JSONL trỏ về máy chủ');
  assert(await noOverflow(page), 'kết quả không tràn ngang');
  eq(page.apiCalls.filter((c) => c.includes(new URL(WWW).host)), [], 'request API gửi nhầm tới origin của app');
  // ghi trong app khi máy chủ chưa có Whisper: plugin nhận dạng, chỉ gửi văn bản (không có file âm thanh)
  await page.tap('.tab[data-tab="record"]');
  await page.fill('#meeting-title', 'Ghi âm từ app di động');
  await page.tap('#btn-record');
  await until(async () => (await recState(page)) === 'Đang ghi và chuyển thành văn bản…', 'ghi trên bản di động');
  for (const sentence of SPOKEN.slice(0, 5)) await nativeSay(page, sentence);
  await page.waitForTimeout(1100);
  await page.tap('#btn-stop');
  await waitResult(page, 'Ghi âm từ app di động');
  const m = (await api('GET', `/api/meetings/${(await findMeeting('Ghi âm từ app di động')).id}`)).data;
  eq([m.status, m.has_audio, m.transcript_source], ['done', false, 'device'], 'cuộc họp trên máy chủ');
  assert(m.duration_sec > 1 && m.duration_sec < 30, `thời lượng gửi kèm dù không có file âm thanh (${m.duration_sec})`);
  // máy chủ sai địa chỉ: báo rõ, mở sẵn mục cài đặt, có lối về chế độ độc lập
  await page.tap('#server-summary');
  await page.fill('#server-url', 'http://127.0.0.1:9');
  await Promise.all([page.waitForNavigation(), page.tap('#btn-server-save')]);
  await until(() => page.evaluate(() => document.querySelector('#badge-ollama').textContent === 'Chưa kết nối máy chủ'), 'báo chưa kết nối khi sai địa chỉ');
  assert(await page.evaluate(() => document.querySelector('#server-box').classList.contains('warn') && document.querySelector('#server-box').open), 'mục máy chủ được đánh dấu cảnh báo và mở sẵn');
  await Promise.all([page.waitForNavigation(), page.tap('#btn-server-clear')]);
  await until(() => page.evaluate(() => document.querySelector('#badge-memory').textContent === 'Lưu trên máy này'), 'về chế độ độc lập');
  assert((await page.textContent('#meeting-list')).includes('Ghi chú trên máy'), 'dữ liệu trên máy còn nguyên');
}, { allow: /ERR_CONNECTION_REFUSED|Failed to load resource/ });

// ============================================ lớp nhận dạng giọng nói (speech.js)
step('speech-web: Web Speech API tự chạy lại, không lặp vô hạn khi dịch vụ hỏng, dừng được cả khi dịch vụ im lặng', async (ctx) => {
  // Chrome trên Android lặp kết quả nếu bật continuous: ở đó phải nhận từng câu rồi tự chạy lại
  const android = await open(WWW + '/', PHONE, { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const mobile = await android.evaluate(async () => {
    const got = [];
    const session = window.M2MSpeech.create({ lang: 'vi-VN', onFinal: (t) => got.push(t) });
    await session.start();
    const first = window.__sr.continuous;
    window.__say('câu một');
    window.__srEnd();                       // hết một câu là dịch vụ tự tắt
    await new Promise((r) => setTimeout(r, 400));
    window.__say('câu hai');
    await session.stop();
    return { support: window.M2MSpeech.support(), first, starts: window.__sr.starts, got };
  });
  eq(mobile, { support: { provider: 'web', recordAudio: false, label: 'trình duyệt' }, first: false, starts: 2, got: ['câu một', 'câu hai'] }, 'Chrome Android');
  await android.context().close();

  const page = ctx.page = await open(WWW + '/', DESKTOP);
  const result = await page.evaluate(async () => {
    const S = window.M2MSpeech;
    const out = { lang: [S.langTag('vi'), S.langTag('en'), S.langTag('en-GB'), S.langTag('auto')],
      format: [S.formatUtterance('  xin   chào '), S.formatUtterance('đã xong chưa?'), S.formatUtterance(''), S.formatUtterance('ổn rồi…')] };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 1) dịch vụ tắt ngay sau khi bật, lần nào cũng vậy: phải dừng hẳn và báo MỘT lỗi, không quay vòng mãi
    const errors = [];
    const states = [];
    class DeadSR { start() { window.__dead = (window.__dead || 0) + 1; setTimeout(() => this.onend && this.onend(), 5); } stop() {} }
    const Real = window.SpeechRecognition;
    window.SpeechRecognition = window.webkitSpeechRecognition = DeadSR;
    let session = S.create({ onError: (e) => errors.push(`${e.code}:${e.fatal}`), onState: (st) => states.push(st.listening) });
    await session.start();
    await wait(6500);
    out.dead = { starts: window.__dead, errors, lastState: states[states.length - 1], active: session.isActive() };
    // 2) trình duyệt ném lỗi ngay khi bật
    class ThrowSR { start() { throw new Error('InvalidStateError'); } }
    window.SpeechRecognition = window.webkitSpeechRecognition = ThrowSR;
    try { await S.create({}).start(); out.throws = 'không báo lỗi'; } catch (err) { out.throws = err.code; }
    // 3) bấm dừng mà dịch vụ không bao giờ báo "đã tắt": vẫn dừng xong, giữ phần đang nói dở
    const finals = [];
    class MuteSR { start() { window.__mute = this; } stop() {} }
    window.SpeechRecognition = window.webkitSpeechRecognition = MuteSR;
    session = S.create({ onFinal: (t) => finals.push(t) });
    await session.start();
    window.__mute.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'nói dở' }], { isFinal: false })] });
    const t0 = Date.now();
    await session.stop();
    out.mute = { finals, waited: Date.now() - t0 < 4000, active: session.isActive() };
    // 4) kết quả của bộ nhận dạng cũ về sau khi đã dừng thì bỏ
    window.__mute.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'về muộn' }], { isFinal: true })] });
    out.late = finals.slice();
    window.SpeechRecognition = window.webkitSpeechRecognition = Real;
    return out;
  });
  eq(result.lang, ['vi-VN', 'en-US', 'en-GB', 'vi-VN'], 'mã ngôn ngữ');
  eq(result.format, ['Xin chào.', 'Đã xong chưa?', '', 'Ổn rồi…'], 'định dạng câu');
  assert(result.dead.starts >= 5 && result.dead.starts <= 6, `số lần thử khi dịch vụ chết (${result.dead.starts})`);
  eq([result.dead.errors, result.dead.lastState, result.dead.active], [['unknown:true'], false, false], 'dịch vụ chết: một lỗi rồi dừng hẳn');
  eq(result.throws, 'unknown', 'trình duyệt ném lỗi khi bật');
  eq(result.mute, { finals: ['nói dở'], waited: true, active: false }, 'dừng khi dịch vụ im lặng');
  eq(result.late, ['nói dở'], 'kết quả về muộn bị bỏ');
});

step('speech-native: plugin của app được ưu tiên, không dùng được thì chuyển sang trình duyệt, dừng xong gỡ hết bộ nghe', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', PHONE, { speech: 'native' });
  const result = await page.evaluate(async () => {
    const S = window.M2MSpeech;
    const out = { support: S.support() };
    const events = [];
    const session = S.create({ lang: 'en-US', onPartial: (t) => events.push(`p:${t}`), onFinal: (t) => events.push(`f:${t}`),
      onState: (st) => events.push(`s:${st.listening}:${st.reason}`), onLevel: (v) => events.push(`l:${v}`),
      onError: (e) => events.push(`e:${e.code}:${e.fatal}`) });
    await session.start();
    await new Promise((r) => setTimeout(r, 20));
    window.__nativeEmit('level', { value: 3 });           // giá trị ngoài khoảng được kẹp về 0..1
    window.__nativeEmit('partial', { text: ' hello ' });
    window.__nativeEmit('final', { text: 'hello world' });
    window.__nativeEmit('error', { code: 'kỳ-lạ', fatal: false });
    window.__native.pending = 'last words';
    await session.stop();
    out.events = events;
    out.listeners = Object.values(window.__native.listeners).reduce((n, l) => n + l.length, 0);
    out.calls = window.__native.calls.map((c) => c[0]);
    window.__nativeEmit('final', { text: 'sau khi dừng' });
    out.after = events.length;
    // máy không có dịch vụ nhận dạng nhưng trình duyệt nhúng có Web Speech API: dùng cái đó
    class WebSR { start() { window.__webStarted = true; } stop() { setTimeout(() => this.onend && this.onend(), 0); } }
    window.SpeechRecognition = WebSR;
    window.__native.startError = { code: 'unavailable', message: 'no service' };
    const fallback = S.create({});
    await fallback.start();
    out.fallback = [fallback.provider, !!window.__webStarted];
    await fallback.stop();
    // lỗi khác (thiếu quyền) thì báo ra, không lặng lẽ đổi nguồn
    window.__native.startError = { code: 'permission', message: 'denied' };
    try { await S.create({}).start(); out.denied = 'không báo lỗi'; } catch (err) { out.denied = [err.code, /quyền/.test(err.message)]; }
    // giữ màn hình sáng đi qua plugin
    S.keepAwake(true); S.keepAwake(false);
    await new Promise((r) => setTimeout(r, 20));
    out.awake = window.__native.calls.filter((c) => c[0] === 'keepAwake').map((c) => c[1].on);
    return out;
  });
  eq(result.support, { provider: 'native', recordAudio: false, label: 'thiết bị' }, 'nguồn nhận dạng');
  eq(result.events, ['s:true:', 'l:1', 'p:hello', 'f:hello world', 'p:', 'e:kỳ-lạ:false', 'f:last words', 'p:', 's:false:'], 'sự kiện từ plugin');
  eq([result.listeners, result.after, result.calls], [0, result.events.length, ['start', 'stop']], 'sau khi dừng: gỡ bộ nghe, bỏ sự kiện về muộn');
  eq(result.fallback, ['web', true], 'chuyển sang Web Speech API khi plugin báo không có dịch vụ');
  eq(result.denied, ['permission', true], 'thiếu quyền thì báo lỗi');
  eq(result.awake, [true, false], 'giữ màn hình sáng');
});

// ================================================================ chạy
async function waitHttp(url, child) {
  await until(async () => { if (child.exitCode !== null) throw new Error('máy chủ thử đã thoát'); return (await fetch(url)).ok; }, `máy chủ ${url} sẵn sàng`, 30000);
}
function serveStatic(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(dir, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const selected = steps.filter((s) => !GREP || s.name.includes(GREP));
  if (!selected.length) { console.error(`Bộ lọc "${GREP}" không khớp bước nào. Các bước: ${steps.map((s) => s.name.split(':')[0]).join(', ')}`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2m-e2e-data-'));
  const port = await freePort();
  const serverLog = fs.openSync(path.join(OUT, 'server.log'), 'w');
  const server = spawn('python3', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    cwd: ROOT, stdio: ['ignore', serverLog, serverLog],
    env: Object.assign({}, process.env, { M2M_DATA_DIR: dataDir, M2M_DISABLE_WHISPER: '1', M2M_DISABLE_OLLAMA: '1' }),
  });
  let failed = 0;
  const skipped = [];
  let www;
  try {
    API = `http://127.0.0.1:${port}`;
    await waitHttp(`${API}/api/health`, server);
    execFileSync('node', [path.join(ROOT, 'mobile', 'build-web.js')], { stdio: 'ignore' });
    www = await serveStatic(path.join(ROOT, 'mobile', 'www'));
    WWW = `http://localhost:${www.address().port}`;   // khác origin với API (127.0.0.1)
    // Máy không đặt locale UTF-8 (CI, container) thì Chromium đổi tên file tải xuống có dấu thành "download"
    // (đã đo: LANG rỗng -> "download", LANG=C.UTF-8 -> đúng tên). Đây là lỗi môi trường, không phải lỗi app.
    browser = await chromium.launch({
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
    });
    for (const s of selected) {
      const ctx = {};
      const started = Date.now();
      const slug = s.name.split(':')[0];
      let error = null;
      try {
        await s.fn(ctx);
        if (ctx.skip) skipped.push(`${slug}: ${ctx.skip}`);
        const errors = (ctx.page ? ctx.page.errors : []).filter((e) => !(s.opts.allow && s.opts.allow.test(e)));
        if (errors.length) throw new Error(`Có lỗi console/trang:\n    ${errors.join('\n    ')}`);
      } catch (err) { error = err; }
      if (ctx.page) {
        try { await ctx.page.screenshot({ path: path.join(OUT, `${slug}${error ? '-FAIL' : ''}.png`), fullPage: false }); } catch (_) { /* trang đã đóng */ }
        await ctx.page.context().close().catch(() => {});
      }
      const ms = Date.now() - started;
      if (error) { failed += 1; console.log(`FAIL ${s.name} (${ms} ms)\n  ${String(error.message).split('\n').join('\n  ')}`); }
      else console.log(`${ctx.skip ? 'SKIP' : 'PASS'} ${s.name} (${ms} ms)${ctx.skip ? ` — ${ctx.skip}` : ''}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`FAIL hạ tầng: ${err.stack || err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (www) www.close();
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\nE2E: ${selected.length - failed - skipped.length}/${selected.length} bước đạt${skipped.length ? `, ${skipped.length} bước BỎ QUA (${skipped.join('; ')})` : ''}${GREP ? ` (lọc "${GREP}")` : ''}. Ảnh chụp: ${OUT}`);
  process.exit(failed ? 1 : 0);
})();
