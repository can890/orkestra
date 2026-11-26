package app.orkestra.mobile.widgets;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import org.json.JSONObject;

public final class SovraWidgetStore {
    private static final String PREFS_NAME = "sovra_home_widgets";
    private static final String KEY_SNAPSHOT = "snapshot_json";

    private SovraWidgetStore() {}

    public static void saveAndRefresh(Context context, String json) {
        if (context == null || json == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_SNAPSHOT, json).apply();
        notifyWidget(context, AgentStatusWidgetProvider.class);
        notifyWidget(context, UsageLimitsWidgetProvider.class);
    }

    public static JSONObject read(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_SNAPSHOT, null);
            return raw != null ? new JSONObject(raw) : new JSONObject();
        } catch (Throwable ignored) {
            return new JSONObject();
        }
    }

    private static void notifyWidget(Context context, Class<?> providerClass) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, providerClass));
            if (ids != null && ids.length > 0) {
                Intent intent = new Intent(context, providerClass);
                intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
                context.sendBroadcast(intent);
            }
        } catch (Throwable ignored) {
            // ignore widget refresh failures
        }
    }
}
