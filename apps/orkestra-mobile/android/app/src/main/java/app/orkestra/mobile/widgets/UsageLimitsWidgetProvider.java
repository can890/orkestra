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

public class UsageLimitsWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        JSONObject data = SovraWidgetStore.read(context);
        String summary = data.optString("usageSummary", "Kota bilgisi bekleniyor");
        int pct = Math.max(0, Math.min(100, data.optInt("usagePercent", 0)));

        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            7102,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        for (int id : appWidgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_usage_limits);
            views.setTextViewText(R.id.widget_usage_title, "Sovra · Kullanım Limitleri");
            views.setTextViewText(R.id.widget_usage_summary, summary);
            views.setProgressBar(R.id.widget_usage_progress, 100, pct, false);
            views.setOnClickPendingIntent(R.id.widget_usage_root, pending);
            manager.updateAppWidget(id, views);
        }
    }
}
