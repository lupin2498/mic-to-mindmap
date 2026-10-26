# Mic to Mindmap - ứng dụng di động (Android / iOS)

Bản di động là vỏ [Capacitor](https://capacitorjs.com) bọc giao diện web trong `app/static`. Điện thoại **ghi âm** và hiển thị kết quả; phần AI (Whisper + Ollama) chạy trên máy tính trong cùng mạng LAN.

## Cách dùng

1. Trên máy tính, chạy máy chủ cho phép truy cập từ mạng LAN:
   ```bash
   ./run.sh --host 0.0.0.0 --port 8000
   ```
   Xem địa chỉ IP của máy (ví dụ `192.168.1.10`). Nếu có tường lửa, mở cổng 8000.
2. Cài ứng dụng lên điện thoại (xem bên dưới), mở app, nhập `http://192.168.1.10:8000` vào ô "Địa chỉ máy chủ" rồi nhấn **Kết nối**.
3. Ghi âm, xử lý, xem mind map như bản web. Dữ liệu và "trí nhớ" nằm trên máy chủ.

## Tải APK / IPA đã build sẵn

GitHub Actions (`.github/workflows/mobile-build.yml`) tự build mỗi khi `mobile/` hoặc `app/static/` thay đổi, và đăng lên pre-release **`mobile-latest`** trong mục *Releases* của repo:

- `mic-to-mindmap-release.apk` (Android): tải về điện thoại, cho phép cài từ nguồn không xác định, mở file để cài.
  Nếu không cấu hình keystore (secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), bản release được ký bằng khóa debug - vẫn cài được, nhưng muốn lên Google Play thì cần keystore riêng.
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
cd android && ./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk

# iOS (cần macOS + Xcode 16)
npx cap open ios           # mở Xcode, chọn Team, Run
```

## Ghi chú kỹ thuật

- `capacitor.config.json`: `androidScheme: http` để WebView có origin `http://localhost` (vẫn là secure context nên dùng được micro) và gọi API HTTP trong LAN không bị chặn mixed-content. Android bật `usesCleartextTraffic`, iOS bật `NSAllowsArbitraryLoads`/`NSAllowsLocalNetworking`.
- Quyền micro: `RECORD_AUDIO` (Android, Capacitor tự xin quyền khi trang web gọi `getUserMedia`) và `NSMicrophoneUsageDescription` (iOS 14.3+).
- Máy chủ FastAPI bật CORS (`*`) để app gọi từ origin khác.
- Dự án iOS dùng Swift Package Manager (`ios/App/CapApp-SPM`), không cần CocoaPods.
