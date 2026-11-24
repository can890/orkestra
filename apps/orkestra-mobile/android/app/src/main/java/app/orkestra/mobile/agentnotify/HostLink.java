package app.orkestra.mobile.agentnotify;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Tek bir eşleşmiş bilgisayara arka plan bildirim kanalıyla (`channel: "notifications"`) bağlanan
 * en küçük yerel istemci: el sıkışma (remote-access.md §4), şifreli çerçeveler, ping/boşta kalma,
 * `agentActivity.events` aboneliği ve `agentActivity.getSnapshot` çağrısı, geri çekilmeli yeniden
 * bağlanma. Kendi iş parçacığında çalışır; sonuçları {@link Listener}'a verir (taşımadan bağımsız
 * model {@link ActivityBook} bunları işler).
 *
 * Neden JS katmanı değil: WebView yalnızca Activity yaşarken çalışır; açılışta (BOOT_COMPLETED),
 * uygulama son görevlerden kaydırılınca ya da sistem Activity'yi yok edince JS bağlantısı da ölür.
 */
public final class HostLink {
    public static final String STATUS_CONNECTING = "connecting";
    public static final String STATUS_CONNECTED = "connected";
    public static final String STATUS_OFFLINE = "offline";
    /** Bilgisayar bu özelliği desteklemiyor (eski sürüm) ya da masaüstünde yayın kapalı. */
    public static final String STATUS_UNSUPPORTED = "unsupported";
    /** Eşleşme iptal edilmiş/sır geçersiz: yeniden eşleşmeden denenmez. */
    public static final String STATUS_REVOKED = "revoked";
    public static final String STATUS_STOPPED = "stopped";

    public static final String CHANNEL = "notifications";
    public static final String EVENTS_TOPIC = "agentActivity.events";
    public static final String SNAPSHOT_PATH = "agentActivity.getSnapshot";

    private static final long PING_INTERVAL_MS = 25_000;
    private static final int IDLE_TIMEOUT_MS = 70_000;
    private static final int LAN_CONNECT_TIMEOUT_MS = 4_000;
    private static final int TUNNEL_CONNECT_TIMEOUT_MS = 12_000;
    private static final long[] BACKOFF_MS = {1_000, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000};
    private static final long UNSUPPORTED_RETRY_MS = 30 * 60_000L;

    public interface Listener {
        void onStatus(HostLink link, String status, String detail);

        /** Masaüstünün bildirdiği güncel adresler/port (kayıtlı adresleri tazelemek için). */
        void onWelcome(HostLink link, String hostName, List<String> addresses, int port);

        void onSnapshot(HostLink link, boolean publishing, String hostName, List<ActivityEntry> entries);

        void onUpsert(HostLink link, ActivityEntry entry, boolean alert);

        void onRemove(HostLink link, String conversationId, long revision);
    }

    /** Zaman kaynağı (testlerde sabitlenebilir). */
    public interface Clock {
        long now();
    }

    private final HostConfig config;
    private final Listener listener;
    private final String clientName;
    private final Clock clock;
    private final Object sleepLock = new Object();
    private volatile boolean stopped = false;
    private volatile boolean wakeRequested = false;
    private volatile MiniWebSocket socket;
    private volatile String lastGoodAddress;
    private Thread thread;

    public HostLink(HostConfig config, String clientName, Listener listener, Clock clock) {
        this.config = config;
        this.clientName = clientName;
        this.listener = listener;
        this.clock = clock == null ? System::currentTimeMillis : clock;
    }

    public HostConfig config() {
        return config;
    }

    public String hostId() {
        return config.hostId;
    }

    public synchronized void start() {
        if (thread != null) return;
        thread = new Thread(this::loop, "orkestra-agent-link-" + Math.abs(config.hostId.hashCode()));
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        stopped = true;
        MiniWebSocket current = socket;
        if (current != null) current.close(1000);
        wakeUp();
    }

    /** Ağ değişti/geri geldi: bekleme süresini atlayıp hemen dener. */
    public void wakeUp() {
        synchronized (sleepLock) {
            wakeRequested = true;
            sleepLock.notifyAll();
        }
    }

    private static final class TerminalException extends Exception {
        TerminalException(String message) {
            super(message);
        }
    }

    private static final class UnsupportedHostException extends Exception {
        UnsupportedHostException(String message) {
            super(message);
        }
    }

    private static final class RetryLaterException extends Exception {
        final long delayMs;

        RetryLaterException(long delayMs) {
            super("retry later");
            this.delayMs = delayMs;
        }
    }

    private void loop() {
        int attempt = 0;
        while (!stopped) {
            listener.onStatus(this, STATUS_CONNECTING, null);
            long delay;
            try {
                boolean established = runSession();
                if (established) attempt = 0;
                listener.onStatus(this, STATUS_OFFLINE, null);
                delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
                attempt++;
            } catch (TerminalException error) {
                listener.onStatus(this, STATUS_REVOKED, error.getMessage());
                return;
            } catch (UnsupportedHostException error) {
                listener.onStatus(this, STATUS_UNSUPPORTED, error.getMessage());
                delay = UNSUPPORTED_RETRY_MS;
            } catch (RetryLaterException error) {
                listener.onStatus(this, STATUS_OFFLINE, "rate-limited");
                delay = Math.max(error.delayMs, 5_000);
            }
            if (stopped) break;
            sleep(delay);
        }
        listener.onStatus(this, STATUS_STOPPED, null);
    }

    private void sleep(long ms) {
        synchronized (sleepLock) {
            long until = clock.now() + ms;
            while (!stopped && !wakeRequested) {
                long left = until - clock.now();
                if (left <= 0) break;
                try {
                    sleepLock.wait(left);
                } catch (InterruptedException ignored) {
                    return;
                }
            }
            wakeRequested = false;
        }
    }

    private List<String> orderedAddresses() {
        List<String> out = new ArrayList<>();
        if (lastGoodAddress != null) out.add(lastGoodAddress);
        for (String address : config.addresses) {
            if (!out.contains(address)) out.add(address);
        }
        return out;
    }

    /** Bir bağlantı turu; oturum kurulup sonra koptuysa {@code true}. */
    private boolean runSession() throws TerminalException, UnsupportedHostException, RetryLaterException {
        for (String address : orderedAddresses()) {
            if (stopped) return false;
            boolean tunnel = address.startsWith("wss://");
            MiniWebSocket ws;
            try {
                ws = MiniWebSocket.connect(
                        HostConfig.urlFor(address, config.port),
                        tunnel ? TUNNEL_CONNECT_TIMEOUT_MS : LAN_CONNECT_TIMEOUT_MS);
            } catch (IOException | RuntimeException error) {
                continue;
            }
            socket = ws;
            Session session;
            try {
                session = handshake(ws);
            } catch (MiniWebSocket.ClosedException closed) {
                ws.close(1000);
                handleCloseCode(closed.code);
                continue;
            } catch (TerminalException | RetryLaterException error) {
                ws.close(1000);
                throw error;
            } catch (IOException | GeneralSecurityException | JSONException error) {
                ws.close(1000);
                continue;
            }
            lastGoodAddress = address;
            try {
                session.run();
            } catch (MiniWebSocket.ClosedException closed) {
                handleCloseCode(closed.code);
            } catch (SocketTimeoutException idle) {
                // Boşta kalma: karşı taraf 70 sn sessiz; yeniden bağlan.
            } catch (IOException | GeneralSecurityException | JSONException error) {
                // Bağlantı koptu ya da bozuk çerçeve.
            } finally {
                session.dispose();
                ws.close(1000);
                socket = null;
            }
            return true;
        }
        return false;
    }

    private static void handleCloseCode(int code) throws TerminalException, RetryLaterException {
        if (code == 4401) throw new TerminalException("auth-failed");
        if (code == 4403) throw new TerminalException("revoked");
        if (code == 4429) throw new RetryLaterException(30_000);
    }

    /** Düz metin hata çerçevesi (`{"t":"error",...}`) → uygun istisna. */
    private static void throwForErrorFrame(JSONObject frame)
            throws TerminalException, RetryLaterException, IOException {
        String code = frame.optString("code", "");
        if ("AUTH_FAILED".equals(code)) throw new TerminalException("auth-failed");
        if ("RATE_LIMITED".equals(code)) throw new RetryLaterException(frame.optLong("retryAfterMs", 30_000));
        throw new IOException("server error " + code);
    }

    private Session handshake(MiniWebSocket ws)
            throws IOException, GeneralSecurityException, JSONException, TerminalException,
                    RetryLaterException {
        byte[] clientNonce = RemoteCrypto.randomBytes(RemoteCrypto.NONCE_BYTES);
        JSONObject hello = new JSONObject()
                .put("t", "hello")
                .put("v", 1)
                .put("deviceId", config.deviceId)
                .put("clientNonce", RemoteCrypto.base64UrlEncode(clientNonce));
        ws.sendText(hello.toString());

        MiniWebSocket.Message challengeMessage = ws.read();
        if (!challengeMessage.text) throw new IOException("expected challenge");
        JSONObject challenge = new JSONObject(challengeMessage.asText());
        if ("error".equals(challenge.optString("t"))) throwForErrorFrame(challenge);
        if (!"challenge".equals(challenge.optString("t"))) throw new IOException("bad challenge");
        byte[] serverNonce = RemoteCrypto.base64UrlDecode(challenge.optString("serverNonce", ""));
        if (serverNonce == null || serverNonce.length != RemoteCrypto.NONCE_BYTES) {
            throw new IOException("bad server nonce");
        }

        RemoteCrypto.ClientKeys keys = RemoteCrypto.deriveClientKeys(config.secret, clientNonce, serverNonce);
        RemoteCrypto.Sealer sealer = new RemoteCrypto.Sealer(keys.send, RemoteCrypto.DIRECTION_C2S);
        RemoteCrypto.Opener opener = new RemoteCrypto.Opener(keys.receive, RemoteCrypto.DIRECTION_S2C);
        JSONObject auth = new JSONObject()
                .put("t", "auth")
                .put("v", 1)
                .put("deviceId", config.deviceId)
                .put("clientName", clientName)
                .put("platform", "android")
                .put("channel", CHANNEL);
        ws.sendBinary(sealer.seal(auth.toString().getBytes(StandardCharsets.UTF_8)));

        MiniWebSocket.Message welcomeMessage = ws.read();
        if (welcomeMessage.text) {
            throwForErrorFrame(new JSONObject(welcomeMessage.asText()));
        }
        JSONObject welcome;
        try {
            welcome = new JSONObject(new String(opener.open(welcomeMessage.data), StandardCharsets.UTF_8));
        } catch (GeneralSecurityException error) {
            // Sunucu sırrı kanıtlayamadı: güvenilmez, bu adresten vazgeç.
            throw new IOException("server could not prove the secret");
        }
        if (!"welcome".equals(welcome.optString("t"))) throw new IOException("bad welcome");
        return new Session(ws, sealer, opener, welcome);
    }

    /** Kurulmuş, kimliği doğrulanmış tek oturum. */
    private final class Session {
        private final MiniWebSocket ws;
        private final RemoteCrypto.Sealer sealer;
        private final RemoteCrypto.Opener opener;
        private final JSONObject welcome;
        private final ScheduledExecutorService pinger = Executors.newSingleThreadScheduledExecutor();
        private ScheduledFuture<?> pingTask;
        private int nextId = 1;
        private String attachId;
        private String snapshotId;
        private long snapshotRevision = -1;
        private final List<JSONObject> buffered = new ArrayList<>();

        Session(MiniWebSocket ws, RemoteCrypto.Sealer sealer, RemoteCrypto.Opener opener, JSONObject welcome) {
            this.ws = ws;
            this.sealer = sealer;
            this.opener = opener;
            this.welcome = welcome;
        }

        void run() throws IOException, GeneralSecurityException, JSONException, UnsupportedHostException {
            // Kanalı tanımayan eski masaüstü `channel`'ı yansıtmaz: bu bağlantı ana oturumun yerine
            // geçmiştir, hemen bırak (telefondaki uygulama oturumunu düşürmemek için).
            if (!CHANNEL.equals(welcome.optString("channel", ""))) {
                ws.close(1000);
                throw new UnsupportedHostException("channel-unsupported");
            }
            List<String> addresses = new ArrayList<>();
            JSONArray rawAddresses = welcome.optJSONArray("addresses");
            if (rawAddresses != null) {
                for (int i = 0; i < rawAddresses.length() && i < 6; i++) {
                    String value = rawAddresses.optString(i, "");
                    if (!value.isEmpty()) addresses.add(value);
                }
            }
            listener.onWelcome(HostLink.this, welcome.optString("hostName", config.hostName), addresses,
                    welcome.optInt("port", config.port));
            listener.onStatus(HostLink.this, STATUS_CONNECTED, null);

            ws.setReadTimeout(IDLE_TIMEOUT_MS);
            pingTask = pinger.scheduleWithFixedDelay(() -> {
                try {
                    sendEnvelope(new JSONObject().put("t", "ping"));
                } catch (IOException | GeneralSecurityException | JSONException ignored) {
                    ws.close(1000);
                }
            }, PING_INTERVAL_MS, PING_INTERVAL_MS, TimeUnit.MILLISECONDS);

            attachId = nextRequestId();
            sendWire(new JSONObject().put("kind", "attach").put("id", attachId).put("topic", EVENTS_TOPIC));
            requestSnapshot();

            while (!stopped) {
                MiniWebSocket.Message message = ws.read();
                if (message.text) throw new IOException("unexpected text frame");
                JSONObject envelope = new JSONObject(new String(opener.open(message.data), StandardCharsets.UTF_8));
                String type = envelope.optString("t");
                if ("ping".equals(type)) {
                    sendEnvelope(new JSONObject().put("t", "pong"));
                } else if ("wire".equals(type)) {
                    handleWire(envelope.getJSONObject("m"));
                }
            }
        }

        private String nextRequestId() {
            return "n" + (nextId++);
        }

        private void requestSnapshot() throws IOException, GeneralSecurityException, JSONException {
            snapshotId = nextRequestId();
            snapshotRevision = -1;
            // `z.void()` girdisi: `input` alanı gönderilmez (JS istemcisi `undefined` gönderir).
            sendWire(new JSONObject().put("kind", "call").put("id", snapshotId).put("path", SNAPSHOT_PATH));
        }

        private void handleWire(JSONObject message)
                throws IOException, GeneralSecurityException, JSONException, UnsupportedHostException {
            String kind = message.optString("kind");
            switch (kind) {
                case "result": {
                    String id = message.optString("id");
                    boolean ok = message.optBoolean("ok", false);
                    if (id.equals(attachId) && !ok) {
                        throw new UnsupportedHostException(message.optString("code", "attach-failed"));
                    }
                    if (id.equals(snapshotId)) {
                        if (!ok) throw new UnsupportedHostException(message.optString("code", "snapshot-failed"));
                        applySnapshot(message.optJSONObject("value"));
                    }
                    break;
                }
                case "update": {
                    if (!EVENTS_TOPIC.equals(message.optString("topic"))) break;
                    JSONObject update = message.optJSONObject("update");
                    JSONObject delta = update == null ? null : update.optJSONObject("delta");
                    JSONObject event = delta == null ? null : delta.optJSONObject("event");
                    if (event == null) break;
                    if (snapshotRevision < 0) {
                        // Snapshot gelmeden önceki olaylar sıraya alınır; snapshot'tan yeniyse uygulanır.
                        if (buffered.size() < 256) buffered.add(event);
                    } else {
                        handleEvent(event);
                    }
                    break;
                }
                case "topic-gap":
                    requestSnapshot();
                    break;
                case "topic-error":
                    if (!message.optBoolean("retrying", false)) throw new IOException("topic failed");
                    break;
                default:
                    break;
            }
        }

        private void applySnapshot(JSONObject value) throws IOException, GeneralSecurityException, JSONException {
            if (value == null) throw new JSONException("missing snapshot");
            long hostNow = value.optLong("now", clock.now());
            long phoneNow = clock.now();
            boolean publishing = value.optBoolean("publishing", true);
            List<ActivityEntry> entries = new ArrayList<>();
            JSONArray rawEntries = value.optJSONArray("entries");
            if (rawEntries != null) {
                for (int i = 0; i < rawEntries.length(); i++) {
                    ActivityEntry entry = parseEntry(rawEntries.optJSONObject(i), hostNow, phoneNow);
                    if (entry != null) entries.add(entry);
                }
            }
            snapshotRevision = value.optLong("revision", 0);
            listener.onSnapshot(HostLink.this, publishing, value.optString("hostName", config.hostName), entries);
            List<JSONObject> pending = new ArrayList<>(buffered);
            buffered.clear();
            for (JSONObject event : pending) handleEvent(event);
        }

        private void handleEvent(JSONObject event) throws IOException, GeneralSecurityException, JSONException {
            String type = event.optString("type");
            long hostNow = event.optLong("now", clock.now());
            switch (type) {
                case "upsert": {
                    ActivityEntry entry = parseEntry(event.optJSONObject("entry"), hostNow, clock.now());
                    if (entry == null || entry.revision <= snapshotRevision) return;
                    listener.onUpsert(HostLink.this, entry, event.optBoolean("alert", false));
                    break;
                }
                case "remove": {
                    long revision = event.optLong("revision", 0);
                    if (revision <= snapshotRevision) return;
                    listener.onRemove(HostLink.this, event.optString("conversationId"), revision);
                    break;
                }
                case "publishing":
                    // Masaüstü ayarı değişti: listeyi baştan al.
                    requestSnapshot();
                    break;
                default:
                    break;
            }
        }

        private ActivityEntry parseEntry(JSONObject raw, long hostNow, long phoneNow) {
            if (raw == null) return null;
            String conversationId = raw.optString("conversationId", "");
            String state = raw.optString("state", "");
            if (conversationId.isEmpty() || !ActivityEntry.isKnownState(state)) return null;
            long stateChangedAt = raw.optLong("stateChangedAt", hostNow);
            long age = Math.max(0, hostNow - stateChangedAt);
            return new ActivityEntry(
                    config.hostId,
                    config.hostName,
                    conversationId,
                    state,
                    clip(raw.optString("title", ""), 120),
                    clip(raw.optString("projectName", ""), 120),
                    clip(raw.optString("providerName", ""), 64),
                    clip(raw.optString("preview", ""), 240),
                    stateChangedAt,
                    phoneNow - age,
                    raw.optLong("revision", 0));
        }

        private void sendWire(JSONObject message) throws IOException, GeneralSecurityException, JSONException {
            sendEnvelope(new JSONObject().put("t", "wire").put("m", message));
        }

        private void sendEnvelope(JSONObject envelope) throws IOException, GeneralSecurityException, JSONException {
            // Sayaç atama ve gönderim aynı kilit altında: çerçeveler sayaç sırasıyla gider.
            synchronized (this) {
                ws.sendBinary(sealer.seal(envelope.toString().getBytes(StandardCharsets.UTF_8)));
            }
        }

        void dispose() {
            if (pingTask != null) pingTask.cancel(false);
            pinger.shutdownNow();
        }
    }

    static String clip(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, Math.max(0, max - 1)) + "…";
    }
}
