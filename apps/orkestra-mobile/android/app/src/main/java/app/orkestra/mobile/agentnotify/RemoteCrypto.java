package app.orkestra.mobile.agentnotify;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Uzak erişim protokolünün (agents/architecture/remote-access.md §4) saf Java karşılığı:
 * HKDF-SHA256 ile yön anahtarları, AES-256-GCM çerçeveleri (sayaç ‖ şifreli metin ‖ etiket).
 * Android bağımlılığı yoktur; JVM birim testleriyle doğrulanır. Sır ve anahtarlar loglanmaz.
 */
public final class RemoteCrypto {
    public static final int SECRET_BYTES = 32;
    public static final int NONCE_BYTES = 32;
    public static final int DIRECTION_C2S = 0x00000001;
    public static final int DIRECTION_S2C = 0x00000002;
    public static final String INFO_C2S = "orkestra-remote/v1 c2s";
    public static final String INFO_S2C = "orkestra-remote/v1 s2c";
    private static final int COUNTER_BYTES = 8;
    private static final int TAG_BITS = 128;
    private static final long MAX_COUNTER = (1L << 53) - 1;
    private static final SecureRandom RANDOM = new SecureRandom();

    private RemoteCrypto() {}

    public static byte[] randomBytes(int length) {
        byte[] out = new byte[length];
        RANDOM.nextBytes(out);
        return out;
    }

    /** RFC 5869 HKDF-SHA256 (extract + expand). */
    public static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int length)
            throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        byte[] effectiveSalt = salt == null || salt.length == 0 ? new byte[32] : salt;
        mac.init(new SecretKeySpec(effectiveSalt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] out = new byte[length];
        byte[] previous = new byte[0];
        int offset = 0;
        for (int block = 1; offset < length; block++) {
            mac.update(previous);
            mac.update(info);
            mac.update((byte) block);
            previous = mac.doFinal();
            int copy = Math.min(previous.length, length - offset);
            System.arraycopy(previous, 0, out, offset, copy);
            offset += copy;
        }
        return out;
    }

    /** İstemci rolünde: gönderme (c2s) ve alma (s2c) anahtarları. */
    public static final class ClientKeys {
        public final byte[] send;
        public final byte[] receive;

        ClientKeys(byte[] send, byte[] receive) {
            this.send = send;
            this.receive = receive;
        }
    }

    public static ClientKeys deriveClientKeys(byte[] secret, byte[] clientNonce, byte[] serverNonce)
            throws GeneralSecurityException {
        if (secret.length != SECRET_BYTES) throw new GeneralSecurityException("secret length");
        if (clientNonce.length != NONCE_BYTES || serverNonce.length != NONCE_BYTES) {
            throw new GeneralSecurityException("nonce length");
        }
        byte[] salt = new byte[NONCE_BYTES * 2];
        System.arraycopy(clientNonce, 0, salt, 0, NONCE_BYTES);
        System.arraycopy(serverNonce, 0, salt, NONCE_BYTES, NONCE_BYTES);
        byte[] c2s = hkdfSha256(secret, salt, INFO_C2S.getBytes(StandardCharsets.UTF_8), 32);
        byte[] s2c = hkdfSha256(secret, salt, INFO_S2C.getBytes(StandardCharsets.UTF_8), 32);
        return new ClientKeys(c2s, s2c);
    }

    static void writeCounter(byte[] target, int offset, long counter) {
        for (int i = 7; i >= 0; i--) {
            target[offset + i] = (byte) (counter & 0xff);
            counter >>>= 8;
        }
    }

    static long readCounter(byte[] source, int offset) {
        long value = 0;
        for (int i = 0; i < 8; i++) value = (value << 8) | (source[offset + i] & 0xffL);
        return value;
    }

    static byte[] nonce(int direction, long counter) {
        byte[] nonce = new byte[12];
        nonce[0] = (byte) (direction >>> 24);
        nonce[1] = (byte) (direction >>> 16);
        nonce[2] = (byte) (direction >>> 8);
        nonce[3] = (byte) direction;
        writeCounter(nonce, 4, counter);
        return nonce;
    }

    /** Gönderim yönü: sayaç 0'dan başlar, her çerçevede 1 artar. İş parçacığı güvenli. */
    public static final class Sealer {
        private final SecretKeySpec key;
        private final int direction;
        private long counter = 0;

        public Sealer(byte[] key, int direction) {
            this.key = new SecretKeySpec(key, "AES");
            this.direction = direction;
        }

        public synchronized byte[] seal(byte[] plaintext) throws GeneralSecurityException {
            if (counter >= MAX_COUNTER) throw new GeneralSecurityException("counter exhausted");
            long current = counter++;
            byte[] header = new byte[COUNTER_BYTES];
            writeCounter(header, 0, current);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce(direction, current)));
            cipher.updateAAD(header);
            byte[] sealed = cipher.doFinal(plaintext);
            byte[] frame = new byte[COUNTER_BYTES + sealed.length];
            System.arraycopy(header, 0, frame, 0, COUNTER_BYTES);
            System.arraycopy(sealed, 0, frame, COUNTER_BYTES, sealed.length);
            return frame;
        }
    }

    /** Alım yönü: beklenen sayaçtan farklı (tekrar/atlanmış) ya da doğrulanamayan çerçeve reddedilir. */
    public static final class Opener {
        private final SecretKeySpec key;
        private final int direction;
        private long expected = 0;

        public Opener(byte[] key, int direction) {
            this.key = new SecretKeySpec(key, "AES");
            this.direction = direction;
        }

        public synchronized byte[] open(byte[] frame) throws GeneralSecurityException {
            if (frame.length < COUNTER_BYTES + TAG_BITS / 8) throw new GeneralSecurityException("short frame");
            long counter = readCounter(frame, 0);
            if (counter != expected) throw new GeneralSecurityException("unexpected counter");
            byte[] header = new byte[COUNTER_BYTES];
            System.arraycopy(frame, 0, header, 0, COUNTER_BYTES);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce(direction, counter)));
            cipher.updateAAD(header);
            byte[] plain = cipher.doFinal(frame, COUNTER_BYTES, frame.length - COUNTER_BYTES);
            expected = counter + 1;
            return plain;
        }
    }

    private static final char[] B64URL =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    /** Dolgusuz base64url (RFC 4648 §5). `java.util.Base64` API 26'dan eski cihazlarda yok. */
    public static String base64UrlEncode(byte[] bytes) {
        StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
        int i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            int n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8) | (bytes[i + 2] & 0xff);
            out.append(B64URL[(n >> 18) & 63]).append(B64URL[(n >> 12) & 63])
                    .append(B64URL[(n >> 6) & 63]).append(B64URL[n & 63]);
        }
        int rest = bytes.length - i;
        if (rest == 1) {
            int n = (bytes[i] & 0xff) << 16;
            out.append(B64URL[(n >> 18) & 63]).append(B64URL[(n >> 12) & 63]);
        } else if (rest == 2) {
            int n = ((bytes[i] & 0xff) << 16) | ((bytes[i + 1] & 0xff) << 8);
            out.append(B64URL[(n >> 18) & 63]).append(B64URL[(n >> 12) & 63]).append(B64URL[(n >> 6) & 63]);
        }
        return out.toString();
    }

    /** Standart, dolgulu base64 (WebSocket el sıkışma başlıkları için). */
    public static String base64Encode(byte[] bytes) {
        StringBuilder out = new StringBuilder(base64UrlEncode(bytes).replace('-', '+').replace('_', '/'));
        while (out.length() % 4 != 0) out.append('=');
        return out.toString();
    }

    /** Geçersiz girdide {@code null}. Dolgu ve standart (+/) alfabe kabul edilmez. */
    public static byte[] base64UrlDecode(String text) {
        if (text == null || text.length() % 4 == 1) return null;
        int[] values = new int[text.length()];
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            int v;
            if (c >= 'A' && c <= 'Z') v = c - 'A';
            else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
            else if (c >= '0' && c <= '9') v = c - '0' + 52;
            else if (c == '-') v = 62;
            else if (c == '_') v = 63;
            else return null;
            values[i] = v;
        }
        byte[] out = new byte[text.length() * 3 / 4];
        int o = 0;
        int i = 0;
        for (; i + 3 < values.length; i += 4) {
            int n = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6) | values[i + 3];
            out[o++] = (byte) (n >> 16);
            out[o++] = (byte) (n >> 8);
            out[o++] = (byte) n;
        }
        int rest = values.length - i;
        if (rest == 2) {
            int n = (values[i] << 18) | (values[i + 1] << 12);
            out[o++] = (byte) (n >> 16);
        } else if (rest == 3) {
            int n = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6);
            out[o++] = (byte) (n >> 16);
            out[o++] = (byte) (n >> 8);
        }
        return out;
    }
}
