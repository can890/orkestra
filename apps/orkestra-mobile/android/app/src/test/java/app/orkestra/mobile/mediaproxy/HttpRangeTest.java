package app.orkestra.mobile.mediaproxy;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** `Range` başlığı ayrıştırma: açık/kapalı uçlar, sonek, kırpma, 416 ve yok sayılan biçimler. */
public class HttpRangeTest {
    private static final long SIZE = 1000;

    private static void assertRange(HttpRange r, HttpRange.Kind kind, long start, long end) {
        assertEquals(kind, r.kind);
        assertEquals(start, r.start);
        assertEquals(end, r.end);
    }

    @Test
    public void missingHeaderMeansFullBody() {
        assertRange(HttpRange.parse(null, SIZE), HttpRange.Kind.FULL, 0, 999);
        assertEquals(1000, HttpRange.parse(null, SIZE).length());
    }

    @Test
    public void closedAndOpenRanges() {
        assertRange(HttpRange.parse("bytes=0-99", SIZE), HttpRange.Kind.PARTIAL, 0, 99);
        assertRange(HttpRange.parse("bytes=500-", SIZE), HttpRange.Kind.PARTIAL, 500, 999);
        assertRange(HttpRange.parse("Bytes = 10 - 20", SIZE), HttpRange.Kind.PARTIAL, 10, 20);
        assertEquals(11, HttpRange.parse("bytes=10-20", SIZE).length());
    }

    @Test
    public void endBeyondSizeIsClamped() {
        assertRange(HttpRange.parse("bytes=900-5000", SIZE), HttpRange.Kind.PARTIAL, 900, 999);
    }

    @Test
    public void suffixRange() {
        assertRange(HttpRange.parse("bytes=-100", SIZE), HttpRange.Kind.PARTIAL, 900, 999);
        assertRange(HttpRange.parse("bytes=-5000", SIZE), HttpRange.Kind.PARTIAL, 0, 999);
        assertEquals(HttpRange.Kind.UNSATISFIABLE, HttpRange.parse("bytes=-0", SIZE).kind);
    }

    @Test
    public void startAtOrBeyondSizeIsUnsatisfiable() {
        assertEquals(HttpRange.Kind.UNSATISFIABLE, HttpRange.parse("bytes=1000-", SIZE).kind);
        assertEquals(HttpRange.Kind.UNSATISFIABLE, HttpRange.parse("bytes=5000-6000", SIZE).kind);
        assertEquals(HttpRange.Kind.UNSATISFIABLE, HttpRange.parse("bytes=0-", 0).kind);
    }

    @Test
    public void multiRangeUsesFirst() {
        assertRange(HttpRange.parse("bytes=0-9, 20-29", SIZE), HttpRange.Kind.PARTIAL, 0, 9);
    }

    @Test
    public void malformedOrForeignUnitIsIgnored() {
        assertEquals(HttpRange.Kind.FULL, HttpRange.parse("items=0-9", SIZE).kind);
        assertEquals(HttpRange.Kind.FULL, HttpRange.parse("bytes=abc-def", SIZE).kind);
        assertEquals(HttpRange.Kind.FULL, HttpRange.parse("bytes=50-10", SIZE).kind);
        assertEquals(HttpRange.Kind.FULL, HttpRange.parse("bytes=", SIZE).kind);
    }

    @Test
    public void handlesMultiGigabyteOffsets() {
        long big = 6L * 1024 * 1024 * 1024;
        assertRange(HttpRange.parse("bytes=5368709120-", big), HttpRange.Kind.PARTIAL, 5368709120L, big - 1);
    }
}
