package app.orkestra.mobile.mediaproxy;

import java.io.IOException;

/** Uzak dosyanın bir bayt aralığını getirir (engelleyici). Uygulamada JS Wire istemcisine köprülenir. */
public interface RangeFetcher {
    /**
     * `[offset, offset + length)` aralığını döndürür. Dosya sonunda daha kısa dönebilir; hata
     * durumunda kullanıcıya gösterilebilir mesajlı {@link IOException} fırlatır.
     */
    byte[] fetch(MediaStreamServer.StreamInfo stream, long offset, int length) throws IOException;
}
