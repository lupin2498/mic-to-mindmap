import Capacitor
import UIKit

/// Màn hình chính của ứng dụng. Plugin nhận dạng giọng nói nằm ngay trong ứng dụng (không phải gói npm) nên phải
/// đăng ký tay ở đây; Main.storyboard trỏ tới lớp này thay cho CAPBridgeViewController mặc định.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SpeechPlugin())
    }
}
