package app.orkestra.mobile.agentnotify;

import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * Bildirim kanalları: her uyarı türü ayrı kanaldadır, böylece kullanıcı Android ayarlarından tek
 * tek sessize alabilir/kapatabilir. Süren etkinlik kartı ve arka plan bağlantı durumu da ayrıdır.
 */
public final class AgentNotifyChannels {
    public static final String GROUP = "orkestra_agents";
    public static final String ONGOING = "agent_ongoing";
    public static final String SERVICE = "agent_service";
    public static final String FINISHED = "agent_finished";
    public static final String FAILED = "agent_failed";
    public static final String APPROVAL = "agent_approval";
    public static final String QUESTION = "agent_question";

    private AgentNotifyChannels() {}

    public static String forState(String state) {
        switch (state) {
            case ActivityEntry.NEEDS_APPROVAL:
                return APPROVAL;
            case ActivityEntry.ASKED_QUESTION:
                return QUESTION;
            case ActivityEntry.FAILED:
                return FAILED;
            default:
                return FINISHED;
        }
    }

    public static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannelGroup(new NotificationChannelGroup(GROUP, "Ajan bildirimleri"));

        NotificationChannel ongoing =
                new NotificationChannel(ONGOING, "Süren ajan etkinliği", NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription("Çalışan ajanları ve son 15 dakikadaki sonuçları tek kartta özetler.");
        ongoing.setShowBadge(false);
        ongoing.setGroup(GROUP);

        NotificationChannel service =
                new NotificationChannel(SERVICE, "Arka plan bağlantısı", NotificationManager.IMPORTANCE_MIN);
        service.setDescription("Bilgisayarlarınıza arka plan bağlantısının açık olduğunu gösterir.");
        service.setShowBadge(false);
        service.setGroup(GROUP);

        NotificationChannel finished =
                new NotificationChannel(FINISHED, "Ajan işini bitirdi", NotificationManager.IMPORTANCE_DEFAULT);
        finished.setDescription("Bir ajan turu tamamladığında bildirir.");
        finished.setGroup(GROUP);

        NotificationChannel failed =
                new NotificationChannel(FAILED, "Ajan hata verdi", NotificationManager.IMPORTANCE_DEFAULT);
        failed.setDescription("Bir ajan turu hatayla bittiğinde bildirir.");
        failed.setGroup(GROUP);

        NotificationChannel approval =
                new NotificationChannel(APPROVAL, "Ajan onay bekliyor", NotificationManager.IMPORTANCE_HIGH);
        approval.setDescription("Bir ajan bir eylem için izninizi beklediğinde anında uyarır.");
        approval.enableVibration(true);
        approval.setGroup(GROUP);

        NotificationChannel question =
                new NotificationChannel(QUESTION, "Ajan soru soruyor", NotificationManager.IMPORTANCE_HIGH);
        question.setDescription("Bir ajan sizden yanıt beklediğinde anında uyarır.");
        question.enableVibration(true);
        question.setGroup(GROUP);

        manager.createNotificationChannel(ongoing);
        manager.createNotificationChannel(service);
        manager.createNotificationChannel(finished);
        manager.createNotificationChannel(failed);
        manager.createNotificationChannel(approval);
        manager.createNotificationChannel(question);
    }
}
