package app.orkestra.mobile.mediaproxy;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Bayt aralıklarını WebView'daki JS Wire istemcisinden ister: yerel taraf `sovra:media-range`
 * olayını gönderir, JS `conversations.readMediaPreview` çağırıp sonucu
 * `SovraNative.mediaRangeResult(reqId, base64, error)` ile geri verir. Böylece eşleştirme sırrı ve
 * şifreli bağlantı yalnızca JS katmanında kalır; ana bağlantının izin listesi değişmez.
 */
public final class JsRangeBridge implements RangeFetcher {
    /** JS'e olay gönderir (uygulamada `evaluateJavascript`, UI iş parçacığında). */
    public interface Dispatcher {
        void dispatch(String detailJson);
    }

    private final Dispatcher dispatcher;
    private final long timeoutMs;
    private final AtomicLong nextId = new AtomicLong();
    private final ConcurrentHashMap<String, CompletableFuture<byte[]>> pending = new ConcurrentHashMap<>();

    public JsRangeBridge(Dispatcher dispatcher, long timeoutMs) {
        this.dispatcher = dispatcher;
        this.timeoutMs = timeoutMs;
    }

    public int pendingCount() {
        return pending.size();
    }

    @Override
    public byte[] fetch(MediaStreamServer.StreamInfo stream, long offset, int length) throws IOException {
        String reqId = "r" + nextId.incrementAndGet();
        CompletableFuture<byte[]> future = new CompletableFuture<>();
        pending.put(reqId, future);
        try {
            dispatcher.dispatch("{\"reqId\":\"" + reqId + "\",\"streamId\":\"" + stream.id
                    + "\",\"offset\":" + offset + ",\"length\":" + length + "}");
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException) throw (IOException) cause;
            throw new IOException("Medya parçası alınamadı.");
        } catch (TimeoutException e) {
            throw new IOException("Bilgisayardan zamanında yanıt gelmedi.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("İptal edildi.");
        } finally {
            pending.remove(reqId);
        }
    }

    /** JS yanıtı: `error` boş değilse istek o mesajla başarısız olur. */
    public void complete(String reqId, byte[] data, String error) {
        CompletableFuture<byte[]> future = reqId == null ? null : pending.remove(reqId);
        if (future == null) return;
        if (error != null && !error.isEmpty()) {
            future.completeExceptionally(new IOException(error));
        } else if (data == null) {
            future.completeExceptionally(new IOException("Medya parçası boş geldi."));
        } else {
            future.complete(data);
        }
    }
}
