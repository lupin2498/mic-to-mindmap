package vn.mictomindmap.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Plugin "M2MSpeech": chuyển lời nói thành văn bản ngay khi nói bằng bộ nhận dạng giọng nói có sẵn của Android
 * (SpeechRecognizer), không cần máy chủ. Giao diện web gọi qua window.Capacitor.Plugins.M2MSpeech (app/static/speech.js).
 *
 * Phương thức: available(), start({language}), stop(), keepAwake({on}).
 * Sự kiện: "partial" {text} (phần đang nói dở), "final" {text} (một câu đã chốt), "state" {listening, reason},
 * "error" {code, fatal}, "level" {value 0..1}.
 *
 * WebView của Android không có Web Speech API, và micro không dùng chung được giữa trang web với bộ nhận dạng, nên
 * khi plugin này chạy thì trang web không tự mở micro nữa.
 */
@CapacitorPlugin(
    name = "M2MSpeech",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = SpeechPlugin.MICROPHONE) }
)
public class SpeechPlugin extends Plugin {

    static final String MICROPHONE = "microphone";
    private static final String PREFS = "m2m_speech";
    private static final String KEY_MUTED = "muted_music_stream";
    private static final long LEVEL_INTERVAL_MS = 100;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Object timerToken = new Object();
    private SpeechRecognizer recognizer;
    private SpeechLoop loop;
    private boolean mutedByUs;
    private boolean keepAwakeRequested;
    private long lastLevelAt;

    @Override
    public void load() {
        loop = new SpeechLoop(new RecognizerEngine(), new MainThreadScheduler(), new JsEvents());
        // Lần chạy trước bị tắt đột ngột khi đang ghi thì luồng âm thanh nhạc có thể còn bị tắt tiếng: trả lại
        if (prefs().getBoolean(KEY_MUTED, false)) {
            mutedByUs = true;
            muteBeep(false);
        }
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("Thiết bị không có dịch vụ nhận dạng giọng nói", "unavailable");
            return;
        }
        if (getPermissionState(MICROPHONE) != PermissionState.GRANTED) {
            requestPermissionForAlias(MICROPHONE, call, "microphoneResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("Chưa được cấp quyền micro", "permission");
        }
    }

    private void begin(final PluginCall call) {
        final String language = call.getString("language", "vi-VN");
        handler.post(new Runnable() {
            @Override
            public void run() {
                muteBeep(true);
                loop.start(language);
                applyKeepAwake();
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
            }
        });
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                loop.stop(new Runnable() {
                    @Override
                    public void run() {
                        muteBeep(false);
                        applyKeepAwake();
                        call.resolve();
                    }
                });
            }
        });
    }

    /** Giữ màn hình sáng trong lúc ghi: màn hình tắt là Android ngắt micro. */
    @PluginMethod
    public void keepAwake(final PluginCall call) {
        keepAwakeRequested = Boolean.TRUE.equals(call.getBoolean("on", false));
        handler.post(new Runnable() {
            @Override
            public void run() {
                applyKeepAwake();
                call.resolve();
            }
        });
    }

    // ------------------------------------------------------------------ vòng đời
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (loop != null && loop.isActive() && !loop.isSuspended()) {
                    loop.pause("background");
                    muteBeep(false);
                }
            }
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (loop != null && loop.isSuspended()) {
                    muteBeep(true);
                    loop.resume();
                }
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (loop != null) {
            loop.stop(null);
        }
        handler.removeCallbacksAndMessages(null);
        muteBeep(false);
        destroyRecognizer();
        super.handleOnDestroy();
    }

    // ------------------------------------------------------------------ tiện ích
    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void applyKeepAwake() {
        final Activity activity = getActivity();
        if (activity == null) {
            return;
        }
        final boolean on = keepAwakeRequested || (loop != null && loop.isActive());
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (on) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }
        });
    }

    /**
     * Bộ nhận dạng của Google kêu "tít" mỗi lần bắt đầu/kết thúc nghe; ghi liên tục phải nghe lại sau mỗi câu nên sẽ
     * kêu suốt buổi họp. Tiếng đó phát trên luồng nhạc: tắt tiếng luồng này trong lúc ghi rồi trả lại như cũ.
     */
    private void muteBeep(boolean mute) {
        try {
            AudioManager audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (audio == null) {
                return;
            }
            if (mute) {
                if (!mutedByUs && !audio.isStreamMute(AudioManager.STREAM_MUSIC)) {
                    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0);
                    mutedByUs = true;
                    prefs().edit().putBoolean(KEY_MUTED, true).apply();
                }
            } else if (mutedByUs) {
                audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
                mutedByUs = false;
                prefs().edit().remove(KEY_MUTED).apply();
            }
        } catch (Exception ignored) {
            // máy không cho đổi âm lượng (chế độ Không làm phiền...): đành chịu tiếng "tít"
        }
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // dịch vụ nhận dạng đã chết
            }
            recognizer = null;
        }
    }

    private static String bestText(Bundle bundle) {
        if (bundle == null) {
            return "";
        }
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String text = list != null && !list.isEmpty() && list.get(0) != null ? list.get(0) : "";
        // chế độ đọc chính tả: phần chưa ổn định nằm riêng
        String unstable = bundle.getString("android.speech.extra.UNSTABLE_TEXT");
        if (unstable != null && !unstable.trim().isEmpty()) {
            text = text.isEmpty() ? unstable : text + " " + unstable;
        }
        return text;
    }

    // ------------------------------------------------------- nối SpeechLoop với Android
    private final class RecognizerEngine implements SpeechLoop.Engine, RecognitionListener {

        @Override
        public void startListening(String language, boolean preferOffline) {
            try {
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                    recognizer.setRecognitionListener(this);
                }
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                // đọc chính tả: nghe được đoạn dài, không dừng ngay ở chỗ ngắt hơi đầu tiên
                intent.putExtra("android.speech.extra.DICTATION_MODE", true);
                if (preferOffline) {
                    intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                }
                recognizer.startListening(intent);
            } catch (Exception ex) {
                // không tạo/gọi được dịch vụ nhận dạng: báo như một lỗi phía ứng dụng để vòng lặp tự thử lại
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        loop.onError(SpeechLoop.ERROR_CLIENT);
                    }
                });
            }
        }

        @Override
        public void stopListening() {
            if (recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (Exception ignored) {
                    // đã dừng
                }
            }
        }

        @Override
        public void cancel() {
            if (recognizer != null) {
                try {
                    recognizer.cancel();
                } catch (Exception ignored) {
                    // đã dừng
                }
            }
        }

        @Override
        public void reset() {
            destroyRecognizer();
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            loop.onReady();
        }

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {
            long now = SystemClock.uptimeMillis();
            if (now - lastLevelAt < LEVEL_INTERVAL_MS) {
                return;
            }
            lastLevelAt = now;
            // SpeechRecognizer báo khoảng -2 dB (im lặng) tới 10 dB (nói to)
            float value = Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f));
            JSObject data = new JSObject();
            data.put("value", value);
            notifyListeners("level", data);
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onError(int error) {
            loop.onError(error);
        }

        @Override
        public void onResults(Bundle results) {
            loop.onResults(bestText(results));
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            loop.onPartial(bestText(partialResults));
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    private final class MainThreadScheduler implements SpeechLoop.Scheduler {

        @Override
        public void postDelayed(Runnable task, long delayMs) {
            handler.postAtTime(task, timerToken, SystemClock.uptimeMillis() + delayMs);
        }

        @Override
        public void cancelAll() {
            handler.removeCallbacksAndMessages(timerToken);
        }
    }

    private final class JsEvents implements SpeechLoop.Events {

        @Override
        public void partial(String text) {
            JSObject data = new JSObject();
            data.put("text", text);
            notifyListeners("partial", data);
        }

        @Override
        public void finalText(String text) {
            JSObject data = new JSObject();
            data.put("text", text);
            notifyListeners("final", data);
        }

        @Override
        public void state(boolean listening, String reason) {
            JSObject data = new JSObject();
            data.put("listening", listening);
            data.put("reason", reason);
            notifyListeners("state", data);
        }

        @Override
        public void error(String code, boolean fatal) {
            if (fatal) {
                muteBeep(false);
                applyKeepAwake();
            }
            JSObject data = new JSObject();
            data.put("code", code);
            data.put("fatal", fatal);
            notifyListeners("error", data);
        }
    }
}
