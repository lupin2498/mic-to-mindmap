package vn.mictomindmap.app;

import android.annotation.TargetApi;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;

import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Chuyển một file ghi âm có sẵn thành văn bản bằng bộ nhận dạng giọng nói của Android, không cần máy chủ.
 *
 * Android 13 (API 33) cho bộ nhận dạng đọc âm thanh từ một ParcelFileDescriptor thay vì micro
 * (RecognizerIntent.EXTRA_AUDIO_SOURCE), kèm chế độ chia đoạn cho âm thanh dài (EXTRA_SEGMENTED_SESSION). File được
 * giải mã (AudioDecoder) thành PCM 16 kHz một kênh rồi bơm vào đường ống (FilePump); FileSession lo phần điều phối.
 * Thử lần lượt: bộ nhận dạng trên thiết bị, dịch vụ của ứng dụng Google, dịch vụ mặc định, các dịch vụ còn lại.
 *
 * Mọi hàm (trừ phần bơm) chạy trên luồng chính.
 */
@TargetApi(Build.VERSION_CODES.TIRAMISU)
final class FileRecognizer implements FileSession.Engine {

    /** Một cách mở bộ nhận dạng: trên thiết bị, theo tên dịch vụ, hoặc dịch vụ mặc định (component = null). */
    static final class Choice {
        final boolean onDevice;
        final ComponentName component;

        Choice(boolean onDevice, ComponentName component) {
            this.onDevice = onDevice;
            this.component = component;
        }
    }

    interface Callback {
        void partial(String text);

        void segment(String text);

        void progress(double value);

        void done(String text, long durationUs);

        void error(String code, String partialText);
    }

    private static final long ON_DEVICE_DELAY_MS = 15;   // khoảng 8 lần nhanh hơn thời gian thật
    private static final long NETWORK_DELAY_MS = 40;     // khoảng 3 lần: tránh bị dịch vụ qua mạng giới hạn

    private final Context context;
    private final Handler main;
    private final File file;
    private final String language;
    private final List<Choice> choices;
    private final Callback callback;
    private final FileSession session;
    private final ExecutorService pumpThread = Executors.newSingleThreadExecutor();
    private int choiceIndex;
    private int generation;   // tăng mỗi lần mở/đóng phiên: tín hiệu về muộn của phiên cũ tự bỏ qua
    private long durationUs = -1;
    private AudioDecoder decoder;
    private FilePump.Stream stream;
    private FilePump pump;
    private SpeechRecognizer recognizer;
    private ParcelFileDescriptor readSide;
    private boolean released;

    FileRecognizer(Context context, Handler main, File file, String language, List<Choice> choices, Callback callback) {
        this.context = context;
        this.main = main;
        this.file = file;
        this.language = language == null || language.isEmpty() ? "vi-VN" : language;
        this.choices = choices;
        this.callback = callback;
        this.session = new FileSession(this, new FileSession.Scheduler() {
            private final Object token = new Object();

            @Override
            public void postDelayed(Runnable task, long delayMs) {
                main.postAtTime(task, token, SystemClock.uptimeMillis() + delayMs);
            }

            @Override
            public void cancelAll() {
                main.removeCallbacksAndMessages(token);
            }
        }, new FileSession.Events() {
            @Override
            public void partial(String text) {
                callback.partial(text);
            }

            @Override
            public void segment(String text) {
                callback.segment(text);
            }

            @Override
            public void progress(double value) {
                callback.progress(value);
            }

            @Override
            public void done(String text) {
                release();
                callback.done(text, durationUs);
            }

            @Override
            public void error(String code, String partialText) {
                release();
                callback.error(code, partialText);
            }
        });
    }

    /** Mở file (trên luồng bơm, để không làm đứng giao diện) rồi bắt đầu nhận dạng. */
    void start() {
        if (choices.isEmpty()) {
            callback.error("unsupported", "");
            return;
        }
        pumpThread.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final AudioDecoder opened = new AudioDecoder(file.getPath());
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (released) {
                                opened.close();
                                return;
                            }
                            decoder = opened;
                            stream = new FilePump.Stream(opened);
                            durationUs = opened.durationUs();
                            session.start(durationUs);
                        }
                    });
                } catch (final IOException e) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (!released) {
                                released = true;
                                pumpThread.shutdown();
                                callback.error("format", "");
                            }
                        }
                    });
                }
            }
        });
    }

    void cancel() {
        if (session.isRunning()) {
            session.cancel();
        } else if (!released) {
            release();
            callback.error("cancelled", "");
        }
    }

    // ------------------------------------------------------------ FileSession.Engine
    @Override
    public void startSession() {
        final int gen = ++generation;
        // đầu ghi của đường ống chỉ thuộc về luồng bơm khi đã giao được cho nó; lỗi trước đó thì phải tự đóng, không thì
        // mỗi lần mở dịch vụ thất bại (máy không có dịch vụ, dịch vụ chết) rò một file descriptor
        ParcelFileDescriptor writeSide = null;
        try {
            if (stream == null) {
                decoder = new AudioDecoder(file.getPath());   // đọc lại từ đầu cho dịch vụ mới
                stream = new FilePump.Stream(decoder);
            }
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            readSide = pipe[0];
            writeSide = pipe[1];
            Choice choice = choices.get(choiceIndex);
            if (choice.onDevice) {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
            } else if (choice.component != null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(context, choice.component);
            } else {
                recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            }
            recognizer.setRecognitionListener(new Listener(gen));
            recognizer.startListening(intentFor(readSide));
            pump = new FilePump(stream, new PipeSink(writeSide), new PumpListener(gen),
                choice.onDevice ? ON_DEVICE_DELAY_MS : NETWORK_DELAY_MS);
            pumpThread.execute(pump);
            writeSide = null;
        } catch (final IOException | RuntimeException e) {
            if (writeSide != null) {
                try {
                    writeSide.close();
                } catch (IOException ignored) {
                    // đã đóng
                }
            }
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gen != generation) {
                        return;
                    }
                    if (e instanceof IOException && stream == null) {
                        session.onSourceFailed();
                    } else {
                        session.onError(FileSession.ERROR_CLIENT);
                    }
                }
            });
        }
    }

    @Override
    public void stopSession() {
        generation++;
        if (pump != null) {
            pump.stop();
            pump = null;
        }
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (RuntimeException ignored) {
                // dịch vụ đã dừng
            }
            try {
                recognizer.destroy();
            } catch (RuntimeException ignored) {
                // dịch vụ đã chết
            }
            recognizer = null;
        }
        if (readSide != null) {
            try {
                readSide.close();
            } catch (IOException ignored) {
                // đã đóng
            }
            readSide = null;
        }
    }

    @Override
    public boolean nextService() {
        if (choiceIndex + 1 >= choices.size()) {
            return false;
        }
        choiceIndex++;
        closeDecoder();   // dịch vụ mới đọc lại file từ đầu
        return true;
    }

    // ---------------------------------------------------------------------- nội bộ
    private void closeDecoder() {
        final AudioDecoder old = decoder;
        decoder = null;
        stream = null;
        if (old != null) {
            // đóng trên luồng bơm, sau khi lần bơm đang dở (nếu có) đã dừng hẳn
            pumpThread.execute(new Runnable() {
                @Override
                public void run() {
                    old.close();
                }
            });
        }
    }

    private void release() {
        if (released) {
            return;
        }
        released = true;
        stopSession();
        closeDecoder();
        pumpThread.shutdown();
    }

    private Intent intentFor(ParcelFileDescriptor source) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
        intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, PcmConverter.TARGET_RATE);
        // chia đoạn theo nguồn âm thanh: trả từng đoạn, chỉ kết thúc khi đường ống đóng (hết file)
        intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
        return intent;
    }

    private final class Listener implements RecognitionListener {
        private final int gen;

        Listener(int gen) {
            this.gen = gen;
        }

        private boolean current() {
            return gen == generation && !released;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (current()) {
                session.onActivity();
            }
        }

        @Override
        public void onBeginningOfSpeech() {
            if (current()) {
                session.onActivity();
            }
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (current()) {
                session.onActivity();
            }
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {
            if (current()) {
                session.onActivity();
            }
        }

        @Override
        public void onError(int error) {
            if (current()) {
                session.onError(error);
            }
        }

        @Override
        public void onResults(Bundle results) {
            if (current()) {
                session.onResults(SpeechPlugin.bestText(results));
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (current()) {
                session.onPartial(SpeechPlugin.bestText(partialResults));
            }
        }

        @Override
        public void onSegmentResults(Bundle segmentResults) {
            if (current()) {
                session.onSegment(SpeechPlugin.bestText(segmentResults));
            }
        }

        @Override
        public void onEndOfSegmentedSession() {
            if (current()) {
                session.onEndOfSegmentedSession();
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    /** Tín hiệu từ luồng bơm, chuyển về luồng chính. */
    private final class PumpListener implements FilePump.Listener {
        private final int gen;

        PumpListener(int gen) {
            this.gen = gen;
        }

        private void post(Runnable task) {
            main.post(new Runnable() {
                @Override
                public void run() {
                    if (gen == generation && !released) {
                        task.run();
                    }
                }
            });
        }

        @Override
        public void pumped(final long bytes, final long positionUs) {
            post(new Runnable() {
                @Override
                public void run() {
                    session.onPumped(bytes, positionUs);
                }
            });
        }

        @Override
        public void finished(final boolean eof) {
            post(new Runnable() {
                @Override
                public void run() {
                    session.onPumpFinished(eof);
                }
            });
        }

        @Override
        public void failed(Exception error) {
            post(new Runnable() {
                @Override
                public void run() {
                    session.onSourceFailed();
                }
            });
        }
    }

    /** Đầu ghi của đường ống, có hạn chờ để luồng bơm luôn kiểm được cờ dừng (không bị chặn mãi khi không ai đọc). */
    static final class PipeSink implements FilePump.Sink {
        private final ParcelFileDescriptor pfd;
        private final FileDescriptor fd;
        private boolean closed;

        PipeSink(ParcelFileDescriptor pfd) {
            this.pfd = pfd;
            this.fd = pfd.getFileDescriptor();
        }

        @Override
        public int write(byte[] data, int offset, int length, long waitMs) throws IOException {
            if (closed) {
                return -1;
            }
            try {
                StructPollfd poll = new StructPollfd();
                poll.fd = fd;
                poll.events = (short) OsConstants.POLLOUT;
                int ready = Os.poll(new StructPollfd[] { poll }, (int) waitMs);
                if (ready == 0) {
                    return 0;
                }
                if ((poll.revents & (OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL)) != 0) {
                    return -1;
                }
                // POLLOUT bảo đảm ghi được ít nhất PIPE_BUF byte mà không bị chặn
                return Os.write(fd, data, offset, Math.min(length, FilePump.CHUNK_BYTES));
            } catch (ErrnoException e) {
                if (e.errno == OsConstants.EPIPE) {
                    return -1;
                }
                if (e.errno == OsConstants.EAGAIN || e.errno == OsConstants.EINTR) {
                    return 0;
                }
                throw new IOException(e);
            }
        }

        @Override
        public void close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                pfd.close();
            } catch (IOException ignored) {
                // đã đóng
            }
        }
    }
}
