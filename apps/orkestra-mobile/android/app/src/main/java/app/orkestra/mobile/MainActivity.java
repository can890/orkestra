package app.orkestra.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int DARK_BG = Color.parseColor("#090A0D");
    private static final int LIGHT_BG = Color.parseColor("#F5F7FA");
    private static final String CHANNEL_DEFAULT = "sovra_updates";
    private static final String CHANNEL_URGENT = "sovra_approvals";
    private static final int REQ_POST_NOTIFICATIONS = 4201;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBarAppearance(true);
        ensureNotificationChannels();
        requestNotificationPermissionIfNeeded();

        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new NativeBridge(), "SovraNative");
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

    private void ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel updates = new NotificationChannel(
            CHANNEL_DEFAULT,
            "Ajan güncellemeleri",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        updates.setDescription("Sovra ajanları bir görevi tamamladığında bildirir.");
        manager.createNotificationChannel(updates);

        NotificationChannel approvals = new NotificationChannel(
            CHANNEL_URGENT,
            "İzin onayları",
            NotificationManager.IMPORTANCE_HIGH
        );
        approvals.setDescription("Bir ajan izin onayı beklediğinde anlık uyarı verir.");
        approvals.enableVibration(true);
        manager.createNotificationChannel(approvals);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                REQ_POST_NOTIFICATIONS
            );
        }
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

    private void triggerHaptic(String kind) {
        View root = getWindow() != null ? getWindow().getDecorView() : null;
        if (root != null) {
            int constant = HapticFeedbackConstants.KEYBOARD_TAP;
            if ("medium".equals(kind)) {
                constant = HapticFeedbackConstants.CONTEXT_CLICK;
            } else if ("success".equals(kind) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                constant = HapticFeedbackConstants.CONFIRM;
            } else if ("warning".equals(kind) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                constant = HapticFeedbackConstants.REJECT;
            }
            if (root.performHapticFeedback(constant)) {
                return;
            }
        }
        try {
            Vibrator vibrator = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vibrator = vm.getDefaultVibrator();
            } else {
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator != null && vibrator.hasVibrator()) {
                long ms = "warning".equals(kind) ? 35L : "medium".equals(kind) ? 20L : 10L;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(ms);
                }
            }
        } catch (Throwable ignored) {
            // Titreşim desteklenmiyorsa sessizce geç.
        }
    }

    private void postLocalNotification(int id, String title, String body, boolean urgent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, id, openIntent, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            this,
            urgent ? CHANNEL_URGENT : CHANNEL_DEFAULT
        )
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title != null && !title.isEmpty() ? title : "Sovra")
            .setContentText(body != null ? body : "")
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body != null ? body : ""))
            .setAutoCancel(true)
            .setPriority(urgent ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pending);

        manager.notify(id, builder.build());
    }

    private final class NativeBridge {
        @JavascriptInterface
        public void setSystemBars(boolean dark) {
            runOnUiThread(() -> applySystemBarAppearance(dark));
        }

        @JavascriptInterface
        public void haptic(String kind) {
            runOnUiThread(() -> triggerHaptic(kind != null ? kind : "light"));
        }

        @JavascriptInterface
        public void notify(int id, String title, String body, boolean urgent) {
            runOnUiThread(() -> postLocalNotification(id, title, body, urgent));
        }
    }
}
