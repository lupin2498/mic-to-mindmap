#!/usr/bin/env node
/* Kiểm thử giao diện thật bằng Playwright (Chromium, micro giả).
   - Tự bật máy chủ FastAPI trên thư mục dữ liệu tạm (không Ollama, không Whisper).
   - Tự dựng mobile/www và phục vụ ở origin khác để kiểm bản di động gọi API chéo origin.
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

/* Mở một trang mới kèm bộ gom lỗi console/pageerror. */
async function open(url, viewport, extra) {
  const context = await browser.newContext(Object.assign({ viewport, permissions: ['microphone'], acceptDownloads: true,
    hasTouch: viewport.width < 600, isMobile: viewport.width < 600, locale: 'vi-VN' }, extra || {}));
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') page.errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => page.errors.push(`pageerror: ${err.message}`));
  page.on('response', (resp) => { if (resp.status() >= 400) page.errors.push(`http ${resp.status()}: ${resp.request().method()} ${resp.url()}`); });
  page.apiCalls = [];
  page.on('request', (req) => { if (req.url().includes('/api/')) page.apiCalls.push(`${req.method()} ${req.url()}`); });
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
step('khoi-dong: trạng thái rỗng, huy hiệu AI, không lỗi console', async (ctx) => {
  const page = ctx.page = await open(API + '/', DESKTOP);
  await until(() => page.evaluate(() => /heuristic/.test(document.querySelector('#badge-ollama').textContent)), 'huy hiệu LLM');
  eq(await page.textContent('#badge-whisper'), 'Whisper: chưa cài', 'huy hiệu Whisper');
  assert((await page.textContent('#meeting-list')).includes('Chưa có cuộc họp nào'), 'danh sách rỗng có nội dung');
  await page.click('.tab[data-tab="result"]');
  assert(await page.isVisible('#result-empty'), 'tab kết quả có trạng thái rỗng');
  assert(await page.isHidden('#server-box'), 'bản web không hiện ô địa chỉ máy chủ');
  await page.click('.tab[data-tab="learning"]');
  await until(() => page.evaluate(() => document.querySelectorAll('#stats .stat').length === 7), 'thống kê học hỏi');
  assert((await page.textContent('#events')).includes('Chưa có gì được học'), 'nhật ký rỗng có nội dung');
  assert((await page.textContent('#glossary-table')).includes('Chưa có thuật ngữ nào'), 'bảng thuật ngữ rỗng có nội dung');
});

step('van-ban: dán transcript → tóm tắt → mind map (máy tính)', async (ctx) => {
  const page = ctx.page = await open(API + '/', DESKTOP);
  await page.selectOption('#meeting-language', 'auto');
  await page.fill('#meeting-participants', 'An, Bình');
  await analyzeText(page, 'Họp kế hoạch e2e');
  await waitResult(page, 'Họp kế hoạch e2e');
  assert((await page.inputValue('#edit-summary')).split('\n').length >= 3, 'có ít nhất 3 ý chính');
  assert((await page.locator('#mindmap .mm-node').count()) >= 4, 'mind map có nút');
  assert((await page.inputValue('#edit-transcript')).startsWith('Hôm nay'), 'transcript hiển thị');
  assert((await page.textContent('#result-meta')).includes('heuristic'), 'meta ghi engine');
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
  await page.fill('.mm-editor', 'Ý con mới');
  await page.press('.mm-editor', 'Enter');
  eq(await count(), before + 1, 'thêm một nút');
  await page.locator('#mindmap .mm-node:has-text("Ý con mới")').click();
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
  assert(text.startsWith('# Họp mind map') && text.includes('Nhánh đã sửa') && text.includes('## Transcript'), 'file Markdown xuất ra đúng nội dung');
});

async function withFakeMic(page) {
  await page.addInitScript(() => {
    window.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    // hộp thoại xin quyền thật luôn có độ trễ: giả lập để lộ lỗi bấm lặp
    navigator.mediaDevices.getUserMedia = async (c) => { await new Promise((r) => setTimeout(r, 200)); const s = await orig(c); window.__streams.push(s); return s; };
    class FakeSR {
      start() { window.__srStarts = (window.__srStarts || 0) + 1; setTimeout(() => { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'phụ đề của bản ghi trước' }], { isFinal: true })] }); }, 60); }
      stop() { if (this.onend) this.onend(); }
    }
    window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  });
}
const liveTracks = (page) => page.evaluate(() => window.__streams.reduce((n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0));

step('ghi-am: micro giả, tạm dừng, dừng, nghe lại, xử lý báo lỗi rõ ràng', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.fill('#meeting-title', 'Bản ghi micro giả');
  await page.click('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#rec-state').textContent === 'Đang ghi âm…'), 'bắt đầu ghi');
  assert(await page.isEnabled('#btn-pause') && await page.isEnabled('#btn-stop'), 'nút tạm dừng và dừng bật');
  await until(() => page.evaluate(() => document.querySelector('#rec-timer').textContent >= '00:01'), 'đồng hồ chạy', 5000);
  await page.click('#btn-pause');
  const t1 = await page.textContent('#rec-timer');
  await page.waitForTimeout(1300);
  eq(await page.textContent('#rec-timer'), t1, 'đồng hồ đứng yên khi tạm dừng');
  eq(await page.textContent('#btn-pause'), '▶ Tiếp tục', 'nhãn nút khi tạm dừng');
  await page.click('#btn-pause');
  await page.waitForTimeout(700);
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  eq(await liveTracks(page), 0, 'micro đã tắt sau khi dừng');
  const size = await page.evaluate(async () => (await (await fetch(document.querySelector('#audio-preview').src)).blob()).size);
  assert(size > 1000, `bản ghi có dữ liệu (${size} byte)`);
  assert(/MB/.test(await page.textContent('#preview-info')), 'hiện dung lượng bản ghi');
  await page.click('#btn-process');
  await until(() => page.evaluate(() => document.querySelector('#tab-result').classList.contains('active') && document.querySelector('#result-status').textContent.includes('faster-whisper')), 'báo lỗi thiếu Whisper ở trang kết quả');
  const m = await findMeeting('Bản ghi micro giả');
  eq([m.status, m.has_audio], ['error', true], 'trạng thái cuộc họp trên máy chủ');
  const audio = await fetch(`${API}/api/meetings/${m.id}/audio`);
  eq(audio.headers.get('content-type'), 'audio/webm', 'kiểu nội dung âm thanh phát lại');
  eq((await audio.arrayBuffer()).byteLength, size, 'âm thanh trên máy chủ đủ kích thước');
  assert(m.duration_sec > 1 && m.duration_sec < 30, `thời lượng hợp lý (${m.duration_sec})`);
  assert(await page.isHidden('#progress') && await page.isHidden('#preview'), 'dọn thanh tiến trình và bản xem trước');
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
  // tạo cuộc họp mới giữa lúc ghi: hủy bản ghi, tắt micro, không hiện bản xem trước
  await page.click('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#rec-state').textContent === 'Đang ghi âm…'), 'ghi lần hai');
  await page.click('#btn-new-meeting');
  await page.waitForTimeout(400);
  eq(await liveTracks(page), 0, 'micro tắt khi tạo cuộc họp mới');
  assert(await page.isHidden('#preview'), 'bản ghi dở bị hủy');
});

step('phu-de: phụ đề của bản ghi trước không dính vào file tải lên sau', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  await page.goto(API + '/');
  await page.check('#live-captions');
  await page.click('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#live-transcript').textContent.includes('phụ đề của bản ghi trước')), 'phụ đề trực tiếp hiện');
  await page.click('#btn-pause');
  await page.click('#btn-pause');
  await until(() => page.evaluate(() => window.__srStarts >= 2), 'phụ đề chạy lại sau tạm dừng');
  await page.click('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  await page.setInputFiles('#audio-file', { name: 'họp tuần 45.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3-fake-mp3-data') });
  eq(await page.inputValue('#meeting-title'), 'họp tuần 45', 'tiêu đề lấy từ tên file');
  await page.click('#btn-process');
  await until(async () => { const m = await findMeeting('họp tuần 45'); return m && ['error', 'done'].includes(m.status); }, 'file tải lên được xử lý xong');
  const m = await findMeeting('họp tuần 45');
  const full = (await api('GET', `/api/meetings/${m.id}`)).data;
  eq(full.transcript || '', '', 'transcript của file tải lên (không được là phụ đề bản ghi trước)');
  eq(full.status, 'error', 'không có Whisper và không có phụ đề thì phải báo lỗi, không tóm tắt nội dung của bản ghi khác');
  await page.click('.tab[data-tab="record"]');
  assert(await page.isHidden('#live-transcript'), 'ẩn phụ đề của bản ghi trước khi chọn file khác');
});

step('nen-xong-muon: bản ghi mới không bị xóa khi cuộc họp trước xử lý xong', async (ctx) => {
  const page = ctx.page = await open(null, DESKTOP);
  await withFakeMic(page);
  const held = await holdProcessing(page);
  await page.goto(API + '/');
  held.titles.add('Họp xử lý lâu');
  await analyzeText(page, 'Họp xử lý lâu');
  await until(() => page.evaluate(() => /Đang tóm tắt/.test(document.querySelector('#progress-text').textContent)), 'đang xử lý cuộc họp đầu');
  // trong lúc chờ, ghi âm cuộc họp tiếp theo và gõ ghi chú mới
  await page.fill('#meeting-title', 'Họp thứ hai');
  await page.click('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#rec-state').textContent === 'Đang ghi âm…'), 'ghi bản thứ hai');
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
  eq(await page.inputValue('#manual-transcript'), 'ghi chú đang gõ dở cho cuộc họp thứ hai', 'ghi chú đang gõ còn nguyên');
  assert(await page.isEnabled('#btn-process'), 'xử lý được bản ghi thứ hai');
  await page.click('#btn-process');
  await until(async () => { const m = await findMeeting('Họp thứ hai'); return m && m.has_audio; }, 'bản ghi thứ hai được tải lên');
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
    return { scale: Number(/scale\(([\d.]+)\)/.exec(t)[1]), rootInside: root.left >= c.left && root.right <= c.right && root.top >= c.top && root.bottom <= c.bottom };
  });
  assert(mm.scale >= 0.55 && mm.rootInside, `mind map đủ lớn và nút gốc nằm trong khung (${JSON.stringify(mm)})`);
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

step('di-dong-www: chưa cấu hình máy chủ thì không gọi API, cấu hình xong chạy chéo origin', async (ctx) => {
  const page = ctx.page = await open(WWW + '/', PHONE);
  await page.waitForTimeout(500);
  eq(page.apiCalls, [], 'các lời gọi API khi chưa có địa chỉ máy chủ');
  assert(await page.isVisible('#server-box') && (await page.textContent('#meeting-list')).includes('Nhập địa chỉ máy chủ'), 'hướng dẫn nhập địa chỉ máy chủ');
  eq(await page.textContent('#badge-ollama'), 'Chưa kết nối máy chủ', 'huy hiệu khi chưa kết nối');
  assert(await noOverflow(page), 'không tràn ngang khi có ô địa chỉ máy chủ');
  // bấm xử lý khi chưa cấu hình: báo lỗi dễ hiểu, không sinh request tới chính origin của app
  await analyzeText(page, 'Chưa có máy chủ');
  await until(() => page.evaluate(() => document.querySelector('#toast').classList.contains('error') && /máy chủ/.test(document.querySelector('#toast').textContent)), 'báo cần nhập địa chỉ máy chủ');
  eq(page.apiCalls.filter((c) => c.includes(new URL(WWW).host)), [], 'request API gửi nhầm tới origin của app');
  assert(await page.isHidden('#progress'), 'không kẹt thanh tiến trình');
  // nhập địa chỉ không kèm http://
  await page.fill('#server-url', `${new URL(API).host}/`);
  await Promise.all([page.waitForNavigation(), page.tap('#btn-server-save')]);
  await until(() => page.evaluate(() => /heuristic/.test(document.querySelector('#badge-ollama').textContent)), 'kết nối được máy chủ chéo origin');
  eq(await page.inputValue('#server-url'), API, 'địa chỉ đã chuẩn hóa');
  await analyzeText(page, 'Họp từ app di động');
  await waitResult(page, 'Họp từ app di động');
  assert((await page.getAttribute('#btn-export-md', 'href')).startsWith(`${API}/api/meetings/`), 'link xuất Markdown trỏ về máy chủ');
  assert((await page.getAttribute('#link-export-jsonl', 'href')).startsWith(`${API}/api/learning/export`), 'link xuất JSONL trỏ về máy chủ');
  assert(await noOverflow(page), 'kết quả không tràn ngang');
  eq(page.apiCalls.filter((c) => c.includes(new URL(WWW).host)), [], 'request API gửi nhầm tới origin của app sau khi cấu hình');
  // ghi âm rồi tải lên chéo origin (multipart + CORS)
  await page.tap('.tab[data-tab="record"]');
  await page.fill('#meeting-title', 'Ghi âm từ app di động');
  await page.tap('#btn-record');
  await until(() => page.evaluate(() => document.querySelector('#rec-state').textContent === 'Đang ghi âm…'), 'ghi âm trên bản di động');
  await page.waitForTimeout(1200);
  await page.tap('#btn-stop');
  await page.waitForSelector('#preview:not([hidden])');
  await page.tap('#btn-process');
  await until(async () => { const m = await findMeeting('Ghi âm từ app di động'); return m && m.has_audio && m.status === 'error'; }, 'âm thanh tải lên được từ origin khác');
  await until(() => page.evaluate(() => (document.querySelector('#result-audio').getAttribute('src') || '').includes('/api/meetings/')), 'trình phát âm thanh hiện');
  assert((await page.getAttribute('#result-audio', 'src')).startsWith(API), 'trình phát âm thanh trỏ về máy chủ');
  // máy chủ sai địa chỉ: báo rõ, không treo
  await page.fill('#server-url', 'http://127.0.0.1:9');
  await Promise.all([page.waitForNavigation(), page.tap('#btn-server-save')]);
  await until(() => page.evaluate(() => document.querySelector('#badge-ollama').textContent === 'Chưa kết nối máy chủ'), 'báo chưa kết nối khi sai địa chỉ');
  assert(await page.evaluate(() => document.querySelector('#server-box').classList.contains('warn')), 'ô địa chỉ được đánh dấu cảnh báo');
}, { allow: /ERR_CONNECTION_REFUSED|Failed to load resource/ });

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
        const errors = (ctx.page ? ctx.page.errors : []).filter((e) => !(s.opts.allow && s.opts.allow.test(e)));
        if (errors.length) throw new Error(`Có lỗi console/trang:\n    ${errors.join('\n    ')}`);
      } catch (err) { error = err; }
      if (ctx.page) {
        try { await ctx.page.screenshot({ path: path.join(OUT, `${slug}${error ? '-FAIL' : ''}.png`), fullPage: false }); } catch (_) { /* trang đã đóng */ }
        await ctx.page.context().close().catch(() => {});
      }
      const ms = Date.now() - started;
      if (error) { failed += 1; console.log(`FAIL ${s.name} (${ms} ms)\n  ${String(error.message).split('\n').join('\n  ')}`); }
      else console.log(`PASS ${s.name} (${ms} ms)`);
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
  console.log(`\nE2E: ${selected.length - failed}/${selected.length} bước đạt${GREP ? ` (lọc "${GREP}")` : ''}. Ảnh chụp: ${OUT}`);
  process.exit(failed ? 1 : 0);
})();
