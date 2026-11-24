package app.orkestra.mobile.agentnotify;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Arka plan servisinin bağlanacağı eşleşmiş bilgisayar. `secret` eşleştirme sırrıdır (32 bayt);
 * yalnızca Keystore ile şifreli depoda (HostStore) ve bellekte tutulur, loglanmaz.
 */
public final class HostConfig {
    public static final String REMOTE_PATH = "/orkestra-remote/v1";

    public final String hostId;
    public final String hostName;
    public final List<String> addresses;
    public final int port;
    public final String deviceId;
    public final byte[] secret;

    public HostConfig(
            String hostId, String hostName, List<String> addresses, int port, String deviceId, byte[] secret) {
        this.hostId = hostId;
        this.hostName = hostName == null ? "" : hostName;
        this.addresses = Collections.unmodifiableList(new ArrayList<>(addresses));
        this.port = port;
        this.deviceId = deviceId;
        this.secret = secret.clone();
    }

    public boolean isValid() {
        return hostId != null
                && !hostId.isEmpty()
                && deviceId != null
                && deviceId.matches("^[A-Za-z0-9_-]{8,64}$")
                && secret.length == RemoteCrypto.SECRET_BYTES
                && port >= 1
                && port <= 65535
                && !addresses.isEmpty();
    }

    /** `remote-access.md` §3: `ws://adres:port/orkestra-remote/v1` ya da `wss://tünel[/yol]`. */
    public static String urlFor(String address, int port) {
        if (address.startsWith("wss://") || address.startsWith("ws://")) {
            int schemeEnd = address.indexOf("://") + 3;
            int slash = address.indexOf('/', schemeEnd);
            if (slash < 0 || slash == address.length() - 1) {
                String base = slash < 0 ? address : address.substring(0, slash);
                return base + REMOTE_PATH;
            }
            return address;
        }
        String host = address.contains(":") && !address.startsWith("[") ? "[" + address + "]" : address;
        return "ws://" + host + ":" + port + REMOTE_PATH;
    }
}
