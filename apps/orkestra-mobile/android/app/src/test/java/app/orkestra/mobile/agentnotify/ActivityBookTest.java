package app.orkestra.mobile.agentnotify;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** Telefon tarafı bildirim kararları: tercihler, ön planda susma, tekilleştirme, 15 dk saklama. */
public class ActivityBookTest {
    private static final long NOW = 10_000_000L;
    private static final NotifyPrefs ALL = new NotifyPrefs(true, true, true, true, true, true);
    private static final ActivityBook.Foreground BG = ActivityBook.Foreground.background();

    private static ActivityEntry entry(String conversationId, String state, long at, long revision) {
        return new ActivityEntry("mac", "Mac", conversationId, state, "Fix login", "Orkestra", "Claude",
                "preview", at, at, revision);
    }

    @Test
    public void firstSnapshotIsSilentButLaterUpdatesAlert() {
        ActivityBook book = new ActivityBook();
        List<ActivityBook.Alert> first = book.applySnapshot("mac",
                Arrays.asList(entry("a", ActivityEntry.FINISHED, NOW - 1_000, 1),
                        entry("b", ActivityEntry.WORKING, NOW - 500, 2)),
                ALL, BG, NOW);
        assertTrue(first.isEmpty());

        assertNull(book.applyUpsert(entry("b", ActivityEntry.WORKING, NOW, 3), false, ALL, BG));
        ActivityBook.Alert done = book.applyUpsert(entry("b", ActivityEntry.FINISHED, NOW + 10, 4), true, ALL, BG);
        assertNotNull(done);
        assertEquals("Claude işini bitirdi", ActivityBook.alertTitle(done.entry));
        // Aynı geçiş tekrar gelirse (yeniden gönderim) ikinci kez bildirilmez.
        assertNull(book.applyUpsert(entry("b", ActivityEntry.FINISHED, NOW + 10, 5), true, ALL, BG));
        // Eski sürüm yok sayılır.
        assertNull(book.applyUpsert(entry("b", ActivityEntry.NEEDS_APPROVAL, NOW + 20, 3), true, ALL, BG));
    }

    @Test
    public void reconnectSnapshotAlertsOnlyForMissedRecentTransitions() {
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Collections.singletonList(entry("a", ActivityEntry.WORKING, NOW - 100, 1)),
                ALL, BG, NOW);
        // Telefon çevrimdışıyken "a" bitti, "old" çok önce bitti.
        List<ActivityBook.Alert> alerts = book.applySnapshot("mac",
                Arrays.asList(entry("a", ActivityEntry.FINISHED, NOW + 60_000, 5),
                        entry("old", ActivityEntry.FAILED, NOW - ActivityBook.RESULT_RETENTION_MS - 1, 2)),
                ALL, BG, NOW + 61_000);
        assertEquals(1, alerts.size());
        assertEquals("a", alerts.get(0).entry.conversationId);
        assertNull(book.find("mac", "old"));
        // Aynı snapshot tekrar gelirse yeni uyarı yok.
        assertTrue(book.applySnapshot("mac",
                Collections.singletonList(entry("a", ActivityEntry.FINISHED, NOW + 60_000, 5)),
                ALL, BG, NOW + 62_000).isEmpty());
    }

    @Test
    public void respectsPerCategoryPreferences() {
        NotifyPrefs onlyApprovals = new NotifyPrefs(true, false, false, true, false, true);
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Collections.<ActivityEntry>emptyList(), onlyApprovals, BG, NOW);
        assertNull(book.applyUpsert(entry("a", ActivityEntry.FINISHED, NOW, 1), true, onlyApprovals, BG));
        assertNull(book.applyUpsert(entry("b", ActivityEntry.ASKED_QUESTION, NOW, 2), true, onlyApprovals, BG));
        assertNull(book.applyUpsert(entry("c", ActivityEntry.FAILED, NOW, 3), true, onlyApprovals, BG));
        assertNotNull(book.applyUpsert(entry("d", ActivityEntry.NEEDS_APPROVAL, NOW, 4), true, onlyApprovals, BG));
    }

    @Test
    public void staysQuietForTheConversationOpenInTheForeground() {
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Collections.<ActivityEntry>emptyList(), ALL, BG, NOW);
        ActivityBook.Foreground viewingA = new ActivityBook.Foreground(true, "mac", "a");
        assertNull(book.applyUpsert(entry("a", ActivityEntry.FINISHED, NOW, 1), true, ALL, viewingA));
        // Başka bir sohbet ön planda gösterilse de uyarılır.
        assertNotNull(book.applyUpsert(entry("b", ActivityEntry.FINISHED, NOW, 2), true, ALL, viewingA));
        // Uygulama arka plandayken aynı sohbet kimliği eşleşse de uyarılır.
        ActivityBook.Foreground hiddenA = new ActivityBook.Foreground(false, "mac", "c");
        assertNotNull(book.applyUpsert(entry("c", ActivityEntry.FAILED, NOW, 3), true, ALL, hiddenA));
    }

    @Test
    public void ongoingSummaryOrdersWaitingFirstAndKeepsResultsFifteenMinutes() {
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Arrays.asList(
                entry("w", ActivityEntry.WORKING, NOW - 50, 1),
                entry("q", ActivityEntry.NEEDS_APPROVAL, NOW - 100, 2),
                entry("r", ActivityEntry.FINISHED, NOW - 200, 3)), ALL, BG, NOW);
        ActivityBook.Summary summary = book.summary(NOW);
        assertEquals(2, summary.activeCount);
        assertEquals(1, summary.waitingCount);
        assertEquals(1, summary.resultCount);
        assertEquals("2 ajan çalışıyor · 1 yanıt bekliyor", summary.title);
        assertEquals("q", summary.primary.conversationId);
        assertEquals(3, summary.lines.size());
        assertTrue(summary.lines.get(0).contains("onay bekliyor"));

        long later = NOW + ActivityBook.RESULT_RETENTION_MS + 1_000;
        assertTrue(book.prune(later));
        ActivityBook.Summary afterExpiry = book.summary(later);
        assertEquals(0, afterExpiry.resultCount);
        assertFalse(afterExpiry.signature.contains("|r="));
    }

    @Test
    public void forgettingAHostClearsItsEntriesAndRebaselines() {
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Collections.singletonList(entry("a", ActivityEntry.WORKING, NOW, 1)), ALL, BG, NOW);
        book.forgetHost("mac");
        assertEquals(0, book.size());
        // Yayın yeniden açılınca gelen ilk snapshot yine sessiz.
        assertTrue(book.applySnapshot("mac",
                Collections.singletonList(entry("a", ActivityEntry.FINISHED, NOW + 5, 9)), ALL, BG, NOW + 6).isEmpty());
        assertTrue(book.summary(NOW + 6).isEmpty() == false);
    }

    @Test
    public void removeIgnoresStaleRevisions() {
        ActivityBook book = new ActivityBook();
        book.applySnapshot("mac", Collections.singletonList(entry("a", ActivityEntry.WORKING, NOW, 5)), ALL, BG, NOW);
        book.applyRemove("mac", "a", 4);
        assertNotNull(book.find("mac", "a"));
        book.applyRemove("mac", "a", 6);
        assertNull(book.find("mac", "a"));
    }
}
