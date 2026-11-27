package app.orkestra.mobile.agentnotify;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Arka plan bildirim servisinin kalıcı durumu.
 * - Tercihler: düz SharedPreferences (sır değil).
 * - Bilgisayar listesi (eşleştirme sırları dahil): Android Keystore'daki, dışarı çıkarılamayan bir
 *   AES-GCM anahtarıyla şifreli olarak SharedPreferences'ta. Uygulamanın JS tarafındaki güvenli
 *   depoyla aynı koruma düzeyi; yedekleme kapalıdır (`allowBackup=false`).
 */
public final class AgentNotifyStore {
    private static final String PREFS = "orkestra_agent_notify";
    private static final String KEY_PREFS = "prefs";
    private static final String KEY_HOSTS = "hosts_enc";
    private static final String KEY_DISMISSED = "ongoing_dismissed_signature";
    private static final String KEYSTORE_ALIAS = "orkestra_agent_notify_hosts";
    private static final int MAX_HOSTS = 8;

    private final SharedPreferences prefs;

    public AgentNotifyStore(Context context) {
        this.prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public NotifyPrefs loadPrefs() {
        String raw = prefs.getString(KEY_PREFS, null);
        NotifyPrefs defaults = NotifyPrefs.defaults();
        if (raw == null) return defaults;
        try {
            return parsePrefs(new JSONObject(raw));
        } catch (Exception error) {
            return defaults;
        }
    }

    public static NotifyPrefs parsePrefs(JSONObject json) {
        NotifyPrefs d = NotifyPrefs.defaults();
        return new NotifyPrefs(
                json.optBoolean("enabled", d.enabled),
                json.optBoolean("finished", d.finished),
                json.optBoolean("failed", d.failed),
                json.optBoolean("approval", d.approval),
                json.optBoolean("question", d.question),
                json.optBoolean("ongoing", d.ongoing));
    }

    public void savePrefs(NotifyPrefs value) {
        try {
            JSONObject json = new JSONObject()
                    .put("enabled", value.enabled)
                    .put("finished", value.finished)
                    .put("failed", value.failed)
                    .put("approval", value.approval)
                    .put("question", value.question)
                    .put("ongoing", value.ongoing);
            prefs.edit().putString(KEY_PREFS, json.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** JS'ten gelen bilgisayar listesini doğrular (geçersizler atlanır). Sır içeren JSON loglanmaz. */
    public static List<HostConfig> parseHosts(JSONArray array) {
        List<HostConfig> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length() && out.size() < MAX_HOSTS; i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            JSONArray rawAddresses = item.optJSONArray("addresses");
            List<String> addresses = new ArrayList<>();
            if (rawAddresses != null) {
                for (int j = 0; j < rawAddresses.length() && addresses.size() < 6; j++) {
                    String address = rawAddresses.optString(j, "").trim();
                    if (!address.isEmpty() && !address.startsWith("ws://")) addresses.add(address);
                }
            }
            byte[] secret = RemoteCrypto.base64UrlDecode(item.optString("secret", ""));
            if (secret == null) continue;
            String discoveryUrl = item.optString("discoveryUrl", "").trim();
            HostConfig host = new HostConfig(
                    item.optString("hostId", ""),
                    item.optString("hostName", ""),
                    addresses,
                    item.optInt("port", 0),
                    item.optString("deviceId", ""),
                    secret,
                    discoveryUrl.isEmpty() ? null : discoveryUrl);
            if (host.isValid()) out.add(host);
        }
        return out;
    }

    static JSONArray serializeHosts(List<HostConfig> hosts) throws Exception {
        JSONArray array = new JSONArray();
        for (HostConfig host : hosts) {
            JSONArray addresses = new JSONArray();
            for (String address : host.addresses) addresses.put(address);
            JSONObject obj = new JSONObject()
                    .put("hostId", host.hostId)
                    .put("hostName", host.hostName)
                    .put("addresses", addresses)
                    .put("port", host.port)
                    .put("deviceId", host.deviceId)
                    .put("secret", RemoteCrypto.base64UrlEncode(host.secret));
            if (host.discoveryUrl != null && !host.discoveryUrl.isEmpty()) {
                obj.put("discoveryUrl", host.discoveryUrl);
            }
            array.put(obj);
        }
        return array;
    }

    public List<HostConfig> loadHosts() {
        String stored = prefs.getString(KEY_HOSTS, null);
        if (stored == null) return new ArrayList<>();
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            if (blob.length < 13) return new ArrayList<>();
            byte[] iv = new byte[12];
            System.arraycopy(blob, 0, iv, 0, 12);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, iv));
            byte[] plain = cipher.doFinal(blob, 12, blob.length - 12);
            return parseHosts(new JSONArray(new String(plain, StandardCharsets.UTF_8)));
        } catch (Exception error) {
            // Anahtar silinmiş/bozuk kayıt: güvenli tarafta kal, listeyi boş say (JS yeniden gönderir).
            return new ArrayList<>();
        }
    }

    public boolean saveHosts(List<HostConfig> hosts) {
        if (hosts.isEmpty()) {
            prefs.edit().remove(KEY_HOSTS).apply();
            return true;
        }
        try {
            byte[] plain = serializeHosts(hosts).toString().getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keystoreKey());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(plain);
            byte[] blob = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
            prefs.edit().putString(KEY_HOSTS, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    public String loadDismissedSignature() {
        return prefs.getString(KEY_DISMISSED, "");
    }

    public void saveDismissedSignature(String signature) {
        prefs.edit().putString(KEY_DISMISSED, signature == null ? "" : signature).apply();
    }

    private static SecretKey keystoreKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEYSTORE_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                        KEYSTORE_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
