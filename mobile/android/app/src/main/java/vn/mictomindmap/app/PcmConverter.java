package vn.mictomindmap.app;

/**
 * Đổi PCM 16-bit xen kênh, tần số bất kỳ, sang PCM 16-bit một kênh 16 kHz cho bộ nhận dạng giọng nói.
 *
 * Trộn các kênh bằng trung bình cộng, đổi tần số bằng nội suy tuyến tính. Giữ trạng thái giữa các khối, nên đưa vào
 * từng khối nối tiếp nhau là ra một luồng liền mạch (mẫu cuối của khối trước nối với mẫu đầu của khối sau).
 * Thuần Java, kiểm thử trên JVM bằng PcmConverterTest.
 */
final class PcmConverter {
    static final int TARGET_RATE = 16000;

    private final int channels;
    private final int sourceRate;
    private final double step;      // số mẫu nguồn ứng với một mẫu đích
    // Vị trí của mẫu đích kế tiếp = posNum / TARGET_RATE mẫu nguồn, tính từ đầu khối hiện tại (luôn >= -1 mẫu).
    // Giữ bằng số nguyên để cắt khối kiểu gì cũng ra đúng cùng một luồng (số thực cộng dồn sẽ lệch dần).
    private long posNum;
    private float last;             // mẫu đã trộn kênh cuối cùng của khối trước (ứng với vị trí -1)
    private boolean hasLast;

    PcmConverter(int sourceRate, int channels) {
        if (sourceRate <= 0 || channels <= 0) {
            throw new IllegalArgumentException("sourceRate=" + sourceRate + ", channels=" + channels);
        }
        this.channels = channels;
        this.sourceRate = sourceRate;
        this.step = (double) sourceRate / TARGET_RATE;
    }

    /** Số mẫu đích tối đa mà một khối frames khung có thể sinh ra (để cấp bộ đệm cho convert). */
    int maxOutput(int frames) {
        return (int) Math.ceil((frames + 1) / step) + 2;
    }

    /** Đổi frames khung đầu của in (mỗi khung có channels mẫu); ghi vào out, trả về số mẫu đã ghi. */
    int convert(short[] in, int frames, short[] out) {
        if (frames <= 0) {
            return 0;
        }
        int n = 0;
        while (true) {
            // chia lấy phần nguyên làm tròn xuống (posNum có thể âm tới -TARGET_RATE)
            long i = posNum >= 0 ? posNum / TARGET_RATE : -((-posNum + TARGET_RATE - 1) / TARGET_RATE);
            if (i + 1 >= frames) {
                break;   // cần mẫu ở khối sau: để dành
            }
            double frac = (double) (posNum - i * TARGET_RATE) / TARGET_RATE;
            float a = i < 0 ? (hasLast ? last : mono(in, 0)) : mono(in, (int) i);
            float b = mono(in, (int) i + 1);
            out[n++] = clamp(a + (b - a) * frac);
            posNum += sourceRate;
        }
        posNum -= (long) frames * TARGET_RATE;
        last = mono(in, frames - 1);
        hasLast = true;
        return n;
    }

    private float mono(short[] in, int frame) {
        int base = frame * channels;
        if (channels == 1) {
            return in[base];
        }
        float sum = 0;
        for (int c = 0; c < channels; c++) {
            sum += in[base + c];
        }
        return sum / channels;
    }

    private static short clamp(double value) {
        long rounded = Math.round(value);
        if (rounded > Short.MAX_VALUE) {
            return Short.MAX_VALUE;
        }
        if (rounded < Short.MIN_VALUE) {
            return Short.MIN_VALUE;
        }
        return (short) rounded;
    }
}
