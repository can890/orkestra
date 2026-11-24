package app.orkestra.mobile.agentnotify;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Arka plan servisi için en küçük RFC 6455 WebSocket istemcisi (yalnızca istemci tarafı,
 * sıkıştırmasız). Uygulamaya yeni bağımlılık (OkHttp vb.) eklememek için yazıldı. `ws://` (LAN /
 * Tailscale; içerik uygulama katmanında şifreli) ve `wss://` (tünel; TLS + ana makine adı
 * doğrulaması) destekler. Engelleyen G/Ç kullanır: okuma tek iş parçacığından yapılmalıdır.
 */
public final class MiniWebSocket {
    public static final int MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    /** Alınan veri mesajı: metin ya da ikili. Kontrol çerçeveleri içeride işlenir. */
    public static final class Message {
        public final boolean text;
        public final byte[] data;

        Message(boolean text, byte[] data) {
            this.text = text;
            this.data = data;
        }

        public String asText() {
            return new String(data, StandardCharsets.UTF_8);
        }
    }

    /** Karşı taraf kapattı; kapanış kodu (yoksa 1005). */
    public static final class ClosedException extends IOException {
        public final int code;
        public final String reason;

        ClosedException(int code, String reason) {
            super("closed " + code);
            this.code = code;
            this.reason = reason;
        }
    }

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private final Object writeLock = new Object();
    private volatile boolean closed = false;

    private MiniWebSocket(Socket socket) throws IOException {
        this.socket = socket;
        this.in = socket.getInputStream();
        this.out = socket.getOutputStream();
    }

    /** `ws://ana-makine:port/yol` ya da `wss://ana-makine/yol` adresine bağlanır ve el sıkışır. */
    public static MiniWebSocket connect(String url, int timeoutMs) throws IOException {
        URI uri = URI.create(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        boolean secure = "wss".equals(scheme);
        if (!secure && !"ws".equals(scheme)) throw new IOException("unsupported scheme");
        String host = uri.getHost();
        if (host == null) throw new IOException("missing host");
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        int port = uri.getPort() > 0 ? uri.getPort() : (secure ? 443 : 80);
        String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();

        Socket raw = new Socket();
        raw.setTcpNoDelay(true);
        raw.setKeepAlive(true);
        raw.connect(new InetSocketAddress(host, port), timeoutMs);
        Socket socket = raw;
        try {
            if (secure) {
                SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) factory.createSocket(raw, host, port, true);
                ssl.setSoTimeout(timeoutMs);
                ssl.startHandshake();
                HostnameVerifier verifier = HttpsURLConnection.getDefaultHostnameVerifier();
                if (!verifier.verify(host, ssl.getSession())) {
                    throw new IOException("TLS hostname mismatch");
                }
                socket = ssl;
            }
            socket.setSoTimeout(timeoutMs);
            MiniWebSocket ws = new MiniWebSocket(socket);
            ws.handshake(host, port, secure, path);
            return ws;
        } catch (IOException | RuntimeException error) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
            throw error;
        }
    }

    private void handshake(String host, int port, boolean secure, String path) throws IOException {
        byte[] keyBytes = RemoteCrypto.randomBytes(16);
        String key = RemoteCrypto.base64Encode(keyBytes);
        boolean defaultPort = (secure && port == 443) || (!secure && port == 80);
        String hostHeader = (host.contains(":") ? "[" + host + "]" : host) + (defaultPort ? "" : ":" + port);
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: Orkestra-Android-Notifications\r\n\r\n";
        out.write(request.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        String status = readLine();
        if (!status.startsWith("HTTP/1.1 101")) throw new IOException("upgrade refused");
        String accept = null;
        boolean upgrade = false;
        while (true) {
            String line = readLine();
            if (line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            if ("sec-websocket-accept".equals(name)) accept = value;
            if ("upgrade".equals(name) && "websocket".equalsIgnoreCase(value)) upgrade = true;
        }
        if (!upgrade || accept == null || !accept.equals(expectedAccept(key))) {
            throw new IOException("bad upgrade response");
        }
    }

    static String expectedAccept(String key) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + GUID).getBytes(StandardCharsets.ISO_8859_1));
            return RemoteCrypto.base64Encode(digest);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private String readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        while (true) {
            int b = in.read();
            if (b < 0) throw new EOFException();
            if (b == '\n') break;
            if (b != '\r') line.write(b);
            if (line.size() > 8192) throw new IOException("header too long");
        }
        return line.toString("ISO-8859-1");
    }

    /** Okuma zaman aşımı (ms); boşta kalma denetimi için. */
    public void setReadTimeout(int timeoutMs) throws IOException {
        socket.setSoTimeout(timeoutMs);
    }

    public void sendText(String text) throws IOException {
        sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    public void sendBinary(byte[] data) throws IOException {
        sendFrame(0x2, data);
    }

    /** Sonraki veri mesajını okur (ping'e pong verir, parçalı mesajları birleştirir). */
    public Message read() throws IOException {
        ByteArrayOutputStream assembled = null;
        boolean assembledText = false;
        while (true) {
            int b0 = readByte();
            int b1 = readByte();
            boolean fin = (b0 & 0x80) != 0;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long length = b1 & 0x7f;
            if (length == 126) {
                length = ((long) readByte() << 8) | readByte();
            } else if (length == 127) {
                length = 0;
                for (int i = 0; i < 8; i++) length = (length << 8) | readByte();
            }
            if (length < 0 || length > MAX_MESSAGE_BYTES) throw new IOException("frame too large");
            byte[] mask = masked ? readFully(4) : null;
            byte[] payload = readFully((int) length);
            if (mask != null) {
                for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            switch (opcode) {
                case 0x8: {
                    int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                    String reason = payload.length > 2
                            ? new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8)
                            : "";
                    close(1000);
                    throw new ClosedException(code, reason);
                }
                case 0x9:
                    sendFrame(0xA, payload);
                    continue;
                case 0xA:
                    continue;
                case 0x0:
                    if (assembled == null) throw new IOException("unexpected continuation");
                    assembled.write(payload);
                    break;
                case 0x1:
                case 0x2:
                    if (assembled != null) throw new IOException("interleaved message");
                    if (fin) return new Message(opcode == 0x1, payload);
                    assembled = new ByteArrayOutputStream();
                    assembled.write(payload);
                    assembledText = opcode == 0x1;
                    break;
                default:
                    throw new IOException("unknown opcode");
            }
            if (assembled.size() > MAX_MESSAGE_BYTES) throw new IOException("message too large");
            if (fin) return new Message(assembledText, assembled.toByteArray());
        }
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b < 0) throw new EOFException();
        return b;
    }

    private byte[] readFully(int length) throws IOException {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(buffer, offset, length - offset);
            if (read < 0) throw new EOFException();
            offset += read;
        }
        return buffer;
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        if (closed) throw new IOException("socket closed");
        byte[] mask = RemoteCrypto.randomBytes(4);
        int headerLength = 2 + (payload.length > 65535 ? 8 : payload.length > 125 ? 2 : 0) + 4;
        byte[] frame = new byte[headerLength + payload.length];
        frame[0] = (byte) (0x80 | opcode);
        int offset;
        if (payload.length > 65535) {
            frame[1] = (byte) (0x80 | 127);
            long len = payload.length;
            for (int i = 9; i >= 2; i--) {
                frame[i] = (byte) (len & 0xff);
                len >>>= 8;
            }
            offset = 10;
        } else if (payload.length > 125) {
            frame[1] = (byte) (0x80 | 126);
            frame[2] = (byte) (payload.length >>> 8);
            frame[3] = (byte) payload.length;
            offset = 4;
        } else {
            frame[1] = (byte) (0x80 | payload.length);
            offset = 2;
        }
        System.arraycopy(mask, 0, frame, offset, 4);
        offset += 4;
        for (int i = 0; i < payload.length; i++) frame[offset + i] = (byte) (payload[i] ^ mask[i % 4]);
        synchronized (writeLock) {
            out.write(frame);
            out.flush();
        }
    }

    /** Kapanış çerçevesi gönderip soketi kapatır; birden çok kez çağrılabilir. */
    public void close(int code) {
        if (closed) return;
        try {
            byte[] payload = new byte[] {(byte) (code >>> 8), (byte) code};
            sendFrame(0x8, payload);
        } catch (IOException ignored) {
        }
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    public boolean isClosed() {
        return closed || socket.isClosed();
    }
}
