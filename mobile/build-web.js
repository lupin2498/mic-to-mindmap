/* Tạo thư mục www cho ứng dụng di động từ giao diện web trong app/static.
   - Chuyển đường dẫn /static/... thành tương đối để Capacitor phục vụ từ gốc.
   - Chèn cờ window.M2M_MOBILE để app.js hiện ô "địa chỉ máy chủ" và gọi API qua mạng LAN. */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'app', 'static');
const OUT = path.resolve(__dirname, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(SRC)) {
  const from = path.join(SRC, name);
  if (!fs.statSync(from).isFile()) continue;
  if (name === 'index.html') {
    let html = fs.readFileSync(from, 'utf8');
    html = html.replace(/(href|src)="\/static\//g, '$1="./');
    html = html.replace('<script src="./mindmap.js"></script>',
      '<script>window.M2M_MOBILE = true;</script>\n  <script src="./mindmap.js"></script>');
    fs.writeFileSync(path.join(OUT, name), html);
  } else {
    fs.copyFileSync(from, path.join(OUT, name));
  }
}
console.log(`Đã tạo ${OUT} từ ${SRC}`);
