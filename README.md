# Mic to Mindmap

Ứng dụng web **ghi âm cuộc họp → tóm tắt ý chính → vẽ mind map**, chạy hoàn toàn bằng **AI local** (không gửi dữ liệu ra ngoài) và **học hỏi để thông minh dần** qua mỗi lần bạn sử dụng.

## Tính năng

- 🎙 **Ghi âm** trực tiếp từ micro trong trình duyệt (tạm dừng/tiếp tục, đồng hồ, biểu đồ âm lượng) hoặc tải file ghi âm có sẵn, hoặc dán transcript thủ công.
- 🗣 **Nhận dạng giọng nói offline** bằng [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper), hỗ trợ tiếng Việt/tiếng Anh/tự nhận dạng.
- 🤖 **Tóm tắt bằng LLM local** qua [Ollama](https://ollama.com): ý chính, quyết định, việc cần làm (ai / hạn), từ khóa, cấu trúc mind map. Không có Ollama vẫn chạy được nhờ bộ phân tích heuristic dự phòng.
- 🧠 **Mind map tương tác** (SVG): kéo/zoom, thu gọn nhánh, sửa chữ, thêm/xóa nút, xuất SVG/PNG, xuất biên bản Markdown.
- 📈 **AI học hỏi và thông minh dần** (xem bên dưới).
- 🔎 **Hỏi trí nhớ**: hỏi đáp trên toàn bộ các cuộc họp đã lưu.

## AI local học hỏi như thế nào?

Mọi dữ liệu nằm trong một file SQLite ở thư mục `data/`. Ứng dụng học từ 4 nguồn:

| Bạn làm gì | Ứng dụng học được gì | Dùng lại ở đâu |
| --- | --- | --- |
| Sửa transcript | Các cặp "nhận sai → đúng" (tên riêng, thuật ngữ). Cặp do AI tự suy ra được áp dụng khi lặp lại đủ `M2M_CORRECTION_THRESHOLD` lần; thuật ngữ bạn thêm tay áp dụng ngay. | Gợi ý "từ nóng" cho Whisper (`initial_prompt`), tự sửa transcript mới, nhắc LLM viết đúng tên. |
| Sửa tóm tắt / mind map / việc cần làm | Bản bạn đã duyệt trở thành **ví dụ mẫu** (few-shot) kèm vector nhúng; thống kê **phong cách** (số ý chính, độ dài, số nhánh, có giữ mục quyết định không). | Ví dụ giống nhất được đưa vào prompt của cuộc họp sau; phong cách thành hướng dẫn cho LLM. |
| Đánh giá ★ và góp ý | ≥4★: kết quả thành ví dụ mẫu; ≤2★: loại khỏi ví dụ; góp ý được nhắc lại trong prompt. | Prompt của các lần sau. |
| Xử lý xong một cuộc họp | Tóm tắt + transcript được **ghi nhớ dài hạn** (vector nhúng bằng Ollama `nomic-embed-text`, hoặc hashing thuần Python khi chưa có). | Cuộc họp mới nhận "bối cảnh từ các cuộc họp trước" liên quan nhất; tính năng Hỏi trí nhớ. |

Tab **Học hỏi** hiển thị thống kê, nhật ký những gì AI đã học, bảng thuật ngữ, và cho phép **xuất dữ liệu huấn luyện (JSONL)** gồm các cặp (transcript, kết quả đã duyệt) để fine-tune model riêng sau này.

## Cài đặt

Yêu cầu: Python 3.10+, ffmpeg (khuyến nghị), trình duyệt Chrome/Edge/Firefox.

```bash
git clone <repo> mic-to-mindmap && cd mic-to-mindmap
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # ứng dụng web (chạy được ngay với heuristic)
pip install -r requirements-ai.txt       # + faster-whisper (nhận dạng giọng nói offline)
cp .env.example .env                     # tùy chỉnh model, cổng, ngôn ngữ

# LLM local: cài Ollama (https://ollama.com) rồi tải model
./scripts/setup_models.sh                # ollama pull qwen2.5:7b, nomic-embed-text + tải Whisper small

./run.sh                                 # mở http://127.0.0.1:8000
```

Gợi ý model cho tiếng Việt: `qwen2.5:7b` (cân bằng), `qwen2.5:14b` hoặc `gemma2:9b` (chất lượng cao hơn), `qwen2.5:3b` (máy yếu). Whisper: `small` nhanh, `medium`/`large-v3` chính xác hơn (đặt `WHISPER_MODEL`). Có GPU NVIDIA: `WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16`.

> Ghi âm từ micro cần trang chạy trên `localhost` hoặc HTTPS. Tùy chọn "Phụ đề trực tiếp" dùng Web Speech API của trình duyệt (Chrome gửi âm thanh tới Google) nên **tắt mặc định**; chỉ bật khi chưa cài Whisper và không cần bảo mật tuyệt đối.

## Ứng dụng di động (Android / iOS)

Thư mục `mobile/` chứa ứng dụng [Capacitor](https://capacitorjs.com) bọc giao diện web: điện thoại ghi âm và xem kết quả, phần AI chạy trên máy tính trong cùng mạng LAN (`./run.sh --host 0.0.0.0`). Trong app nhập địa chỉ máy chủ, ví dụ `http://192.168.1.10:8000`, rồi nhấn **Kết nối**.

Bản build sẵn do GitHub Actions tạo tự động nằm ở pre-release **[mobile-latest](https://github.com/lupin2498/mic-to-mindmap/releases/tag/mobile-latest)**:

- `mic-to-mindmap-release.apk`: cài trực tiếp trên Android (cho phép cài từ nguồn không xác định).
- `mic-to-mindmap-unsigned.ipa`: bộ cài iOS chưa ký; ký bằng Apple ID qua Sideloadly/AltStore hoặc mở `mobile/ios/App/App.xcodeproj` bằng Xcode rồi cài lên iPhone.

Chi tiết build thủ công, ký release và cấu hình xem [`mobile/README.md`](mobile/README.md).

## Cấu hình (biến môi trường / `.env`)

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `M2M_DATA_DIR` | `./data` | Nơi lưu audio và SQLite |
| `M2M_LANGUAGE` | `vi` | Ngôn ngữ mặc định |
| `M2M_HOST`, `M2M_PORT` | `127.0.0.1`, `8000` | Địa chỉ web |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Địa chỉ Ollama |
| `OLLAMA_MODEL` | `qwen2.5:7b` | LLM tóm tắt |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Model nhúng cho trí nhớ |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | `small` / `cpu` / `int8` | Cấu hình faster-whisper |
| `M2M_CORRECTION_THRESHOLD` | `2` | Số lần một sửa lỗi suy ra cần lặp lại trước khi tự áp dụng |

## Kiến trúc

```
app/
├── main.py            FastAPI: REST API + phục vụ giao diện tĩnh
├── pipeline.py        Nhận dạng → sửa thuật ngữ → phân tích → ghi nhớ (chạy nền, có trạng thái)
├── transcription.py   faster-whisper (tùy chọn), gợi ý từ nóng đã học
├── summarizer.py      Prompt LLM (Ollama) kèm bối cảnh đã học; map-reduce cho transcript dài
├── heuristic.py       Bộ phân tích dự phòng không cần LLM (tóm tắt trích xuất, quyết định, việc cần làm, mind map)
├── mindmap.py         Chuẩn hóa cây mind map từ mọi định dạng LLM trả về, xuất Markdown
├── learning/
│   ├── memory.py      Trí nhớ dài hạn + tìm kiếm ngữ nghĩa (cosine)
│   ├── embeddings.py  Ollama embeddings, dự phòng hashing 512 chiều
│   ├── glossary.py    Học thuật ngữ từ diff transcript, áp dụng sửa lỗi
│   ├── feedback.py    Ví dụ mẫu, phong cách, đánh giá, xuất JSONL
│   └── context.py     Gom bối cảnh cho prompt
├── db.py              SQLite (meetings, feedback, glossary, memories, preferences, events)
└── static/            Giao diện: index.html, app.js (ghi âm, API), mindmap.js (SVG), style.css
```

API chính: `POST /api/meetings`, `POST /api/meetings/{id}/audio`, `POST /api/meetings/{id}/process`, `GET /api/meetings/{id}`, `PUT /api/meetings/{id}/transcript`, `PUT /api/meetings/{id}/analysis`, `POST /api/meetings/{id}/rating`, `GET /api/meetings/{id}/export.md`, `GET /api/learning/stats`, `POST /api/learning/ask`, `GET/POST/DELETE /api/glossary`, `GET /api/learning/export`, `GET /api/health`. Tài liệu tương tác tại `/docs`.

## Kiểm thử

```bash
pip install -r requirements-dev.txt
pytest
```

Bộ test chạy không cần Ollama/Whisper (dùng heuristic và bộ nhúng hashing).
