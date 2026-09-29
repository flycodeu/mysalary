package com.flylabs.salary;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SalaryNativePlugin.class);
        super.onCreate(savedInstanceState);
        // AndroidX handles both the system back button and Android edge-back gestures.
        // The single-page UI owns its dialog/page stack; WebView history is not that stack.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null) getBridge().triggerWindowJSEvent("salary:navigate-back");
            }
        });
    }
}
