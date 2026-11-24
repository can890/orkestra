package app.orkestra.mobile.agentnotify;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import org.junit.Test;

/** Protokol kriptosunun JS (`@orkestra/wire/remote`) ile birebir uyumu. */
public class RemoteCryptoTest {
    private static byte[] hex(String value) {
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static byte[] seq(int start, int length) {
        byte[] out = new byte[length];
        for (int i = 0; i < length; i++) out[i] = (byte) (start + i);
        return out;
    }

    @Test
    public void hkdfMatchesRfc5869TestCase1() throws Exception {
        byte[] okm = RemoteCrypto.hkdfSha256(
                hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
                hex("000102030405060708090a0b0c"),
                hex("f0f1f2f3f4f5f6f7f8f9"),
                42);
        assertArrayEquals(
                hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
                okm);
    }

    /** Vektörler Node'da `deriveChannelKeys` + `createFrameSealer` ile üretildi (aynı sır/nonce'lar). */
    @Test
    public void opensFramesSealedByTheTypeScriptServerAndSealsIdentically() throws Exception {
        byte[] secret = seq(1, 32);
        byte[] clientNonce = seq(0xa0, 32);
        byte[] serverNonce = seq(0x10, 32);
        assertEquals("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", RemoteCrypto.base64UrlEncode(secret));

        RemoteCrypto.ClientKeys keys = RemoteCrypto.deriveClientKeys(secret, clientNonce, serverNonce);
        RemoteCrypto.Opener opener = new RemoteCrypto.Opener(keys.receive, RemoteCrypto.DIRECTION_S2C);
        assertEquals(
                "{\"t\":\"welcome\",\"v\":1,\"channel\":\"notifications\"}",
                new String(opener.open(hex("0000000000000000183c161e5c6ef560a41a0dd01894b3929d0e4e01023eeaf81d74311ec68432f9c814545f21cd56bb859fe9b020ec01f68be678ca0e268edba16b21ce453b97")), StandardCharsets.UTF_8));
        assertEquals(
                "{\"t\":\"auth\",\"v\":1}",
                new String(opener.open(hex("0000000000000001630ff7958221403057d59a563e56d59fd3f687f1ebb7e28df287c927cd392591e06f")), StandardCharsets.UTF_8));

        RemoteCrypto.Sealer sealer = new RemoteCrypto.Sealer(keys.send, RemoteCrypto.DIRECTION_C2S);
        assertArrayEquals(
                hex("00000000000000004d377e0582dae791d55dd511d45d6db33f6b9b358dcd6944f26b71064fecfc2ff0bf"),
                sealer.seal("{\"t\":\"auth\",\"v\":1}".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void rejectsReplayedSkippedAndTamperedFrames() throws Exception {
        byte[] key = seq(5, 32);
        RemoteCrypto.Sealer sealer = new RemoteCrypto.Sealer(key, RemoteCrypto.DIRECTION_S2C);
        byte[] first = sealer.seal(new byte[] {1});
        byte[] second = sealer.seal(new byte[] {2});
        byte[] third = sealer.seal(new byte[] {3});

        RemoteCrypto.Opener opener = new RemoteCrypto.Opener(key, RemoteCrypto.DIRECTION_S2C);
        assertArrayEquals(new byte[] {1}, opener.open(first));
        expectFailure(opener, first); // tekrar
        expectFailure(opener, third); // atlanmış
        byte[] tampered = second.clone();
        tampered[tampered.length - 1] ^= 1;
        expectFailure(opener, tampered);
        // Yanlış yön anahtarı/nonce'u ile açılamaz.
        RemoteCrypto.Opener wrongDirection = new RemoteCrypto.Opener(key, RemoteCrypto.DIRECTION_C2S);
        expectFailure(wrongDirection, first);
    }

    private static void expectFailure(RemoteCrypto.Opener opener, byte[] frame) {
        try {
            opener.open(frame);
            fail("frame should be rejected");
        } catch (GeneralSecurityException expected) {
            // beklenen
        }
    }

    @Test
    public void base64UrlRoundTripsAndRejectsForeignAlphabet() {
        for (int length = 0; length < 40; length++) {
            byte[] data = seq(250 - length, length);
            assertArrayEquals(data, RemoteCrypto.base64UrlDecode(RemoteCrypto.base64UrlEncode(data)));
        }
        assertNull(RemoteCrypto.base64UrlDecode("ab+/"));
        assertNull(RemoteCrypto.base64UrlDecode("abc="));
        assertNull(RemoteCrypto.base64UrlDecode("a"));
        assertEquals("AQID", RemoteCrypto.base64Encode(new byte[] {1, 2, 3}));
        assertEquals("AQ==", RemoteCrypto.base64Encode(new byte[] {1}));
    }

    @Test
    public void websocketAcceptMatchesRfc6455Example() {
        assertEquals(
                "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
                MiniWebSocket.expectedAccept("dGhlIHNhbXBsZSBub25jZQ=="));
    }

    @Test
    public void buildsRemoteUrlsLikeTheTypeScriptClient() {
        assertEquals("ws://192.168.1.5:4000/orkestra-remote/v1", HostConfig.urlFor("192.168.1.5", 4000));
        assertEquals("ws://[fd00::1]:4000/orkestra-remote/v1", HostConfig.urlFor("fd00::1", 4000));
        assertEquals("wss://x.trycloudflare.com/orkestra-remote/v1", HostConfig.urlFor("wss://x.trycloudflare.com", 4000));
        assertEquals("wss://x.trycloudflare.com/orkestra-remote/v1", HostConfig.urlFor("wss://x.trycloudflare.com/", 4000));
        assertEquals("wss://x.example/custom", HostConfig.urlFor("wss://x.example/custom", 4000));
    }
}
