package vn.mictomindmap.app;

/**
 * Vòng lặp nhận dạng giọng nói liên tục, tách khỏi Android để kiểm thử được trên JVM (xem SpeechLoopTest).
 *
 * SpeechRecognizer của Android chỉ nghe từng đoạn: nó tự dừng sau mỗi câu, khi im lặng, hoặc khi lỗi. Lớp này quyết
 * định sau mỗi lần dừng thì nghe tiếp ngay, chờ rồi thử lại, hay bỏ cuộc và báo lỗi, để với người dùng đó là một
 * lần ghi liên tục. Nó cũng giữ lại phần đang nói dở (kết quả tạm) khi bộ nhận dạng dừng mà chưa kịp chốt.
 *
 * Mọi hàm phải được gọi trên cùng một luồng (luồng chính của ứng dụng).
 */
final class SpeechLoop {
    // Mã lỗi của android.speech.SpeechRecognizer, chép lại để lớp này không phụ thuộc Android
    static final int ERROR_NETWORK_TIMEOUT = 1;
    static final int ERROR_NETWORK = 2;
    static final int ERROR_AUDIO = 3;
    static final int ERROR_SERVER = 4;
    static final int ERROR_CLIENT = 5;
    static final int ERROR_SPEECH_TIMEOUT = 6;
    static final int ERROR_NO_MATCH = 7;
    static final int ERROR_RECOGNIZER_BUSY = 8;
    static final int ERROR_INSUFFICIENT_PERMISSIONS = 9;
    static final int ERROR_TOO_MANY_REQUESTS = 10;
    static final int ERROR_SERVER_DISCONNECTED = 11;
    static final int ERROR_LANGUAGE_NOT_SUPPORTED = 12;
    static final int ERROR_LANGUAGE_UNAVAILABLE = 13;

    static final long RESTART_DELAY_MS = 120;   // nghỉ giữa hai lần nghe: gọi lại ngay lập tức hay bị báo lỗi CLIENT/BUSY
    static final long RETRY_DELAY_MS = 400;
    static final long STOP_TIMEOUT_MS = 1500;   // chờ kết quả cuối sau khi người dùng bấm dừng
    static final int MAX_NETWORK_FAILURES = 3;
    static final int MAX_AUDIO_FAILURES = 3;
    static final int MAX_OTHER_FAILURES = 6;

    /** Bộ nhận dạng thật (SpeechRecognizer) hoặc giả (trong bài test). */
    interface Engine {
        void startListening(String language, boolean preferOffline);

        /** Dừng nghe nhưng vẫn trả kết quả của phần đã nghe. */
        void stopListening();

        /** Dừng ngay, không trả kết quả. */
        void cancel();

        /** Bỏ bộ nhận dạng hiện tại; lần nghe sau tạo cái mới (gỡ tình trạng kẹt sau lỗi). */
        void reset();
    }

    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);

        void cancelAll();
    }

    interface Events {
        void partial(String text);

        void finalText(String text);

        void state(boolean listening, String reason);

        void error(String code, boolean fatal);
    }

    private final Engine engine;
    private final Scheduler scheduler;
    private final Events events;

    private String language = "vi-VN";
    private boolean active;         // người dùng muốn phiên tiếp tục chạy
    private boolean suspended;      // ứng dụng đang ở nền: tạm ngừng nghe
    private boolean listening;      // bộ nhận dạng đang nghe (chờ kết quả hoặc lỗi)
    private boolean stopping;       // đã bấm dừng, đang chờ kết quả cuối
    private boolean preferOffline;
    private boolean offlineTried;
    private int failures;
    private String lastPartial = "";
    private Runnable onStopped;
    private boolean reportedListening;
    private String reportedReason = "";

    private final Runnable listenTask = new Runnable() {
        @Override
        public void run() {
            listen();
        }
    };
    private final Runnable stopTimeout = new Runnable() {
        @Override
        public void run() {
            finishStop();
        }
    };

    SpeechLoop(Engine engine, Scheduler scheduler, Events events) {
        this.engine = engine;
        this.scheduler = scheduler;
        this.events = events;
    }

    boolean isActive() {
        return active;
    }

    boolean isSuspended() {
        return active && suspended;
    }

    void start(String requestedLanguage) {
        if (stopping) {
            finishStop();   // phiên trước còn đang dừng dở: kết thúc nó trước
        }
        scheduler.cancelAll();
        language = requestedLanguage == null || requestedLanguage.isEmpty() ? "vi-VN" : requestedLanguage;
        active = true;
        suspended = false;
        failures = 0;
        preferOffline = false;
        offlineTried = false;
        lastPartial = "";
        listen();
    }

    /** Dừng phiên. done được gọi sau khi câu cuối (nếu có) đã được báo ra. */
    void stop(final Runnable done) {
        if (stopping) {
            // bấm dừng hai lần: cả hai cùng chờ một lần dừng
            final Runnable first = onStopped;
            onStopped = new Runnable() {
                @Override
                public void run() {
                    if (first != null) {
                        first.run();
                    }
                    if (done != null) {
                        done.run();
                    }
                }
            };
            return;
        }
        scheduler.cancelAll();
        active = false;
        suspended = false;
        onStopped = done;
        if (listening) {
            stopping = true;
            engine.stopListening();
            scheduler.postDelayed(stopTimeout, STOP_TIMEOUT_MS);
        } else {
            finishStop();
        }
    }

    /** Ứng dụng ra nền (hoặc tắt màn hình): Android không cho thu âm nữa, tạm ngừng cho tới khi quay lại. */
    void pause(String reason) {
        if (!active || suspended) {
            return;
        }
        suspended = true;
        scheduler.cancelAll();
        if (listening) {
            listening = false;
            engine.cancel();
        }
        flushPartial();
        report(false, reason);
    }

    void resume() {
        if (!active || !suspended) {
            return;
        }
        suspended = false;
        failures = 0;
        listen();
    }

    // ------------------------------------------------------- tín hiệu từ bộ nhận dạng
    void onReady() {
        if (active && !suspended && listening) {
            report(true, "");
        }
    }

    void onPartial(String text) {
        if (!listening) {
            return;   // kết quả về muộn của một lần nghe đã hủy
        }
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty() || clean.equals(lastPartial)) {
            return;
        }
        failures = 0;
        lastPartial = clean;
        events.partial(clean);
    }

    void onResults(String text) {
        if (!listening) {
            return;
        }
        listening = false;
        failures = 0;
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) {
            clean = lastPartial;   // vài bộ nhận dạng trả kết quả cuối rỗng dù đã có kết quả tạm
        }
        lastPartial = "";
        if (!clean.isEmpty()) {
            events.finalText(clean);
        }
        next(RESTART_DELAY_MS);
    }

    void onError(int code) {
        if (!listening) {
            return;   // lỗi của một lần nghe đã hủy
        }
        listening = false;
        flushPartial();
        if (stopping || !active) {
            next(0);
            return;
        }
        switch (code) {
            case ERROR_NO_MATCH:
            case ERROR_SPEECH_TIMEOUT:
                // chỉ là một quãng im lặng: nghe tiếp
                next(RESTART_DELAY_MS);
                return;
            case ERROR_INSUFFICIENT_PERMISSIONS:
                fail("permission");
                return;
            case ERROR_LANGUAGE_NOT_SUPPORTED:
            case ERROR_LANGUAGE_UNAVAILABLE:
                if (preferOffline) {
                    // máy chưa tải gói nhận dạng ngoại tuyến của ngôn ngữ này: quay lại nhận dạng qua mạng
                    preferOffline = false;
                    next(RETRY_DELAY_MS);
                } else {
                    fail("language");
                }
                return;
            case ERROR_NETWORK:
            case ERROR_NETWORK_TIMEOUT:
            case ERROR_SERVER:
            case ERROR_SERVER_DISCONNECTED:
            case ERROR_TOO_MANY_REQUESTS:
                engine.reset();
                if (!offlineTried) {
                    // mất mạng: thử gói nhận dạng ngoại tuyến của máy trước khi báo lỗi
                    offlineTried = true;
                    preferOffline = true;
                    next(RETRY_DELAY_MS);
                    return;
                }
                preferOffline = false;
                failures++;
                if (failures >= MAX_NETWORK_FAILURES) {
                    fail("network");
                    return;
                }
                events.error("network", false);
                next(1000L * failures);
                return;
            case ERROR_AUDIO:
                engine.reset();
                failures++;
                if (failures >= MAX_AUDIO_FAILURES) {
                    fail("audio");
                    return;
                }
                next(RETRY_DELAY_MS * failures);
                return;
            default:
                // CLIENT, RECOGNIZER_BUSY hoặc mã chưa biết: thường hết sau khi tạo lại bộ nhận dạng
                engine.reset();
                failures++;
                if (failures >= MAX_OTHER_FAILURES) {
                    fail("unknown");
                    return;
                }
                next(RETRY_DELAY_MS * failures);
        }
    }

    // ---------------------------------------------------------------------- nội bộ
    private void listen() {
        if (!active || suspended || listening) {
            return;
        }
        listening = true;
        engine.startListening(language, preferOffline);
    }

    private void next(long delayMs) {
        if (stopping) {
            finishStop();
            return;
        }
        if (!active || suspended) {
            return;
        }
        scheduler.postDelayed(listenTask, delayMs);
    }

    private void finishStop() {
        scheduler.cancelAll();
        stopping = false;
        if (listening) {
            // quá hạn mà bộ nhận dạng chưa trả kết quả cuối: hủy hẳn, giữ phần tạm đã có
            listening = false;
            engine.cancel();
        }
        flushPartial();
        report(false, "");
        Runnable done = onStopped;
        onStopped = null;
        if (done != null) {
            done.run();
        }
    }

    private void fail(String code) {
        active = false;
        suspended = false;
        scheduler.cancelAll();
        engine.reset();
        events.error(code, true);
        report(false, "error");
    }

    /** Phần đang nói dở mà bộ nhận dạng chưa chốt: báo ra như một câu để không mất chữ. */
    private void flushPartial() {
        if (!lastPartial.isEmpty()) {
            String text = lastPartial;
            lastPartial = "";
            events.finalText(text);
        }
    }

    private void report(boolean value, String reason) {
        if (reportedListening == value && reportedReason.equals(reason)) {
            return;
        }
        reportedListening = value;
        reportedReason = reason;
        events.state(value, reason);
    }
}
