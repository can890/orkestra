package app.orkestra.mobile.agentnotify;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * WebView köprüsünün (`SovraNative.agentNotify*`) arka plan bildirimleriyle ilgili kısmı.
 * JS tarafı: `src/core/agent-notifications/native.ts`.
 */
public final class AgentNotifyBridge {
    private AgentNotifyBridge() {}

    /**
     * Tercihleri ve (verildiyse) bilgisayar listesini kaydeder; servisi başlatır/durdurur.
     * Kapatınca servisin kendi şifreli sır kopyası silinir.
     */
    public static String configure(Context context, String json) {
        AgentNotifyStore store = new AgentNotifyStore(context);
        try {
            JSONObject root = new JSONObject(json);
            JSONObject rawPrefs = root.optJSONObject("prefs");
            NotifyPrefs prefs = rawPrefs != null ? AgentNotifyStore.parsePrefs(rawPrefs) : store.loadPrefs();
            store.savePrefs(prefs);
            if (!prefs.enabled) {
                store.saveHosts(java.util.Collections.emptyList());
                AgentActivityService.stop(context);
                return status(context);
            }
            if (root.has("hosts")) {
                List<HostConfig> hosts = AgentNotifyStore.parseHosts(root.optJSONArray("hosts"));
                store.saveHosts(hosts);
            }
            if (store.loadHosts().isEmpty()) {
                AgentActivityService.stop(context);
            } else {
                AgentActivityService.reload(context);
            }
        } catch (Exception error) {
            // Bozuk girdi ya da servis başlatılamadı: durum çağıran tarafa yansır.
        }
        return status(context);
    }

    public static String status(Context context) {
        try {
            JSONObject hosts = new JSONObject();
            for (Map.Entry<String, String> entry : AgentActivityService.HOST_STATUS.entrySet()) {
                hosts.put(entry.getKey(), entry.getValue());
            }
            AgentNotifyStore store = new AgentNotifyStore(context);
            return new JSONObject()
                    .put("supported", true)
                    .put("sdk", Build.VERSION.SDK_INT)
                    .put("enabled", store.loadPrefs().enabled)
                    .put("running", AgentActivityService.running)
                    .put("permission", permissionState(context))
                    .put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
                    .put("batteryOptimized", isBatteryOptimized(context))
                    .put("hosts", hosts)
                    .toString();
        } catch (Exception error) {
            return "{\"supported\":true}";
        }
    }

    static String permissionState(Context context) {
        if (Build.VERSION.SDK_INT < 33) return "not-required";
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED
                ? "granted"
                : "denied";
    }

    static boolean isBatteryOptimized(Context context) {
        PowerManager power = context.getSystemService(PowerManager.class);
        return power != null && !power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    /** Pil optimizasyonu listesi (özel izin gerektirmeyen ekran); yoksa uygulama ayrıntıları. */
    public static boolean openBatterySettings(Activity activity) {
        try {
            activity.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            return true;
        } catch (RuntimeException error) {
            return openAppDetails(activity);
        }
    }

    /** Uygulamanın bildirim ayarları (kanal bazında sessize alma burada). */
    public static boolean openNotificationSettings(Activity activity) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
            activity.startActivity(intent);
            return true;
        } catch (RuntimeException error) {
            return openAppDetails(activity);
        }
    }

    private static boolean openAppDetails(Activity activity) {
        try {
            activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + activity.getPackageName())));
            return true;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    /** Ön planda açık sohbet (JS her ekran değişiminde bildirir); boş değerler "sohbet yok". */
    public static void setVisibleConversation(Context context, String hostId, String conversationId) {
        String host = hostId == null || hostId.isEmpty() ? null : hostId;
        String conversation = conversationId == null || conversationId.isEmpty() ? null : conversationId;
        AgentActivityService.visibleHostId = host;
        AgentActivityService.visibleConversationId = conversation;
        if (host != null && conversation != null && AgentActivityService.appVisible) {
            AgentActivityService.onConversationVisible(context, host, conversation);
        }
    }

    public static void setAppVisible(boolean visible) {
        AgentActivityService.appVisible = visible;
    }

    /** Bildirime dokunmayla gelen hedef (`{"hostId":…,"conversationId":…}`) ya da {@code null}. */
    public static String launchTargetFrom(Intent intent) {
        if (intent == null || !AgentActivityService.ACTION_OPEN_CONVERSATION.equals(intent.getAction())) {
            return null;
        }
        String hostId = intent.getStringExtra(AgentActivityService.EXTRA_HOST_ID);
        String conversationId = intent.getStringExtra(AgentActivityService.EXTRA_CONVERSATION_ID);
        if (hostId == null || conversationId == null) return null;
        try {
            return new JSONObject().put("hostId", hostId).put("conversationId", conversationId).toString();
        } catch (Exception error) {
            return null;
        }
    }
}
