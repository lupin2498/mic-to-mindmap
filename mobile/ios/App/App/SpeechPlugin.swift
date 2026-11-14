import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit

/// Plugin "M2MSpeech": chuyển lời nói thành văn bản ngay khi nói bằng bộ nhận dạng giọng nói có sẵn của iOS
/// (SFSpeechRecognizer), không cần máy chủ. Giao diện web gọi qua window.Capacitor.Plugins.M2MSpeech
/// (app/static/speech.js). Cùng giao diện với bản Android (SpeechPlugin.java):
///
/// - Phương thức: available(), start({language}), stop(), keepAwake({on}).
/// - Sự kiện: "partial" {text} (phần đang nói dở), "final" {text} (một câu đã chốt), "state" {listening, reason},
///   "error" {code, fatal}, "level" {value 0..1}.
///
/// iOS trả kết quả cộng dồn cho tới khi một lượt nhận dạng kết thúc (và giới hạn mỗi lượt khoảng một phút), nên ở
/// đây mỗi chỗ ngắt hơi được chốt thành một câu rồi mở lượt mới: với người dùng đó là một lần ghi liên tục.
/// Mọi trạng thái chỉ được đụng tới trên luồng chính; riêng `request` có khóa vì luồng âm thanh cũng dùng.
@objc(SpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechPlugin"
    public let jsName = "M2MSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise)
    ]

    private static let pauseSeconds: TimeInterval = 1.6      // im lặng chừng này thì chốt câu
    private static let finalTimeout: TimeInterval = 2.0      // chờ kết quả cuối của một lượt
    private static let maxFailures = 5

    private let audioEngine = AVAudioEngine()
    private let requestLock = NSLock()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var taskSerial = 0
    private var taskStartedAt = Date()
    private var active = false          // người dùng muốn phiên tiếp tục chạy
    private var suspended = false       // ứng dụng ở nền hoặc bị cuộc gọi chen ngang
    private var stopping = false        // đã bấm dừng, đang chờ câu cuối
    private var audioRunning = false
    private var lastPartial = ""
    private var failures = 0
    private var pauseTimer: Timer?
    private var finalTimer: Timer?
    private var stopCalls: [CAPPluginCall] = []
    private var lastLevelAt: CFTimeInterval = 0
    private var reportedListening = false
    private var reportedReason = ""
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.suspend(reason: "background")
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.resumeIfNeeded()
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Phương thức gọi từ giao diện web

    @objc func available(_ call: CAPPluginCall) {
        call.resolve(["available": SFSpeechRecognizer() != nil])
    }

    @objc func start(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "vi-VN"
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("Chưa được cấp quyền nhận dạng giọng nói", "permission")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        call.reject("Chưa được cấp quyền micro", "permission")
                        return
                    }
                    self.begin(language: language, call: call)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopCalls.append(call)
            if self.stopping {
                return   // bấm dừng hai lần: cùng chờ một lần dừng
            }
            self.active = false
            self.suspended = false
            if self.task != nil {
                // chờ bộ nhận dạng trả nốt câu đang nói dở
                self.stopping = true
                self.endAudioOfCurrentTask()
                self.finalTimer?.invalidate()
                self.finalTimer = Timer.scheduledTimer(withTimeInterval: SpeechPlugin.finalTimeout, repeats: false) { [weak self] _ in
                    self?.completeStop()
                }
            } else {
                self.completeStop()
            }
        }
    }

    /// Giữ màn hình sáng trong lúc ghi: màn hình khóa là iOS ngắt micro.
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    // MARK: - Phiên nhận dạng

    private func begin(language: String, call: CAPPluginCall) {
        if stopping {
            completeStop()   // phiên trước còn đang dừng dở: kết thúc nó trước
        }
        guard let newRecognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
            call.reject("Máy chưa hỗ trợ nhận dạng ngôn ngữ này", "language")
            return
        }
        cancelTask()
        teardownAudio()
        recognizer = newRecognizer
        active = true
        suspended = false
        failures = 0
        lastPartial = ""
        do {
            try startAudio()
        } catch {
            active = false
            teardownAudio()
            call.reject("Không mở được micro: \(error.localizedDescription)", "audio")
            return
        }
        startTask()
        call.resolve(["started": true])
    }

    private func startAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "M2MSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "micro chưa sẵn sàng"])
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
        audioRunning = true
    }

    private func teardownAudio() {
        if audioRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
            audioRunning = false
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Chạy trên luồng âm thanh: đưa âm thanh cho lượt nhận dạng hiện tại và đo mức âm cho thanh hiển thị.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        requestLock.lock()
        let current = request
        requestLock.unlock()
        current?.append(buffer)

        let now = CACurrentMediaTime()
        guard now - lastLevelAt >= 0.1, let channels = buffer.floatChannelData else {
            return
        }
        lastLevelAt = now
        let frames = Int(buffer.frameLength)
        guard frames > 0 else {
            return
        }
        let samples = channels[0]
        var sum: Float = 0
        for index in 0..<frames {
            let sample = samples[index]
            sum += sample * sample
        }
        let level = min(1, (sum / Float(frames)).squareRoot() * 8)
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners("level", data: ["value": level])
        }
    }

    private func setRequest(_ value: SFSpeechAudioBufferRecognitionRequest?) {
        requestLock.lock()
        request = value
        requestLock.unlock()
    }

    /// Báo cho bộ nhận dạng là hết âm thanh của lượt này để nó trả kết quả cuối.
    private func endAudioOfCurrentTask() {
        requestLock.lock()
        let current = request
        request = nil
        requestLock.unlock()
        current?.endAudio()
    }

    private func startTask() {
        guard active, !suspended, !stopping, task == nil, let recognizer = recognizer else {
            return
        }
        let newRequest = SFSpeechAudioBufferRecognitionRequest()
        newRequest.shouldReportPartialResults = true
        if #available(iOS 16.0, *) {
            newRequest.addsPunctuation = true
        }
        taskSerial += 1
        let serial = taskSerial
        taskStartedAt = Date()
        lastPartial = ""
        setRequest(newRequest)
        task = recognizer.recognitionTask(with: newRequest) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            DispatchQueue.main.async {
                self?.handle(serial: serial, text: text, isFinal: isFinal, failed: failed)
            }
        }
        report(listening: true, reason: "")
    }

    private func handle(serial: Int, text: String?, isFinal: Bool, failed: Bool) {
        guard serial == taskSerial, task != nil else {
            return   // kết quả về muộn của một lượt đã bỏ
        }
        if let text = text {
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if isFinal {
                finishTask(finalText: clean, failed: false)
                return
            }
            if !clean.isEmpty && clean != lastPartial {
                lastPartial = clean
                failures = 0
                notifyListeners("partial", data: ["text": clean])
                schedulePauseCut()
            }
        }
        if failed {
            finishTask(finalText: nil, failed: true)
        }
    }

    /// Người nói ngắt hơi: chốt đoạn vừa nói thành một câu rồi nghe đoạn mới.
    private func schedulePauseCut() {
        pauseTimer?.invalidate()
        pauseTimer = Timer.scheduledTimer(withTimeInterval: SpeechPlugin.pauseSeconds, repeats: false) { [weak self] _ in
            guard let self = self, self.active, !self.suspended, !self.stopping, self.task != nil, !self.lastPartial.isEmpty else {
                return
            }
            self.endAudioOfCurrentTask()
            self.finalTimer?.invalidate()
            self.finalTimer = Timer.scheduledTimer(withTimeInterval: SpeechPlugin.finalTimeout, repeats: false) { [weak self] _ in
                // bộ nhận dạng không trả kết quả cuối: dùng phần tạm đã có
                self?.finishTask(finalText: nil, failed: false)
            }
        }
    }

    private func clearTimers() {
        pauseTimer?.invalidate()
        pauseTimer = nil
        finalTimer?.invalidate()
        finalTimer = nil
    }

    private func cancelTask() {
        taskSerial += 1          // bỏ mọi kết quả về muộn của lượt cũ
        setRequest(nil)
        task?.cancel()
        task = nil
    }

    private func emitFinal(_ text: String) {
        if !text.isEmpty {
            notifyListeners("final", data: ["text": text])
        }
    }

    private func finishTask(finalText: String?, failed: Bool) {
        guard task != nil else {
            return
        }
        clearTimers()
        let lived = Date().timeIntervalSince(taskStartedAt)
        var text = finalText ?? ""
        if text.isEmpty {
            text = lastPartial
        }
        lastPartial = ""
        cancelTask()
        if !text.isEmpty {
            failures = 0
            emitFinal(text)
        } else if failed && lived < 1.0 {
            failures += 1      // hỏng ngay khi vừa mở lượt: không phải do im lặng
        }
        if stopping {
            completeStop()
            return
        }
        guard active, !suspended else {
            return
        }
        if failures >= SpeechPlugin.maxFailures {
            fail(code: recognizer?.isAvailable == false ? "network" : "unknown")
            return
        }
        if failed {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.startTask()
            }
        } else {
            startTask()
        }
    }

    private func completeStop() {
        clearTimers()
        stopping = false
        let pending = lastPartial
        lastPartial = ""
        cancelTask()
        emitFinal(pending)
        teardownAudio()
        report(listening: false, reason: "")
        let calls = stopCalls
        stopCalls = []
        for call in calls {
            call.resolve()
        }
    }

    private func fail(code: String) {
        active = false
        suspended = false
        clearTimers()
        cancelTask()
        teardownAudio()
        notifyListeners("error", data: ["code": code, "fatal": true])
        report(listening: false, reason: "error")
    }

    // MARK: - Ứng dụng ra nền, cuộc gọi chen ngang

    private func suspend(reason: String) {
        guard active, !suspended else {
            return
        }
        suspended = true
        clearTimers()
        let pending = lastPartial
        lastPartial = ""
        cancelTask()
        emitFinal(pending)
        teardownAudio()
        report(listening: false, reason: reason)
    }

    private func resumeIfNeeded() {
        guard active, suspended else {
            return
        }
        suspended = false
        failures = 0
        do {
            try startAudio()
        } catch {
            fail(code: "audio")
            return
        }
        startTask()
    }

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else {
            return
        }
        if type == .began {
            suspend(reason: "background")
        } else if UIApplication.shared.applicationState == .active {
            resumeIfNeeded()
        }
    }

    private func report(listening: Bool, reason: String) {
        guard listening != reportedListening || reason != reportedReason else {
            return
        }
        reportedListening = listening
        reportedReason = reason
        notifyListeners("state", data: ["listening": listening, "reason": reason])
    }
}
