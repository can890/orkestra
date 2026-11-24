package app.orkestra.mobile.agentnotify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Telefon açıldığında ya da uygulama güncellendiğinde, kullanıcı arka plan bildirimlerini açık
 * bıraktıysa servisi yeniden başlatır (`specialUse` türü BOOT_COMPLETED'dan başlatılabilir).
 * Uygulama "Zorla durdur" ile durdurulduysa Android bu yayını uygulama yeniden açılana dek iletmez.
 */
public final class AgentNotifyBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        AgentNotifyStore store = new AgentNotifyStore(context);
        if (!store.loadPrefs().enabled || store.loadHosts().isEmpty()) return;
        try {
            AgentActivityService.reload(context);
        } catch (RuntimeException ignored) {
            // Sistem bu anda ön plan servisine izin vermediyse kullanıcı uygulamayı açınca başlar.
        }
    }
}
