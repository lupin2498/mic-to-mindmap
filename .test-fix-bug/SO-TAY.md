# Sổ tay kiểm thử: mic-to-mindmap
<!-- Agent test-fix-bug tự cập nhật sau mỗi lần chạy. -->
## Lệnh và môi trường
- test backend: `python3 -m pytest -q` (khoảng 27 giây, không cần Ollama/Whisper thật)
- E2E giao diện: `E2E_OUT=<thư mục tạm> node tests/e2e/run.js` (khoảng 1 phút, tự bật máy chủ; `--grep <chuỗi>` để chạy riêng vài bước)
- chạy máy chủ thử tay: `M2M_DISABLE_WHISPER=1 M2M_DATA_DIR=<tạm> python3 -m uvicorn app.main:app --port 8765`
- CI: workflow "Tests (pytest + Playwright)" chạy khi push đụng `app/`, `tests/`; "Mobile build" chạy khi đụng `mobile/`, `app/static/`. Xem bằng công cụ GitHub MCP (`actions_list`, `get_job_logs`), không có `gh`.
- Môi trường cloud: không có Ollama, không tải được model Whisper (Hugging Face bị chặn), không build được APK/IPA (dl.google.com bị chặn).

## Ghi nhanh
- [2026-11-13] Lượt 2 (nối tiếp sau khi container khởi động lại): mốc 94 pytest xanh, E2E 19/19 xanh tại HEAD 31e8b07.
- [2026-11-13] Thăm dò API bằng byte JSON thô tìm ra: `\ud83d` (nửa emoji) làm 5 endpoint ghi trả 500; mind map lồng 3000 cấp trả 500 (RecursionError); `DELETE /api/glossary/<số 23 chữ số>` trả 500; `duration_sec=-5` được lưu nguyên. Đang sửa.
- [2026-11-13] Đã sửa 4 lỗi trên (tests/test_bad_input.py, 6 test đỏ → xanh), pytest 100/100. Tiếp theo: rà giao diện, viết TEST_REPORT.md, hoàn thiện sổ tay.
