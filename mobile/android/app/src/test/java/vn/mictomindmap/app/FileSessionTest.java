package vn.mictomindmap.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

/** Điều phối nhận dạng từ file bằng bộ nhận dạng giả và đồng hồ giả (chạy trên JVM, không cần thiết bị). */
public class FileSessionTest {

    private final List<String> log = new ArrayList<>();
    private final List<Object[]> timers = new ArrayList<>();
    private long now;
    private int spareServices;
    private FileSession session;

    @Before
    public void setUp() {
        session = new FileSession(new FileSession.Engine() {
            @Override
            public void startSession() {
                log.add("open");
            }

            @Override
            public void stopSession() {
                log.add("close");
            }

            @Override
            public boolean nextService() {
                if (spareServices <= 0) {
                    return false;
                }
                spareServices--;
                log.add("nextService");
                return true;
            }
        }, new FileSession.Scheduler() {
            @Override
            public void postDelayed(Runnable task, long delayMs) {
                timers.add(new Object[] { now + delayMs, task });
            }

            @Override
            public void cancelAll() {
                timers.clear();
            }
        }, new FileSession.Events() {
            @Override
            public void partial(String text) {
                log.add("partial " + text);
            }

            @Override
            public void segment(String text) {
                log.add("segment " + text);
            }

            @Override
            public void progress(double value) {
                log.add("progress " + Math.round(value * 100));
            }

            @Override
            public void done(String text) {
                log.add("done " + text);
            }

            @Override
            public void error(String code, String partialText) {
                log.add("error " + code + (partialText.isEmpty() ? "" : " | " + partialText));
            }
        });
    }

    private void advance(long ms) {
        long target = now + ms;
        while (true) {
            Object[] next = null;
            for (Object[] timer : timers) {
                if ((Long) timer[0] <= target && (next == null || (Long) timer[0] < (Long) next[0])) {
                    next = timer;
                }
            }
            if (next == null) {
                break;
            }
            timers.remove(next);
            now = (Long) next[0];
            ((Runnable) next[1]).run();
        }
        now = target;
    }

    private List<String> take() {
        List<String> copy = new ArrayList<>(log);
        log.clear();
        return copy;
    }

    /** Bỏ các dòng tiến trình để so cho gọn. */
    private List<String> takeQuiet() {
        List<String> out = new ArrayList<>();
        for (String line : take()) {
            if (!line.startsWith("progress")) {
                out.add(line);
            }
        }
        return out;
    }

    private static List<String> list(String... items) {
        List<String> out = new ArrayList<>();
        for (String item : items) {
            out.add(item);
        }
        return out;
    }

    /** Bộ nhận dạng đọc bình thường: bơm được nhiều hơn vùng đệm của đường ống. */
    private void pumpWell(long bytes) {
        session.onPumped(bytes, bytes / 32 * 1000);
    }

    @Test
    public void segmentedRecognizerFinishesInOneSession() {
        session.start(60_000_000L);   // file 60 giây
        assertEquals(list("open"), take());
        session.onActivity();
        pumpWell(200_000);
        session.onPartial("hôm nay chúng ta");
        session.onSegment("hôm nay chúng ta họp về kế hoạch quý bốn");
        pumpWell(1_920_000);
        session.onPumpFinished(true);
        session.onSegment("chị lan sẽ gửi báo cáo");
        session.onEndOfSegmentedSession();
        assertEquals(list("progress 10", "partial hôm nay chúng ta", "segment hôm nay chúng ta họp về kế hoạch quý bốn",
            "progress 100", "segment chị lan sẽ gửi báo cáo", "close", "close", "progress 100",
            "done hôm nay chúng ta họp về kế hoạch quý bốn chị lan sẽ gửi báo cáo"), take());
        assertFalse(session.isRunning());
        advance(10 * 60_000);
        assertEquals("xong rồi thì không hẹn giờ nào chạy nữa", list(), take());
    }

    @Test
    public void nonSegmentedRecognizerIsReopenedUntilTheFileEnds() {
        session.start(-1);   // không biết thời lượng: không báo tiến trình
        take();
        pumpWell(150_000);
        session.onResults("câu thứ nhất");             // dừng sau câu đầu dù file còn
        assertEquals(list("segment câu thứ nhất", "close"), take());
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals("mở phiên mới đọc tiếp", list("open"), take());
        pumpWell(140_000);
        session.onError(FileSession.ERROR_NO_MATCH);   // một đoạn im lặng: đọc tiếp
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals(list("close", "open"), take());
        pumpWell(300_000);
        session.onPumpFinished(true);
        session.onResults("câu cuối");
        assertEquals(list("segment câu cuối", "close", "close", "progress 100", "done câu thứ nhất câu cuối"), take());
    }

    @Test
    public void recognizerThatIgnoresTheFileIsDroppedForTheNextService() {
        spareServices = 1;
        session.start(60_000_000L);
        take();
        session.onActivity();             // dịch vụ báo sẵn sàng... nhưng nghe micro, không đọc đường ống
        session.onPumped(65_536, 2_048_000);
        advance(FileSession.CONSUME_CHECK_MS);
        assertEquals(list("close", "nextService"), takeQuiet());
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals("dịch vụ kế đọc lại file từ đầu", list("open"), take());
        pumpWell(400_000);
        advance(FileSession.CONSUME_CHECK_MS);
        assertEquals("dịch vụ này đọc được: không bị bỏ", list("progress 21"), take());
        session.onSegment("dịch vụ thứ hai chạy được");
        session.onPumpFinished(true);
        session.onEndOfSegmentedSession();
        assertEquals(list("segment dịch vụ thứ hai chạy được", "close", "close", "done dịch vụ thứ hai chạy được"), takeQuiet());
    }

    @Test
    public void noServiceReadsTheFileMeansUnsupported() {
        session.start(60_000_000L);
        take();
        session.onPumped(65_536, 2_048_000);
        advance(FileSession.CONSUME_CHECK_MS);
        assertEquals(list("close", "close", "error unsupported"), takeQuiet());
        advance(60_000);
        assertEquals(list(), take());
    }

    @Test
    public void repeatedEmptySessionsAlsoMeanTheFileIsNotRead() {
        session.start(60_000_000L);
        take();
        for (int i = 0; i < FileSession.MAX_EMPTY_SESSIONS - 1; i++) {
            session.onPumped(65_536, 0);
            session.onError(FileSession.ERROR_NO_MATCH);   // nghe micro, không có ai nói, cứ thế kết thúc
            advance(FileSession.RESTART_DELAY_MS);
        }
        take();
        session.onPumped(65_536, 0);
        session.onError(FileSession.ERROR_SPEECH_TIMEOUT);
        assertEquals(list("close", "close", "close", "error unsupported"), takeQuiet());
    }

    @Test
    public void longSilenceInTheFileIsNotAnError() {
        session.start(600_000_000L);
        take();
        for (int i = 0; i < 20; i++) {
            pumpWell(320_000);                              // 10 giây im lặng mỗi phiên, bộ nhận dạng vẫn đọc
            session.onError(FileSession.ERROR_NO_MATCH);
            advance(FileSession.RESTART_DELAY_MS);
        }
        assertTrue(session.isRunning());
        assertFalse(take().toString().contains("error"));
    }

    @Test
    public void languageProblemSwitchesServiceOnlyBeforeAnyText() {
        spareServices = 1;
        session.start(60_000_000L);
        take();
        session.onError(FileSession.ERROR_LANGUAGE_UNAVAILABLE);
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals(list("close", "close", "nextService", "open"), take());
        pumpWell(200_000);
        session.onSegment("đã ra chữ");
        session.onError(FileSession.ERROR_LANGUAGE_NOT_SUPPORTED);
        assertEquals("đã ra chữ thì đổi dịch vụ sẽ lặp lại chữ: báo lỗi, giữ phần đã có",
            list("segment đã ra chữ", "close", "close", "close", "error language | đã ra chữ"), takeQuiet());
    }

    @Test
    public void networkErrorsAreRetriedThenReportedWithTheTextSoFar() {
        session.start(60_000_000L);
        take();
        pumpWell(200_000);
        session.onSegment("phần đầu");
        session.onError(FileSession.ERROR_NETWORK);
        advance(FileSession.RETRY_DELAY_MS);
        session.onError(FileSession.ERROR_SERVER);
        advance(FileSession.RETRY_DELAY_MS * 2);
        assertEquals(list("segment phần đầu", "close", "open", "close", "open"), takeQuiet());
        session.onError(FileSession.ERROR_NETWORK_TIMEOUT);
        assertEquals(list("close", "close", "close", "error network | phần đầu"), takeQuiet());
    }

    @Test
    public void missingPermissionOfTheService() {
        session.start(60_000_000L);
        take();
        session.onError(FileSession.ERROR_INSUFFICIENT_PERMISSIONS);
        assertEquals(list("close", "close", "close", "error service-permission"), take());
    }

    @Test
    public void afterTheFileEndsWaitWhileTheRecognizerIsStillWorking() {
        session.start(10_000_000L);
        take();
        pumpWell(320_000);
        session.onPumpFinished(true);
        session.onSegment("đoạn một");
        advance(FileSession.IDLE_AFTER_END_MS - 1);
        session.onActivity();                              // còn đang xử lý phần cuối
        advance(FileSession.IDLE_AFTER_END_MS);
        assertTrue(session.isRunning());
        session.onSegment("đoạn hai");
        advance(FileSession.IDLE_AFTER_END_MS * 2);        // không bao giờ báo hết: thôi chờ
        assertFalse(session.isRunning());
        List<String> lines = takeQuiet();
        assertEquals("done đoạn một đoạn hai", lines.get(lines.size() - 1));
    }

    @Test
    public void stalledRecognizerIsReopenedOnceThenGivenUp() {
        session.start(60_000_000L);
        take();
        pumpWell(200_000);
        session.onSegment("được một câu");
        advance(FileSession.STALL_TIMEOUT_MS * 2);        // không đọc thêm, không ra chữ (phát hiện trong 45-90 giây)
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals(list("segment được một câu", "close", "open"), takeQuiet());
        session.onPumped(65_536, 0);                       // phiên mới chỉ nhận được vùng đệm rồi đứng
        advance(FileSession.CONSUME_CHECK_MS);
        assertEquals("dịch vụ đã từng đọc được file: kẹt lần nữa thì báo lỗi, giữ phần đã có",
            list("close", "close", "error unknown | được một câu"), takeQuiet());
    }

    @Test
    public void unreadableFile() {
        session.start(-1);
        take();
        session.onSourceFailed();
        assertEquals(list("close", "error format"), take());

        setUp();
        log.clear();
        session.start(-1);
        pumpWell(200_000);
        session.onSegment("phần đọc được");
        session.onSourceFailed();   // hỏng giữa file
        assertEquals(list("open", "segment phần đọc được", "close", "error unknown | phần đọc được"), takeQuiet());
    }

    @Test
    public void cancelStopsEverythingAndIgnoresLateSignals() {
        session.start(60_000_000L);
        pumpWell(200_000);
        session.onSegment("đang dở");
        take();
        session.cancel();
        assertEquals(list("close", "error cancelled | đang dở"), take());
        session.onSegment("về muộn");
        session.onResults("về muộn");
        session.onError(FileSession.ERROR_CLIENT);
        session.onEndOfSegmentedSession();
        advance(10 * 60_000);
        assertEquals(list(), take());
    }

    @Test
    public void clientErrorsBeforeAnyTextSwitchService() {
        spareServices = 1;
        session.start(60_000_000L);
        take();
        for (int i = 1; i < FileSession.MAX_FAILURES; i++) {
            session.onError(FileSession.ERROR_CLIENT);
            advance(FileSession.RETRY_DELAY_MS * i);
        }
        assertEquals(list("close", "open", "close", "open"), take());
        session.onError(FileSession.ERROR_RECOGNIZER_BUSY);
        advance(FileSession.RESTART_DELAY_MS);
        assertEquals(list("close", "close", "nextService", "open"), take());
    }
}
