package app.orkestra.mobile.agentnotify;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import app.orkestra.mobile.MainActivity;
import app.orkestra.mobile.R;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Arka plan ajan bildirimleri için ön plan servisi (Android 14+: `specialUse`). Etkinken her
 * eşleşmiş bilgisayara bir {@link HostLink} açar, ajan etkinliğini {@link ActivityBook}'ta toplar,
 * geçişlerde uyarı bildirimi ve "çalışan ajanlar" kartını gösterir. Bulut/push yoktur: bağlantı
 * doğrudan bilgisayara (LAN / Tailscale / wss tünel) gider.
 */
public final class AgentActivityService extends Service implements HostLink.Listener {
    public static final String ACTION_RELOAD = "app.orkestra.mobile.agentnotify.RELOAD";
    public static final String ACTION_STOP = "app.orkestra.mobile.agentnotify.STOP";
    public static final String ACTION_HIDE_CARD = "app.orkestra.mobile.agentnotify.HIDE_CARD";
    public static final String ACTION_OPEN_CONVERSATION = "app.orkestra.mobile.OPEN_CONVERSATION";
    public static final String EXTRA_HOST_ID = "orkestra.hostId";
    public static final String EXTRA_CONVERSATION_ID = "orkestra.conversationId";
    static final int ONGOING_ID = 4310;
    private static final long PRUNE_INTERVAL_MS = 60_000;
    private static final String CLIENT_NAME = "Android (arka plan bildirimleri)";

    /** Bilgisayar başına bağlantı durumu (köprü bunu ayarlar ekranına verir). */
    static final Map<String, String> HOST_STATUS = new ConcurrentHashMap<>();
    static volatile boolean running = false;
    /** Uygulama ön planda mı ve hangi sohbet açık (MainActivity / JS köprüsü yazar). */
    static volatile boolean appVisible = false;
    static volatile String visibleHostId = null;
    static volatile String visibleConversationId = null;

    private final ActivityBook book = new ActivityBook();
    private final Map<String, HostLink> links = new HashMap<>();
    private Handler main;
    private AgentNotifyStore store;
    private NotifyPrefs prefs = NotifyPrefs.defaults();
    private boolean inForeground = false;
    private String dismissedSignature = "";
    private String lastPostedKey = "";
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Runnable pruneTick = new Runnable() {
        @Override
        public void run() {
            if (book.prune(System.currentTimeMillis())) updateOngoing();
            main.postDelayed(this, PRUNE_INTERVAL_MS);
        }
    };

    public static void reload(Context context) {
        Intent intent = new Intent(context, AgentActivityService.class).setAction(ACTION_RELOAD);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        if (!running) return;
        context.startService(new Intent(context, AgentActivityService.class).setAction(ACTION_STOP));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        main = new Handler(Looper.getMainLooper());
        store = new AgentNotifyStore(this);
        dismissedSignature = store.loadDismissedSignature();
        AgentNotifyChannels.ensure(this);
        registerNetworkCallback();
        main.postDelayed(pruneTick, PRUNE_INTERVAL_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (!inForeground && !enterForeground()) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (ACTION_HIDE_CARD.equals(action)) {
            dismissedSignature = book.summary(System.currentTimeMillis()).signature;
            store.saveDismissedSignature(dismissedSignature);
            lastPostedKey = "";
            updateOngoing();
            return START_STICKY;
        }
        reloadConfiguration();
        return START_STICKY;
    }

    private boolean enterForeground() {
        Notification notification = buildServiceNotification(0, 0);
        try {
            // Android 14+ tür bildirmek zorunlu; daha eski sürümlerde manifestteki tür kullanılır.
            int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
            if (type != 0) {
                ServiceCompat.startForeground(this, ONGOING_ID, notification, type);
            } else {
                startForeground(ONGOING_ID, notification);
            }
            inForeground = true;
            running = true;
            return true;
        } catch (RuntimeException error) {
            // ForegroundServiceStartNotAllowedException (arka plandan başlatma kısıtı) vb.
            return false;
        }
    }

    private void reloadConfiguration() {
        prefs = store.loadPrefs();
        List<HostConfig> hosts = prefs.enabled ? store.loadHosts() : new ArrayList<>();
        if (hosts.isEmpty()) {
            shutdown();
            return;
        }
        Map<String, HostConfig> wanted = new HashMap<>();
        for (HostConfig host : hosts) wanted.put(host.hostId, host);
        for (String hostId : new ArrayList<>(links.keySet())) {
            HostConfig next = wanted.get(hostId);
            HostLink link = links.get(hostId);
            if (next == null || !sameConnection(link.config(), next)) {
                link.stop();
                links.remove(hostId);
                book.forgetHost(hostId);
                HOST_STATUS.remove(hostId);
            }
        }
        for (HostConfig host : hosts) {
            if (links.containsKey(host.hostId)) continue;
            HostLink link = new HostLink(host, CLIENT_NAME, this, null);
            links.put(host.hostId, link);
            HOST_STATUS.put(host.hostId, HostLink.STATUS_CONNECTING);
            link.start();
        }
        lastPostedKey = "";
        updateOngoing();
    }

    private static boolean sameConnection(HostConfig a, HostConfig b) {
        return a.deviceId.equals(b.deviceId)
                && a.port == b.port
                && Arrays.equals(a.secret, b.secret)
                && a.addresses.equals(b.addresses)
                && Objects.equals(a.discoveryUrl, b.discoveryUrl);
    }

    private void shutdown() {
        for (HostLink link : links.values()) link.stop();
        links.clear();
        HOST_STATUS.clear();
        running = false;
        if (inForeground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            inForeground = false;
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        for (HostLink link : links.values()) link.stop();
        links.clear();
        running = false;
        if (main != null) main.removeCallbacksAndMessages(null);
        unregisterNetworkCallback();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // --- HostLink.Listener (bağlantı iş parçacıklarından; ana iş parçacığına aktarılır) ---------

    @Override
    public void onStatus(HostLink link, String status, String detail) {
        main.post(() -> {
            if (links.get(link.hostId()) != link) return;
            HOST_STATUS.put(link.hostId(), status);
            if (HostLink.STATUS_REVOKED.equals(status) || HostLink.STATUS_UNSUPPORTED.equals(status)) {
                book.forgetHost(link.hostId());
            }
            updateOngoing();
        });
    }

    @Override
    public void onWelcome(HostLink link, String hostName, List<String> addresses, int port) {
        main.post(() -> {
            if (links.get(link.hostId()) != link || addresses.isEmpty()) return;
            HostConfig current = link.config();
            List<String> liveAddresses = link.currentAddresses();
            // Masaüstünün bildirdiği güncel yerel adresler; elle eklenmiş ya da keşfedilmiş wss:// tünelleri korunur.
            List<String> merged = new ArrayList<>(addresses);
            for (String address : liveAddresses) {
                if (address.startsWith("wss://") && !merged.contains(address)) merged.add(address);
            }
            for (String address : current.addresses) {
                if (address.startsWith("wss://") && !merged.contains(address)) merged.add(address);
            }
            if (merged.size() > 6) merged = new ArrayList<>(merged.subList(0, 6));
            link.updateAddresses(merged);
            if (merged.equals(current.addresses) && port == current.port) return;
            List<HostConfig> hosts = store.loadHosts();
            List<HostConfig> updated = new ArrayList<>();
            for (HostConfig host : hosts) {
                updated.add(host.hostId.equals(current.hostId)
                        ? new HostConfig(host.hostId, host.hostName, merged, port > 0 ? port : host.port,
                                host.deviceId, host.secret, host.discoveryUrl)
                        : host);
            }
            // Bağlantı sürerken yeniden başlatılmaz: yaşayan HostLink ve kalıcı depo birlikte güncellendi.
            store.saveHosts(updated);
        });
    }

    @Override
    public void onSnapshot(HostLink link, boolean publishing, String hostName, List<ActivityEntry> entries) {
        main.post(() -> {
            if (links.get(link.hostId()) != link) return;
            if (!publishing) {
                book.forgetHost(link.hostId());
                HOST_STATUS.put(link.hostId(), "paused");
            } else {
                List<ActivityBook.Alert> alerts = book.applySnapshot(
                        link.hostId(), entries, prefs, foreground(), System.currentTimeMillis());
                for (ActivityBook.Alert alert : alerts) postAlert(alert);
            }
            updateOngoing();
        });
    }

    @Override
    public void onUpsert(HostLink link, ActivityEntry entry, boolean alert) {
        main.post(() -> {
            if (links.get(link.hostId()) != link) return;
            ActivityBook.Alert decided = book.applyUpsert(entry, alert, prefs, foreground());
            if (decided != null) postAlert(decided);
            // Sohbet yeniden çalışmaya başladıysa eski uyarısı (ör. "onay bekliyor") kaldırılır.
            if (entry.isActive() && decided == null && ActivityEntry.WORKING.equals(entry.state)) {
                NotificationManagerCompat.from(this)
                        .cancel(ActivityBook.alertNotificationId(entry.hostId, entry.conversationId));
            }
            updateOngoing();
        });
    }

    @Override
    public void onRemove(HostLink link, String conversationId, long revision) {
        main.post(() -> {
            if (links.get(link.hostId()) != link) return;
            book.applyRemove(link.hostId(), conversationId, revision);
            updateOngoing();
        });
    }

    // --- Bildirimler ---------------------------------------------------------------------------

    private static ActivityBook.Foreground foreground() {
        return new ActivityBook.Foreground(appVisible, visibleHostId, visibleConversationId);
    }

    private boolean canNotify() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    /** Sohbeti açan PendingIntent (bildirime dokununca uygulama o sohbete gider). */
    private PendingIntent openIntent(ActivityEntry entry, int requestCode) {
        Intent intent = new Intent(this, MainActivity.class)
                .setAction(ACTION_OPEN_CONVERSATION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (entry != null) {
            // Benzersiz veri URI'si: her sohbetin PendingIntent'i ayrı kalsın (extras ezilmesin).
            intent.setData(Uri.parse("orkestra-notify://conversation/"
                    + Uri.encode(entry.hostId) + "/" + Uri.encode(entry.conversationId)));
            intent.putExtra(EXTRA_HOST_ID, entry.hostId);
            intent.putExtra(EXTRA_CONVERSATION_ID, entry.conversationId);
        }
        return PendingIntent.getActivity(
                this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void postAlert(ActivityBook.Alert alert) {
        if (!canNotify()) return;
        ActivityEntry entry = alert.entry;
        String body = ActivityBook.alertBody(entry);
        int id = alert.notificationId();
        boolean urgent = ActivityEntry.NEEDS_APPROVAL.equals(entry.state)
                || ActivityEntry.ASKED_QUESTION.equals(entry.state);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(
                        this, AgentNotifyChannels.forState(entry.state))
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle(ActivityBook.alertTitle(entry))
                .setContentText(body.contains("\n") ? body.substring(0, body.indexOf('\n')) : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSubText(entry.hostName)
                .setWhen(entry.localStateAt)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setGroup("orkestra_agent_alerts")
                .setCategory(urgent
                        ? NotificationCompat.CATEGORY_REMINDER
                        : ActivityEntry.FAILED.equals(entry.state)
                                ? NotificationCompat.CATEGORY_ERROR
                                : NotificationCompat.CATEGORY_STATUS)
                .setPriority(urgent ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(openIntent(entry, id));
        try {
            NotificationManagerCompat.from(this).notify(id, builder.build());
        } catch (SecurityException ignored) {
            // İzin yarışta geri alındıysa sessizce geç.
        }
    }

    private int connectedCount() {
        int count = 0;
        for (String status : HOST_STATUS.values()) {
            if (HostLink.STATUS_CONNECTED.equals(status)) count++;
        }
        return count;
    }

    private Notification buildServiceNotification(int hostCount, int connected) {
        String text = hostCount == 0
                ? "Bilgisayarlara bağlanılıyor…"
                : connected + "/" + hostCount + " bilgisayar bağlı · ajan bildirimleri açık";
        return new NotificationCompat.Builder(this, AgentNotifyChannels.SERVICE)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setContentTitle("Ajan bildirimleri")
                .setContentText(text)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(openIntent(null, ONGOING_ID))
                .build();
    }

    /** Süren etkinlik kartını (ya da kapalıysa sade servis bildirimini) günceller. */
    private void updateOngoing() {
        if (!inForeground) return;
        long now = System.currentTimeMillis();
        ActivityBook.Summary summary = book.summary(now);
        if (!summary.signature.equals(dismissedSignature) && !dismissedSignature.isEmpty()) {
            // İçerik değişti: kullanıcının gizlediği kart yeniden gösterilebilir.
            dismissedSignature = "";
            store.saveDismissedSignature("");
        }
        boolean showCard = prefs.ongoing && !summary.isEmpty() && dismissedSignature.isEmpty();
        Notification notification;
        String key;
        if (showCard) {
            key = "card|" + summary.signature + "|" + summary.title;
            NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
            for (String line : summary.lines) inbox.addLine(line);
            notification = new NotificationCompat.Builder(this, AgentNotifyChannels.ONGOING)
                    .setSmallIcon(R.drawable.ic_stat_agent)
                    .setContentTitle(summary.title)
                    .setContentText(summary.text)
                    .setStyle(inbox)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setShowWhen(false)
                    .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                    .setContentIntent(openIntent(summary.primary, ONGOING_ID))
                    .setDeleteIntent(hideCardIntent())
                    .addAction(0, "Kartı gizle", hideCardIntent())
                    .build();
        } else {
            int hosts = links.size();
            int connected = connectedCount();
            key = "service|" + hosts + "|" + connected;
            notification = buildServiceNotification(hosts, connected);
        }
        if (key.equals(lastPostedKey)) return;
        lastPostedKey = key;
        try {
            NotificationManagerCompat.from(this).notify(ONGOING_ID, notification);
        } catch (SecurityException ignored) {
        }
    }

    private PendingIntent hideCardIntent() {
        Intent intent = new Intent(this, AgentActivityService.class).setAction(ACTION_HIDE_CARD);
        return PendingIntent.getService(
                this, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // --- Ağ ------------------------------------------------------------------------------------

    private void registerNetworkCallback() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // Wi-Fi ↔ mobil veri geçişi ya da ağ geri geldi: bekleyen bağlantıları hemen dene.
                main.post(() -> {
                    for (HostLink link : links.values()) link.wakeUp();
                });
            }
        };
        try {
            manager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null || networkCallback == null) return;
        try {
            manager.unregisterNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
        }
        networkCallback = null;
    }

    /** Uygulama bu sohbeti ön planda gösteriyor: varsa bekleyen uyarısını kaldır. */
    static void onConversationVisible(Context context, String hostId, String conversationId) {
        if (hostId == null || conversationId == null) return;
        NotificationManagerCompat.from(context)
                .cancel(ActivityBook.alertNotificationId(hostId, conversationId));
    }
}
