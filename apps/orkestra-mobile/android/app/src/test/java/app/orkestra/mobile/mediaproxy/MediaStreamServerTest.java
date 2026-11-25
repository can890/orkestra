package app.orkestra.mobile.mediaproxy;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Test;

/**
 * Yerel medya vekili uçtan uca: gerçek soket üzerinden HTTP `Range` → `206`/`200`/`416`, gizli
 * anahtar denetimi, getirme hatasında `502`, blok önbelleği, ileri okuma ve tam dosya kopyalama.
 * Dosya içeriği konuma bağlı üretilir; çok GB'lık "dosya" bellekte hiç oluşturulmaz.
 */
public class MediaStreamServerTest {
    private static final int BLOCK = 64 * 1024;

    private static byte at(long pos) {
        return (byte) (pos * 31 + 7);
    }

    private static byte[] expected(long start, int length) {
        byte[] out = new byte[length];
        for (int i = 0; i < length; i++) out[i] = at(start + i);
        return out;
    }

    /** Konuma bağlı bayt üreten sahte getirici; çağrıları kaydeder. */
    private static final class FakeFetcher implements RangeFetcher {
        final List<Long> offsets = Collections.synchronizedList(new ArrayList<>());
        volatile String failWith = null;
        volatile CountDownLatch gate = null;

        @Override
        public byte[] fetch(MediaStreamServer.StreamInfo stream, long offset, int length) throws IOException {
            offsets.add(offset);
            CountDownLatch g = gate;
            if (g != null) {
                try {
                    g.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    throw new IOException("interrupted");
                }
            }
            if (failWith != null) throw new IOException(failWith);
            int n = (int) Math.max(0, Math.min(length, stream.size - offset));
            return expected(offset, n);
        }
    }

    private static final class Response {
        int status;
        final Map<String, String> headers = new HashMap<>();
        byte[] body;
    }

    private final List<MediaStreamServer> servers = new ArrayList<>();

    @After
    public void tearDown() {
        for (MediaStreamServer s : servers) s.close();
    }

    private MediaStreamServer newServer(FakeFetcher fetcher, long cacheBytes) throws Exception {
        File dir = Files.createTempDirectory("sovra-proxy").toFile();
        MediaStreamServer server = new MediaStreamServer(new BlockCache(dir, cacheBytes), fetcher, 3, 5_000);
        server.setReadAheadBlocks(0);
        servers.add(server);
        return server;
    }

    private static String pathOf(String url) {
        int idx = url.indexOf('/', "http://".length());
        return url.substring(idx);
    }

    private static Response request(MediaStreamServer server, String method, String path, String range)
            throws IOException {
        try (Socket socket = new Socket("127.0.0.1", server.port())) {
            socket.setSoTimeout(10_000);
            OutputStream out = socket.getOutputStream();
            StringBuilder req = new StringBuilder(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            req.append("Host: 127.0.0.1\r\n");
            if (range != null) req.append("Range: ").append(range).append("\r\n");
            req.append("\r\n");
            out.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            out.flush();
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) all.write(buf, 0, n);
            byte[] raw = all.toByteArray();
            int split = -1;
            for (int i = 0; i + 3 < raw.length; i++) {
                if (raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' && raw[i + 3] == '\n') {
                    split = i;
                    break;
                }
            }
            assertTrue("no header terminator", split > 0);
            String[] lines = new String(raw, 0, split, StandardCharsets.UTF_8).split("\r\n");
            Response res = new Response();
            res.status = Integer.parseInt(lines[0].split(" ")[1]);
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                res.headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            res.body = java.util.Arrays.copyOfRange(raw, split + 4, raw.length);
            return res;
        }
    }

    @Test
    public void servesPartialContentAcrossBlockBoundaries() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "film.mp4", "video/mp4", 5L * BLOCK + 123, BLOCK);
        String path = pathOf(server.urlFor(info));

        long start = BLOCK - 10;
        Response res = request(server, "GET", path, "bytes=" + start + "-" + (start + 2 * BLOCK + 19));
        assertEquals(206, res.status);
        assertEquals("video/mp4", res.headers.get("content-type"));
        assertEquals("bytes", res.headers.get("accept-ranges"));
        assertEquals(String.valueOf(2 * BLOCK + 20), res.headers.get("content-length"));
        assertEquals("bytes " + start + "-" + (start + 2 * BLOCK + 19) + "/" + info.size, res.headers.get("content-range"));
        assertArrayEquals(expected(start, 2 * BLOCK + 20), res.body);
        // Yalnızca 0, 1, 2 ve 3. bloklar istendi.
        assertEquals(4, fetcher.offsets.size());
    }

    @Test
    public void servesFullBodyWithoutRangeAndTailBlock() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        long size = 2L * BLOCK + 5;
        MediaStreamServer.StreamInfo info = server.register("k", "ses.mp3", "audio/mpeg", size, BLOCK);
        Response res = request(server, "GET", pathOf(server.urlFor(info)), null);
        assertEquals(200, res.status);
        assertEquals(String.valueOf(size), res.headers.get("content-length"));
        assertArrayEquals(expected(0, (int) size), res.body);
    }

    @Test
    public void unsatisfiableRangeReturns416() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 1000, BLOCK);
        Response res = request(server, "GET", pathOf(server.urlFor(info)), "bytes=1000-");
        assertEquals(416, res.status);
        assertEquals("bytes */1000", res.headers.get("content-range"));
        assertTrue(fetcher.offsets.isEmpty());
    }

    @Test
    public void rejectsWrongTokenUnknownStreamAndOtherMethods() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 1000, BLOCK);
        String good = pathOf(server.urlFor(info));
        String badToken = good.replace(server.token(), server.token().substring(1) + "0");
        assertEquals(403, request(server, "GET", badToken, null).status);
        assertEquals(403, request(server, "GET", "/" + info.id, null).status);
        assertEquals(404, request(server, "GET", "/" + server.token() + "/ffffffff/a.mp4", null).status);
        assertEquals(405, request(server, "POST", good, null).status);
        assertTrue(fetcher.offsets.isEmpty());
    }

    @Test
    public void headReturnsHeadersWithoutFetching() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 1000, BLOCK);
        Response res = request(server, "HEAD", pathOf(server.urlFor(info)), "bytes=0-99");
        assertEquals(206, res.status);
        assertEquals("100", res.headers.get("content-length"));
        assertEquals(0, res.body.length);
        assertTrue(fetcher.offsets.isEmpty());
    }

    @Test
    public void fetchFailureBeforeHeadersReturns502WithMessage() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        fetcher.failWith = "Masaüstü uygulaması güncel değil.";
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 1000, BLOCK);
        Response res = request(server, "GET", pathOf(server.urlFor(info)), "bytes=0-");
        assertEquals(502, res.status);
        assertEquals("Masaüstü uygulaması güncel değil.", new String(res.body, StandardCharsets.UTF_8));
    }

    @Test
    public void seeksDeepIntoMultiGigabyteFileFetchingOnlyNeededBlock() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        long size = 6L * 1024 * 1024 * 1024;
        MediaStreamServer.StreamInfo info = server.register("k", "render.mov", "video/quicktime", size, BLOCK);
        long start = 5_000_000_000L;
        Response res = request(server, "GET", pathOf(server.urlFor(info)), "bytes=" + start + "-" + (start + 99));
        assertEquals(206, res.status);
        assertArrayEquals(expected(start, 100), res.body);
        assertEquals(1, fetcher.offsets.size());
        assertEquals((start / BLOCK) * BLOCK, (long) fetcher.offsets.get(0));
        // Dosyanın son baytı (sonek aralığı).
        Response tail = request(server, "GET", pathOf(server.urlFor(info)), "bytes=-1");
        assertEquals("bytes " + (size - 1) + "-" + (size - 1) + "/" + size, tail.headers.get("content-range"));
        assertArrayEquals(expected(size - 1, 1), tail.body);
    }

    @Test
    public void cachedBlocksAreNotFetchedAgain() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 3L * BLOCK, BLOCK);
        String path = pathOf(server.urlFor(info));
        request(server, "GET", path, "bytes=0-99");
        request(server, "GET", path, "bytes=100-199");
        assertEquals(1, fetcher.offsets.size());
        // Aynı anahtarla yeniden kayıt aynı kimliği ve önbelleği kullanır.
        assertEquals(info.id, server.register("k", "a.mp4", "video/mp4", 3L * BLOCK, BLOCK).id);
    }

    @Test
    public void evictedBlocksAreRefetchedWithinBudget() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 2L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 3L * BLOCK, BLOCK);
        String path = pathOf(server.urlFor(info));
        Response all = request(server, "GET", path, "bytes=0-");
        assertArrayEquals(expected(0, 3 * BLOCK), all.body);
        assertEquals(3, fetcher.offsets.size());
        // Blok 0 tahliye edildi (bütçe 2 blok) → yeniden getirilir.
        request(server, "GET", path, "bytes=0-9");
        assertEquals(4, fetcher.offsets.size());
    }

    @Test
    public void readAheadPrefetchesFollowingBlocks() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        server.setReadAheadBlocks(2);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 10L * BLOCK, BLOCK);
        request(server, "GET", pathOf(server.urlFor(info)), "bytes=0-9");
        long deadline = System.currentTimeMillis() + 5_000;
        while (fetcher.offsets.size() < 3 && System.currentTimeMillis() < deadline) Thread.sleep(10);
        assertTrue(fetcher.offsets.contains((long) BLOCK));
        assertTrue(fetcher.offsets.contains(2L * BLOCK));
        assertFalse(fetcher.offsets.contains(3L * BLOCK));
    }

    @Test
    public void concurrentRequestsForSameBlockFetchOnce() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        CountDownLatch gate = new CountDownLatch(1);
        fetcher.gate = gate;
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 2L * BLOCK, BLOCK);
        String path = pathOf(server.urlFor(info));
        Response[] results = new Response[2];
        Thread a = new Thread(() -> {
            try {
                results[0] = request(server, "GET", path, "bytes=0-9");
            } catch (IOException ignored) {
            }
        });
        Thread b = new Thread(() -> {
            try {
                results[1] = request(server, "GET", path, "bytes=10-19");
            } catch (IOException ignored) {
            }
        });
        a.start();
        b.start();
        Thread.sleep(200);
        gate.countDown();
        a.join(5_000);
        b.join(5_000);
        assertArrayEquals(expected(0, 10), results[0].body);
        assertArrayEquals(expected(10, 10), results[1].body);
        assertEquals(1, fetcher.offsets.size());
    }

    @Test
    public void copyToStreamsWholeFileWithoutFillingCache() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        File dir = Files.createTempDirectory("sovra-proxy").toFile();
        BlockCache cache = new BlockCache(dir, 64L * BLOCK);
        MediaStreamServer server = new MediaStreamServer(cache, fetcher, 3, 5_000);
        servers.add(server);
        long size = 4L * BLOCK + 77;
        MediaStreamServer.StreamInfo info = server.register("k", "a.pdf", "application/pdf", size, BLOCK);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        long[] last = {0};
        server.copyTo(info, out, (written, total) -> last[0] = written, new AtomicBoolean(false));
        assertArrayEquals(expected(0, (int) size), out.toByteArray());
        assertEquals(size, last[0]);
        assertEquals(0, cache.blockCount());
    }

    @Test(expected = IOException.class)
    public void copyToHonoursCancellation() throws Exception {
        FakeFetcher fetcher = new FakeFetcher();
        MediaStreamServer server = newServer(fetcher, 64L * BLOCK);
        MediaStreamServer.StreamInfo info = server.register("k", "a.pdf", "application/pdf", 4L * BLOCK, BLOCK);
        server.copyTo(info, new ByteArrayOutputStream(), null, new AtomicBoolean(true));
    }

    @Test
    public void shortFetchIsReportedAsError() throws Exception {
        RangeFetcher shortFetcher = (stream, offset, length) -> new byte[Math.max(0, length - 1)];
        File dir = Files.createTempDirectory("sovra-proxy").toFile();
        MediaStreamServer server = new MediaStreamServer(new BlockCache(dir, 64L * BLOCK), shortFetcher, 1, 5_000);
        servers.add(server);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 1000, BLOCK);
        assertEquals(502, request(server, "GET", pathOf(server.urlFor(info)), "bytes=0-").status);
    }
}
