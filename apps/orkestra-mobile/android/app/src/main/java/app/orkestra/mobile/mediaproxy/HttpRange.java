package app.orkestra.mobile.mediaproxy;

/**
 * HTTP `Range` başlığı ayrıştırıcı (RFC 9110 §14). Yalnızca `bytes` birimi ve tek aralık
 * desteklenir; çoklu aralıkta ilk aralık kullanılır (Chromium medya yükleyicisi tek aralık ister).
 */
public final class HttpRange {
    public enum Kind {
        /** Başlık yok ya da anlaşılmadı: tüm gövde `200` ile döner. */
        FULL,
        /** Geçerli aralık: `206 Partial Content`. */
        PARTIAL,
        /** Karşılanamaz aralık: `416 Range Not Satisfiable`. */
        UNSATISFIABLE
    }

    public final Kind kind;
    /** Dahil başlangıç baytı. */
    public final long start;
    /** Dahil bitiş baytı. */
    public final long end;

    private HttpRange(Kind kind, long start, long end) {
        this.kind = kind;
        this.start = start;
        this.end = end;
    }

    public long length() {
        return kind == Kind.UNSATISFIABLE ? 0 : Math.max(0, end - start + 1);
    }

    public static HttpRange full(long size) {
        return new HttpRange(Kind.FULL, 0, size - 1);
    }

    public static HttpRange parse(String header, long size) {
        if (header == null) return full(size);
        String value = header.trim();
        int eq = value.indexOf('=');
        if (eq < 0 || !value.substring(0, eq).trim().equalsIgnoreCase("bytes")) {
            // Bilinmeyen birim: RFC'ye göre başlık yok sayılır.
            return full(size);
        }
        String spec = value.substring(eq + 1).trim();
        int comma = spec.indexOf(',');
        if (comma >= 0) spec = spec.substring(0, comma).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return full(size);
        String first = spec.substring(0, dash).trim();
        String last = spec.substring(dash + 1).trim();
        try {
            if (first.isEmpty()) {
                // Sonek aralığı: son N bayt.
                if (last.isEmpty()) return full(size);
                long suffix = Long.parseLong(last);
                if (suffix <= 0 || size <= 0) return unsatisfiable();
                long start = Math.max(0, size - suffix);
                return new HttpRange(Kind.PARTIAL, start, size - 1);
            }
            long start = Long.parseLong(first);
            if (start < 0) return full(size);
            if (start >= size) return unsatisfiable();
            long end = last.isEmpty() ? size - 1 : Long.parseLong(last);
            if (end < start) return full(size);
            return new HttpRange(Kind.PARTIAL, start, Math.min(end, size - 1));
        } catch (NumberFormatException ignored) {
            return full(size);
        }
    }

    private static HttpRange unsatisfiable() {
        return new HttpRange(Kind.UNSATISFIABLE, 0, -1);
    }
}
