/* Tạo thư mục www cho ứng dụng di động từ giao diện web trong app/static.
   - Chuyển đường dẫn /static/... thành tương đối để Capacitor phục vụ từ gốc.
   - Chèn cờ window.M2M_MOBILE trước mọi script: app.js chạy ĐỘC LẬP (nhận dạng giọng nói, tóm tắt, vẽ sơ đồ tư duy
     và lưu dữ liệu ngay trên máy), máy chủ AI trong mạng LAN chỉ là tùy chọn. */
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
    const first = html.indexOf('<script src="./');
    if (first < 0) throw new Error('index.html không còn thẻ <script src="/static/...">: không biết chèn cờ M2M_MOBILE vào đâu');
    html = html.slice(0, first) + '<script>window.M2M_MOBILE = true;</script>\n  ' + html.slice(first);
    fs.writeFileSync(path.join(OUT, name), html);
  } else {
    fs.copyFileSync(from, path.join(OUT, name));
  }
}
console.log(`Đã tạo ${OUT} từ ${SRC}`);
