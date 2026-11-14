package vn.mictomindmap.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/** Bơm âm thanh vào đường ống: đủ byte, đúng thứ tự, phiên đứt giữa chừng thì phiên sau nối tiếp không mất byte nào. */
public class FilePumpTest {

    /** Nguồn giả: trả dữ liệu theo từng khúc kích thước khác nhau (có cả khúc rỗng như bộ giải mã thật). */
    private static final class FakeSource implements FilePump.Source {
        final byte[] data;
        final int[] sizes;
        int offset;
        int call;
        IOException failAt;
        int failOffset = -1;

        FakeSource(int length, int... sizes) {
            data = new byte[length];
            for (int i = 0; i < length; i++) {
                data[i] = (byte) (i * 31 + 7);
            }
            this.sizes = sizes;
        }

        @Override
        public int read(byte[] buffer) throws IOException {
            if (failOffset >= 0 && offset >= failOffset) {
                throw failAt;
            }
            if (offset >= data.length) {
                return -1;
            }
            int n = Math.min(Math.min(sizes[call++ % sizes.length], buffer.length), data.length - offset);
            System.arraycopy(data, offset, buffer, 0, n);
            offset += n;
            return n;
        }

        @Override
        public long positionUs() {
            return offset / 32L * 1000;   // 32 byte = 1 ms ở 16 kHz 16-bit
        }

        @Override
        public long durationUs() {
            return data.length / 32L * 1000;
        }

        @Override
        public void close() {}
    }

    /** Đầu ghi giả: nhận tối đa perCall byte mỗi lần, sau limit byte thì coi như phía đọc đóng (hoặc đứng yên). */
    private static final class FakeSink implements FilePump.Sink {
        final ByteArrayOutputStream received = new ByteArrayOutputStream();
        final int perCall;
        final int limit;
        final boolean stallAtLimit;
        FilePump pumpToStop;
        int waits;
        boolean closed;

        FakeSink(int perCall, int limit, boolean stallAtLimit) {
            this.perCall = perCall;
            this.limit = limit;
            this.stallAtLimit = stallAtLimit;
        }

        @Override
        public int write(byte[] data, int offset, int length, long waitMs) {
            assertFalse("ghi sau khi đã đóng", closed);
            assertTrue("mỗi lần ghi không quá PIPE_BUF", length <= FilePump.CHUNK_BYTES);
            int room = limit - received.size();
            if (room <= 0) {
                if (!stallAtLimit) {
                    return -1;
                }
                if (++waits >= 3 && pumpToStop != null) {
                    pumpToStop.stop();   // bộ nhận dạng không đọc nữa: phiên bị đóng từ phía điều phối
                }
                return 0;
            }
            int n = Math.min(Math.min(length, perCall), room);
            received.write(data, offset, n);
            return n;
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    private static final class Recorder implements FilePump.Listener {
        final List<Long> bytes = new ArrayList<>();
        Boolean eof;
        Exception error;

        @Override
        public void pumped(long total, long positionUs) {
            bytes.add(total);
        }

        @Override
        public void finished(boolean value) {
            eof = value;
        }

        @Override
        public void failed(Exception e) {
            error = e;
        }
    }

    @Test
    public void pumpsTheWholeFileInOrderThenClosesThePipe() {
        FakeSource source = new FakeSource(50_000, 1000, 0, 4096, 333, 9000);
        FakeSink sink = new FakeSink(1500, Integer.MAX_VALUE, false);
        Recorder recorder = new Recorder();
        new FilePump(new FilePump.Stream(source), sink, recorder, 0).run();
        assertArrayEquals(source.data, sink.received.toByteArray());
        assertEquals(Boolean.TRUE, recorder.eof);
        assertTrue("đóng đường ống để bộ nhận dạng biết đã hết", sink.closed);
        assertEquals(Long.valueOf(50_000), recorder.bytes.get(recorder.bytes.size() - 1));
        for (int i = 1; i < recorder.bytes.size(); i++) {
            assertTrue(recorder.bytes.get(i) > recorder.bytes.get(i - 1));
        }
    }

    @Test
    public void nextSessionContinuesExactlyWhereTheClosedOneStopped() {
        FakeSource source = new FakeSource(40_000, 4096, 1234, 4096);
        FilePump.Stream stream = new FilePump.Stream(source);
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        // ba phiên liền nhau, mỗi phiên bộ nhận dạng đóng ống sau một lượng byte lẻ (giữa một khối)
        int[] limits = { 10_001, 7_777, 1 };
        for (int limit : limits) {
            FakeSink sink = new FakeSink(1000, limit, false);
            Recorder recorder = new Recorder();
            new FilePump(stream, sink, recorder, 0).run();
            assertEquals("phiên dừng giữa chừng", Boolean.FALSE, recorder.eof);
            assertTrue(sink.closed);
            byte[] got = sink.received.toByteArray();
            all.write(got, 0, got.length);
        }
        FakeSink last = new FakeSink(4096, Integer.MAX_VALUE, false);
        Recorder recorder = new Recorder();
        new FilePump(stream, last, recorder, 0).run();
        assertEquals(Boolean.TRUE, recorder.eof);
        byte[] rest = last.received.toByteArray();
        all.write(rest, 0, rest.length);
        assertArrayEquals("không mất, không lặp byte nào giữa các phiên", source.data, all.toByteArray());
    }

    @Test
    public void stopsWhenAskedEvenIfNobodyReads() {
        FakeSource source = new FakeSource(100_000, 4096);
        FakeSink sink = new FakeSink(4096, 65_536, true);   // vùng đệm 64 KB đầy, không ai đọc
        Recorder recorder = new Recorder();
        FilePump pump = new FilePump(new FilePump.Stream(source), sink, recorder, 0);
        sink.pumpToStop = pump;
        pump.run();
        assertEquals(Boolean.FALSE, recorder.eof);
        assertEquals(65_536, sink.received.size());
        assertTrue(sink.closed);
    }

    @Test
    public void decoderFailureIsReported() {
        FakeSource source = new FakeSource(30_000, 4096);
        source.failOffset = 8192;
        source.failAt = new IOException("file hỏng");
        FakeSink sink = new FakeSink(4096, Integer.MAX_VALUE, false);
        Recorder recorder = new Recorder();
        new FilePump(new FilePump.Stream(source), sink, recorder, 0).run();
        assertEquals("file hỏng", recorder.error.getMessage());
        assertEquals(null, recorder.eof);
        assertTrue(sink.closed);
        assertEquals(8192, sink.received.size());
    }
}
