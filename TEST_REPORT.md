# Báo cáo kiểm thử và sửa lỗi: Mic to Mindmap

# Đợt 14/11/2026: phần không cần AI và nhập bản ghi âm có sẵn

Nhánh `ccr-917aaad6-9ufq0r`, mốc ban đầu là commit `b965832`. Phạm vi: những gì thêm sau đợt 13/11 (bộ máy tóm tắt
không cần AI hai bản Python/JavaScript, nhận dạng giọng nói của thiết bị, nhập bản ghi âm có sẵn, chế độ độc lập, plugin
Android/iOS). Thời lượng khoảng một giờ.

## 1. Môi trường và phương pháp

| Hạng mục | Giá trị |
|---|---|
| Tại chỗ | Linux, Python 3, Node 22, Playwright với Chromium; javac + JUnit cho phần Java thuần, biên dịch cả plugin với `android-all.jar` và `classes.jar` của Capacitor |
| CI | `Tests (pytest + Playwright)` và `Mobile build (Android APK + iOS IPA)` (41 → 42 test JVM, biên dịch Swift trên macOS) |
| Không có | Thiết bị, máy ảo Android, Xcode, Whisper, Ollama, Firefox, WebKit |

- Rà bằng mắt từng luồng bất đồng bộ của `speech.js`, `app.js` (nhập file), `FileRecognizer`/`FileSession`/`FilePump`/`SpeechPlugin` (Android) và `FileTranscriptionJob` (iOS): lời gọi không bao giờ trả lời, hẹn giờ của đối tượng đã chết, tài nguyên không đóng, chặn đã có cho ghi âm nhưng chưa có cho nhập file.
- So bộ máy Python với JavaScript thêm 10 hạt giống ngẫu nhiên (khoảng 50.000 ca, ngoài 5.000 ca của bộ test): khớp hết, trước và sau khi sửa.
- Chạy bộ máy trên văn bản nhận dạng giọng nói tự viết (một mạch không dấu câu, nhiều mốc thời gian).
- Nghi ngờ khẳng định lỏng: đo cỡ chữ thật của sơ đồ trên màn 390px, đo phần tử tràn ngang theo `clientWidth`.
- Mỗi lỗi có test đỏ trước khi sửa. Bước E2E khẳng định ba lỗi thì chạy lại với từng bản sửa một phần để chắc từng khẳng định bắt được lỗi của nó.

## 2. Kết quả

| Bộ test | Trước | Sau |
|---|---|---|
| pytest | 120 đạt | 122 đạt / 122 |
| E2E Playwright | 34 bước đạt | 37 bước đạt / 37 |
| JVM (Android, chạy tại chỗ bằng JUnit; CI chạy `gradlew testDebugUnitTest`) | 41 đạt | 42 đạt / 42 |

## 3. Lỗi đã sửa

| # | Mức độ | Lỗi người dùng thấy | Nguyên nhân | Nơi sửa | Commit | Test hồi quy |
|---|---|---|---|---|---|---|
| 1 | Cao | Mở một cuộc họp cũ ra sửa trong lúc đang chuyển file ghi âm (việc mất nhiều phút): chuyển xong là bị kéo sang kết quả của file, phần đang sửa mất | Mốc "người dùng đã mở cuộc họp khác" (openSeq) lấy lúc gửi lên, không phải lúc bắt đầu chuyển file | `app/static/app.js` | `cf7c4a3` | E2E `doc-lap-nhap-file-roi-di` |
| 2 | Cao | Bấm "Cuộc họp mới" giữa lúc chuyển file: văn bản đã có bị xóa nhưng việc chuyển vẫn chạy, phần còn lại tự thành một cuộc họp thiếu cả đoạn đầu | Nút chỉ bỏ bản ghi đang ghi, không dừng việc chuyển file | `app/static/app.js` | `cf7c4a3` | E2E `doc-lap-nhap-file-roi-di` |
| 3 | Cao | Đóng hoặc tải lại trang giữa lúc chuyển file: không hỏi, mất hết phần đã nhận dạng | Hộp hỏi `beforeunload` không tính việc chuyển file | `app/static/app.js` | `cf7c4a3` | E2E `doc-lap-nhap-file-roi-di` |
| 4 | Trung bình | Trình duyệt nhận dạng file: dịch vụ tự tắt hai lần liền (mạng chập chờn) thì file vẫn phát lúc chưa có bộ nhận dạng nào nghe, đoạn đó mất khỏi văn bản | Hẹn giờ "phát phòng khi không có onstart" không gắn với bộ nhận dạng đã đặt nó | `app/static/speech.js` | `45c6f8d` | E2E `nhap-file-ngat` |
| 5 | Trung bình | Văn bản nói một mạch: "trước thứ năm tuần sau", "hạn là cuối tuần này" bị cắt đôi, việc cần làm mất hạn chót; việc có hạn "hôm nay" (từ "hôm nay mình họp") thay vì "trước thứ năm tuần sau" | Cắt bắt buộc ở từ thứ 28 không tránh cụm thời hạn; lấy mốc thời gian đầu tiên trong câu | `app/textutil.py`, `app/heuristic.py`, `app/static/engine.js` | `62d4b6f` | `test_engine.py::test_run_on_speech_keeps_deadlines_whole_and_prefers_real_deadlines`, `::test_due_prefers_a_marked_deadline_over_a_narrative_time`, mẫu `vi_speech_run_on` trong bộ so Python/JavaScript |
| 6 | Trung bình | Trên điện thoại 390px (web và app) trang kết quả rộng 399px: kéo ngang được, trình duyệt thu nhỏ cả trang | Cột lưới `1fr` của `.layout` không co nhỏ hơn bề rộng tối thiểu của nội dung | `app/static/style.css` | mục 6 | E2E `dien-thoai`, `doc-lap-ghi-am` (khẳng định tràn ngang đã siết) |
| 7 | Trung bình | Phóng to sơ đồ để đọc rồi cuộn trang (thanh địa chỉ ẩn) hoặc sửa chữ một nút (bàn phím ảo mở): sơ đồ nhảy về mức vừa khung, ô sửa lệch khỏi nút | Mọi sự kiện resize đều vẽ lại và fit, kể cả khi chỉ chiều cao đổi | `app/static/mindmap.js` | mục 6 | E2E `mindmap-doi-cao` |
| 8 | Thấp | Android: chuyển file gửi vài chục sự kiện tiến trình mỗi giây qua cầu nối, mỗi lần giao diện đếm lại toàn bộ số từ (file 1 giờ: 28.126 sự kiện) | Báo tiến trình cho mỗi khối 4096 byte | `FileSession.java` | `d2cc53d` | `FileSessionTest.progressIsReportedInSmallStepsNotOncePerPipeChunk` |
| 9 | Thấp | Android: mỗi lần mở dịch vụ nhận dạng thất bại rò một file descriptor | Đầu ghi của đường ống chỉ được đóng khi đã giao cho luồng bơm | `FileRecognizer.java` | `d2cc53d` | chỉ biên dịch được (không có máy ảo) |
| 10 | Hạ tầng test | Khẳng định "không tràn ngang" đạt cả khi trang tràn 9px | So `scrollWidth` với `innerWidth`, mà trên điện thoại innerWidth rộng ra theo nội dung | `tests/e2e/run.js` | mục 6 | đỏ ở `dien-thoai`, `doc-lap-ghi-am` với CSS cũ |

## 4. Lỗi còn lại và hạn chế đã biết

1. **Chữ của sơ đồ trên màn 390px cao 8,3px** (cỡ 13 nhân tỉ lệ 0,64 để ba cấp vừa bề ngang), dưới mức 11-12px thường khuyên dùng trên điện thoại. Đây là đánh đổi thiết kế (vừa bề ngang, không kéo ngang) nên không đổi trong đợt này; cách làm lớn hơn: tăng cỡ chữ ở bố cục hẹp (nút nhiều dòng hơn) hoặc cho kéo ngang. Người dùng phóng to được và nay mức phóng to không còn bị mất khi cuộn.
2. Bộ máy không cần AI: "bình ơi em phụ trách ..." chưa nhận ra Bình là người phụ trách; đầu việc còn đuôi "nhé hạn là" sau khi tách hạn chót ra cột riêng; câu nói một mạch vẫn có thể gộp hai việc vào một câu (việc của Hà trong mẫu `vi_speech_run_on` thành quyết định vì cùng câu với "chốt lại").
3. Chế độ độc lập (`local.js`): đọc, sửa, ghi một cuộc họp không trong một giao dịch IndexedDB; xóa cuộc họp đúng lúc đang lưu file âm thanh lớn có thể làm nó sống lại (khoảng trống hẹp, chưa tái hiện qua giao diện).
4. Chọn file trong mấy mili giây đầu, trước khi plugin trả lời `fileSupport`, sẽ bị báo "máy chưa hỗ trợ".
5. Bản máy chủ: tải âm thanh lên lỗi mà vẫn có văn bản thì nguồn văn bản ghi là `device` dù nhận dạng bằng trình duyệt (chỉ sai nhãn).

## 5. Chưa kiểm được ở môi trường này

| Hạng mục | Nên tự thử trên máy thật |
|---|---|
| Plugin Android nhận dạng file (`EXTRA_AUDIO_SOURCE`, Android 13+) | Bộ nhận dạng trên máy và ứng dụng Google; file m4a/mp3/amr/ogg dài 1 giờ; tắt màn hình hoặc chuyển app giữa chừng (dịch vụ có thể từ chối khi app ở nền); bấm Hủy; máy không có Google |
| Plugin iOS (`FileTranscriptionJob`) | Chỉ rà bằng mắt và biên dịch trên CI; thử file dài, có và không có nhận dạng tiếng Việt trên máy, hủy giữa chừng |
| Bàn phím ảo và thanh địa chỉ thật | E2E chỉ đổi kích thước khung nhìn; thử sửa chữ trong nút sơ đồ trên Android/iPhone |
| Firefox, Safari | Chỉ có Chromium |

## 6. Commit

`cf7c4a3`, `45c6f8d`, `d2cc53d`, `62d4b6f`, rồi commit "Điện thoại: trang kết quả không còn rộng hơn màn hình..." (lỗi 6, 7, 10) và commit sổ tay kèm báo cáo này. Lỗi 6, 7, 10 nằm trong commit đó.

# Đợt 13/11/2026

Đợt kiểm thử ngày 13/11/2026 trên nhánh `ccr-58431d82-km60c8`, mốc ban đầu là commit `d6aa6a5`.
Đợt này chạy thành hai lượt vì máy làm việc bị khởi động lại giữa chừng; lượt hai dựng lại bức tranh từ lịch sử git, chạy lại toàn bộ test và rà nốt phần còn hở.

## 1. Môi trường

| Hạng mục | Giá trị |
|---|---|
| Máy chạy tại chỗ | Linux, Python 3 với FastAPI 0.162, Starlette 1.7, Pydantic 2.13; Node 22, Playwright 1.63 với Chromium |
| CI | GitHub Actions: `Tests (pytest + Playwright)` trên ubuntu-latest; `Mobile build` dựng APK (ubuntu) và IPA (macOS) |
| Không có ở môi trường này | Ollama thật, model Whisper thật (không tải được), Android SDK, Xcode, thiết bị thật, Firefox và WebKit |

## 2. Phạm vi và phương pháp

- **Lõi thuần** (tách câu, từ khóa, heuristic, mind map, đọc JSON của LLM, học thuật ngữ): unit test và fuzz hạt giống cố định.
- **API và pipeline**: máy chủ FastAPI thật trong tiến trình test với SQLite thật; Ollama giả chạy qua HTTP và Whisper giả (`tests/fakes.py`) bám hợp đồng thật để kiểm JSON hỏng, timeout, thiếu model, sai tag, đổi model nhúng rồi nhúng lại.
- **Tương tranh**: pipeline chạy bằng luồng thật, có cổng chặn để dừng đúng giữa bước phân tích; máy chủ uvicorn thật nhận nhiều request đồng thời.
- **Tải file**: tên lạ, đường dẫn thoát thư mục, file rỗng, file lớn, đuôi không cho phép, kiểu nội dung giả, dọn file cũ.
- **Dữ liệu vào hỏng ở tầng JSON thô**: nửa emoji (surrogate lẻ), lồng hàng nghìn cấp, số ngoài khoảng, gửi bằng byte thô.
- **Giao diện thật** (`tests/e2e/run.js`, Playwright): 20 bước trên máy tính 1280px, điện thoại 390px và bản `mobile/www` chạy khác origin; micro giả của Chromium; mỗi bước kiểm không có lỗi console, không có HTTP từ 400 trở lên ngoài dự kiến, và chụp ảnh màn hình.
- **Cấu hình di động** (kiểm tĩnh): `www` dựng từ `app/static` có cờ di động, quyền micro và cleartext trong AndroidManifest, mô tả quyền micro và ATS trong Info.plist, workflow dựng lại `www` cho cả hai nền tảng.

## 3. Kết quả

| Bộ test | Trước đợt kiểm thử | Sau đợt kiểm thử |
|---|---|---|
| pytest | 45 đạt | 100 đạt / 100 |
| E2E Playwright | chưa có | 20 bước đạt / 20 |
| CI | chỉ có Mobile build | thêm workflow Tests chạy ở mỗi lần push đụng `app/`, `tests/` |

## 4. Lỗi đã sửa

Mức độ: Nghiêm trọng (mất dữ liệu, bảo mật), Cao, Trung bình, Thấp.

| # | Mức độ | Lỗi người dùng thấy | Nơi sửa | Commit | Test hồi quy |
|---|---|---|---|---|---|
| 1 | Nghiêm trọng | Góp ý đánh giá chứa HTML được chạy như mã ở tab Học hỏi (XSS lưu trữ) | `app/static/app.js` | `729fb42` | E2E `xss` |
| 2 | Nghiêm trọng | File tải lên khai kiểu `text/html` được phát lại nguyên kiểu ở `/audio` | `app/main.py` | `38cf5cf` | `test_upload_security.py::test_audio_is_never_served_as_html` |
| 3 | Nghiêm trọng | Bản ghi mới và ghi chú đang gõ bị xóa khi cuộc họp gửi trước đó xử lý xong | `app/static/app.js` | `729fb42` | E2E `nen-xong-muon` |
| 4 | Nghiêm trọng | Tải âm thanh khi đang xử lý xóa file Whisper đang đọc và ghi đè transcript | `app/main.py` | `38cf5cf` | `test_concurrency.py::test_upload_is_rejected_while_processing_and_keeps_audio` |
| 5 | Nghiêm trọng | Tải file rỗng xóa mất bản ghi cũ | `app/main.py` | `38cf5cf` | `test_upload_security.py::test_empty_upload_is_rejected_and_keeps_previous_audio` |
| 6 | Nghiêm trọng | Lưu 20 ý chính chỉ còn 12; nhánh mind map thứ 13 và cấp thứ 5 biến mất; xóa hết nhánh rồi lưu thì cây cũ vẫn còn | `app/main.py`, `app/mindmap.py` | `31e8b07` | `test_api.py::test_user_edits_are_not_truncated_by_llm_output_limits` |
| 7 | Nghiêm trọng | Đóng hoặc tải lại trang khi còn bản ghi chưa gửi làm mất bản ghi, không hỏi lại | `app/static/app.js` | `b192c9c` | E2E `ghi-am-ngat` |
| 8 | Cao | Máy chủ tắt giữa lúc xử lý để cuộc họp kẹt mãi ở "đang xử lý" | `app/main.py`, `app/db.py` | `38cf5cf` | `test_concurrency.py::test_interrupted_meetings_are_recovered_on_restart` |
| 9 | Cao | Cuộc họp đã xóa vẫn hiện khi hỏi trí nhớ (xóa đúng lúc pipeline đang ghi) | `app/pipeline.py` | `38cf5cf` | `test_concurrency.py::test_delete_while_processing_leaves_no_orphan_memory` |
| 10 | Cao | Ollama có model cùng tên khác tag được báo "sẵn sàng" nhưng mọi lần phân tích âm thầm rơi về heuristic | `app/llm.py` | `38cf5cf` | `test_ollama_contract.py::test_model_tag_must_match_like_real_ollama` |
| 11 | Cao | Thêm thuật ngữ chứa `\` làm mọi cuộc họp sau đó xử lý lỗi "bad escape" | `app/learning/glossary.py` | `b192c9c` | `test_learning.py::test_glossary_term_with_backslash_does_not_break_apply` |
| 12 | Cao | Nhấp chuột không chọn được nút mind map, nhấp đúp không sửa được chữ | `app/static/mindmap.js` | `729fb42` | E2E `mindmap` |
| 13 | Cao | Thanh tiến trình kẹt, nút xử lý bị khóa khi mở cuộc họp khác trong lúc chờ | `app/static/app.js` | `729fb42` | E2E `polling` |
| 14 | Trung bình | Tiêu đề, transcript, ý chính, thuật ngữ, góp ý hay câu hỏi bị cắt giữa một emoji làm máy chủ trả 500 và không lưu gì | `app/textutil.py`, `app/main.py` | `3fc2010` | `test_bad_input.py::test_half_emoji_in_json_is_replaced_instead_of_500`, `::test_validation_error_with_half_emoji_is_422_not_500` |
| 15 | Trung bình | LLM trả JSON có nửa emoji làm cả cuộc họp báo lỗi; câu trả lời hỏi đáp có nửa emoji làm `/api/learning/ask` trả 500 | `app/llm.py` | `3fc2010` | `test_bad_input.py::test_llm_reply_with_half_emoji_or_deep_nesting_is_cleaned`, `::test_llm_text_answer_with_half_emoji_does_not_break_ask` |
| 16 | Trung bình | Nhập tiêu đề hơn 200 ký tự (góp ý hơn 1000, thuật ngữ hơn 120, câu hỏi hơn 1000) thì hiện lỗi JSON thô `string_too_long`, không lưu | `app/static/index.html` | `e987a69` | E2E `gioi-han` |
| 17 | Trung bình | Nhận dạng lỗi lần đầu rồi nhấn "Phân tích lại" luôn báo "Chưa có transcript" | `app/pipeline.py` | `38cf5cf` | `test_concurrency.py::test_reanalyze_retries_transcription_when_first_attempt_failed` |
| 18 | Trung bình | Cột Phụ trách ghi "Cần", "We", "Tôi", "Need" thay vì tên người | `app/heuristic.py` | `b192c9c` | `test_heuristic.py::test_owner_is_a_name_not_a_pronoun_or_cue_word` |
| 19 | Trung bình | Micro bị rút hoặc bị thu hồi giữa lúc ghi: đồng hồ vẫn chạy trên bản ghi câm | `app/static/app.js` | `b192c9c` | E2E `ghi-am-ngat` |
| 20 | Trung bình | Mất mạng một nhịp là dừng theo dõi tiến trình | `app/static/app.js` | `729fb42` | E2E `mang` |
| 21 | Trung bình | Bấm đúp nút ghi âm mở hai luồng micro, luồng đầu không bao giờ tắt | `app/static/app.js` | `729fb42` | E2E `ghi-am-bam-lap` |
| 22 | Trung bình | Phụ đề trực tiếp của bản ghi trước bị gửi kèm file âm thanh chọn sau đó | `app/static/app.js` | `729fb42` | E2E `phu-de` |
| 23 | Trung bình | Bấm nhanh hai cuộc họp thì hiện cuộc họp trả lời chậm hơn | `app/static/app.js` | `729fb42` | E2E `dieu-huong` |
| 24 | Trung bình | Bản di động chưa nhập máy chủ vẫn gửi request tới chính nó khi bấm xử lý | `app/static/app.js` | `729fb42` | E2E `di-dong-www` |
| 25 | Trung bình | Danh sách cuộc họp không dùng được bằng bàn phím, nhiều ô thiếu tên trợ năng | `app/static/app.js`, `index.html` | `729fb42` | E2E `ban-phim` |
| 26 | Thấp | Cuộc họp xử lý xong lúc đang ghi âm thì bị chuyển sang tab kết quả | `app/static/app.js` | `b192c9c` | theo lời commit: E2E các bước ghi âm |
| 27 | Thấp | "Nhúng lại trí nhớ" đếm cả mảnh nhúng thất bại | `app/learning/memory.py` | `38cf5cf` | `test_ollama_contract.py::test_reindex_does_not_count_failed_embeddings` |
| 28 | Thấp | Nhãn nguồn transcript dài ra mỗi lần lưu; lần dán đầu tiên bị ghi nhận là một lần chỉnh sửa | `app/main.py` | `38cf5cf` | `test_whisper_pipeline.py::test_first_manual_transcript_is_not_recorded_as_an_edit` |
| 29 | Thấp | Tìm kiếm coi `%` và `_` là ký tự đại diện, không chuẩn hóa NFC | `app/db.py`, `app/main.py` | `38cf5cf` | `test_upload_security.py::test_sql_injection_and_like_wildcards_in_search`, `::test_search_normalizes_nfd_query` |
| 30 | Thấp | Thuật ngữ dài không dấu cách đẩy nút xóa ra ngoài thẻ; mind map trên máy tính bị cắt hai bên | `app/static/style.css`, `mindmap.js` | `729fb42` | E2E `chu-dai`, `mindmap` |
| 31 | Thấp | Mind map lồng hàng nghìn cấp làm `PUT /analysis` trả 500 | `app/textutil.py`, `app/main.py` | `3fc2010` | `test_bad_input.py::test_deeply_nested_json_does_not_crash` |
| 32 | Thấp | `DELETE /api/glossary/<số quá lớn>` trả 500; thời lượng âm hoặc phi lý do client gửi được lưu nguyên | `app/main.py` | `3fc2010` | `test_bad_input.py::test_out_of_range_numbers_are_rejected_cleanly` |

Lỗi 1 đến 13 và 17 đến 30 do lượt một sửa; mô tả lấy từ lời commit, lượt hai xác nhận lại bằng cách chạy toàn bộ test hồi quy (đều xanh). Lỗi 14, 15, 16, 31, 32 do lượt hai tìm và sửa, test đều đỏ trước khi sửa.

## 5. Rủi ro còn lại và đề xuất

1. **CORS mở `*` và API không xác thực** (chủ ý cho mạng LAN, không đổi trong đợt này). Hệ quả: mọi máy trong cùng mạng đọc, sửa, xóa được cuộc họp; một trang web bất kỳ mở trên máy đang chạy máy chủ cũng gọi được API ở `localhost`. Đề xuất: thêm mã truy cập tùy chọn qua biến môi trường và giới hạn origin về app di động cùng địa chỉ máy chủ.
2. **Không giới hạn dung lượng file tải lên**: một file rất lớn có thể làm đầy ổ đĩa. Đề xuất: giới hạn cấu hình được, trả 413 kèm thông báo rõ.
3. **Thông báo lỗi 500 trả nguyên văn ngoại lệ** (`detail: str(exc)`): có thể lộ đường dẫn nội bộ. Đề xuất: ghi chi tiết vào log, trả thông báo chung.
4. **Workflow Mobile build đăng pre-release `mobile-latest` từ mọi nhánh**: mỗi lần push đụng `app/static/` hay `mobile/` ở nhánh bất kỳ đều thay bản tải công khai. Đề xuất: chỉ chạy job đăng bản ở nhánh mặc định.
5. Lỗi kiểm tra dữ liệu (422) vẫn được giao diện in dạng JSON nếu phát sinh ở trường khác; sáu ô nhập có giới hạn đã được chặn tại chỗ.
6. Lưu bản sửa của transcript rất dài chậm dần: đo được 0,24 giây với 9.000 từ, 2,7 giây với 30.000 từ, 11,6 giây với 60.000 từ (bước so khớp để học thuật ngữ). Chưa sửa vì chỉ ảnh hưởng cuộc họp dài nhiều giờ.

## 6. Chưa kiểm được ở môi trường này

| Hạng mục | Vì sao | Nên tự thử |
|---|---|---|
| Whisper thật, Ollama thật | Không tải được model, không có Ollama | Ghi âm 2 phút tiếng Việt, xử lý, đổi model nhúng rồi bấm "Nhúng lại trí nhớ" |
| App Android và iOS trên thiết bị | Không có SDK, máy ảo, thiết bị; CI chỉ dựng gói, không chạy app | Hộp thoại xin quyền micro (từ chối một lần, từ chối hẳn), ghi âm khi tắt màn hình hoặc chuyển app, nghe lại bản ghi, xuất Markdown/SVG/PNG trong WebView |
| MediaRecorder `audio/mp4` trên iOS thật | Chỉ giả lập trong Chromium | Ghi âm trên iPhone rồi xử lý bằng Whisper |
| Firefox, Safari | Chỉ có Chromium | Chạy `tests/e2e/run.js` với hai trình duyệt này |
| Cuộc họp dài hàng giờ | Micro giả chỉ ghi vài giây | Ghi 60 phút, theo dõi bộ nhớ trình duyệt và thời gian tải lên |
| Hiệu năng thật của pipeline | Không có model | Đo thời gian nhận dạng và phân tích trên máy đích |

## 7. Cách chạy lại

```bash
python3 -m pytest -q
E2E_OUT=/tmp/e2e node tests/e2e/run.js
```
