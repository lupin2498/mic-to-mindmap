# Mic to Mindmap

Ứng dụng **nói → văn bản → tóm tắt → sơ đồ tư duy**, tự động từ đầu đến cuối và **không cần AI**: không cần cài Whisper, Ollama hay máy chủ nào. Bấm ghi, nói, bấm dừng là có bản tóm tắt và sơ đồ tư duy. Ai có máy tính chạy AI local thì nối thêm vào để kết quả tốt hơn, và ứng dụng vẫn **học thói quen của bạn** qua mỗi lần dùng.

## Tính năng

- 🎙 **Nói là ra chữ**: văn bản hiện ngay trong lúc nói nhờ bộ nhận dạng giọng nói có sẵn của điện thoại hoặc trình duyệt (tiếng Việt, tiếng Anh). Có tạm dừng/tiếp tục, đồng hồ, tự nghe lại khi bộ nhận dạng ngắt quãng.
- ✨ **Tự tóm tắt, không cần AI**: một bộ máy thuật toán rút ý chính, quyết định, việc cần làm (việc gì / ai / hạn nào), từ khóa và đặt luôn tiêu đề. Bản xem trước cập nhật ngay khi bạn còn đang nói.
- 🧠 **Tự vẽ sơ đồ tư duy** (SVG tương tác): nhánh theo chủ đề, nhánh Quyết định, nhánh Việc cần làm; kéo/zoom (chuột, một ngón, chụm hai ngón), thu gọn nhánh, sửa chữ, thêm/xóa nút, xuất SVG/PNG, xuất biên bản Markdown.
- 📱 **Chạy độc lập trên điện thoại**: app Android/iOS tự xử lý và lưu mọi thứ ngay trên máy, không cần máy chủ, không cần mạng LAN.
- 📝 Vẫn nhận **file ghi âm có sẵn** (cần máy chủ có Whisper) và **văn bản dán tay**.
- 📈 **Học dần**: tự sửa thuật ngữ bạn hay phải sửa, tóm tắt đúng cỡ bạn hay giữ, tìm lại nội dung trong các bản ghi cũ.
- 🤖 **AI local là tùy chọn**: có [faster-whisper](https://github.com/SYSTRAN/faster-whisper) thì máy chủ nhận dạng lại từ file ghi âm cho chính xác hơn; có [Ollama](https://ollama.com) thì LLM viết tóm tắt thay cho thuật toán.

## Không cần AI thì chạy bằng gì?

| Bước | Cách làm | Nằm ở đâu |
| --- | --- | --- |
| Giọng nói → văn bản | Bộ nhận dạng giọng nói **có sẵn của thiết bị**: `SpeechRecognizer` trên Android, `SFSpeechRecognizer` trên iOS (qua plugin riêng của app), Web Speech API trên trình duyệt máy tính (Chrome, Edge, Safari). Ứng dụng tự nghe lại sau mỗi câu để thành một lần ghi liên tục. | `app/static/speech.js`, `mobile/android/.../SpeechPlugin.java`, `mobile/ios/App/App/SpeechPlugin.swift` |
| Văn bản → tóm tắt | Thuật toán thuần: gộp từ ghép tiếng Việt bằng từ điển, chấm điểm câu theo cụm từ khóa, vị trí, con số, từ gợi ý (thống nhất, chốt, giao cho, trước thứ sáu...), chọn các câu vừa quan trọng vừa không trùng ý. | `app/heuristic.py`, `app/textutil.py` (máy chủ) và `app/static/engine.js` (điện thoại, trình duyệt) |
| Tóm tắt → sơ đồ tư duy | Cụm từ khóa nổi bật thành nhánh chủ đề, xếp theo thứ tự được nhắc tới; mỗi câu chỉ nằm ở một nhánh; quyết định và việc cần làm thành hai nhánh riêng. | cùng các file trên, vẽ bằng `app/static/mindmap.js` |

Hai bản Python và JavaScript của bộ máy dùng chung một file dữ liệu (`app/static/engine-data.js`) và được kiểm cho ra kết quả **giống hệt nhau** trên hơn 5.000 ca (`tests/test_engine_parity.py`).

> **Về riêng tư:** ứng dụng không gửi gì đi đâu. Riêng bộ nhận dạng giọng nói là dịch vụ của hệ điều hành/trình duyệt: Chrome và phần lớn máy Android gửi âm thanh tới Google, iPhone gửi tới Apple, trừ khi máy đã có gói nhận dạng ngoại tuyến cho ngôn ngữ đó (app Android tự thử gói ngoại tuyến khi mất mạng). Cần giữ âm thanh hoàn toàn trong nhà thì dùng máy chủ có Whisper ở phần "AI local" bên dưới.

Giới hạn nên biết: bộ máy không cần AI **chọn và rút gọn câu có sẵn** chứ không viết lại bằng lời khác, nên chất lượng phụ thuộc vào văn bản nhận dạng được; nó hiểu tiếng Việt và tiếng Anh. Trên trình duyệt máy tính, ứng dụng vừa nhận dạng vừa ghi âm để nghe lại; trên điện thoại, micro chỉ cho một bên dùng nên app chỉ giữ văn bản (không có file ghi âm).

## Ứng dụng học hỏi như thế nào?

Trên máy chủ, dữ liệu nằm trong một file SQLite ở thư mục `data/`; ở chế độ độc lập, dữ liệu nằm trong bộ nhớ của app/trình duyệt (IndexedDB). Ứng dụng học từ 4 nguồn:

| Bạn làm gì | Ứng dụng học được gì | Dùng lại ở đâu |
| --- | --- | --- |
| Sửa văn bản | Các cặp "nhận sai → đúng" (tên riêng, thuật ngữ). Cặp tự suy ra được áp dụng khi lặp lại đủ `M2M_CORRECTION_THRESHOLD` lần; thuật ngữ bạn thêm tay áp dụng ngay. | Tự sửa văn bản mới; gợi ý "từ nóng" cho Whisper và nhắc LLM viết đúng tên (khi có AI). |
| Sửa tóm tắt / sơ đồ / việc cần làm | **Phong cách** của bạn: hay giữ mấy ý chính, mấy nhánh. Khi có LLM, bản bạn đã duyệt còn thành **ví dụ mẫu** (few-shot). | Từ lần sửa thứ hai, bộ máy không cần AI tự tóm tắt đúng số ý và số nhánh đó; LLM nhận ví dụ và hướng dẫn phong cách. |
| Đánh giá ★ và góp ý | ≥4★: kết quả thành ví dụ mẫu; ≤2★: loại khỏi ví dụ; góp ý được nhắc lại trong prompt. | Prompt của LLM ở các lần sau. |
| Xử lý xong một bản ghi | Tóm tắt + văn bản được **ghi nhớ** (vector nhúng bằng Ollama `nomic-embed-text`, hoặc so khớp từ thuần toán khi không có). | Tính năng **Hỏi trí nhớ**: tìm lại đoạn liên quan trong mọi bản ghi cũ; bối cảnh cho LLM. |

Tab **Học hỏi** hiển thị thống kê, nhật ký những gì đã học, bảng thuật ngữ; trên máy chủ còn **xuất dữ liệu huấn luyện (JSONL)** gồm các cặp (văn bản, kết quả đã duyệt) để fine-tune model riêng sau này.

## Cài đặt

**Chỉ dùng trên điện thoại:** cài APK/IPA ở mục "Ứng dụng di động" bên dưới là xong, không cần làm gì thêm.

**Chạy bản web trên máy tính** (Python 3.10+, trình duyệt Chrome/Edge/Safari để có nhận dạng giọng nói):

```bash
git clone <repo> mic-to-mindmap && cd mic-to-mindmap
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # đủ để dùng ngay, không cần AI
./run.sh                                 # mở http://127.0.0.1:8000
```

> Micro và nhận dạng giọng nói cần trang chạy trên `localhost` hoặc HTTPS. Firefox chưa có Web Speech API: vẫn ghi âm, dán văn bản được, còn "nói ra chữ" thì cần Chrome/Edge/Safari hoặc máy chủ có Whisper.

### AI local (tùy chọn)

```bash
pip install -r requirements-ai.txt       # + faster-whisper (nhận dạng giọng nói offline, cần ffmpeg)
cp .env.example .env                     # tùy chỉnh model, cổng, ngôn ngữ
./scripts/setup_models.sh                # cài Ollama (https://ollama.com) trước; lệnh này tải qwen2.5:7b, nomic-embed-text, Whisper small
```

Có Whisper: văn bản nhận dạng lúc nói chỉ là bản nháp, máy chủ nhận dạng lại từ file ghi âm (trừ khi bạn đã sửa tay). Có Ollama: LLM viết tóm tắt và sơ đồ; lỗi hay tắt Ollama thì tự quay về thuật toán. Ba huy hiệu ở góc trên cho biết ứng dụng đang chạy kiểu nào.

Gợi ý model cho tiếng Việt: `qwen2.5:7b` (cân bằng), `qwen2.5:14b` hoặc `gemma2:9b` (chất lượng cao hơn), `qwen2.5:3b` (máy yếu). Whisper: `small` nhanh, `medium`/`large-v3` chính xác hơn (đặt `WHISPER_MODEL`). Có GPU NVIDIA: `WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16`.

## Ứng dụng di động (Android / iOS)

Thư mục `mobile/` chứa ứng dụng [Capacitor](https://capacitorjs.com) bọc giao diện web cùng bộ máy không cần AI. App **chạy độc lập**: nói, ra văn bản, tóm tắt, vẽ sơ đồ tư duy và lưu ngay trên điện thoại. Lần đầu bấm ghi, máy hỏi quyền micro (iOS hỏi thêm quyền nhận dạng giọng nói).

Bản build sẵn do GitHub Actions tạo tự động nằm ở pre-release **[mobile-latest](https://github.com/lupin2498/mic-to-mindmap/releases/tag/mobile-latest)**:

- `mic-to-mindmap-release.apk`: cài trực tiếp trên Android (cho phép cài từ nguồn không xác định).
- `mic-to-mindmap-unsigned.ipa`: bộ cài iOS chưa ký; ký bằng Apple ID qua Sideloadly/AltStore hoặc mở `mobile/ios/App/App.xcodeproj` bằng Xcode rồi cài lên iPhone.

Muốn dùng thêm AI: chạy `./run.sh --host 0.0.0.0` trên máy tính cùng mạng LAN, trong app mở **⚙ Máy chủ AI (tùy chọn)**, nhập địa chỉ (ví dụ `http://192.168.1.10:8000`) rồi nhấn **Kết nối**; nhấn **Dùng độc lập** để quay về.

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
├── heuristic.py       Bộ máy không cần AI: ý chính, quyết định, việc cần làm (ai/hạn), tiêu đề, sơ đồ tư duy
├── textutil.py        Tách câu, gộp từ ghép tiếng Việt, cụm từ khóa, chấm điểm câu
├── engine_data.py     Đọc app/static/engine-data.js (từ điển, từ gợi ý) dùng chung với bản JavaScript
├── mindmap.py         Chuẩn hóa cây sơ đồ từ mọi định dạng, xuất Markdown
├── transcription.py   faster-whisper (tùy chọn), gợi ý từ nóng đã học
├── summarizer.py      Prompt LLM (Ollama, tùy chọn) kèm bối cảnh đã học; không có thì dùng heuristic.py
├── learning/          Trí nhớ + tìm kiếm, thuật ngữ học từ lần sửa, phong cách, ví dụ mẫu
├── db.py              SQLite (meetings, feedback, glossary, memories, preferences, events)
└── static/
    ├── engine-data.js Dữ liệu của bộ máy (JSON), một nguồn cho cả Python lẫn JavaScript
    ├── engine.js      Bộ máy không cần AI bản JavaScript, kết quả giống hệt bản Python
    ├── speech.js      Nhận dạng giọng nói của thiết bị: plugin của app hoặc Web Speech API
    ├── local.js       Chế độ độc lập: thay máy chủ bằng IndexedDB ngay trên máy
    ├── app.js         Giao diện: ghi, văn bản trực tiếp, xem trước, kết quả, học hỏi
    └── mindmap.js     Sơ đồ tư duy SVG tương tác
mobile/
├── android/app/src/main/java/.../SpeechPlugin.java, SpeechLoop.java   Plugin nhận dạng giọng nói Android
└── ios/App/App/SpeechPlugin.swift                                     Plugin nhận dạng giọng nói iOS
```

API chính: `POST /api/meetings`, `POST /api/meetings/{id}/audio`, `POST /api/meetings/{id}/process`, `GET /api/meetings/{id}`, `PUT /api/meetings/{id}/transcript`, `PUT /api/meetings/{id}/analysis`, `POST /api/meetings/{id}/rating`, `GET /api/meetings/{id}/export.md`, `GET /api/learning/stats`, `POST /api/learning/ask`, `GET/POST/DELETE /api/glossary`, `GET /api/learning/export`, `GET /api/health`. Tài liệu tương tác tại `/docs`.

## Kiểm thử

```bash
pip install -r requirements-dev.txt
python3 -m pytest -q                       # bộ máy không cần AI (kể cả so Python với JavaScript, cần node), API, pipeline, học hỏi, tương tranh, tải file, fuzz, cấu hình di động

cd tests/e2e && npm install && npx playwright install chromium && cd ../..
node tests/e2e/run.js                      # giao diện thật bằng Playwright: máy tính, 390px, bản đóng gói chạy độc lập, nhận dạng giọng nói giả
node tests/e2e/run.js --grep mindmap       # chỉ chạy các bước có tên chứa "mindmap"
E2E_OUT=/tmp/e2e node tests/e2e/run.js     # chọn nơi lưu ảnh chụp từng bước và log máy chủ
```

Bộ test chạy không cần Ollama/Whisper thật:

- `tests/fakes.py` có Ollama giả chạy qua HTTP (`/api/tags`, `/api/chat`, `/api/embed`, `/api/embeddings`) và Whisper giả, bám sát hợp đồng thật để kiểm JSON hỏng, timeout, thiếu model, đổi model nhúng.
- `tests/e2e/run.js` tự bật máy chủ trên thư mục dữ liệu tạm, dùng micro giả của Chromium, thay Web Speech API và plugin của app bằng bản giả điều khiển được (nói câu nào, lỗi lúc nào), in `PASS`/`FAIL` từng bước và thoát mã khác 0 khi có bước đỏ.
- `mobile/android/app/src/test/.../SpeechLoopTest.java` kiểm vòng lặp nghe liên tục của Android trên JVM (`./gradlew testDebugUnitTest`), không cần máy ảo.
- GitHub Actions: workflow **Tests (pytest + Playwright)** chạy hai bộ đầu ở mỗi lần push đụng tới `app/` hoặc `tests/`; workflow **Mobile build** chạy test Android rồi dựng APK/IPA. Xem kết quả ở tab Actions của repo.
- Chưa có gì thay được việc thử trên máy thật: chất lượng nhận dạng giọng nói tùy từng điện thoại và chưa được kiểm tự động.
- Báo cáo đợt kiểm thử gần nhất: [`TEST_REPORT.md`](TEST_REPORT.md).
