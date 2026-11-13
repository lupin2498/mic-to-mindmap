# Sổ tay kiểm thử: mic-to-mindmap
<!-- Agent test-fix-bug tự cập nhật sau mỗi lần chạy. -->
## Lệnh và môi trường
- test backend: `python3 -m pytest -q` (100 test, khoảng 27 giây, không cần Ollama/Whisper thật)
- E2E giao diện: `E2E_OUT=<thư mục tạm> node tests/e2e/run.js` (20 bước, khoảng 1 phút, tự bật máy chủ trên dữ liệu tạm; `--grep <chuỗi>` chạy riêng vài bước; Chromium và Playwright cài sẵn, không chạy `playwright install`)
- máy chủ thử tay: `M2M_DISABLE_WHISPER=1 M2M_DATA_DIR=<tạm> python3 -m uvicorn app.main:app --port 8765`
- thăm dò nhanh không cần máy chủ: `TestClient(create_app(Settings(data_dir=..., sync_jobs=True, disable_ollama=True, disable_whisper=True)), raise_server_exceptions=False)`
- CI: "Tests (pytest + Playwright)" chạy khi push đụng `app/`, `tests/`, vài file cấu hình `mobile/`; "Mobile build" chạy khi đụng `mobile/`, `app/static/`. Cả hai xong trong khoảng 2-3 phút. Xem bằng công cụ GitHub MCP (`actions_list` với `list_workflow_runs` rồi `list_workflow_jobs`), không có `gh`.
- Môi trường cloud: không có Ollama; không tải được model Whisper; không build được APK/IPA tại chỗ; chỉ có Chromium.

## Bẫy của dự án
- [2026-11-13] `pkill -f` với mẫu trùng chính dòng lệnh đang chạy tự giết shell (exit 144) → dùng mẫu neo đầu dòng (`^python3 -m uvicorn`) hoặc lưu PID.
- [2026-11-13] Test trong `tests/` import kiểu `from conftest import ...`, `from fakes import ...` (không dùng import tương đối) → file test mới theo đúng kiểu đó hoặc `from tests.fakes import ...`.
- [2026-11-13] Job "Đăng bản tải" của Mobile build cập nhật pre-release `mobile-latest` từ mọi nhánh → push đụng `app/static/` hay `mobile/` ở nhánh QA sẽ thay bản tải công khai; gom thay đổi giao diện vào ít lần push và báo cho người dùng.
- [2026-11-13] Máy chủ bỏ dấu cách hai đầu tiêu đề → khẳng định độ dài trong E2E phải chừa 1 ký tự (bước `gioi-han` từng đỏ vì bài test, 199 so với 200).
- [2026-11-13] Thư viện client (httpx, fetch của Node) không gửi được chuỗi có surrogate lẻ → muốn thử phải gửi byte JSON thô (`content=b'{"title": "\\ud83d"}'`).
- [2026-11-13] `tests/fakes.py::FakeOllama.raw_chat_body` gửi nguyên văn thân trả lời của `/api/chat`: dùng khi cần Ollama trả thứ `json.dumps` không tạo ra được.
- [2026-11-13] `git fetch --depth 1 origin <nhánh đang làm>` (bước tìm sổ tay ở nhánh khác) biến repo cục bộ thành bản nông tại HEAD: `git log d6aa6a5..HEAD` chỉ còn thấy commit mới → bỏ qua nhánh hiện tại khi dò, hoặc chạy `git fetch --unshallow origin <nhánh>` ngay sau đó.
- [2026-11-13] Lệnh tải kinh nghiệm chung từ repo khác (curl tới raw.githubusercontent.com) bị bộ phân quyền của phiên từ chối → ghi "không nạp được" vào báo cáo, không tìm cách vòng.

## Bản đồ phủ
- Lõi văn bản, heuristic, mind map, đọc JSON của LLM: unit + fuzz hạt giống cố định; còn thiếu ngôn ngữ ngoài Việt/Anh.
- API và pipeline: test tích hợp với SQLite thật, Ollama giả qua HTTP, Whisper giả; tương tranh bằng luồng thật và uvicorn thật; JSON thô hỏng (`tests/test_bad_input.py`). Còn thiếu: hai lượt tải lên đồng thời cho cùng cuộc họp; `Pipeline.start` gặp lỗi CSDL.
- Tải file: tên lạ, rỗng, lớn, kiểu giả, dọn file cũ; còn thiếu giới hạn dung lượng (sản phẩm chưa có).
- Giao diện: 20 bước E2E (máy tính, 390px, `mobile/www` khác origin); chưa đụng `#btn-reindex`, `#mm-zoom-out`; chưa chạy Firefox, WebKit.
- Di động: chỉ kiểm tĩnh cấu hình và dựng gói trên CI; chưa chạy app trên máy ảo hay thiết bị.
- Whisper thật, Ollama thật: chưa kiểm.

## Việc còn treo
- [ ] Quyết định của người dùng: mã truy cập và giới hạn origin cho API (hiện CORS `*`, không xác thực, chủ ý cho LAN).
- [ ] Giới hạn dung lượng file tải lên.
- [ ] Chỉ cho job đăng `mobile-latest` chạy ở nhánh mặc định.
- [ ] Trả thông báo chung cho lỗi 500 thay vì `str(exc)`.
- [ ] Hiển thị lỗi 422 thành câu dễ hiểu ở giao diện (hiện in JSON nếu phát sinh ngoài sáu ô đã có maxlength).
- [ ] Lưu bản sửa transcript rất dài chậm: 30.000 từ mất 2,7 giây, 60.000 từ mất 11,6 giây (so khớp difflib trong `Glossary.learn_from_edit`).
- [ ] Chạy E2E trên Firefox/WebKit; thử app trên Android và iOS thật (quyền micro, ghi âm khi tắt màn hình, xuất file trong WebView).

## Ghi nhanh
- (trống)

## Nhật ký
- 2026-11-13 | nhánh ccr-58431d82-km60c8 | lượt 1: toàn bộ backend, giao diện, cấu hình di động | pytest 45 → 94, E2E 0 → 19 | sửa 27 lỗi (7 nghiêm trọng) trong 5 commit | phiên bị ngắt trước khi viết sổ tay và báo cáo | không rõ thời lượng
- 2026-11-13 | nhánh ccr-58431d82-km60c8 | lượt 2: dựng lại từ git, JSON thô hỏng, giới hạn ô nhập, báo cáo | pytest 100/100, E2E 20/20, CI Tests #5 và Mobile build #5 xanh | sửa 5 lỗi (0 nghiêm trọng) | 1 lần đỏ do bài test (khẳng định độ dài 200 so với 199) | khoảng 20 phút
