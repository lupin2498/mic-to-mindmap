package vn.mictomindmap.app;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;

/**
 * Giải mã kênh âm thanh đầu tiên của một file (m4a, mp3, aac, ogg/opus, webm, wav, flac, amr, 3gp...) bằng
 * MediaExtractor + MediaCodec của Android, trả ra PCM 16-bit một kênh 16 kHz (little-endian) cho bộ nhận dạng.
 * Đọc dần từng khối nên file dài mấy cũng không tốn nhiều bộ nhớ. Dùng trên một luồng duy nhất (luồng bơm).
 */
final class AudioDecoder implements FilePump.Source {
    private static final long TIMEOUT_US = 10000;
    private static final int MAX_IDLE_STEPS = 3000;   // khoảng 30 giây bộ giải mã không trả gì: coi như treo

    private final MediaExtractor extractor = new MediaExtractor();
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    private MediaCodec codec;   // null: file chứa sẵn PCM (wav), đọc thẳng
    private long durationUs = -1;
    private int sampleRate;
    private int channels;
    private int encoding = AudioFormat.ENCODING_PCM_16BIT;
    private PcmConverter converter;
    private boolean inputDone;
    private boolean outputDone;
    private long positionUs;
    private byte[] pending = new byte[0];
    private int pendingOffset;
    private int pendingLength;
    private short[] samples = new short[0];
    private short[] converted = new short[0];
    private ByteBuffer rawBuffer;

    AudioDecoder(String path) throws IOException {
        try {
            extractor.setDataSource(path);
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    extractor.selectTrack(i);
                    format = candidate;
                    break;
                }
            }
            if (format == null) {
                throw new IOException("File không có kênh âm thanh");
            }
            if (format.containsKey(MediaFormat.KEY_DURATION)) {
                durationUs = format.getLong(MediaFormat.KEY_DURATION);
            }
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                encoding = format.getInteger(MediaFormat.KEY_PCM_ENCODING);
            }
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (!MediaFormat.MIMETYPE_AUDIO_RAW.equals(mime)) {
                codec = MediaCodec.createDecoderByType(mime);
                codec.configure(format, null, null, 0);
                codec.start();
            }
        } catch (IOException | RuntimeException e) {
            close();
            throw e instanceof IOException ? (IOException) e : new IOException(e);
        }
    }

    @Override
    public long durationUs() {
        return durationUs;
    }

    @Override
    public long positionUs() {
        return positionUs;
    }

    @Override
    public int read(byte[] buffer) throws IOException {
        int idle = 0;
        try {
            while (pendingLength == 0) {
                if (outputDone) {
                    return -1;
                }
                if (codec == null) {
                    readRaw();
                } else {
                    decodeStep();
                }
                if (pendingLength == 0 && ++idle > MAX_IDLE_STEPS) {
                    throw new IOException("Bộ giải mã âm thanh không trả dữ liệu");
                }
            }
        } catch (IllegalStateException | IllegalArgumentException e) {
            throw new IOException(e);
        }
        int n = Math.min(buffer.length, pendingLength);
        System.arraycopy(pending, pendingOffset, buffer, 0, n);
        pendingOffset += n;
        pendingLength -= n;
        return n;
    }

    @Override
    public void close() {
        if (codec != null) {
            try {
                codec.stop();
            } catch (RuntimeException ignored) {
                // đã dừng
            }
            try {
                codec.release();
            } catch (RuntimeException ignored) {
                // đã giải phóng
            }
            codec = null;
        }
        try {
            extractor.release();
        } catch (RuntimeException ignored) {
            // đã giải phóng
        }
    }

    // ---------------------------------------------------------------------- nội bộ
    private void readRaw() throws IOException {
        if (rawBuffer == null) {
            rawBuffer = ByteBuffer.allocate(64 * 1024);
        }
        rawBuffer.clear();
        int size = extractor.readSampleData(rawBuffer, 0);
        if (size < 0) {
            outputDone = true;
            return;
        }
        positionUs = Math.max(positionUs, extractor.getSampleTime());
        rawBuffer.position(0);
        rawBuffer.limit(size);
        extractor.advance();
        convert(rawBuffer);
    }

    private void decodeStep() throws IOException {
        if (!inputDone) {
            int in = codec.dequeueInputBuffer(TIMEOUT_US);
            if (in >= 0) {
                ByteBuffer input = codec.getInputBuffer(in);
                int size = input == null ? -1 : extractor.readSampleData(input, 0);
                if (size < 0) {
                    codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    inputDone = true;
                } else {
                    codec.queueInputBuffer(in, 0, size, Math.max(0, extractor.getSampleTime()), 0);
                    extractor.advance();
                }
            }
        }
        int out = codec.dequeueOutputBuffer(info, TIMEOUT_US);
        if (out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            MediaFormat format = codec.getOutputFormat();
            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            encoding = format.containsKey(MediaFormat.KEY_PCM_ENCODING)
                ? format.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
            converter = null;
        } else if (out >= 0) {
            ByteBuffer output = codec.getOutputBuffer(out);
            if (output != null && info.size > 0) {
                output.position(info.offset);
                output.limit(info.offset + info.size);
                positionUs = Math.max(positionUs, info.presentationTimeUs);
                convert(output);
            }
            codec.releaseOutputBuffer(out, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                outputDone = true;
            }
        }
    }

    /** PCM của bộ giải mã (mọi kiểu mẫu thường gặp) -> PCM 16-bit một kênh 16 kHz trong pending. */
    private void convert(ByteBuffer pcm) throws IOException {
        if (sampleRate <= 0 || channels <= 0) {
            throw new IOException("Định dạng âm thanh không hợp lệ");
        }
        pcm.order(ByteOrder.LITTLE_ENDIAN);
        int count;
        if (encoding == AudioFormat.ENCODING_PCM_16BIT) {
            ShortBuffer shorts = pcm.asShortBuffer();
            count = shorts.remaining();
            ensureSamples(count);
            shorts.get(samples, 0, count);
        } else if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
            FloatBuffer floats = pcm.asFloatBuffer();
            count = floats.remaining();
            ensureSamples(count);
            for (int i = 0; i < count; i++) {
                float v = floats.get(i) * 32767f;
                samples[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(v)));
            }
        } else if (encoding == AudioFormat.ENCODING_PCM_8BIT) {
            int base = pcm.position();
            count = pcm.remaining();
            ensureSamples(count);
            for (int i = 0; i < count; i++) {
                samples[i] = (short) (((pcm.get(base + i) & 0xff) - 128) << 8);
            }
        } else if (encoding == 21) {   // AudioFormat.ENCODING_PCM_24BIT_PACKED
            int base = pcm.position();
            count = pcm.remaining() / 3;
            ensureSamples(count);
            for (int i = 0; i < count; i++) {
                // bỏ byte thấp nhất: 16 bit cao là đủ cho nhận dạng giọng nói
                int b1 = pcm.get(base + 3 * i + 1) & 0xff;
                int b2 = pcm.get(base + 3 * i + 2);   // byte cao giữ dấu
                samples[i] = (short) ((b2 << 8) | b1);
            }
        } else if (encoding == 22) {   // AudioFormat.ENCODING_PCM_32BIT
            java.nio.IntBuffer ints = pcm.asIntBuffer();
            count = ints.remaining();
            ensureSamples(count);
            for (int i = 0; i < count; i++) {
                samples[i] = (short) (ints.get(i) >> 16);
            }
        } else {
            throw new IOException("Kiểu mẫu âm thanh chưa hỗ trợ: " + encoding);
        }
        int frames = count / channels;
        if (frames <= 0) {
            return;
        }
        if (converter == null) {
            converter = new PcmConverter(sampleRate, channels);
        }
        int max = converter.maxOutput(frames);
        if (converted.length < max) {
            converted = new short[max];
        }
        int n = converter.convert(samples, frames, converted);
        int bytes = n * 2;
        if (pending.length < bytes) {
            pending = new byte[bytes];
        }
        for (int i = 0; i < n; i++) {
            pending[2 * i] = (byte) converted[i];
            pending[2 * i + 1] = (byte) (converted[i] >> 8);
        }
        pendingOffset = 0;
        pendingLength = bytes;
    }

    private void ensureSamples(int count) {
        if (samples.length < count) {
            samples = new short[count];
        }
    }
}
