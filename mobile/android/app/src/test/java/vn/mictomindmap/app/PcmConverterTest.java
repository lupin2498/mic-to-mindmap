package vn.mictomindmap.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Random;

import org.junit.Test;

/** Đổi PCM sang 16 kHz một kênh: đúng tần số, trộn kênh đúng, cắt khối kiểu gì cũng ra cùng một luồng. */
public class PcmConverterTest {

    private static short[] convertAll(PcmConverter converter, short[] in, int channels, int[] blockFrames) {
        short[] out = new short[converter.maxOutput(in.length / channels) * 2 + 16];
        int total = 0;
        int frame = 0;
        int block = 0;
        int frames = in.length / channels;
        while (frame < frames) {
            int size = Math.min(blockFrames[block % blockFrames.length], frames - frame);
            block++;
            short[] chunk = new short[size * channels];
            System.arraycopy(in, frame * channels, chunk, 0, size * channels);
            short[] part = new short[converter.maxOutput(size)];
            int n = converter.convert(chunk, size, part);
            assertTrue("khối " + size + " khung sinh " + n + " mẫu, quá bộ đệm", n <= part.length);
            System.arraycopy(part, 0, out, total, n);
            total += n;
            frame += size;
        }
        short[] result = new short[total];
        System.arraycopy(out, 0, result, 0, total);
        return result;
    }

    private static short[] sine(int rate, int channels, double hz, double seconds, int amplitude) {
        int frames = (int) (rate * seconds);
        short[] data = new short[frames * channels];
        for (int i = 0; i < frames; i++) {
            short v = (short) Math.round(amplitude * Math.sin(2 * Math.PI * hz * i / rate));
            for (int c = 0; c < channels; c++) {
                data[i * channels + c] = v;
            }
        }
        return data;
    }

    private static int zeroCrossings(short[] data) {
        int count = 0;
        for (int i = 1; i < data.length; i++) {
            if ((data[i - 1] < 0) != (data[i] < 0)) {
                count++;
            }
        }
        return count;
    }

    @Test
    public void sameRateMonoPassesSamplesThroughAcrossBlocks() {
        short[] in = new short[1000];
        for (int i = 0; i < in.length; i++) {
            in[i] = (short) (i * 7 - 3000);
        }
        short[] out = convertAll(new PcmConverter(16000, 1), in, 1, new int[] { 1, 3, 250, 17, 64 });
        // luồng liền mạch, chỉ trễ đúng một mẫu (mẫu cuối chờ khối sau)
        assertEquals(in.length - 1, out.length);
        short[] expected = new short[in.length - 1];
        System.arraycopy(in, 0, expected, 0, expected.length);
        assertArrayEquals(expected, out);
    }

    @Test
    public void downsamplesStereo48kAndKeepsPitch() {
        short[] in = sine(48000, 2, 440, 2.0, 12000);
        short[] out = convertAll(new PcmConverter(48000, 2), in, 2, new int[] { 4096 });
        assertEquals(32000, out.length, 2);   // 2 giây ở 16 kHz
        // 440 Hz trong 2 giây: khoảng 1760 lần đổi dấu, đổi tần số không làm lệch cao độ
        assertEquals(1760, zeroCrossings(out), 4);
        int peak = 0;
        for (short v : out) {
            peak = Math.max(peak, Math.abs(v));
        }
        assertEquals(12000, peak, 120);
    }

    @Test
    public void upsamples8kByInterpolating() {
        short[] in = { 0, 1000, 2000, 3000, 4000 };
        short[] out = convertAll(new PcmConverter(8000, 1), in, 1, new int[] { 2 });
        // mỗi mẫu nguồn thành hai mẫu đích, mẫu chen giữa nằm giữa hai mẫu kề nhau
        assertArrayEquals(new short[] { 0, 500, 1000, 1500, 2000, 2500, 3000, 3500 }, out);
    }

    @Test
    public void mixesChannelsByAveraging() {
        short[] in = new short[2 * 160];
        for (int i = 0; i < 160; i++) {
            in[2 * i] = 1000;       // kênh trái
            in[2 * i + 1] = -3000;  // kênh phải
        }
        short[] out = convertAll(new PcmConverter(16000, 2), in, 2, new int[] { 160 });
        for (short v : out) {
            assertEquals(-1000, v);
        }
    }

    @Test
    public void blockSizesDoNotChangeTheStream() {
        Random random = new Random(20261114);
        short[] in = new short[2 * 44100];
        for (int i = 0; i < in.length; i++) {
            in[i] = (short) (random.nextGaussian() * 6000);
        }
        short[] whole = convertAll(new PcmConverter(44100, 2), in, 2, new int[] { 44100 });
        short[] pieces = convertAll(new PcmConverter(44100, 2), in, 2, new int[] { 1, 2, 3, 1024, 333, 4096, 7, 59 });
        assertArrayEquals(whole, pieces);
        assertEquals(16000, whole.length, 2);
    }
}
