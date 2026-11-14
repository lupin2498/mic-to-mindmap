# Mic to Mindmap - ứng dụng di động (Android / iOS)

Bản di động là vỏ [Capacitor](https://capacitorjs.com) bọc giao diện web trong `app/static`, kèm một plugin nhận dạng giọng nói viết riêng cho app. App **chạy độc lập, không cần AI và không cần máy chủ**: nói là ra văn bản, dừng là có tóm tắt và sơ đồ tư duy, mọi thứ lưu ngay trên điện thoại.

## Cách dùng

1. Cài ứng dụng (xem bên dưới) và mở app.
2. Nhấn **nút đỏ** rồi nói. Lần đầu máy hỏi quyền micro; iOS hỏi thêm quyền nhận dạng giọng nói. Văn bản hiện ra ngay khi nói, bản tóm tắt và sơ đồ tư duy xem trước cập nhật theo.
3. Nhấn **⏹ Dừng**: app tự đặt tiêu đề, tóm tắt, tách quyết định, việc cần làm và vẽ sơ đồ tư duy. Bỏ chọn "Tự động tóm tắt và vẽ sơ đồ tư duy khi dừng ghi" nếu muốn xem lại văn bản trước.

Những điều nên biết:

- Chuyển giọng nói thành văn bản là việc của **bộ nhận dạng có sẵn trên máy** (Google trên Android, Apple trên iOS). Thường cần mạng; máy đã tải gói nhận dạng ngoại tuyến cho ngôn ngữ đó thì không cần (Android: *Cài đặt → Hệ thống → Ngôn ngữ → Nhận dạng giọng nói trên thiết bị* hoặc trong ứng dụng Google; iOS: tùy đời máy và ngôn ngữ). Máy Android không có dịch vụ nhận dạng nào (một số máy không có ứng dụng Google) thì app báo rõ và vẫn nhận văn bản dán tay.
- Giữ app ở phía trước trong lúc ghi: hệ điều hành không cho nhận dạng khi app chạy nền. App giữ màn hình sáng, tạm ngừng khi bị che và nghe tiếp khi quay lại.
- Micro của điện thoại chỉ cho một bên dùng, nên khi nhận dạng trực tiếp app **không lưu kèm file ghi âm**.
- Dữ liệu nằm trong bộ nhớ của app; gỡ app là mất. Dùng nút xuất Markdown/SVG/PNG để giữ lại.

### Dùng thêm AI (tùy chọn)

Có máy tính chạy Whisper/Ollama thì nối vào để nhận dạng và tóm tắt bằng AI:

1. Trên máy tính: `./run.sh --host 0.0.0.0 --port 8000`, xem địa chỉ IP (ví dụ `192.168.1.10`), mở cổng 8000 nếu có tường lửa.
2. Trong app mở **⚙ Máy chủ AI (tùy chọn)**, nhập `http://192.168.1.10:8000` rồi nhấn **Kết nối**. Từ đó dữ liệu và "trí nhớ" nằm trên máy chủ; nhấn **Dùng độc lập** để quay về chạy trên máy.

## Tải APK / IPA đã build sẵn

GitHub Actions (`.github/workflows/mobile-build.yml`) tự chạy test rồi build mỗi khi `mobile/` hoặc `app/static/` thay đổi, và đăng lên pre-release **`mobile-latest`** trong mục *Releases* của repo:

- `mic-to-mindmap-release.apk` (Android): tải về điện thoại, cho phép cài từ nguồn không xác định, mở file để cài.
  Nếu không cấu hình keystore (secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), bản release được ký bằng khóa debug - vẫn cài được, nhưng muốn lên Google Play thì cần keystore riêng. Khóa debug được tạo mới ở mỗi lần build, nên khi cập nhật lên bản mới Android có thể báo "ứng dụng không được cài đặt": gỡ bản cũ rồi cài lại (dữ liệu lưu trong app sẽ mất, hãy xuất trước).
- `mic-to-mindmap-unsigned.ipa` (iOS): Apple bắt buộc ký ứng dụng, nên file này **chưa ký**. Cách cài:
  - **Sideloadly** hoặc **AltStore** (máy tính + Apple ID miễn phí, chứng chỉ 7 ngày), hoặc
  - Mở `mobile/ios/App/App.xcodeproj` bằng Xcode trên macOS, chọn *Signing & Capabilities → Team*, cắm iPhone và nhấn Run (chứng chỉ cá nhân 7 ngày, tài khoản Apple Developer trả phí thì 1 năm / TestFlight).

Cũng có thể chạy workflow thủ công: tab **Actions → Mobile build → Run workflow**. File build còn nằm trong *Artifacts* của mỗi lần chạy.

## Build thủ công

```bash
cd mobile
npm install
npm run build:web          # tạo www/ từ app/static (chèn cờ M2M_MOBILE)
npx cap sync               # đồng bộ vào android/ và ios/

# Android (cần Android Studio hoặc SDK + JDK 21)
cd android && ./gradlew testDebugUnitTest assembleRelease   # test vòng lặp nhận dạng (JVM) rồi đóng gói
# -> android/app/build/outputs/apk/release/app-release.apk

# iOS (cần macOS + Xcode 16)
npx cap open ios           # mở Xcode, chọn Team, Run
```

## Ghi chú kỹ thuật

- **Chế độ độc lập**: `npm run build:web` chép `app/static` sang `www/` và chèn cờ `window.M2M_MOBILE`. Khi chưa nhập địa chỉ máy chủ, `local.js` trả lời mọi lời gọi `/api/...` bằng dữ liệu trong IndexedDB và `engine.js` (bộ máy tóm tắt không cần AI, kết quả giống hệt bản Python trên máy chủ).
- **Plugin `M2MSpeech`** (cùng giao diện ở hai nền tảng: `available`, `start`, `stop`, `keepAwake`; sự kiện `partial`, `final`, `state`, `error`, `level`):
  - Android: `SpeechPlugin.java` dùng `SpeechRecognizer` ở chế độ đọc chính tả. `SpeechLoop.java` là vòng lặp không phụ thuộc Android (kiểm được trên JVM bằng `SpeechLoopTest`): nghe lại sau mỗi câu, coi im lặng là bình thường, giữ phần đang nói dở khi bộ nhận dạng dừng, mất mạng thì thử gói ngoại tuyến rồi mới báo lỗi. Trong lúc ghi app tắt tiếng "tít" của bộ nhận dạng rồi trả lại âm lượng.
  - iOS: `SpeechPlugin.swift` dùng `SFSpeechRecognizer` + `AVAudioEngine`, chốt câu ở mỗi chỗ ngắt hơi rồi mở lượt mới để vượt giới hạn khoảng một phút mỗi lượt của Apple.
  - Vì sao không dùng plugin cộng đồng: bản có sẵn không nghe liên tục, nuốt lỗi và không hỗ trợ Swift Package Manager mà dự án iOS này dùng.
- **Quyền**: Android `RECORD_AUDIO` và khai báo `<queries>` tới `android.speech.RecognitionService` (Android 11+ cần mới thấy dịch vụ nhận dạng); iOS `NSMicrophoneUsageDescription` và `NSSpeechRecognitionUsageDescription`.
- `capacitor.config.json`: `androidScheme: http` để WebView có origin `http://localhost` (vẫn là secure context nên dùng được micro) và gọi API HTTP trong LAN không bị chặn mixed-content. Android bật `usesCleartextTraffic`, iOS bật `NSAllowsArbitraryLoads`/`NSAllowsLocalNetworking`. Chỉ cần tới khi nối máy chủ AI.
- Máy chủ FastAPI bật CORS (`*`) để app gọi từ origin khác.
- Dự án iOS dùng Swift Package Manager (`ios/App/CapApp-SPM`), không cần CocoaPods. `SpeechPlugin.swift` và `MainViewController.swift` (nơi đăng ký plugin) nằm trong target `App`.
- Chưa kiểm trên thiết bị thật: phần gốc mới được biên dịch và kiểm bằng test JVM trên CI; hành vi của bộ nhận dạng khác nhau giữa các hãng máy.
