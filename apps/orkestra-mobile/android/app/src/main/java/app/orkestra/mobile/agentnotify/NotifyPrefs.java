package app.orkestra.mobile.agentnotify;

/**
 * Telefon tarafı bildirim tercihleri (Ayarlar → Ajan bildirimleri). JS tarafındaki
 * `agent-notifications/preferences.ts` ile aynı alanlar; varsayılanlar da aynıdır.
 */
public final class NotifyPrefs {
    /** Arka plan servisi (ön plan servisi + yerel bağlantı) açık mı? Varsayılan kapalı. */
    public final boolean enabled;
    public final boolean finished;
    public final boolean failed;
    public final boolean approval;
    public final boolean question;
    /** "Çalışan ajanlar" süren etkinlik kartı. */
    public final boolean ongoing;

    public NotifyPrefs(
            boolean enabled,
            boolean finished,
            boolean failed,
            boolean approval,
            boolean question,
            boolean ongoing) {
        this.enabled = enabled;
        this.finished = finished;
        this.failed = failed;
        this.approval = approval;
        this.question = question;
        this.ongoing = ongoing;
    }

    public static NotifyPrefs defaults() {
        return new NotifyPrefs(false, true, true, true, true, true);
    }

    /** Bu durum için uyarı bildirimi isteniyor mu? `working` hiçbir zaman uyarı değildir. */
    public boolean allows(String state) {
        switch (state) {
            case ActivityEntry.FINISHED:
                return finished;
            case ActivityEntry.FAILED:
                return failed;
            case ActivityEntry.NEEDS_APPROVAL:
                return approval;
            case ActivityEntry.ASKED_QUESTION:
                return question;
            default:
                return false;
        }
    }
}
