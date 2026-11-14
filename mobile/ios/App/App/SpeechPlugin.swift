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
///
/// Nhận dạng từ file ghi âm có sẵn (xem FileTranscriptionJob): fileSupport(), fileBegin({name, size}) -> {id},
/// fileChunk({id, data: base64}), fileTranscribe({id, language}) -> {text, duration}, fileCancel({id}).
/// Sự kiện "fileProgress" {id, value}, "filePartial" {id, text}, "fileSegment" {id, text}.
@objc(SpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechPlugin"
    public let jsName = "M2MSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileSupport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileBegin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileTranscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileCancel", returnType: CAPPluginReturnPromise)
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
    // nhận dạng từ file: importFiles chỉ đụng tới trên importQueue, fileJob chỉ trên luồng chính
    private let importQueue = DispatchQueue(label: "vn.mictomindmap.import")
    private var importFiles: [String: URL] = [:]
    private var fileJob: FileTranscriptionJob?

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

    // MARK: - Nhận dạng từ file ghi âm có sẵn

    @objc func fileSupport(_ call: CAPPluginCall) {
        let recognizer = SFSpeechRecognizer()
        call.resolve(["available": recognizer != nil, "onDevice": recognizer?.supportsOnDeviceRecognition ?? false])
    }

    @objc func fileBegin(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        importQueue.async {
            let manager = FileManager.default
            let dir = manager.temporaryDirectory.appendingPathComponent("m2m-import", isDirectory: true)
            do {
                try manager.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                call.reject("Không tạo được thư mục tạm: \(error.localizedDescription)", "unknown")
                return
            }
            if self.importFiles.isEmpty, let stale = try? manager.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
                // file tạm còn sót của lần chạy trước (app bị tắt giữa chừng)
                for old in stale {
                    try? manager.removeItem(at: old)
                }
            }
            let id = UUID().uuidString
            let url = dir.appendingPathComponent("\(id).\(SpeechPlugin.safeExtension(name))")
            guard manager.createFile(atPath: url.path, contents: nil) else {
                call.reject("Không tạo được file tạm", "unknown")
                return
            }
            self.importFiles[id] = url
            call.resolve(["id": id])
        }
    }

    @objc func fileChunk(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let data = call.getString("data") ?? ""
        importQueue.async {
            guard let url = self.importFiles[id] else {
                call.reject("Không tìm thấy file tạm", "unknown")
                return
            }
            guard let bytes = Data(base64Encoded: data, options: .ignoreUnknownCharacters) else {
                call.reject("Dữ liệu file hỏng", "unknown")
                return
            }
            do {
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                _ = try handle.seekToEnd()
                try handle.write(contentsOf: bytes)
                call.resolve()
            } catch {
                call.reject("Không ghi được file tạm (bộ nhớ máy có thể đã đầy): \(error.localizedDescription)", "storage")
            }
        }
    }

    @objc func fileTranscribe(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let language = call.getString("language") ?? "vi-VN"
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("Chưa được cấp quyền nhận dạng giọng nói", "permission")
                return
            }
            self.importQueue.async {
                guard let url = self.importFiles[id] else {
                    call.reject("Không tìm thấy file tạm", "unknown")
                    return
                }
                DispatchQueue.main.async {
                    self.beginFile(id: id, url: url, language: language, call: call)
                }
            }
        }
    }

    @objc func fileCancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        DispatchQueue.main.async {
            if let job = self.fileJob, job.id == id {
                job.cancel()   // lời gọi fileTranscribe nhận lỗi "cancelled", file tạm được dọn sau đó
            } else {
                self.dropImport(id)
            }
            call.resolve()
        }
    }

    private func beginFile(id: String, url: URL, language: String, call: CAPPluginCall) {
        if fileJob != nil || active || stopping {
            call.reject("Bộ nhận dạng đang bận", "busy")
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
            call.reject("Máy chưa hỗ trợ nhận dạng ngôn ngữ này", "language")
            return
        }
        let job = FileTranscriptionJob(id: id, url: url, recognizer: recognizer)
        job.onPartial = { [weak self] text in
            DispatchQueue.main.async { self?.notifyListeners("filePartial", data: ["id": id, "text": text]) }
        }
        job.onSegment = { [weak self] text in
            DispatchQueue.main.async { self?.notifyListeners("fileSegment", data: ["id": id, "text": text]) }
        }
        job.onProgress = { [weak self] value in
            DispatchQueue.main.async { self?.notifyListeners("fileProgress", data: ["id": id, "value": value]) }
        }
        fileJob = job
        job.run { [weak self] outcome in
            DispatchQueue.main.async {
                if let self = self {
                    if self.fileJob === job {
                        self.fileJob = nil
                    }
                    self.dropImport(id)
                }
                switch outcome {
                case .success(let text, let duration):
                    call.resolve(["text": text, "duration": duration])
                case .failure(let code, let message):
                    call.reject(message, code)
                }
            }
        }
    }

    private func dropImport(_ id: String) {
        importQueue.async {
            if let url = self.importFiles.removeValue(forKey: id) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private static func safeExtension(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789")
        if ext.isEmpty || ext.count > 5 || ext.unicodeScalars.contains(where: { !allowed.contains($0) }) {
            return "m4a"
        }
        return ext
    }

    // MARK: - Phiên nhận dạng

    private func begin(language: String, call: CAPPluginCall) {
        if fileJob != nil {
            call.reject("Bộ nhận dạng đang chuyển một file ghi âm thành văn bản", "busy")
            return
        }
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

/// Chuyển một file ghi âm có sẵn thành văn bản bằng SFSpeechRecognizer, không cần máy chủ của ứng dụng.
///
/// Nhận dạng qua máy chủ của Apple giới hạn khoảng một phút âm thanh mỗi lượt, nên file được đọc theo từng đoạn
/// dưới một phút, cắt ở chỗ lặng nhất trong mấy giây cuối của đoạn (không chặt đôi một từ), rồi nhận dạng lần lượt.
/// Máy có nhận dạng trên thiết bị cho ngôn ngữ đó thì dùng luôn (không gửi âm thanh đi đâu).
/// Chạy trên một hàng đợi riêng; mỗi đoạn chờ bộ nhận dạng trả kết quả cuối rồi mới sang đoạn sau.
final class FileTranscriptionJob {
    enum Outcome {
        case success(String, Double)
        case failure(String, String)
    }

    private enum WindowResult {
        case text(String)
        case cancelled
        case failed(String, String)
    }

    /// Kết quả của một lượt nhận dạng, ghi từ hàng đợi của bộ nhận dạng, đọc từ hàng đợi của việc này.
    private final class ResultBox {
        private let lock = NSLock()
        private var text = ""
        private var error: Error?
        private var done = false

        func update(_ value: String) {
            lock.lock()
            text = value
            lock.unlock()
        }

        func fail(_ value: Error) {
            lock.lock()
            error = value
            lock.unlock()
        }

        /// true đúng một lần: lần đầu lượt nhận dạng kết thúc (kết quả cuối hoặc lỗi).
        func markDone() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done {
                return false
            }
            done = true
            return true
        }

        func snapshot() -> (String, Error?) {
            lock.lock()
            defer { lock.unlock() }
            return (text, error)
        }
    }

    static let windowSeconds: Double = 50       // dưới giới hạn khoảng một phút mỗi lượt
    static let searchSeconds: Double = 8        // tìm chỗ lặng trong 8 giây cuối của đoạn
    static let frameSeconds: Double = 0.1
    static let sliceSeconds: Double = 1         // đưa âm thanh cho bộ nhận dạng từng giây một
    static let windowTimeout: Double = 90

    let id: String
    var onPartial: ((String) -> Void)?
    var onSegment: ((String) -> Void)?
    var onProgress: ((Double) -> Void)?

    private let url: URL
    private let recognizer: SFSpeechRecognizer
    private let queue = DispatchQueue(label: "vn.mictomindmap.file-transcription")
    private let lock = NSLock()
    private var cancelled = false
    private var task: SFSpeechRecognitionTask?
    private var wake: DispatchSemaphore?

    init(id: String, url: URL, recognizer: SFSpeechRecognizer) {
        self.id = id
        self.url = url
        self.recognizer = recognizer
    }

    func run(completion: @escaping (Outcome) -> Void) {
        queue.async {
            completion(self.transcribe())
        }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let running = task
        let waiting = wake
        lock.unlock()
        running?.cancel()
        waiting?.signal()
    }

    private var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    private func transcribe() -> Outcome {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            return .failure("format", "Không đọc được file âm thanh này")
        }
        let format = file.processingFormat
        let rate = format.sampleRate
        let total = file.length
        guard rate > 0, total > 0, format.channelCount > 0 else {
            return .failure("format", "File âm thanh rỗng hoặc hỏng")
        }
        let onDevice = recognizer.supportsOnDeviceRecognition
        let windowFrames = AVAudioFramePosition(FileTranscriptionJob.windowSeconds * rate)
        var texts: [String] = []
        var position: AVAudioFramePosition = 0
        var failures = 0
        while position < total {
            if isCancelled {
                return .failure("cancelled", "Đã hủy")
            }
            let wanted = AVAudioFrameCount(min(windowFrames, total - position))
            guard let window = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: wanted) else {
                return .failure("unknown", "Không đủ bộ nhớ để đọc file")
            }
            do {
                file.framePosition = position
                try file.read(into: window, frameCount: wanted)
            } catch {
                return .failure(texts.isEmpty ? "format" : "unknown", "Không đọc được file âm thanh này")
            }
            if window.frameLength == 0 {
                break
            }
            let isLast = position + AVAudioFramePosition(window.frameLength) >= total
            let cut = isLast ? window.frameLength : quietestCut(window)
            switch recognizeWindow(window, frames: cut, onDevice: onDevice) {
            case .text(let text):
                failures = 0
                if !text.isEmpty {
                    texts.append(text)
                    onSegment?(text)
                }
            case .cancelled:
                return .failure("cancelled", "Đã hủy")
            case .failed(let code, let message):
                failures += 1
                if failures >= 2 {
                    return .failure(code, message)
                }
                Thread.sleep(forTimeInterval: 1)
                continue   // thử lại đúng đoạn này một lần
            }
            position += AVAudioFramePosition(cut)
            onProgress?(min(1, Double(position) / Double(total)))
        }
        return .success(texts.joined(separator: " "), Double(total) / rate)
    }

    /// Vị trí cắt đoạn: giữa khung 100 ms lặng nhất trong mấy giây cuối của đoạn.
    private func quietestCut(_ buffer: AVAudioPCMBuffer) -> AVAudioFrameCount {
        let length = Int(buffer.frameLength)
        guard let data = buffer.floatChannelData, length > 0 else {
            return buffer.frameLength
        }
        let rate = buffer.format.sampleRate
        let frame = max(1, Int(FileTranscriptionJob.frameSeconds * rate))
        let channels = Int(buffer.format.channelCount)
        var start = max(0, length - Int(FileTranscriptionJob.searchSeconds * rate))
        var bestStart = max(0, length - frame)
        var bestEnergy = Float.greatestFiniteMagnitude
        while start + frame <= length {
            var energy: Float = 0
            for channel in 0..<channels {
                let samples = data[channel]
                for index in start..<(start + frame) {
                    let value = samples[index]
                    energy += value * value
                }
            }
            if energy < bestEnergy {
                bestEnergy = energy
                bestStart = start
            }
            start += frame
        }
        let cut = min(length, bestStart + frame / 2)
        return AVAudioFrameCount(max(1, cut))
    }

    private func slice(_ source: AVAudioPCMBuffer, from start: AVAudioFrameCount, count: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        guard let piece = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: count),
              let from = source.floatChannelData, let to = piece.floatChannelData else {
            return nil
        }
        for channel in 0..<Int(source.format.channelCount) {
            memcpy(to[channel], from[channel].advanced(by: Int(start)), Int(count) * MemoryLayout<Float>.size)
        }
        piece.frameLength = count
        return piece
    }

    private func recognizeWindow(_ window: AVAudioPCMBuffer, frames: AVAudioFrameCount, onDevice: Bool) -> WindowResult {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if onDevice {
            request.requiresOnDeviceRecognition = true
        }
        if #available(iOS 16.0, *) {
            request.addsPunctuation = true
        }
        let done = DispatchSemaphore(value: 0)
        let box = ResultBox()
        lock.lock()
        if cancelled {
            lock.unlock()
            return .cancelled
        }
        wake = done
        let running = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result = result {
                let text = result.bestTranscription.formattedString
                box.update(text)
                if result.isFinal {
                    if box.markDone() {
                        done.signal()
                    }
                } else {
                    self?.onPartial?(text)
                }
            }
            if let error = error {
                box.fail(error)
                if box.markDone() {
                    done.signal()
                }
            }
        }
        task = running
        lock.unlock()

        let step = AVAudioFrameCount(max(1, FileTranscriptionJob.sliceSeconds * window.format.sampleRate))
        var offset: AVAudioFrameCount = 0
        while offset < frames {
            let count = min(step, frames - offset)
            if let piece = slice(window, from: offset, count: count) {
                request.append(piece)
            }
            offset += count
        }
        request.endAudio()

        let waited = done.wait(timeout: .now() + FileTranscriptionJob.windowTimeout)
        lock.lock()
        let wasCancelled = cancelled
        task = nil
        wake = nil
        lock.unlock()
        if wasCancelled {
            running.cancel()
            return .cancelled
        }
        let (text, error) = box.snapshot()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if waited == .timedOut {
            running.cancel()
            return clean.isEmpty ? .failed("unknown", "Nhận dạng một đoạn của file quá lâu") : .text(clean)
        }
        if let error = error, clean.isEmpty {
            let ns = error as NSError
            // 1110: không có lời nói trong đoạn này; 203 / 1107: hết lượt mà không ra chữ
            if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203 || ns.code == 1107) {
                return .text("")
            }
            if !recognizer.isAvailable {
                return .failed("network", "Dịch vụ nhận dạng giọng nói không kết nối được")
            }
            return .failed("unknown", error.localizedDescription)
        }
        return .text(clean)
    }
}

