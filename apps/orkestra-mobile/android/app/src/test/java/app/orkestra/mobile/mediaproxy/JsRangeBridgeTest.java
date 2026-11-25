package app.orkestra.mobile.mediaproxy;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONObject;
import org.junit.Test;

/** Yerel ↔ JS aralık köprüsü: istek olayı, yanıt eşleme, hata ve zaman aşımı. */
public class JsRangeBridgeTest {
    private static MediaStreamServer.StreamInfo stream() throws Exception {
        MediaStreamServer server = new MediaStreamServer(
                new BlockCache(Files.createTempDirectory("sovra-js").toFile(), 1024), (s, o, l) -> new byte[0], 1, 1000);
        MediaStreamServer.StreamInfo info = server.register("k", "a.mp4", "video/mp4", 10_000, 1024);
        server.close();
        return info;
    }

    @Test
    public void dispatchesRequestAndReturnsJsBytes() throws Exception {
        List<String> sent = new CopyOnWriteArrayList<>();
        JsRangeBridge[] holder = new JsRangeBridge[1];
        holder[0] = new JsRangeBridge(detail -> {
            sent.add(detail);
            new Thread(() -> {
                try {
                    JSONObject json = new JSONObject(detail);
                    holder[0].complete(json.getString("reqId"), new byte[] {1, 2, 3}, null);
                } catch (Exception ignored) {
                }
            }).start();
        }, 2_000);
        MediaStreamServer.StreamInfo info = stream();
        assertArrayEquals(new byte[] {1, 2, 3}, holder[0].fetch(info, 4096, 3));
        JSONObject req = new JSONObject(sent.get(0));
        assertEquals(info.id, req.getString("streamId"));
        assertEquals(4096L, req.getLong("offset"));
        assertEquals(3, req.getInt("length"));
        assertEquals(0, holder[0].pendingCount());
    }

    @Test
    public void jsErrorBecomesIOExceptionWithMessage() throws Exception {
        JsRangeBridge[] holder = new JsRangeBridge[1];
        holder[0] = new JsRangeBridge(detail -> {
            try {
                holder[0].complete(new JSONObject(detail).getString("reqId"), null, "Masaüstünü güncelleyin.");
            } catch (Exception ignored) {
            }
        }, 2_000);
        try {
            holder[0].fetch(stream(), 0, 10);
            fail("expected IOException");
        } catch (IOException e) {
            assertEquals("Masaüstünü güncelleyin.", e.getMessage());
        }
    }

    @Test
    public void timesOutWhenJsNeverAnswers() throws Exception {
        JsRangeBridge bridge = new JsRangeBridge(detail -> {}, 100);
        long started = System.currentTimeMillis();
        try {
            bridge.fetch(stream(), 0, 10);
            fail("expected IOException");
        } catch (IOException e) {
            assertTrue(System.currentTimeMillis() - started < 2_000);
        }
        assertEquals(0, bridge.pendingCount());
        // Geç gelen yanıt yok sayılır.
        bridge.complete("r1", new byte[] {1}, null);
    }
}
