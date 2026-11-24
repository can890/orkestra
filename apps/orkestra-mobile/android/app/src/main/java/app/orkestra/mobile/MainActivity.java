package app.orkestra.mobile;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int DARK_BG = Color.parseColor("#090A0D");
    private static final int LIGHT_BG = Color.parseColor("#F5F7FA");

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBarAppearance(true);

        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new SystemBarBridge(), "SovraNative");
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView activeWebView = getBridge() != null ? getBridge().getWebView() : null;
                if (activeWebView == null) {
                    moveTaskToBack(true);
                    return;
                }
                activeWebView.evaluateJavascript(
                    "(function(){ try { return window.__orkestraHandleBack ? window.__orkestraHandleBack() : 'exit'; } catch (e) { return 'exit'; } })()",
                    value -> {
                        if ("\"exit\"".equals(value)) {
                            moveTaskToBack(true);
                        }
                    }
                );
            }
        });
    }

    private void applySystemBarAppearance(boolean dark) {
        Window window = getWindow();
        if (window == null) return;
        int color = dark ? DARK_BG : LIGHT_BG;
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        WindowInsetsControllerCompat controller =
            new WindowInsetsControllerCompat(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    private final class SystemBarBridge {
        @JavascriptInterface
        public void setSystemBars(boolean dark) {
            runOnUiThread(() -> applySystemBarAppearance(dark));
        }
    }
}
