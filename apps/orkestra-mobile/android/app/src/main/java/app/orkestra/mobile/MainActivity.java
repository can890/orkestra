package app.orkestra.mobile;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
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
}
