package vn.mictomindmap.app;

/**
 * Điều phối việc chuyển một file ghi âm có sẵn thành văn bản bằng bộ nhận dạng giọng nói của Android (API 33+:
 * RecognizerIntent.EXTRA_AUDIO_SOURCE). Bộ nhận dạng đọc âm thanh qua đường ống do FilePump bơm vào; lớp này quyết
 * định khi nào mở phiên mới đọc tiếp, khi nào đổi sang dịch vụ nhận dạng khác, khi nào xong hay báo lỗi.
 *
 * Những tình huống đã tính:
 * - bộ nhận dạng chia đoạn (EXTRA_SEGMENTED_SESSION) trả từng đoạn rồi báo hết khi đường ống đóng: một phiên là xong;
 * - bộ nhận dạng không chia đoạn dừng sau câu đầu: mở phiên mới đọc tiếp phần còn lại của file;
 * - bộ nhận dạng không hỗ trợ đọc từ file sẽ lặng lẽ nghe micro thay vào đó: nó không đọc đường ống, nên sau vài giây
 *   số byte bơm được vẫn chỉ bằng vùng đệm của đường ống. Gặp vậy thì bỏ dịch vụ đó;
 * - dịch vụ không nhận ngôn ngữ, thiếu quyền, lỗi liên tiếp khi chưa ra chữ nào: thử dịch vụ khác (đọc lại từ đầu file).
 *
 * Mọi hàm gọi trên cùng một luồng (luồng chính). Thuần Java, kiểm thử trên JVM bằng FileSessionTest.
 */
final class FileSession {
    // Mã lỗi của android.speech.SpeechRecognizer
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

    static final long CONSUME_CHECK_MS = 8000;
    /** 4 giây âm thanh: vượt xa vùng đệm 64 KB của đường ống, nên bơm được chừng này tức là bộ nhận dạng có đọc. */
    static final long MIN_CONSUMED_BYTES = 128 * 1024;
    static final long STALL_TIMEOUT_MS = 45000;
    static final long IDLE_AFTER_END_MS = 20000;
    static final long RESTART_DELAY_MS = 150;
    static final long RETRY_DELAY_MS = 600;
    static final int MAX_EMPTY_SESSIONS = 4;
    static final int MAX_FAILURES = 3;
    static final int MAX_STALLS = 2;
    /** Báo tiến trình khi đổi từ 0,5% trở lên: khoảng 200 lần cho cả file, thay vì mỗi khối 128 ms âm thanh (hàng chục
     *  lần mỗi giây qua cầu nối sang WebView, mỗi lần giao diện lại đếm lại toàn bộ số từ). */
    static final double PROGRESS_STEP = 0.005;

    interface Engine {
        /** Mở phiên nhận dạng mới (dịch vụ hiện tại), đọc tiếp từ chỗ đang dở của file. */
        void startSession();

        /** Kết thúc phiên hiện tại: hủy bộ nhận dạng, dừng bơm (phần chưa ghi được giữ lại). Gọi nhiều lần không sao. */
        void stopSession();

        /** Chuyển sang dịch vụ nhận dạng kế tiếp và đọc lại file từ đầu; false nếu đã hết dịch vụ để thử. */
        boolean nextService();
    }

    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);

        void cancelAll();
    }

    interface Events {
        void partial(String text);

        void segment(String text);

        void progress(double value);

        void done(String text);

        void error(String code, String partialText);
    }

    private final Engine engine;
    private final Scheduler scheduler;
    private final Events events;
    private final StringBuilder transcript = new StringBuilder();

    private boolean running;
    private boolean sessionOpen;
    private int session;            // tăng mỗi lần mở phiên: việc hẹn giờ của phiên cũ tự bỏ qua
    private long sessionBytes;      // số byte đã bơm trong phiên hiện tại
    private boolean textInSession;
    private boolean anyText;        // dịch vụ hiện tại đã ra chữ (đổi dịch vụ lúc này sẽ lặp lại chữ: không đổi nữa)
    private boolean sourceDone;     // đã bơm hết file và đóng đường ống
    private boolean everPumped;     // đã giải mã được ít nhất một khối âm thanh
    private long activity;          // đếm mọi tín hiệu (bơm, kết quả, mức âm): đứng yên lâu là bộ nhận dạng treo
    private int emptySessions;
    private int failures;
    private int stalls;
    private long durationUs = -1;
    private double lastProgress = -1;

    FileSession(Engine engine, Scheduler scheduler, Events events) {
        this.engine = engine;
        this.scheduler = scheduler;
        this.events = events;
    }

    boolean isRunning() {
        return running;
    }

    void start(long fileDurationUs) {
        durationUs = fileDurationUs;
        running = true;
        open();
    }

    void cancel() {
        fail("cancelled");
    }

    // ------------------------------------------------------- tín hiệu từ bộ nhận dạng và bơm
    void onActivity() {
        if (sessionOpen) {
            activity++;
        }
    }

    void onPartial(String text) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        String clean = text == null ? "" : text.trim();
        if (!clean.isEmpty()) {
            events.partial(clean);
        }
    }

    /** Một đoạn đã chốt (bộ nhận dạng chia đoạn). */
    void onSegment(String text) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        addText(text);
    }

    /** Kết quả cuối của một phiên (bộ nhận dạng không chia đoạn): phiên đã kết thúc. */
    void onResults(String text) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        addText(text);
        endSession();
    }

    void onEndOfSegmentedSession() {
        if (sessionOpen) {
            endSession();
        }
    }

    void onPumped(long bytes, long positionUs) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        everPumped = true;
        sessionBytes = bytes;
        if (durationUs > 0 && positionUs >= 0) {
            double value = Math.min(1.0, (double) positionUs / durationUs);
            // giảm cũng báo: dịch vụ mới đọc lại file từ đầu
            if (lastProgress < 0 || Math.abs(value - lastProgress) >= PROGRESS_STEP || (value >= 1.0 && lastProgress < 1.0)) {
                lastProgress = value;
                events.progress(value);
            }
        }
    }

    void onPumpFinished(boolean eof) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        if (eof && !sourceDone) {
            sourceDone = true;
            armIdleAfterEnd(session, activity);
        }
    }

    /** Không giải mã được file (định dạng lạ, file hỏng giữa chừng). */
    void onSourceFailed() {
        if (running) {
            fail(everPumped ? "unknown" : "format");
        }
    }

    void onError(int code) {
        if (!sessionOpen) {
            return;
        }
        activity++;
        switch (code) {
            case ERROR_NO_MATCH:
            case ERROR_SPEECH_TIMEOUT:
                endSession();   // một quãng không nghe ra chữ: đọc tiếp phần sau
                return;
            case ERROR_INSUFFICIENT_PERMISSIONS:
                closeSession();
                switchOrFail("service-permission");
                return;
            case ERROR_LANGUAGE_NOT_SUPPORTED:
            case ERROR_LANGUAGE_UNAVAILABLE:
                closeSession();
                switchOrFail("language");
                return;
            case ERROR_NETWORK:
            case ERROR_NETWORK_TIMEOUT:
            case ERROR_SERVER:
            case ERROR_SERVER_DISCONNECTED:
            case ERROR_TOO_MANY_REQUESTS:
                closeSession();
                retryOrFail("network");
                return;
            default:
                // CLIENT, RECOGNIZER_BUSY, AUDIO hoặc mã lạ
                closeSession();
                retryOrFail(anyText ? "unknown" : "unsupported");
        }
    }

    // ---------------------------------------------------------------------- nội bộ
    private void open() {
        if (!running) {
            return;
        }
        session++;
        sessionOpen = true;
        sessionBytes = 0;
        textInSession = false;
        final int current = session;
        engine.startSession();
        scheduler.postDelayed(new Runnable() {
            @Override
            public void run() {
                checkConsumed(current);
            }
        }, CONSUME_CHECK_MS);
        armStall(current, activity);
    }

    private void reopen(long delayMs) {
        final int expected = session;
        scheduler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (running && !sessionOpen && session == expected) {
                    open();
                }
            }
        }, delayMs);
    }

    private void closeSession() {
        sessionOpen = false;
        engine.stopSession();
    }

    private void addText(String text) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) {
            return;
        }
        if (transcript.length() > 0) {
            transcript.append(' ');
        }
        transcript.append(clean);
        textInSession = true;
        anyText = true;
        emptySessions = 0;
        failures = 0;
        stalls = 0;
        events.segment(clean);
    }

    /** Phiên nhận dạng đã kết thúc bình thường. */
    private void endSession() {
        closeSession();
        if (sourceDone) {
            finish();
            return;
        }
        // còn file: mở phiên mới đọc tiếp. Phiên không đọc thêm được gì mà cũng không ra chữ thì đếm lại.
        boolean progressed = textInSession || sessionBytes >= MIN_CONSUMED_BYTES;
        emptySessions = progressed ? 0 : emptySessions + 1;
        if (emptySessions >= MAX_EMPTY_SESSIONS) {
            switchOrFail("unsupported");
            return;
        }
        reopen(RESTART_DELAY_MS);
    }

    private void retryOrFail(String code) {
        failures++;
        if (failures >= MAX_FAILURES) {
            failures = 0;
            switchOrFail(code);
            return;
        }
        reopen(RETRY_DELAY_MS * failures);
    }

    /** Dịch vụ hiện tại không dùng được: thử dịch vụ khác nếu chưa ra chữ nào, không thì báo lỗi (giữ phần đã có). */
    private void switchOrFail(String code) {
        closeSession();
        if (!anyText && engine.nextService()) {
            sourceDone = false;
            failures = 0;
            emptySessions = 0;
            stalls = 0;
            reopen(RESTART_DELAY_MS);
            return;
        }
        fail(code);
    }

    private void checkConsumed(int current) {
        if (!running || !sessionOpen || current != session) {
            return;
        }
        if (sourceDone || textInSession || sessionBytes >= MIN_CONSUMED_BYTES) {
            return;
        }
        if (anyText) {
            stalled();   // dịch vụ này đã đọc được file ở phiên trước: chỉ là lần này bị kẹt
            return;
        }
        // bộ nhận dạng không đọc âm thanh của file (có thể nó đang nghe micro thay vào đó): bỏ dịch vụ này
        switchOrFail("unsupported");
    }

    /** Bộ nhận dạng kẹt (không đọc thêm, không ra chữ): mở lại phiên một lần, kẹt nữa thì thôi. */
    private void stalled() {
        closeSession();
        stalls++;
        if (stalls >= MAX_STALLS) {
            fail(anyText ? "unknown" : "unsupported");
        } else {
            reopen(RESTART_DELAY_MS);
        }
    }

    private void armStall(final int current, final long seen) {
        scheduler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!running || !sessionOpen || current != session || sourceDone) {
                    return;
                }
                if (activity != seen) {
                    armStall(current, activity);
                    return;
                }
                stalled();   // không bơm thêm, không ra chữ suốt một lúc lâu: bộ nhận dạng treo
            }
        }, STALL_TIMEOUT_MS);
    }

    /** Đã đưa hết file: chờ bộ nhận dạng trả nốt, im lặng quá lâu thì thôi chờ và kết thúc với phần đã có. */
    private void armIdleAfterEnd(final int current, final long seen) {
        scheduler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!running || !sessionOpen || current != session) {
                    return;
                }
                if (activity != seen) {
                    armIdleAfterEnd(current, activity);
                    return;
                }
                closeSession();
                finish();
            }
        }, IDLE_AFTER_END_MS);
    }

    private void finish() {
        if (!running) {
            return;
        }
        running = false;
        sessionOpen = false;
        scheduler.cancelAll();
        engine.stopSession();
        events.progress(1.0);
        events.done(transcript.toString());
    }

    private void fail(String code) {
        if (!running) {
            return;
        }
        running = false;
        sessionOpen = false;
        scheduler.cancelAll();
        engine.stopSession();
        events.error(code, transcript.toString());
    }
}
