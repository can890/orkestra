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
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
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
import app.orkestra.mobile.agentnotify.AgentNotifyBridge;
import app.orkestra.mobile.mediaproxy.MediaProxyHost;
import app.orkestra.mobile.widgets.SovraWidgetStore;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

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
    /** Ajan bildirimine dokunmayla gelen, JS'in henüz almadığı sohbet hedefi (JSON). */
    private volatile String pendingLaunchTarget = null;
    /** Sohbet medyası için yerel HTTP vekili (ilk kullanımda başlar). */
    private MediaProxyHost mediaProxy;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pendingLaunchTarget = AgentNotifyBridge.launchTargetFrom(getIntent());
        applySystemBarAppearance(true);
        ensureNotificationChannels();
        requestNotificationPermissionIfNeeded();

        mediaProxy = new MediaProxyHost(this, new MediaProxyHost.Host() {
            @Override
            public void emit(String eventName, JSONObject detail) {
                dispatchWindowEvent(eventName, detail);
            }

            @Override
            public void deliverCachedFile(File file, String fileName, String mimeType, String mode) {
                MainActivity.this.deliverCachedFile(file, fileName, mimeType, mode);
            }

            @Override
            public void toast(String text) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_LONG).show());
            }
        });

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
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String target = AgentNotifyBridge.launchTargetFrom(intent);
        if (target == null) return;
        pendingLaunchTarget = target;
        WebView activeWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (activeWebView != null) {
            activeWebView.post(() -> activeWebView.evaluateJavascript(
                "(function(){ try { window.dispatchEvent(new Event('sovra:open-conversation')); } catch(e){} })()",
                null
            ));
        }
    }

    @Override
    public void onPause() {
        AgentNotifyBridge.setAppVisible(false);
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        AgentNotifyBridge.setAppVisible(true);
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

    private volatile boolean notificationPermissionAsked = false;

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionAsked = true;
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

    /** `window` üzerinde `CustomEvent(name, {detail})` yayınlar (her iş parçacığından çağrılabilir). */
    private void dispatchWindowEvent(String eventName, JSONObject detail) {
        WebView activeWebView = getBridge() != null ? getBridge().getWebView() : null;
        if (activeWebView == null) return;
        String script = "(function(){ try { window.dispatchEvent(new CustomEvent("
            + JSONObject.quote(eventName) + ", { detail: " + detail.toString() + " })); } catch(e){} })()";
        activeWebView.post(() -> activeWebView.evaluateJavascript(script, null));
    }

    /** Önbellekteki dosyayı `download` / `open` / `share` kipine göre teslim eder. */
    private boolean deliverCachedFile(File file, String fileName, String mimeType, String mode) {
        String effectiveMode = mode != null ? mode : "open";
        if ("share".equals(effectiveMode)) {
            runOnUiThread(() -> shareFileWithNativeSheet(file, mimeType, fileName));
            return true;
        }
        boolean saved = copyToPublicDownloads(file, fileName, mimeType);
        if ("download".equals(effectiveMode)) {
            runOnUiThread(() -> Toast.makeText(
                MainActivity.this,
                saved
                    ? "İndirilenler/Sovra klasörüne kaydedildi: " + fileName
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
            boolean opened = openFileWithNativeViewer(file, mimeType, fileName);
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
        public void updateWidgets(String json) {
            SovraWidgetStore.saveAndRefresh(MainActivity.this, json);
        }

        /** Arka plan ajan bildirimleri: tercihler + (isteğe bağlı) bilgisayar listesi; durum JSON'u döner. */
        @JavascriptInterface
        public String agentNotifyConfigure(String json) {
            return AgentNotifyBridge.configure(MainActivity.this, json != null ? json : "{}");
        }

        @JavascriptInterface
        public String agentNotifyStatus() {
            return AgentNotifyBridge.status(MainActivity.this);
        }

        @JavascriptInterface
        public void agentNotifyRequestPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED) {
                    return;
                }
                if (!ActivityCompat.shouldShowRequestPermissionRationale(
                        MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                        && notificationPermissionAsked) {
                    // "Bir daha sorma" sonrası sistem diyaloğu açılmaz: ayarlara yönlendir.
                    AgentNotifyBridge.openNotificationSettings(MainActivity.this);
                    return;
                }
                notificationPermissionAsked = true;
                ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQ_POST_NOTIFICATIONS
                );
            });
        }

        @JavascriptInterface
        public boolean agentNotifyOpenBatterySettings() {
            runOnUiThread(() -> AgentNotifyBridge.openBatterySettings(MainActivity.this));
            return true;
        }

        @JavascriptInterface
        public boolean agentNotifyOpenNotificationSettings() {
            runOnUiThread(() -> AgentNotifyBridge.openNotificationSettings(MainActivity.this));
            return true;
        }

        /** Ön planda açık sohbet; boş dizeler "sohbet ekranında değil" demektir. */
        @JavascriptInterface
        public void agentNotifySetConversation(String hostId, String conversationId) {
            AgentNotifyBridge.setVisibleConversation(MainActivity.this, hostId, conversationId);
        }

        /** Bildirime dokunmayla gelen sohbet hedefini bir kez verir (yoksa boş dize). */
        @JavascriptInterface
        public String agentNotifyConsumeLaunchTarget() {
            String target = pendingLaunchTarget;
            pendingLaunchTarget = null;
            return target != null ? target : "";
        }

        /** Yerel medya vekili var mı (JS özellik denetimi). */
        @JavascriptInterface
        public boolean mediaProxyAvailable() {
            return mediaProxy != null;
        }

        /** `{key,name,mimeType,size,blockBytes}` → `{streamId,url}` (hata: boş dize). */
        @JavascriptInterface
        public String mediaStreamOpen(String json) {
            return mediaProxy != null && json != null ? mediaProxy.open(json) : "";
        }

        /** `sovra:media-range` isteğinin yanıtı: base64 veri ya da hata mesajı. */
        @JavascriptInterface
        public void mediaRangeResult(String reqId, String base64, String error) {
            if (mediaProxy != null) mediaProxy.rangeResult(reqId, base64, error);
        }

        /** Poster karesi/süre/en-boy (video, ses) ya da 1. sayfa (pdf); sonuç `sovra:media-probe`. */
        @JavascriptInterface
        public boolean mediaStreamProbe(String streamId, String kind) {
            return mediaProxy != null && mediaProxy.probe(streamId, kind);
        }

        /** Tam dosyayı akıtarak indirir/açar/paylaşır; ilerleme `sovra:media-save`. */
        @JavascriptInterface
        public String mediaStreamSave(String streamId, String mode) {
            return mediaProxy != null ? mediaProxy.save(streamId, mode) : "";
        }

        @JavascriptInterface
        public void mediaStreamCancelSave(String jobId) {
            if (mediaProxy != null) mediaProxy.cancelSave(jobId);
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
            return deliverCachedFile(transfer.file, transfer.fileName, transfer.mimeType, mode);
        }

        /**
         * Telegram/WhatsApp tarzı zengin önizleme:
         * - `pdf`: Android yerleşik `PdfRenderer` ile 1. sayfanın gerçek görsel önizlemesini ve sayfa sayısını üretir.
         * - `video`: `MediaMetadataRetriever` ile ilk kare poster görseli ve süreyi üretir.
         * - `audio`: ses süresini döndürür.
         */
        @JavascriptInterface
        public String finishFilePreview(String transferId, String kind) {
            PendingFileTransfer transfer = transferId != null ? activeTransfers.remove(transferId) : null;
            if (transfer == null) return "";
            try {
                transfer.out.flush();
                transfer.out.close();
            } catch (Throwable ignored) {
                return "";
            }
            JSONObject out = new JSONObject();
            try {
                if ("pdf".equals(kind)) {
                    try (ParcelFileDescriptor pfd = ParcelFileDescriptor.open(
                            transfer.file,
                            ParcelFileDescriptor.MODE_READ_ONLY
                    );
                         PdfRenderer renderer = new PdfRenderer(pfd)) {
                        int pageCount = renderer.getPageCount();
                        out.put("pageCount", pageCount);
                        if (pageCount > 0) {
                            try (PdfRenderer.Page page = renderer.openPage(0)) {
                                int srcW = Math.max(1, page.getWidth());
                                int srcH = Math.max(1, page.getHeight());
                                int targetW = 640;
                                int targetH = Math.min(920, Math.max(220, (int) ((long) srcH * targetW / srcW)));
                                Bitmap bmp = Bitmap.createBitmap(targetW, targetH, Bitmap.Config.ARGB_8888);
                                Canvas canvas = new Canvas(bmp);
                                canvas.drawColor(Color.WHITE);
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                                ByteArrayOutputStream jpg = new ByteArrayOutputStream();
                                bmp.compress(Bitmap.CompressFormat.JPEG, 82, jpg);
                                bmp.recycle();
                                String b64 = Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP);
                                out.put("thumbnail", "data:image/jpeg;base64," + b64);
                            }
                        }
                    }
                } else if ("video".equals(kind) || "audio".equals(kind)) {
                    MediaMetadataRetriever retriever = new MediaMetadataRetriever();
                    try {
                        retriever.setDataSource(transfer.file.getAbsolutePath());
                        String dur = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                        if (dur != null) {
                            try {
                                out.put("durationMs", Long.parseLong(dur));
                            } catch (NumberFormatException ignored) {
                            }
                        }
                        if ("video".equals(kind)) {
                            Bitmap frame = retriever.getFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                            if (frame == null) {
                                frame = retriever.getFrameAtTime(0L);
                            }
                            if (frame != null) {
                                int w = frame.getWidth();
                                int h = frame.getHeight();
                                Bitmap scaled = frame;
                                if (w > 640 && h > 0) {
                                    int nh = Math.max(1, (int) ((long) h * 640 / w));
                                    scaled = Bitmap.createScaledBitmap(frame, 640, nh, true);
                                    if (scaled != frame) frame.recycle();
                                }
                                ByteArrayOutputStream jpg = new ByteArrayOutputStream();
                                scaled.compress(Bitmap.CompressFormat.JPEG, 80, jpg);
                                scaled.recycle();
                                String b64 = Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP);
                                out.put("thumbnail", "data:image/jpeg;base64," + b64);
                            }
                        }
                    } finally {
                        try {
                            retriever.release();
                        } catch (Throwable ignored) {
                        }
                    }
                }
                return out.toString();
            } catch (Throwable ignored) {
                return "";
            }
        }
    }
}
