# Sổ tay kiểm thử: mic-to-mindmap
<!-- Agent test-fix-bug tự cập nhật sau mỗi lần chạy. -->
## Lệnh và môi trường
- test backend: `python3 -m pytest -q` (122 test, khoảng 35 giây, không cần Ollama/Whisper thật; `tests/test_engine_parity.py` cần `node` để so bản JavaScript của bộ máy với bản Python, không có thì tự bỏ qua)
- E2E giao diện: `E2E_OUT=<thư mục tạm> node tests/e2e/run.js` (37 bước, khoảng 2 phút rưỡi, tự bật máy chủ trên dữ liệu tạm; `--grep <chuỗi>` lọc theo chuỗi con của tên bước, không phải biểu thức chính quy; Chromium và Playwright cài sẵn, không chạy `playwright install`)
- test Android trên JVM: `./gradlew testDebugUnitTest` trong `mobile/android` trên CI (42 test). Tại chỗ không có Android SDK nhưng chạy được bằng javac + JUnit: các file thuần Java (SpeechLoop, FileSession, FilePump, PcmConverter) cùng test của chúng; biên dịch thử cả plugin với `android-all.jar` (Robolectric) và `classes.jar` của Capacitor (tải từ Maven Central).
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

- [2026-11-14] Bộ máy không cần AI có hai bản phải khớp từng ký tự: `app/heuristic.py` + `app/textutil.py` và `app/static/engine.js`, dữ liệu chung ở `app/static/engine-data.js` → sửa luật ở một bên thì sửa bên kia rồi chạy `tests/test_engine_parity.py`; biểu thức chính quy dùng chung không dùng `\b`, `\d`, lookbehind.
- [2026-11-14] Máy CI dùng phông rộng hơn máy phát triển nên chữ trong nút sơ đồ xuống dòng ở chỗ khác → đừng khẳng định theo vị trí xuống dòng; đọc chữ của nút bằng `.mm-node > text` (đã giữ dấu cách ở chỗ xuống dòng).
- [2026-11-14] E2E không có micro thật lẫn dịch vụ nhận dạng: `fakeWebSpeech` / `fakeNativeSpeech` trong `tests/e2e/run.js` thay Web Speech API và plugin `M2MSpeech`, điều khiển bằng `say()` / `nativeSay()`.
- [2026-11-14] Chờ một dòng chữ tiến trình rồi mới thao tác tiếp không bảo đảm ứng dụng đã làm xong bước sau dòng chữ đó (bước `polling` từng đỏ một lần trên CI, lộ ra lỗi thật: gửi xong mở ngay cuộc họp khác thì bị kéo đi) → muốn tái hiện chắc chắn thì làm chậm đúng lời gọi bằng `page.route`, như bước `polling-som`.
- [2026-11-14] Máy này không tải được artifact của Actions (máy chủ blob bị chặn); log của job thì đọc được bằng `get_job_logs`.
- [2026-11-14] Máy chủ thử của E2E phục vụ `app/static` thẳng từ đĩa: sửa file tĩnh lúc bộ E2E đang chạy thì các bước sau chạy mã mới (bản `mobile/www` thì đã dựng từ đầu) → đừng sửa `app/static` khi đang đo mốc; muốn so trước/sau thì `git stash push <file>` rồi chạy `--grep`.
- [2026-11-14] Trình giả lập điện thoại (`isMobile`) thu nhỏ trang khi nội dung rộng hơn màn hình nên `innerWidth` rộng theo (399 trên màn 390): khẳng định tràn ngang phải so với `document.documentElement.clientWidth` (bước `dien-thoai`, `doc-lap-ghi-am` đỏ với CSS cũ).
- [2026-11-14] Một bước E2E khẳng định nhiều lỗi thì trước khi sửa chỉ lỗi đầu tiên đỏ → chạy lại bước với từng bản sửa một phần để chắc mỗi khẳng định bắt được lỗi của nó (đã làm cho `doc-lap-nhap-file-roi-di`).
- [2026-11-14] So bộ máy Python với JavaScript trên nhiều hạt giống: chép `_cases()`/`_python()` của `tests/test_engine_parity.py`, đổi `SEED`, chạy qua `tests/js/engine_cli.js` (mỗi hạt giống khoảng 5.000 ca, 20 giây).

## Bản đồ phủ
- Lõi văn bản, heuristic, mind map, đọc JSON của LLM: unit + fuzz hạt giống cố định; còn thiếu ngôn ngữ ngoài Việt/Anh.
- API và pipeline: test tích hợp với SQLite thật, Ollama giả qua HTTP, Whisper giả; tương tranh bằng luồng thật và uvicorn thật; JSON thô hỏng (`tests/test_bad_input.py`). Còn thiếu: hai lượt tải lên đồng thời cho cùng cuộc họp; `Pipeline.start` gặp lỗi CSDL.
- Tải file: tên lạ, rỗng, lớn, kiểu giả, dọn file cũ; còn thiếu giới hạn dung lượng (sản phẩm chưa có).
- Bộ máy không cần AI: mẫu giống thật trong `tests/samples.py` (họp, bài giảng, ghi chú ngắn, văn bản nhận dạng giọng nói, giao việc đích danh, nói một mạch không dấu câu), khẳng định hành vi ở `tests/test_engine.py`, so Python với JavaScript trên hơn 5.000 ca (đợt 14/11 thử thêm 10 hạt giống, khớp hết); còn thiếu bản ghi thật dài hàng giờ, ngôn ngữ ngoài Việt/Anh, người phụ trách gọi bằng "X ơi".
- Giao diện: 37 bước E2E (máy tính, 390px, `mobile/www` khác origin, chế độ độc lập, nhận dạng giọng nói giả qua Web Speech API và plugin, nhập file ghi âm qua Web Speech API nhận MediaStreamTrack và qua plugin giả, dịch vụ tự tắt giữa lúc nghe file, rời trang/mở cuộc họp khác/bấm cuộc họp mới khi đang chuyển file, đổi chiều cao khung nhìn khi đang phóng to và sửa nút sơ đồ); chưa đụng `#mm-zoom-out`; chưa chạy Firefox, WebKit; chưa có bàn phím ảo thật.
- Di động: kiểm tĩnh cấu hình, test JVM (vòng lặp nghe liên tục, điều phối nhận dạng từ file kể cả nhịp báo tiến trình, bơm âm thanh, đổi tần số) và dựng gói trên CI; phần dùng API Android/iOS thật (MediaCodec, SpeechRecognizer với EXTRA_AUDIO_SOURCE, SFSpeechRecognizer, AVAudioFile) chỉ mới được biên dịch; chưa chạy app trên máy ảo hay thiết bị.
- Whisper thật, Ollama thật: chưa kiểm.

## Việc còn treo
- [ ] Quyết định của người dùng: mã truy cập và giới hạn origin cho API (hiện CORS `*`, không xác thực, chủ ý cho LAN).
- [ ] Giới hạn dung lượng file tải lên.
- [ ] Chỉ cho job đăng `mobile-latest` chạy ở nhánh mặc định.
- [ ] Trả thông báo chung cho lỗi 500 thay vì `str(exc)`.
- [ ] Hiển thị lỗi 422 thành câu dễ hiểu ở giao diện (hiện in JSON nếu phát sinh ngoài sáu ô đã có maxlength).
- [ ] Lưu bản sửa transcript rất dài chậm: 30.000 từ mất 2,7 giây, 60.000 từ mất 11,6 giây (so khớp difflib trong `Glossary.learn_from_edit`).
- [ ] Chạy E2E trên Firefox/WebKit; thử app trên Android và iOS thật (quyền micro, ghi âm khi tắt màn hình, xuất file trong WebView).
- [ ] Thử nhận dạng giọng nói trên máy thật: plugin `M2MSpeech` (Android nhiều hãng, iOS), tiếng "tít" của bộ nhận dạng, mất mạng giữa chừng, ra nền rồi quay lại, ghi liên tục trên 30 phút.
- [ ] Chữ của sơ đồ trên màn 390px chỉ cao 8,3px (cỡ 13 nhân tỉ lệ 0,64): cần người dùng chọn giữa chữ to hơn (nút nhiều dòng hơn) và kéo ngang.
- [ ] Bộ máy: nhận "X ơi em phụ trách" là việc của X; bỏ đuôi "nhé hạn là" khỏi đầu việc; tách hai việc nói liền trong một câu (mẫu `vi_speech_run_on`, việc của Hà).
- [ ] `local.js`: đọc-sửa-ghi cuộc họp trong một giao dịch IndexedDB (xóa đúng lúc đang lưu âm thanh lớn có thể làm cuộc họp sống lại).
- [ ] Thử nhập file ghi âm trên máy thật (cả khi app ở nền hoặc tắt màn hình giữa chừng): dịch vụ nào của Android nhận `EXTRA_AUDIO_SOURCE` (bộ nhận dạng trên máy, ứng dụng Google, máy không có Google), file m4a/mp3/amr/ogg dài 1 giờ, iPhone có và không có nhận dạng tiếng Việt trên máy.

## Ghi nhanh
- (trống)

## Nhật ký
- 2026-11-13 | nhánh ccr-58431d82-km60c8 | lượt 1: toàn bộ backend, giao diện, cấu hình di động | pytest 45 → 94, E2E 0 → 19 | sửa 27 lỗi (7 nghiêm trọng) trong 5 commit | phiên bị ngắt trước khi viết sổ tay và báo cáo | không rõ thời lượng
- 2026-11-13 | nhánh ccr-58431d82-km60c8 | lượt 2: dựng lại từ git, JSON thô hỏng, giới hạn ô nhập, báo cáo | pytest 100/100, E2E 20/20, CI Tests #5 và Mobile build #5 xanh | sửa 5 lỗi (0 nghiêm trọng) | 1 lần đỏ do bài test (khẳng định độ dài 200 so với 199) | khoảng 20 phút
- 2026-11-14 | nhánh ccr-917aaad6-9ufq0r | nâng cấp (không phải lượt test-fix-bug): nói ra văn bản bằng nhận dạng của thiết bị, tóm tắt và sơ đồ tư duy bằng thuật toán, app chạy độc lập | pytest 100 → 118, E2E 20 → 31, thêm 18 test JVM cho Android | 2 lần đỏ trên CI do phông chữ khác máy phát triển (đã sửa ở `mindmap.js` và bài test)
- 2026-11-14 | nhánh ccr-917aaad6-9ufq0r | thêm tính năng nhập bản ghi âm có sẵn (không cần AI): plugin Android/iOS nhận dạng từ file, Chrome nhận dạng từ MediaStreamTrack | pytest 120, E2E 34, JVM 41 | chưa thử trên máy thật
- 2026-11-14 | nhánh ccr-917aaad6-9ufq0r | lượt test-fix-bug: nhập file, nhận dạng giọng nói, bộ máy không cần AI, giao diện điện thoại, plugin | pytest 120 → 122, E2E 34 → 37, JVM 41 → 42 | sửa 9 lỗi (3 cao) + 1 khẳng định lỏng | 0 lần đỏ do môi trường | khoảng 1 giờ
