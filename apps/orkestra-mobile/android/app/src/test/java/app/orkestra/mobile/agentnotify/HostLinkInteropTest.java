package app.orkestra.mobile.agentnotify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Diller arası uçtan uca test: bu Java istemcisi GERÇEK masaüstü uzak erişim sunucusuna (TypeScript,
 * `RemoteAccessService` + `AgentActivityFeed`) bağlanır. Sunucuyu masaüstü tarafındaki
 * `agent-activity-android-interop.test.ts` başlatır ve bu testi
 * `ORKESTRA_INTEROP_CONFIG` ortam değişkeniyle çalıştırır; değişken yoksa test atlanır.
 */
public class HostLinkInteropTest {
    @Test
    public void connectsOverTheNotificationsChannelAndReceivesActivity() throws Exception {
        String raw = System.getenv("ORKESTRA_INTEROP_CONFIG");
        assumeTrue("interop server not configured", raw != null && !raw.isEmpty());
        JSONObject config = new JSONObject(raw);
        HostConfig host = new HostConfig(
                config.getString("hostId"),
                "Interop",
                Collections.singletonList(config.getString("address")),
                config.getInt("port"),
                config.getString("deviceId"),
                RemoteCrypto.base64UrlDecode(config.getString("secret")));
        assertTrue(host.isValid());

        List<String> statuses = new CopyOnWriteArrayList<>();
        List<ActivityEntry> snapshot = new CopyOnWriteArrayList<>();
        List<ActivityEntry> upserts = new CopyOnWriteArrayList<>();
        List<Boolean> alerts = new CopyOnWriteArrayList<>();
        CountDownLatch gotSnapshot = new CountDownLatch(1);
        CountDownLatch gotAlert = new CountDownLatch(1);
        HostLink link = new HostLink(host, "JUnit interop", new HostLink.Listener() {
            @Override
            public void onStatus(HostLink l, String status, String detail) {
                statuses.add(status + (detail == null ? "" : ":" + detail));
            }

            @Override
            public void onWelcome(HostLink l, String hostName, List<String> addresses, int port) {}

            @Override
            public void onSnapshot(HostLink l, boolean publishing, String hostName, List<ActivityEntry> entries) {
                snapshot.addAll(entries);
                gotSnapshot.countDown();
            }

            @Override
            public void onUpsert(HostLink l, ActivityEntry entry, boolean alert) {
                upserts.add(entry);
                alerts.add(alert);
                if (alert && ActivityEntry.FINISHED.equals(entry.state)) gotAlert.countDown();
            }

            @Override
            public void onRemove(HostLink l, String conversationId, long revision) {}
        }, null);
        link.start();
        try {
            assertTrue("snapshot not received; statuses=" + statuses, gotSnapshot.await(30, TimeUnit.SECONDS));
            assertTrue(statuses.contains(HostLink.STATUS_CONNECTED));
            boolean seeded = false;
            for (ActivityEntry entry : snapshot) {
                if ("seed-conversation".equals(entry.conversationId)) {
                    seeded = true;
                    assertEquals(ActivityEntry.WORKING, entry.state);
                    assertEquals("Chat seed-conversation", entry.title);
                }
            }
            assertTrue("seeded entry missing from snapshot", seeded);
            assertTrue("finished alert not received; upserts=" + upserts.size(), gotAlert.await(30, TimeUnit.SECONDS));
        } finally {
            link.stop();
        }
        List<String> states = new ArrayList<>();
        for (ActivityEntry entry : upserts) states.add(entry.state);
        assertTrue(states.contains(ActivityEntry.FINISHED));
    }
}
