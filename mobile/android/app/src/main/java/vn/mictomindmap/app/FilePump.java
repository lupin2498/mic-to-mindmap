package vn.mictomindmap.app;

import java.io.IOException;

/**
 * Bơm âm thanh đã giải mã (PCM 16 kHz một kênh) của một file sang bộ nhận dạng giọng nói qua đường ống. Chạy trên luồng
 * riêng (FileRecognizer xếp các lần bơm nối đuôi nhau trên một luồng).
 *
 * Nguồn (Stream) dùng chung giữa các phiên nhận dạng: phiên kết thúc giữa chừng thì phần đã đọc ra mà chưa ghi được
 * vào đường ống vẫn còn đó, phiên sau bơm tiếp từ đúng chỗ ấy. Thuần Java, kiểm thử trên JVM bằng FilePumpTest.
 */
final class FilePump implements Runnable {
    /** 128 ms âm thanh. Ghi một lần không quá PIPE_BUF (4096) nên đã báo ghi được là ghi trọn, không bị chặn. */
    static final int CHUNK_BYTES = 4096;
    static final long WRITE_WAIT_MS = 200;

    interface Source {
        /** Đọc tối đa buffer.length byte PCM; trả -1 khi hết file. */
        int read(byte[] buffer) throws IOException;

        long positionUs();

        long durationUs();

        void close();
    }

    interface Sink {
        /** Ghi tối đa length byte, chờ tối đa waitMs: trả số byte đã ghi (0 = chưa ghi được), -1 nếu phía đọc đã đóng. */
        int write(byte[] data, int offset, int length, long waitMs) throws IOException;

        void close();
    }

    interface Listener {
        void pumped(long bytes, long positionUs);

        /** eof = true: đã đưa hết file và đóng đường ống. false: dừng giữa chừng (bị dừng hoặc phía đọc đã đóng). */
        void finished(boolean eof);

        void failed(Exception error);
    }

    /** Nguồn kèm phần đã đọc ra mà chưa ghi được. */
    static final class Stream {
        final Source source;
        final byte[] buffer = new byte[CHUNK_BYTES];
        int offset;
        int length;
        boolean eof;

        Stream(Source source) {
            this.source = source;
        }

        /** Có dữ liệu chưa ghi (đọc thêm nếu cần); false khi đã hết file. */
        boolean fill() throws IOException {
            while (length == 0) {
                if (eof) {
                    return false;
                }
                int n = source.read(buffer);
                if (n < 0) {
                    eof = true;
                    return false;
                }
                offset = 0;
                length = n;
            }
            return true;
        }

        void consumed(int n) {
            offset += n;
            length -= n;
        }
    }

    private final Stream stream;
    private final Sink sink;
    private final Listener listener;
    private final long delayMs;
    private volatile boolean stopped;
    private long written;

    /** delayMs: nghỉ sau mỗi khối, để không dồn âm thanh nhanh hơn sức bộ nhận dạng. */
    FilePump(Stream stream, Sink sink, Listener listener, long delayMs) {
        this.stream = stream;
        this.sink = sink;
        this.listener = listener;
        this.delayMs = delayMs;
    }

    void stop() {
        stopped = true;
    }

    @Override
    public void run() {
        try {
            while (!stopped) {
                if (!stream.fill()) {
                    sink.close();   // bộ nhận dạng thấy hết âm thanh: phiên kết thúc sau khi trả nốt kết quả
                    listener.finished(true);
                    return;
                }
                int n = sink.write(stream.buffer, stream.offset, Math.min(stream.length, CHUNK_BYTES), WRITE_WAIT_MS);
                if (n < 0) {
                    break;   // phiên nhận dạng đã đóng phía đọc
                }
                if (n == 0) {
                    continue;   // bộ nhận dạng chưa đọc kịp: chờ tiếp, vẫn kiểm cờ dừng
                }
                stream.consumed(n);
                written += n;
                listener.pumped(written, stream.source.positionUs());
                if (delayMs > 0 && stream.length == 0) {
                    try {
                        Thread.sleep(delayMs);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        stopped = true;
                    }
                }
            }
            sink.close();
            listener.finished(false);
        } catch (Exception error) {
            sink.close();
            listener.failed(error);
        }
    }
}
