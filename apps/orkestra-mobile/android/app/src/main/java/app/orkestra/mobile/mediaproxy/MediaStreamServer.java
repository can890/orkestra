package app.orkestra.mobile.mediaproxy;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Uygulama içi yerel medya vekili: yalnızca `127.0.0.1` üzerinde, rastgele portta, açılışa özel
 * gizli anahtar yolda olacak şekilde `GET`/`HEAD` + `Range` → `206` sunar. `<video>`, `<audio>`,
 * `<img>` ve `MediaMetadataRetriever` bu adresi okur; istenen bloklar {@link RangeFetcher} ile
 * (uygulamada JS Wire istemcisi → masaüstü `readMediaPreview`) getirilir, diskteki
 * {@link BlockCache}'e yazılır ve küçük bir ileri okuma penceresiyle önceden çekilir. Böylece
 * çok GB'lık dosyalar bile sabit bellekle oynatılır ve ileri/geri sarılabilir.
 */
public final class MediaStreamServer implements Closeable {
    public static final int DEFAULT_READ_AHEAD_BLOCKS = 4;
    public static final long DEFAULT_FETCH_TIMEOUT_MS = 45_000;
    private static final int PRIORITY_DEMAND = 0;
    private static final int PRIORITY_PREFETCH = 1;
    private static final int PRIORITY_SAVE = 2;
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int SAVE_WINDOW_BLOCKS = 3;

    /** Kayıtlı bir uzak dosya akışı. */
    public static final class StreamInfo {
        public final String id;
        public final String name;
        public final String mimeType;
        public final long size;
        public final int blockBytes;

        StreamInfo(String id, String name, String mimeType, long size, int blockBytes) {
            this.id = id;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
            this.blockBytes = blockBytes;
        }

        public long blockCount() {
            return size <= 0 ? 0 : (size + blockBytes - 1) / blockBytes;
        }

        public int blockLength(long index) {
            long start = index * (long) blockBytes;
            return (int) Math.max(0, Math.min(blockBytes, size - start));
        }
    }

    /** Kaydetme ilerlemesi (yazılan bayt). */
    public interface ProgressListener {
        void onProgress(long written, long total);
    }

    private final ServerSocket serverSocket;
    private final String token;
    private final byte[] tokenBytes;
    private final BlockCache cache;
    private final RangeFetcher fetcher;
    private final long fetchTimeoutMs;
    private final ThreadPoolExecutor connectionPool;
    private final ThreadPoolExecutor fetchPool;
    private final ConcurrentHashMap<String, StreamInfo> streams = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, FetchTask> inflight = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicInteger fetchCount = new AtomicInteger();
    private volatile int readAheadBlocks = DEFAULT_READ_AHEAD_BLOCKS;
    private volatile boolean closed = false;

    public MediaStreamServer(BlockCache cache, RangeFetcher fetcher, int fetchThreads, long fetchTimeoutMs)
            throws IOException {
        this.cache = cache;
        this.fetcher = fetcher;
        this.fetchTimeoutMs = fetchTimeoutMs;
        this.token = randomToken();
        this.tokenBytes = token.getBytes(StandardCharsets.US_ASCII);
        this.serverSocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
        this.connectionPool = new ThreadPoolExecutor(0, 32, 30, TimeUnit.SECONDS,
                new SynchronousQueue<>(), daemonFactory("sovra-media-conn"));
        int threads = Math.max(1, fetchThreads);
        this.fetchPool = new ThreadPoolExecutor(threads, threads, 30, TimeUnit.SECONDS,
                new PriorityBlockingQueue<>(), daemonFactory("sovra-media-fetch"));
        this.fetchPool.allowCoreThreadTimeOut(true);
        Thread accept = new Thread(this::acceptLoop, "sovra-media-proxy");
        accept.setDaemon(true);
        accept.start();
    }

    private static ThreadFactory daemonFactory(String name) {
        AtomicInteger n = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, name + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    private static String randomToken() {
        byte[] raw = new byte[24];
        new SecureRandom().nextBytes(raw);
        return hex(raw);
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    public int port() {
        return serverSocket.getLocalPort();
    }

    public String token() {
        return token;
    }

    public void setReadAheadBlocks(int blocks) {
        readAheadBlocks = Math.max(0, blocks);
    }

    /** Testler için: bugüne kadar getiriciye giden blok isteği sayısı. */
    public int fetchCount() {
        return fetchCount.get();
    }

    /**
     * Akışı kaydeder (aynı anahtar + boyut + blok boyutu aynı kimliği verir, önbellek paylaşılır).
     */
    public StreamInfo register(String key, String name, String mimeType, long size, int blockBytes) {
        if (size < 0) throw new IllegalArgumentException("size");
        int block = Math.max(64 * 1024, blockBytes);
        String id = streamIdFor(key + "|" + size + "|" + block);
        StreamInfo info = new StreamInfo(id, name == null ? "dosya" : name,
                mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType, size, block);
        streams.put(id, info);
        return info;
    }

    public StreamInfo stream(String id) {
        return id == null ? null : streams.get(id);
    }

    static String streamIdFor(String key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            return hex(Arrays.copyOf(digest, 12));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public String urlFor(StreamInfo info) {
        String safeName;
        try {
            safeName = URLEncoder.encode(info.name, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            safeName = "media";
        }
        return "http://127.0.0.1:" + port() + "/" + token + "/" + info.id + "/" + safeName;
    }

    @Override
    public void close() {
        closed = true;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
        }
        connectionPool.shutdownNow();
        fetchPool.shutdownNow();
    }

    // ── Blok motoru ──────────────────────────────────────────────────────────────────────────

    private final class FetchTask implements Runnable, Comparable<FetchTask> {
        final String key;
        final StreamInfo stream;
        final long index;
        final long seq = sequence.incrementAndGet();
        final CompletableFuture<byte[]> future = new CompletableFuture<>();
        volatile int priority;
        volatile boolean store;

        FetchTask(String key, StreamInfo stream, long index, int priority, boolean store) {
            this.key = key;
            this.stream = stream;
            this.index = index;
            this.priority = priority;
            this.store = store;
        }

        @Override
        public void run() {
            try {
                byte[] data = fetchBlock(stream, index);
                if (store) cache.put(stream.id, index, data);
                future.complete(data);
            } catch (Throwable t) {
                future.completeExceptionally(t);
            } finally {
                inflight.remove(key, this);
            }
        }

        @Override
        public int compareTo(FetchTask other) {
            if (priority != other.priority) return Integer.compare(priority, other.priority);
            return Long.compare(seq, other.seq);
        }
    }

    private byte[] fetchBlock(StreamInfo stream, long index) throws IOException {
        int length = stream.blockLength(index);
        long offset = index * (long) stream.blockBytes;
        fetchCount.incrementAndGet();
        byte[] data = fetcher.fetch(stream, offset, length);
        if (data == null || data.length < length) {
            throw new IOException("Dosya beklenenden kısa geldi; bilgisayarda değişmiş olabilir.");
        }
        return data.length == length ? data : Arrays.copyOf(data, length);
    }

    private CompletableFuture<byte[]> request(StreamInfo stream, long index, int priority, boolean store) {
        String key = BlockCache.key(stream.id, index);
        FetchTask existing = inflight.get(key);
        if (existing != null) {
            if (store) existing.store = true;
            if (priority < existing.priority && fetchPool.getQueue().remove(existing)) {
                existing.priority = priority;
                executeOrFail(existing);
            }
            return existing.future;
        }
        FetchTask task = new FetchTask(key, stream, index, priority, store);
        FetchTask raced = inflight.putIfAbsent(key, task);
        if (raced != null) return raced.future;
        executeOrFail(task);
        return task.future;
    }

    private void executeOrFail(FetchTask task) {
        try {
            fetchPool.execute(task);
        } catch (RejectedExecutionException e) {
            inflight.remove(task.key, task);
            task.future.completeExceptionally(new IOException("Medya vekili kapandı."));
        }
    }

    private CompletableFuture<byte[]> cachedOrRequest(StreamInfo stream, long index, int priority, boolean store) {
        byte[] cached = cache.read(stream.id, index);
        if (cached != null && cached.length == stream.blockLength(index)) {
            return CompletableFuture.completedFuture(cached);
        }
        return request(stream, index, priority, store);
    }

    private byte[] await(CompletableFuture<byte[]> future) throws IOException {
        try {
            return future.get(fetchTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException) throw (IOException) cause;
            throw new IOException(cause != null && cause.getMessage() != null
                    ? cause.getMessage() : "Medya parçası alınamadı.");
        } catch (TimeoutException e) {
            throw new IOException("Bilgisayardan zamanında yanıt gelmedi.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("İptal edildi.");
        }
    }

    /** Oynatma için bloğu getirir (önbellekte yoksa öncelikli istekle) ve önbelleğe yazar. */
    public byte[] readBlock(StreamInfo stream, long index) throws IOException {
        return await(cachedOrRequest(stream, index, PRIORITY_DEMAND, true));
    }

    /** `from`'dan itibaren en çok `count` bloğu arka planda önceden çeker. */
    public void prefetch(StreamInfo stream, long from, int count) {
        long last = Math.min(stream.blockCount(), from + count);
        for (long i = Math.max(0, from); i < last; i++) {
            if (cache.has(stream.id, i) || inflight.containsKey(BlockCache.key(stream.id, i))) continue;
            request(stream, i, PRIORITY_PREFETCH, true);
        }
    }

    /**
     * Tüm dosyayı sırayla `out`'a yazar (indirme/paylaşma/açma). Önbelleği şişirmemek için yeni
     * blokları önbelleğe yazmaz; önbellekte olanları kullanır. Bellek: en çok birkaç blok.
     */
    public void copyTo(StreamInfo stream, OutputStream out, ProgressListener progress, AtomicBoolean cancelled)
            throws IOException {
        long count = stream.blockCount();
        ArrayDeque<CompletableFuture<byte[]>> window = new ArrayDeque<>();
        long next = 0;
        long written = 0;
        for (long index = 0; index < count; index++) {
            while (next < count && next < index + SAVE_WINDOW_BLOCKS) {
                window.add(cachedOrRequest(stream, next, PRIORITY_SAVE, false));
                next++;
            }
            if (cancelled != null && cancelled.get()) throw new IOException("İptal edildi.");
            byte[] data = await(window.poll());
            out.write(data);
            written += data.length;
            if (progress != null) progress.onProgress(written, stream.size);
        }
        out.flush();
    }

    // ── HTTP ─────────────────────────────────────────────────────────────────────────────────

    private void acceptLoop() {
        while (!closed) {
            Socket socket;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (closed) return;
                continue;
            }
            try {
                connectionPool.execute(() -> handle(socket));
            } catch (RejectedExecutionException e) {
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static final class Request {
        String method;
        String path;
        final Map<String, String> headers = new HashMap<>();
    }

    private static String readLine(InputStream in, int[] budget) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) return sb.length() == 0 ? null : sb.toString();
            if (--budget[0] < 0) throw new IOException("header too large");
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
        }
        return sb.toString();
    }

    private static Request readRequest(InputStream in) throws IOException {
        int[] budget = {MAX_HEADER_BYTES};
        String line = readLine(in, budget);
        if (line == null || line.isEmpty()) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        Request req = new Request();
        req.method = parts[0].toUpperCase(Locale.ROOT);
        String target = parts[1];
        int q = target.indexOf('?');
        req.path = q >= 0 ? target.substring(0, q) : target;
        while (true) {
            String header = readLine(in, budget);
            if (header == null || header.isEmpty()) break;
            int colon = header.indexOf(':');
            if (colon <= 0) continue;
            req.headers.put(header.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                    header.substring(colon + 1).trim());
        }
        return req;
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30_000);
            s.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
            Request req = readRequest(in);
            if (req == null) {
                writeSimple(out, 400, "Bad Request", "bad request");
                return;
            }
            serve(req, out);
        } catch (IOException ignored) {
            // İstemci bağlantıyı kapattı (ör. ileri sarma) ya da getirme başarısız: bağlantıyı bırak.
        }
    }

    private boolean tokenMatches(String candidate) {
        return MessageDigest.isEqual(tokenBytes, candidate.getBytes(StandardCharsets.US_ASCII));
    }

    private void serve(Request req, OutputStream out) throws IOException {
        String[] segments = req.path.split("/");
        // "/<token>/<streamId>/<ad>" → ["", token, streamId, ad]
        if (segments.length < 3 || !tokenMatches(segments[1])) {
            writeSimple(out, 403, "Forbidden", "forbidden");
            return;
        }
        if (!"GET".equals(req.method) && !"HEAD".equals(req.method)) {
            writeSimple(out, 405, "Method Not Allowed", "method not allowed");
            return;
        }
        StreamInfo stream = streams.get(segments[2]);
        if (stream == null) {
            writeSimple(out, 404, "Not Found", "not found");
            return;
        }
        HttpRange range = HttpRange.parse(req.headers.get("range"), stream.size);
        if (range.kind == HttpRange.Kind.UNSATISFIABLE) {
            StringBuilder h = statusLine(416, "Range Not Satisfiable");
            h.append("Content-Range: bytes */").append(stream.size).append("\r\n");
            h.append("Content-Length: 0\r\n");
            finishHeaders(out, h);
            out.flush();
            return;
        }
        boolean partial = range.kind == HttpRange.Kind.PARTIAL;
        long length = stream.size == 0 ? 0 : range.length();
        boolean head = "HEAD".equals(req.method);

        // Başlıklardan önce ilk bloğu getir: hata olursa 502 ile net yanıt verilebilsin.
        byte[] first = null;
        long blockBytes = stream.blockBytes;
        long index = length > 0 ? range.start / blockBytes : 0;
        if (!head && length > 0) {
            try {
                first = readBlock(stream, index);
            } catch (IOException e) {
                writeSimple(out, 502, "Bad Gateway", e.getMessage() != null ? e.getMessage() : "fetch failed");
                return;
            }
        }

        StringBuilder h = statusLine(partial ? 206 : 200, partial ? "Partial Content" : "OK");
        h.append("Content-Type: ").append(stream.mimeType).append("\r\n");
        h.append("Accept-Ranges: bytes\r\n");
        h.append("Content-Length: ").append(length).append("\r\n");
        if (partial) {
            h.append("Content-Range: bytes ").append(range.start).append('-').append(range.end)
                    .append('/').append(stream.size).append("\r\n");
        }
        finishHeaders(out, h);
        if (head || length == 0) {
            out.flush();
            return;
        }

        long pos = range.start;
        long end = range.end;
        byte[] block = first;
        while (pos <= end) {
            if (block == null) block = readBlock(stream, index);
            prefetch(stream, index + 1, readAheadBlocks);
            int offsetInBlock = (int) (pos - index * blockBytes);
            int n = (int) Math.min(block.length - offsetInBlock, end - pos + 1);
            if (n <= 0) throw new IOException("block underflow");
            out.write(block, offsetInBlock, n);
            pos += n;
            index++;
            block = null;
        }
        out.flush();
    }

    private static StringBuilder statusLine(int code, String reason) {
        return new StringBuilder("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
    }

    private static void finishHeaders(OutputStream out, StringBuilder h) throws IOException {
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void writeSimple(OutputStream out, int code, String reason, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        StringBuilder h = statusLine(code, reason);
        h.append("Content-Type: text/plain; charset=utf-8\r\n");
        h.append("Content-Length: ").append(bytes.length).append("\r\n");
        finishHeaders(out, h);
        out.write(bytes);
        out.flush();
    }
}
