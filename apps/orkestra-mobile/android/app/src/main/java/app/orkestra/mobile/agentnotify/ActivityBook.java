// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/mobile/src/features/agent-awareness/foregroundNotificationBehavior.ts
// (ön planda açık sohbetin uyarısını bastırma) ve docs/user/mobile-notifications.md (kategori
// tercihleri, süren etkinlik kartı, biten sonucun 15 dk görünmesi). T3 bunu bulut push ile yapar;
// burada aynı kurallar telefonun yerel servisinde, doğrudan bağlantıdan gelen akışa uygulanır.
package app.orkestra.mobile.agentnotify;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Telefonun tüm eşleşmiş bilgisayarlarındaki ajan etkinliğinin tek modeli ve "hangi geçiş için
 * bildirim gösterilir" kararı. Taşımadan bağımsızdır: doğrudan bağlantı (HostLink) ya da ileride
 * eklenebilecek bir push taşıması aynı `apply*` yöntemlerini çağırır. Saf Java; iş parçacığı
 * güvenliği çağıranın (servisin ana iş parçacığı) sorumluluğundadır.
 */
public final class ActivityBook {
    /** Biten/başarısız sonuçlar süren etkinlik kartında en çok bu kadar kalır. */
    public static final long RESULT_RETENTION_MS = 15 * 60_000L;
    private static final int MAX_DELIVERED_KEYS = 512;
    private static final int MAX_SUMMARY_LINES = 6;

    /** Uygulama ön planda mı ve hangi sohbet açık? (Ön plandaki sohbetin uyarısı gösterilmez.) */
    public static final class Foreground {
        public final boolean appVisible;
        public final String hostId;
        public final String conversationId;

        public Foreground(boolean appVisible, String hostId, String conversationId) {
            this.appVisible = appVisible;
            this.hostId = hostId;
            this.conversationId = conversationId;
        }

        public static Foreground background() {
            return new Foreground(false, null, null);
        }

        boolean isViewing(ActivityEntry entry) {
            return appVisible
                    && entry.hostId.equals(hostId)
                    && entry.conversationId.equals(conversationId);
        }
    }

    /** Gösterilecek uyarı bildirimi. */
    public static final class Alert {
        public final ActivityEntry entry;

        Alert(ActivityEntry entry) {
            this.entry = entry;
        }

        /** Sohbet başına tek uyarı: aynı sohbetin yeni uyarısı eskisinin yerine geçer. */
        public int notificationId() {
            return alertNotificationId(entry.hostId, entry.conversationId);
        }
    }

    /** Süren etkinlik kartının içeriği. */
    public static final class Summary {
        public final int activeCount;
        public final int waitingCount;
        public final int resultCount;
        public final String title;
        public final String text;
        public final List<String> lines;
        /** Karta dokununca açılacak sohbet (yoksa {@code null}). */
        public final ActivityEntry primary;
        /** Kart içeriğinin kimliği: kullanıcı kartı kapattıysa ancak bu değişince yeniden gösterilir. */
        public final String signature;

        Summary(
                int activeCount,
                int waitingCount,
                int resultCount,
                String title,
                String text,
                List<String> lines,
                ActivityEntry primary,
                String signature) {
            this.activeCount = activeCount;
            this.waitingCount = waitingCount;
            this.resultCount = resultCount;
            this.title = title;
            this.text = text;
            this.lines = lines;
            this.primary = primary;
            this.signature = signature;
        }

        public boolean isEmpty() {
            return activeCount == 0 && resultCount == 0;
        }
    }

    /** Uyarı bildirimi kimliği (süren etkinlik kartının sabit kimliğiyle çakışmaz). */
    public static int alertNotificationId(String hostId, String conversationId) {
        return 0x4000_0000 | ((hostId + "|" + conversationId).hashCode() & 0x3fff_ffff);
    }

    private final Map<String, ActivityEntry> entries = new LinkedHashMap<>();
    private final Set<String> baselinedHosts = new HashSet<>();
    private final LinkedHashSet<String> delivered = new LinkedHashSet<>();

    /**
     * Bağlantı (yeniden) kurulunca gelen tam liste. Bir bilgisayarın İLK snapshot'ı sessizdir
     * (servis açılmadan önceki sonuçlar için bildirim yok). Sonraki snapshot'larda (kopukluk
     * sonrası) daha önce görülmemiş, 15 dk'dan yeni uyarı durumları bildirilir: telefon çevrimdışıyken
     * biten tur kaçırılmaz.
     */
    public List<Alert> applySnapshot(
            String hostId, List<ActivityEntry> snapshot, NotifyPrefs prefs, Foreground fg, long now) {
        removeHostEntries(hostId);
        boolean firstSnapshot = !baselinedHosts.contains(hostId);
        List<Alert> alerts = new ArrayList<>();
        for (ActivityEntry entry : snapshot) {
            if (!entry.isActive() && now - entry.localStateAt > RESULT_RETENTION_MS) continue;
            entries.put(entry.key(), entry);
            if (!entry.isAlertState()) continue;
            if (firstSnapshot) {
                markDelivered(entry.alertKey());
                continue;
            }
            Alert alert = decide(entry, prefs, fg);
            if (alert != null) alerts.add(alert);
        }
        baselinedHosts.add(hostId);
        return alerts;
    }

    /**
     * Canlı güncelleme. `hostAlert`: host'un geçiş kararı (yeni uyarı durumuna giriş). Eski sürüm
     * (revision) yok sayılır. Bildirim gösterilmeyecekse {@code null}.
     */
    public Alert applyUpsert(ActivityEntry entry, boolean hostAlert, NotifyPrefs prefs, Foreground fg) {
        ActivityEntry previous = entries.get(entry.key());
        if (previous != null && previous.revision >= entry.revision) return null;
        entries.put(entry.key(), entry);
        if (!entry.isAlertState()) return null;
        if (!hostAlert) {
            markDelivered(entry.alertKey());
            return null;
        }
        return decide(entry, prefs, fg);
    }

    public void applyRemove(String hostId, String conversationId, long revision) {
        String key = hostId + "|" + conversationId;
        ActivityEntry previous = entries.get(key);
        if (previous != null && previous.revision < revision) entries.remove(key);
    }

    /** Host yayını kapattı ya da bilgisayar kaldırıldı: kayıtlar silinir, sonraki snapshot sessizdir. */
    public void forgetHost(String hostId) {
        removeHostEntries(hostId);
        baselinedHosts.remove(hostId);
    }

    /** Süresi dolan sonuçları düşürür; değişiklik olduysa {@code true}. */
    public boolean prune(long now) {
        boolean changed = false;
        Iterator<ActivityEntry> it = entries.values().iterator();
        while (it.hasNext()) {
            ActivityEntry entry = it.next();
            if (!entry.isActive() && now - entry.localStateAt > RESULT_RETENTION_MS) {
                it.remove();
                changed = true;
            }
        }
        return changed;
    }

    public ActivityEntry find(String hostId, String conversationId) {
        return entries.get(hostId + "|" + conversationId);
    }

    public int size() {
        return entries.size();
    }

    private void removeHostEntries(String hostId) {
        Iterator<ActivityEntry> it = entries.values().iterator();
        while (it.hasNext()) {
            if (it.next().hostId.equals(hostId)) it.remove();
        }
    }

    private Alert decide(ActivityEntry entry, NotifyPrefs prefs, Foreground fg) {
        String key = entry.alertKey();
        if (delivered.contains(key)) return null;
        // Bastırılan uyarı da "teslim edildi" sayılır: yeniden bağlanınca sonradan çıkmaz.
        markDelivered(key);
        if (!prefs.allows(entry.state)) return null;
        if (fg.isViewing(entry)) return null;
        return new Alert(entry);
    }

    private void markDelivered(String key) {
        delivered.remove(key);
        delivered.add(key);
        while (delivered.size() > MAX_DELIVERED_KEYS) {
            Iterator<String> it = delivered.iterator();
            it.next();
            it.remove();
        }
    }

    /** Süren etkinlik kartı: önce bekleyenler, sonra çalışanlar, sonra 15 dk içindeki sonuçlar. */
    public Summary summary(long now) {
        List<ActivityEntry> waiting = new ArrayList<>();
        List<ActivityEntry> working = new ArrayList<>();
        List<ActivityEntry> results = new ArrayList<>();
        for (ActivityEntry entry : entries.values()) {
            if (ActivityEntry.WORKING.equals(entry.state)) working.add(entry);
            else if (entry.isActive()) waiting.add(entry);
            else if (now - entry.localStateAt <= RESULT_RETENTION_MS) results.add(entry);
        }
        java.util.Comparator<ActivityEntry> newestFirst =
                (a, b) -> Long.compare(b.localStateAt, a.localStateAt);
        Collections.sort(waiting, newestFirst);
        Collections.sort(working, newestFirst);
        Collections.sort(results, newestFirst);

        List<ActivityEntry> ordered = new ArrayList<>(waiting);
        ordered.addAll(working);
        ordered.addAll(results);
        List<String> lines = new ArrayList<>();
        StringBuilder signature = new StringBuilder();
        for (ActivityEntry entry : ordered) {
            signature.append(entry.key()).append('=').append(entry.state).append(';');
            if (lines.size() < MAX_SUMMARY_LINES) lines.add(lineFor(entry));
        }
        int active = waiting.size() + working.size();
        String title;
        if (active > 0) {
            title = active + " ajan çalışıyor";
            if (!waiting.isEmpty()) title += " · " + waiting.size() + " yanıt bekliyor";
        } else if (!results.isEmpty()) {
            title = "Son ajan sonuçları";
        } else {
            title = "Ajan etkinliği izleniyor";
        }
        String text;
        if (!ordered.isEmpty()) {
            text = lineFor(ordered.get(0));
        } else {
            text = "Şu anda çalışan ajan yok.";
        }
        return new Summary(
                active,
                waiting.size(),
                results.size(),
                title,
                text,
                Collections.unmodifiableList(lines),
                ordered.isEmpty() ? null : ordered.get(0),
                signature.toString());
    }

    public static String stateLabel(String state) {
        switch (state) {
            case ActivityEntry.WORKING:
                return "çalışıyor";
            case ActivityEntry.NEEDS_APPROVAL:
                return "onay bekliyor";
            case ActivityEntry.ASKED_QUESTION:
                return "soru soruyor";
            case ActivityEntry.FINISHED:
                return "bitti";
            case ActivityEntry.FAILED:
                return "hata verdi";
            default:
                return state;
        }
    }

    static String lineFor(ActivityEntry entry) {
        String title = entry.title.isEmpty() ? "Sohbet" : entry.title;
        String place = entry.projectName.isEmpty() ? entry.hostName : entry.projectName;
        return title + " — " + stateLabel(entry.state) + (place.isEmpty() ? "" : " · " + place);
    }

    /** Uyarı bildirimi başlığı. */
    public static String alertTitle(ActivityEntry entry) {
        String who = entry.providerName.isEmpty() ? "Ajan" : entry.providerName;
        switch (entry.state) {
            case ActivityEntry.NEEDS_APPROVAL:
                return who + " onay bekliyor";
            case ActivityEntry.ASKED_QUESTION:
                return who + " bir soru soruyor";
            case ActivityEntry.FAILED:
                return who + " hata verdi";
            case ActivityEntry.FINISHED:
            default:
                return who + " işini bitirdi";
        }
    }

    /** Uyarı bildirimi metni: sohbet başlığı + kısa önizleme. */
    public static String alertBody(ActivityEntry entry) {
        String title = entry.title.isEmpty() ? "Sohbet" : entry.title;
        String place = entry.projectName.isEmpty() ? entry.hostName : entry.projectName;
        String head = place.isEmpty() ? title : title + " · " + place;
        return entry.preview.isEmpty() ? head : head + "\n" + entry.preview;
    }
}
