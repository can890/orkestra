package app.orkestra.mobile.mediaproxy;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Android tarafı yapıştırıcı: {@link MediaStreamServer}'ı tembel başlatır, JS köprü çağrılarını
 * (akış aç, aralık sonucu, önizleme, kaydet) karşılar. Önizleme (poster karesi, süre, en-boy,
 * PDF 1. sayfa) ve kaydetme işleri arka plan iş parçacığında yürür; sonuçlar JS'e olayla döner.
 */
public final class MediaProxyHost {
    /** Aynı anda bellekte/diskte tutulacak oynatma önbelleği üst sınırı. */
    public static final long CACHE_MAX_BYTES = 256L * 1024 * 1024;
    private static final int FETCH_THREADS = 3;
    private static final int MIN_BLOCK = 256 * 1024;
    private static final int MAX_BLOCK = 8 * 1024 * 1024;

    /** MainActivity'nin sağladığı yetenekler. */
    public interface Host {
        /** `window` üzerinde `CustomEvent(name, {detail})` yayınlar. */
        void emit(String eventName, JSONObject detail);

        /** Önbellekteki dosyayı açar (`open`) ya da paylaşım menüsüne verir (`share`). */
        void deliverCachedFile(File file, String fileName, String mimeType, String mode);

        void toast(String text);
    }

    private final Context context;
    private final Host host;
    private final ExecutorService probeExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService saveExecutor = Executors.newFixedThreadPool(2);
    private final Map<String, JSONObject> probeResults = new ConcurrentHashMap<>();
    private final Map<String, AtomicBoolean> saveJobs = new ConcurrentHashMap<>();
    private volatile MediaStreamServer server;
    private volatile JsRangeBridge bridge;

    public MediaProxyHost(Context context, Host host) {
        this.context = context.getApplicationContext();
        this.host = host;
    }

    private synchronized MediaStreamServer server() throws IOException {
        if (server != null) return server;
        JsRangeBridge jsBridge = new JsRangeBridge(detail -> {
            try {
                host.emit("sovra:media-range", new JSONObject(detail));
            } catch (Exception ignored) {
                // Ayrıştırılamayan istek: zaman aşımıyla düşer.
            }
        }, MediaStreamServer.DEFAULT_FETCH_TIMEOUT_MS);
        BlockCache cache = new BlockCache(new File(context.getCacheDir(), "sovra_media"), CACHE_MAX_BYTES);
        server = new MediaStreamServer(cache, jsBridge, FETCH_THREADS, MediaStreamServer.DEFAULT_FETCH_TIMEOUT_MS);
        bridge = jsBridge;
        return server;
    }

    /** `{key,name,mimeType,size,blockBytes}` → `{streamId,url}` JSON (hata: boş dize). */
    public String open(String json) {
        try {
            JSONObject in = new JSONObject(json);
            long size = in.getLong("size");
            int block = Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, in.optInt("blockBytes", 1024 * 1024)));
            MediaStreamServer srv = server();
            MediaStreamServer.StreamInfo info = srv.register(in.getString("key"), in.optString("name", "dosya"),
                    in.optString("mimeType", "application/octet-stream"), size, block);
            JSONObject out = new JSONObject();
            out.put("streamId", info.id);
            out.put("url", srv.urlFor(info));
            return out.toString();
        } catch (Exception e) {
            return "";
        }
    }

    public void rangeResult(String reqId, String base64, String error) {
        JsRangeBridge b = bridge;
        if (b == null) return;
        if (error != null && !error.isEmpty()) {
            b.complete(reqId, null, error);
            return;
        }
        try {
            b.complete(reqId, Base64.decode(base64 != null ? base64 : "", Base64.DEFAULT), null);
        } catch (IllegalArgumentException e) {
            b.complete(reqId, null, "Medya parçası çözülemedi.");
        }
    }

    // ── Önizleme ────────────────────────────────────────────────────────────────────────────

    /** `kind`: `video` | `audio` | `pdf`. Sonuç `sovra:media-probe` olayıyla gelir. */
    public boolean probe(String streamId, String kind) {
        MediaStreamServer srv = server;
        MediaStreamServer.StreamInfo info = srv != null ? srv.stream(streamId) : null;
        if (info == null) return false;
        String cacheKey = streamId + "|" + kind;
        JSONObject cached = probeResults.get(cacheKey);
        if (cached != null) {
            probeExecutor.execute(() -> host.emit("sovra:media-probe", cached));
            return true;
        }
        probeExecutor.execute(() -> {
            JSONObject result = new JSONObject();
            try {
                result.put("streamId", streamId);
                result.put("kind", kind);
                if ("pdf".equals(kind)) {
                    probePdf(srv, info, result);
                } else {
                    probeMedia(srv, info, "video".equals(kind), result);
                }
                result.put("ok", true);
                probeResults.put(cacheKey, result);
            } catch (Throwable t) {
                try {
                    result.put("ok", false);
                    result.put("error", t.getMessage() != null ? t.getMessage() : "Önizleme hazırlanamadı.");
                } catch (Exception ignored) {
                }
            }
            host.emit("sovra:media-probe", result);
        });
        return true;
    }

    private static void probeMedia(MediaStreamServer srv, MediaStreamServer.StreamInfo info, boolean video,
            JSONObject out) throws Exception {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            // Yerel vekil üzerinden: yalnızca başlık (moov) ve ilk kare için gereken aralıklar çekilir.
            retriever.setDataSource(srv.urlFor(info), new HashMap<>());
            String dur = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (dur != null) {
                try {
                    out.put("durationMs", Long.parseLong(dur));
                } catch (NumberFormatException ignored) {
                }
            }
            if (!video) return;
            int width = parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int height = parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            int rotation = parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
            if (rotation == 90 || rotation == 270) {
                int t = width;
                width = height;
                height = t;
            }
            if (width > 0 && height > 0) {
                out.put("width", width);
                out.put("height", height);
            }
            Bitmap frame;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                frame = retriever.getScaledFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 720, 720);
                if (frame == null) {
                    frame = retriever.getScaledFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 720, 720);
                }
            } else {
                frame = retriever.getFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                if (frame == null) frame = retriever.getFrameAtTime(0L);
            }
            if (frame != null) {
                Bitmap scaled = frame;
                int w = frame.getWidth();
                int h = frame.getHeight();
                if (w > 720 && h > 0) {
                    scaled = Bitmap.createScaledBitmap(frame, 720, Math.max(1, (int) ((long) h * 720 / w)), true);
                    if (scaled != frame) frame.recycle();
                }
                if (width <= 0 || height <= 0) {
                    out.put("width", scaled.getWidth());
                    out.put("height", scaled.getHeight());
                }
                ByteArrayOutputStream jpg = new ByteArrayOutputStream();
                scaled.compress(Bitmap.CompressFormat.JPEG, 78, jpg);
                scaled.recycle();
                out.put("thumbnail", "data:image/jpeg;base64," + Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP));
            }
        } finally {
            try {
                retriever.release();
            } catch (Throwable ignored) {
            }
        }
    }

    private static int parseInt(String value) {
        if (value == null) return 0;
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void probePdf(MediaStreamServer srv, MediaStreamServer.StreamInfo info, JSONObject out) throws Exception {
        File dir = new File(context.getCacheDir(), "sovra_media_tmp");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File tmp = new File(dir, info.id + ".pdf");
        try {
            try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                srv.copyTo(info, fos, null, null);
            }
            try (ParcelFileDescriptor pfd = ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY);
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
                        out.put("thumbnail", "data:image/jpeg;base64,"
                                + Base64.encodeToString(jpg.toByteArray(), Base64.NO_WRAP));
                    }
                }
            }
        } finally {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    // ── Kaydet / aç / paylaş ────────────────────────────────────────────────────────────────

    /**
     * Dosyanın tamamını parça parça çeker: `download` doğrudan İndirilenler/Sovra'ya akıtılır;
     * `open`/`share` önbellek dosyasına yazılıp mevcut açma/paylaşma akışına verilir.
     * İlerleme ve sonuç `sovra:media-save` olayıyla gelir. Dönüş: iş kimliği (hata: boş dize).
     */
    public String save(String streamId, String mode) {
        MediaStreamServer srv = server;
        MediaStreamServer.StreamInfo info = srv != null ? srv.stream(streamId) : null;
        if (info == null) return "";
        String jobId = UUID.randomUUID().toString();
        AtomicBoolean cancelled = new AtomicBoolean(false);
        saveJobs.put(jobId, cancelled);
        String effectiveMode = mode != null ? mode : "download";
        saveExecutor.execute(() -> {
            long[] lastEmit = {0L};
            MediaStreamServer.ProgressListener progress = (written, total) -> {
                long now = System.currentTimeMillis();
                if (now - lastEmit[0] < 400 && written < total) return;
                lastEmit[0] = now;
                emitSave(jobId, streamId, "progress", written, total, null);
            };
            try {
                if ("download".equals(effectiveMode)) {
                    downloadToPublic(srv, info, progress, cancelled);
                    host.toast("İndirilenler/Sovra klasörüne kaydedildi: " + sanitizeFileName(info.name));
                } else {
                    File dir = new File(context.getCacheDir(), "sovra_files");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File target = new File(dir, sanitizeFileName(info.name));
                    try (FileOutputStream fos = new FileOutputStream(target, false)) {
                        srv.copyTo(info, fos, progress, cancelled);
                    } catch (IOException e) {
                        //noinspection ResultOfMethodCallIgnored
                        target.delete();
                        throw e;
                    }
                    host.deliverCachedFile(target, sanitizeFileName(info.name), info.mimeType, effectiveMode);
                }
                emitSave(jobId, streamId, "done", info.size, info.size, null);
            } catch (Throwable t) {
                String message = cancelled.get() ? "İptal edildi."
                        : t.getMessage() != null ? t.getMessage() : "Dosya kaydedilemedi.";
                emitSave(jobId, streamId, cancelled.get() ? "cancelled" : "error", 0, info.size, message);
            } finally {
                saveJobs.remove(jobId);
            }
        });
        return jobId;
    }

    public void cancelSave(String jobId) {
        AtomicBoolean flag = jobId != null ? saveJobs.get(jobId) : null;
        if (flag != null) flag.set(true);
    }

    private void emitSave(String jobId, String streamId, String state, long written, long total, String error) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("jobId", jobId);
            detail.put("streamId", streamId);
            detail.put("state", state);
            detail.put("written", written);
            detail.put("total", total);
            if (error != null) detail.put("error", error);
            host.emit("sovra:media-save", detail);
        } catch (Exception ignored) {
        }
    }

    private void downloadToPublic(MediaStreamServer srv, MediaStreamServer.StreamInfo info,
            MediaStreamServer.ProgressListener progress, AtomicBoolean cancelled) throws IOException {
        String displayName = sanitizeFileName(info.name);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
            values.put(MediaStore.Downloads.MIME_TYPE, info.mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sovra");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            ContentResolver resolver = context.getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("İndirilenler klasörüne yazılamadı.");
            boolean ok = false;
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("İndirilenler klasörüne yazılamadı.");
                srv.copyTo(info, out, progress, cancelled);
                ok = true;
            } finally {
                if (ok) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(uri, done, null, null);
                } else {
                    try {
                        resolver.delete(uri, null, null);
                    } catch (Throwable ignored) {
                    }
                }
            }
            return;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sovra");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File dest = new File(dir, displayName);
        try (FileOutputStream out = new FileOutputStream(dest, false)) {
            srv.copyTo(info, out, progress, cancelled);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            dest.delete();
            throw e;
        }
    }

    static String sanitizeFileName(String raw) {
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
}
