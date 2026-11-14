package vn.mictomindmap.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

/** Kiểm vòng lặp nhận dạng liên tục bằng bộ nhận dạng giả và đồng hồ giả (chạy trên JVM, không cần thiết bị). */
public class SpeechLoopTest {

    private final List<String> log = new ArrayList<>();
    private final List<Object[]> timers = new ArrayList<>();
    private long now;
    private int stopped;
    private SpeechLoop loop;

    private final Runnable done = new Runnable() {
        @Override
        public void run() {
            stopped++;
            log.add("done");
        }
    };

    @Before
    public void setUp() {
        loop = new SpeechLoop(new SpeechLoop.Engine() {
            @Override
            public void startListening(String language, boolean preferOffline) {
                log.add("listen " + language + (preferOffline ? " offline" : ""));
            }

            @Override
            public void stopListening() {
                log.add("stopListening");
            }

            @Override
            public void cancel() {
                log.add("cancel");
            }

            @Override
            public void reset() {
                log.add("reset");
            }
        }, new SpeechLoop.Scheduler() {
            @Override
            public void postDelayed(Runnable task, long delayMs) {
                timers.add(new Object[] { now + delayMs, task });
            }

            @Override
            public void cancelAll() {
                timers.clear();
            }
        }, new SpeechLoop.Events() {
            @Override
            public void partial(String text) {
                log.add("partial " + text);
            }

            @Override
            public void finalText(String text) {
                log.add("final " + text);
            }

            @Override
            public void state(boolean listening, String reason) {
                log.add("state " + listening + (reason.isEmpty() ? "" : " " + reason));
            }

            @Override
            public void error(String code, boolean fatal) {
                log.add("error " + code + (fatal ? " fatal" : ""));
            }
        });
    }

    /** Cho đồng hồ giả chạy thêm ms mili giây, chạy các việc tới hạn theo thứ tự. */
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

    private static List<String> list(String... items) {
        List<String> out = new ArrayList<>();
        for (String item : items) {
            out.add(item);
        }
        return out;
    }

    @Test
    public void listensAgainAfterEachSentenceWithoutReportingStop() {
        loop.start("vi-VN");
        loop.onReady();
        loop.onPartial("hôm nay");
        loop.onPartial("hôm nay");          // lặp lại: không báo lần hai
        loop.onPartial("hôm nay chúng ta họp");
        loop.onResults("hôm nay chúng ta họp");
        assertEquals(list("listen vi-VN", "state true", "partial hôm nay", "partial hôm nay chúng ta họp", "final hôm nay chúng ta họp"), take());
        advance(SpeechLoop.RESTART_DELAY_MS);
        loop.onReady();
        assertEquals("nghe lại ngay, không báo dừng giữa hai câu", list("listen vi-VN"), take());
        assertTrue(loop.isActive());
    }

    @Test
    public void silenceIsNotAnErrorAndUnfinishedWordsAreKept() {
        loop.start("vi-VN");
        loop.onReady();
        take();
        for (int i = 0; i < 20; i++) {       // im lặng rất lâu: nghe lại mãi, không bao giờ báo lỗi
            loop.onError(i % 2 == 0 ? SpeechLoop.ERROR_NO_MATCH : SpeechLoop.ERROR_SPEECH_TIMEOUT);
            advance(SpeechLoop.RESTART_DELAY_MS);
        }
        List<String> quiet = take();
        assertEquals(20, quiet.size());
        assertFalse(quiet.toString(), quiet.toString().contains("error"));
        // bộ nhận dạng dừng khi còn kết quả tạm chưa chốt: giữ lại như một câu
        loop.onPartial("phần đang nói dở");
        loop.onError(SpeechLoop.ERROR_NO_MATCH);
        assertEquals(list("partial phần đang nói dở", "final phần đang nói dở"), take());
        // kết quả cuối rỗng dù đã có kết quả tạm
        advance(SpeechLoop.RESTART_DELAY_MS);
        take();
        loop.onPartial("câu thứ hai");
        loop.onResults("");
        assertEquals(list("partial câu thứ hai", "final câu thứ hai"), take());
    }

    @Test
    public void stopWaitsForTheLastSentenceThenReportsDoneOnce() {
        loop.start("vi-VN");
        loop.onReady();
        loop.onPartial("câu cuối");
        take();
        loop.stop(done);
        assertEquals(list("stopListening"), take());
        assertEquals("chưa xong khi kết quả cuối chưa về", 0, stopped);
        loop.onResults("câu cuối cùng");
        assertEquals(list("final câu cuối cùng", "state false", "done"), take());
        advance(10_000);
        assertEquals("không nghe lại sau khi đã dừng", list(), take());
        assertEquals(1, stopped);
        assertFalse(loop.isActive());
    }

    @Test
    public void stopTimesOutWhenRecognizerNeverAnswersAndKeepsPartialText() {
        loop.start("vi-VN");
        loop.onReady();
        loop.onPartial("chưa kịp chốt");
        take();
        loop.stop(done);
        loop.stop(done);                     // bấm dừng hai lần
        advance(SpeechLoop.STOP_TIMEOUT_MS);
        assertEquals(list("stopListening", "cancel", "final chưa kịp chốt", "state false", "done", "done"), take());
        loop.onResults("về muộn");            // kết quả về sau khi đã hết hạn chờ: bỏ
        assertEquals(list(), take());
    }

    @Test
    public void stopWhenNotListeningFinishesImmediately() {
        loop.stop(done);
        assertEquals(list("done"), take());
        loop.start("en-US");
        loop.onError(SpeechLoop.ERROR_NO_MATCH);   // đang nghỉ giữa hai lần nghe
        take();
        loop.stop(done);
        assertEquals(list("done"), take());
        advance(10_000);
        assertEquals(list(), take());
    }

    @Test
    public void networkLossTriesOfflinePackThenGivesUpWithOneFatalError() {
        loop.start("vi-VN");
        loop.onReady();
        take();
        loop.onError(SpeechLoop.ERROR_NETWORK);
        advance(SpeechLoop.RETRY_DELAY_MS);
        assertEquals("lần đầu mất mạng: thử gói ngoại tuyến, chưa làm phiền người dùng", list("reset", "listen vi-VN offline"), take());
        // máy chưa có gói ngoại tuyến tiếng Việt: quay lại nhận dạng qua mạng
        loop.onError(SpeechLoop.ERROR_LANGUAGE_UNAVAILABLE);
        advance(SpeechLoop.RETRY_DELAY_MS);
        assertEquals(list("listen vi-VN"), take());
        loop.onError(SpeechLoop.ERROR_NETWORK);
        assertEquals(list("reset", "error network"), take());
        advance(1000);
        loop.onError(SpeechLoop.ERROR_SERVER);
        advance(2000);
        assertEquals(list("listen vi-VN", "reset", "error network", "listen vi-VN"), take());
        loop.onError(SpeechLoop.ERROR_NETWORK_TIMEOUT);
        assertEquals(list("reset", "reset", "error network fatal", "state false error"), take());
        assertFalse(loop.isActive());
        advance(60_000);
        assertEquals("không tự chạy lại sau lỗi chết", list(), take());
    }

    @Test
    public void networkFailuresAreForgottenOnceRecognitionWorksAgain() {
        loop.start("vi-VN");
        loop.onReady();
        loop.onError(SpeechLoop.ERROR_NETWORK);          // thử ngoại tuyến
        advance(SpeechLoop.RETRY_DELAY_MS);
        loop.onError(SpeechLoop.ERROR_NETWORK);          // lỗi 1
        advance(1000);
        loop.onError(SpeechLoop.ERROR_NETWORK);          // lỗi 2
        advance(2000);
        loop.onPartial("mạng có lại");
        loop.onResults("mạng có lại rồi");
        advance(SpeechLoop.RESTART_DELAY_MS);
        take();
        loop.onError(SpeechLoop.ERROR_NETWORK);          // đếm lại từ đầu, chưa chết
        assertEquals(list("reset", "error network"), take());
        assertTrue(loop.isActive());
    }

    @Test
    public void missingPermissionAndUnsupportedLanguageAreFatal() {
        loop.start("vi-VN");
        loop.onError(SpeechLoop.ERROR_INSUFFICIENT_PERMISSIONS);
        assertEquals(list("listen vi-VN", "reset", "error permission fatal", "state false error"), take());
        loop.start("xx-XX");
        loop.onReady();
        loop.onError(SpeechLoop.ERROR_LANGUAGE_NOT_SUPPORTED);
        assertEquals(list("listen xx-XX", "state true", "reset", "error language fatal", "state false error"), take());
    }

    @Test
    public void busyOrClientErrorsRecreateTheRecognizerAndEventuallyGiveUp() {
        loop.start("vi-VN");
        take();
        for (int i = 1; i < SpeechLoop.MAX_OTHER_FAILURES; i++) {
            loop.onError(i % 2 == 0 ? SpeechLoop.ERROR_CLIENT : SpeechLoop.ERROR_RECOGNIZER_BUSY);
            advance(SpeechLoop.RETRY_DELAY_MS * i);
            assertEquals("lần " + i, list("reset", "listen vi-VN"), take());
        }
        loop.onError(SpeechLoop.ERROR_CLIENT);
        assertEquals(list("reset", "reset", "error unknown fatal", "state false error"), take());
    }

    @Test
    public void backgroundPausesAndForegroundResumes() {
        loop.start("vi-VN");
        loop.onReady();
        loop.onPartial("đang nói thì chuyển app");
        take();
        loop.pause("background");
        assertEquals(list("cancel", "final đang nói thì chuyển app", "state false background"), take());
        assertTrue(loop.isSuspended());
        loop.onResults("kết quả của lần nghe đã hủy");
        advance(60_000);
        assertEquals("ở nền thì không nghe lại", list(), take());
        loop.resume();
        loop.onReady();
        assertEquals(list("listen vi-VN", "state true"), take());
        // dừng khi đang ở nền: xong ngay
        loop.pause("background");
        take();
        loop.stop(done);
        assertEquals(list("state false", "done"), take());
        loop.resume();
        assertEquals("đã dừng thì quay lại ứng dụng không tự bật", list(), take());
    }

    @Test
    public void startingAgainWhileStoppingFinishesTheOldSessionFirst() {
        loop.start("vi-VN");
        loop.onReady();
        take();
        loop.stop(done);
        loop.start("en-US");
        assertEquals(list("stopListening", "cancel", "state false", "done", "listen en-US"), take());
        loop.onReady();
        loop.onResults("hello");
        assertEquals(list("state true", "final hello"), take());
    }
}
