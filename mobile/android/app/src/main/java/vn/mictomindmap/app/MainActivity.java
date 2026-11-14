package vn.mictomindmap.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin nhận dạng giọng nói nằm ngay trong ứng dụng (không phải gói npm) nên phải đăng ký tay, trước super.onCreate
        registerPlugin(SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
