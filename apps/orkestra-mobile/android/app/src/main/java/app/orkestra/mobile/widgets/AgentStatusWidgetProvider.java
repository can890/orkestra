package app.orkestra.mobile.widgets;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import app.orkestra.mobile.MainActivity;
import app.orkestra.mobile.R;
import org.json.JSONObject;

public class AgentStatusWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        JSONObject data = SovraWidgetStore.read(context);
        int running = data.optInt("runningCount", 0);
        int waiting = data.optInt("waitingApprovalCount", 0);
        String activeTitle = data.optString("activeTitle", "");
        long updatedAt = data.optLong("updatedAt", 0L);

        boolean stale = updatedAt > 0 && (System.currentTimeMillis() - updatedAt) > 10L * 60L * 1000L;
        String headline;
        if (waiting > 0) {
            headline = waiting + " onay bekliyor";
        } else if (running > 0) {
            headline = running + " ajan çalışıyor";
        } else {
            headline = "Tüm ajanlar boşta";
        }

        String subtitle = !activeTitle.isEmpty()
            ? activeTitle
            : stale
                ? "Bağlantı güncellenmeyi bekliyor"
                : "Sovra'yı açmak için dokunun";

        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            7101,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_agent_status);
            views.setTextViewText(R.id.widget_agent_title, "Sovra · Ajan Durumu");
            views.setTextViewText(R.id.widget_agent_headline, headline);
            views.setTextViewText(R.id.widget_agent_subtitle, subtitle);
            views.setOnClickPendingIntent(R.id.widget_agent_root, pending);
            manager.updateAppWidget(id, views);
        }
    }
}
