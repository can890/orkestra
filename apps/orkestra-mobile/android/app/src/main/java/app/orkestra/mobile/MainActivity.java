package app.orkestra.mobile;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends BridgeActivity {
    private static final int DARK_BG = Color.parseColor("#090A0D");
    private static final int LIGHT_BG = Color.parseColor("#F5F7FA");
    private static final String CHANNEL_DEFAULT = "sovra_updates";
    private static final String CHANNEL_URGENT = "sovra_approvals";
    private static final int REQ_POST_NOTIFICATIONS = 4201;

    private static final class PendingFileTransfer {
        final File file;
        final String fileName;
        final String mimeType;
        final FileOutputStream out;

        PendingFileTransfer(File file, String fileName, String mimeType, FileOutputStream out) {
            this.file = file;
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.out = out;
        }
    }

    private final Map<String, PendingFileTransfer> activeTransfers = new ConcurrentHashMap<>();

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

    @Override
    public void onResume() {
        super.onResume();
        WebView activeWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (activeWebView != null) {
            activeWebView.post(() -> activeWebView.evaluateJavascript(
                "(function(){ try { window.dispatchEvent(new Event('sovra:resume')); } catch(e){} })()",
                null
            ));
        }
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

    private static String sanitizeFileName(String raw) {
        String name = (raw == null || raw.trim().isEmpty()) ? "dosya" : raw.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]+", "_");
        if (name.startsWith(".")) name = "dosya" + name;
        if (name.length() > 140) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 ? name.substring(dot) : "";
            name = name.substring(0, Math.max(1, 130 - ext.length())) + ext;
        }
        return name;
    }

    private static String resolveMimeType(String fileName, String providedMime) {
        if (providedMime != null && !providedMime.isEmpty() && !"application/octet-stream".equals(providedMime)) {
            return providedMime;
        }
        int dot = fileName.lastIndexOf('.');
        if (dot > 0 && dot < fileName.length() - 1) {
            String ext = fileName.substring(dot + 1).toLowerCase();
            String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (guessed != null && !guessed.isEmpty()) return guessed;
        }
        return "application/octet-stream";
    }

    private boolean copyToPublicDownloads(File source, String displayName, String mimeType) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sovra");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return false;
                try (InputStream in = new FileInputStream(source);
                     OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) return false;
                    byte[] buf = new byte[32 * 1024];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                    }
                    out.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
                return true;
            }
            File downloadsDir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "Sovra"
            );
            if (!downloadsDir.exists()) downloadsDir.mkdirs();
            File dest = new File(downloadsDir, displayName);
            try (InputStream in = new FileInputStream(source);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[32 * 1024];
                int read;
                while ((read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                }
                out.flush();
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean openFileWithNativeViewer(File file, String mimeType, String displayName) {
        try {
            Uri contentUri = FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                file
            );
            Intent viewIntent = new Intent(Intent.ACTION_VIEW);
            viewIntent.setDataAndType(contentUri, mimeType);
            viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            viewIntent.setClipData(ClipData.newRawUri(displayName, contentUri));
            try {
                startActivity(Intent.createChooser(viewIntent, displayName));
                return true;
            } catch (Throwable ignored) {
                return shareFileWithNativeSheet(file, mimeType, displayName);
            }
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean shareFileWithNativeSheet(File file, String mimeType, String displayName) {
        try {
            Uri contentUri = FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                file
            );
            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType(mimeType);
            shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, displayName);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            shareIntent.setClipData(ClipData.newRawUri(displayName, contentUri));
            startActivity(Intent.createChooser(shareIntent, displayName));
            return true;
        } catch (Throwable ignored) {
            return false;
        }
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

        @JavascriptInterface
        public String beginFileSave(String fileName, String mimeType) {
            try {
                File dir = new File(getCacheDir(), "sovra_files");
                if (!dir.exists()) dir.mkdirs();
                // Eski geçici önbellek dosyalarını (6 saatten eski) temizle.
                long cutoff = System.currentTimeMillis() - 6L * 60L * 60L * 1000L;
                File[] existing = dir.listFiles();
                if (existing != null) {
                    for (File f : existing) {
                        if (f.lastModified() < cutoff) f.delete();
                    }
                }
                String safeName = sanitizeFileName(fileName);
                String id = UUID.randomUUID().toString();
                File target = new File(dir, safeName);
                FileOutputStream out = new FileOutputStream(target, false);
                String resolvedMime = resolveMimeType(safeName, mimeType);
                activeTransfers.put(id, new PendingFileTransfer(target, safeName, resolvedMime, out));
                return id;
            } catch (Throwable ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean appendFileChunk(String transferId, String base64Chunk) {
            PendingFileTransfer transfer = transferId != null ? activeTransfers.get(transferId) : null;
            if (transfer == null || base64Chunk == null) return false;
            try {
                byte[] bytes = Base64.decode(base64Chunk, Base64.DEFAULT);
                transfer.out.write(bytes);
                return true;
            } catch (Throwable ignored) {
                return false;
            }
        }

        @JavascriptInterface
        public void abortFileSave(String transferId) {
            PendingFileTransfer transfer = transferId != null ? activeTransfers.remove(transferId) : null;
            if (transfer == null) return;
            try {
                transfer.out.close();
            } catch (Throwable ignored) {
            }
            transfer.file.delete();
        }

        @JavascriptInterface
        public boolean finishFileSave(String transferId, String mode) {
            PendingFileTransfer transfer = transferId != null ? activeTransfers.remove(transferId) : null;
            if (transfer == null) return false;
            try {
                transfer.out.flush();
                transfer.out.close();
            } catch (Throwable ignored) {
                return false;
            }
            String effectiveMode = mode != null ? mode : "open";
            if ("share".equals(effectiveMode)) {
                runOnUiThread(() -> shareFileWithNativeSheet(transfer.file, transfer.mimeType, transfer.fileName));
                return true;
            }
            boolean saved = copyToPublicDownloads(transfer.file, transfer.fileName, transfer.mimeType);
            if ("download".equals(effectiveMode)) {
                runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    saved
                        ? "İndirilenler/Sovra klasörüne kaydedildi: " + transfer.fileName
                        : "Dosya kaydedilemedi.",
                    Toast.LENGTH_LONG
                ).show());
                return saved;
            }
            // "open": hem İndirilenler/Sovra'ya kaydet hem telefonun yerel PDF/dosya okuyucusunda aç!
            runOnUiThread(() -> {
                if (saved) {
                    Toast.makeText(
                        MainActivity.this,
                        "İndirilenler/Sovra'ya indirildi, açılıyor…",
                        Toast.LENGTH_SHORT
                    ).show();
                }
                boolean opened = openFileWithNativeViewer(transfer.file, transfer.mimeType, transfer.fileName);
                if (!opened) {
                    Toast.makeText(
                        MainActivity.this,
                        "Bu dosyayı açacak uygulama bulunamadı; İndirilenler/Sovra klasörüne kaydedildi.",
                        Toast.LENGTH_LONG
                    ).show();
                }
            });
            return true;
        }
    }
}
