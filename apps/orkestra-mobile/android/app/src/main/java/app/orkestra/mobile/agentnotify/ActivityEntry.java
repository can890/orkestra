package app.orkestra.mobile.agentnotify;

/**
 * Bir bilgisayardaki tek sohbetin güncel ajan durumu (host'un `agentActivity` akışındaki kaydın
 * telefondaki karşılığı). Değişmezdir; saf Java (JVM testleri).
 */
public final class ActivityEntry {
    public static final String WORKING = "working";
    public static final String NEEDS_APPROVAL = "needs-approval";
    public static final String ASKED_QUESTION = "asked-question";
    public static final String FINISHED = "finished";
    public static final String FAILED = "failed";

    public final String hostId;
    public final String hostName;
    public final String conversationId;
    public final String state;
    public final String title;
    public final String projectName;
    public final String providerName;
    public final String preview;
    /** Host saatiyle durum değişim anı (tekilleştirme anahtarı bunu kullanır). */
    public final long stateChangedAt;
    /** Aynı anın telefon saatindeki karşılığı (yaş/15 dk saklama hesabı; saat kaymasından bağımsız). */
    public final long localStateAt;
    public final long revision;

    public ActivityEntry(
            String hostId,
            String hostName,
            String conversationId,
            String state,
            String title,
            String projectName,
            String providerName,
            String preview,
            long stateChangedAt,
            long localStateAt,
            long revision) {
        this.hostId = hostId;
        this.hostName = hostName == null ? "" : hostName;
        this.conversationId = conversationId;
        this.state = state;
        this.title = title == null ? "" : title;
        this.projectName = projectName == null ? "" : projectName;
        this.providerName = providerName == null ? "" : providerName;
        this.preview = preview == null ? "" : preview;
        this.stateChangedAt = stateChangedAt;
        this.localStateAt = localStateAt;
        this.revision = revision;
    }

    public static boolean isKnownState(String state) {
        return WORKING.equals(state)
                || NEEDS_APPROVAL.equals(state)
                || ASKED_QUESTION.equals(state)
                || FINISHED.equals(state)
                || FAILED.equals(state);
    }

    public boolean isActive() {
        return WORKING.equals(state) || NEEDS_APPROVAL.equals(state) || ASKED_QUESTION.equals(state);
    }

    public boolean isAlertState() {
        return !WORKING.equals(state);
    }

    /** Aynı geçişin iki kez bildirilmemesi için anahtar. */
    public String alertKey() {
        return hostId + "|" + conversationId + "|" + state + "|" + stateChangedAt;
    }

    public String key() {
        return hostId + "|" + conversationId;
    }
}
