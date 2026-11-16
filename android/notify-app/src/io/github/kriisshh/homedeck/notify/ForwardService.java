package io.github.kriisshh.homedeck.notify;

import android.app.Notification;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Android binds this when notification access is on and calls it for each notification; it does
 * nothing in between. Posted notifications go to Home Deck, and ones cleared on the phone are
 * cleared there too.
 */
public class ForwardService extends NotificationListenerService {
    private ConnectivityManager.NetworkCallback networkCallback;

    @Override
    public void onListenerConnected() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null && networkCallback == null) {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    Forwarder.flush(ForwardService.this); // send anything queued while offline
                }
            };
            try {
                cm.registerDefaultNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                networkCallback = null;
            }
        }
        Forwarder.flush(this);
    }

    @Override
    public void onListenerDisconnected() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm != null && networkCallback != null) {
            try { cm.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        }
        networkCallback = null;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (!shouldForward(sbn)) return;
        Bundle extras = sbn.getNotification().extras;
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE_BIG));
        if (title.isEmpty()) title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (body.isEmpty()) {
            CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES); // inbox style
            if (lines != null && lines.length > 0) {
                StringBuilder sb = new StringBuilder();
                for (CharSequence line : lines) sb.append(sb.length() > 0 ? "\n" : "").append(line);
                body = sb.toString();
            }
        }
        if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (title.isEmpty() && body.isEmpty()) return;
        try {
            JSONObject json = new JSONObject()
                    .put("app", appName(sbn.getPackageName()))
                    .put("pkg", sbn.getPackageName())
                    .put("title", title)
                    .put("text", body)
                    .put("nkey", sbn.getKey());
            Forwarder.enqueue(this, "/notify", json);
        } catch (JSONException ignored) {
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (!shouldForward(sbn)) return; // never sent, so nothing to clear
        try {
            Forwarder.enqueue(this, "/notifications/dismiss", new JSONObject().put("nkeys", new JSONArray().put(sbn.getKey())));
        } catch (JSONException ignored) {
        }
    }

    private boolean shouldForward(StatusBarNotification sbn) {
        Notification n = sbn.getNotification();
        if (sbn.getPackageName().equals(getPackageName())) return false;
        if (sbn.isOngoing() || !sbn.isClearable()) return false; // music players, downloads, VPN status
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return false; // "3 new messages" summaries
        if ((n.flags & Notification.FLAG_FOREGROUND_SERVICE) != 0) return false;
        return !Notification.CATEGORY_PROGRESS.equals(n.category) && !Notification.CATEGORY_SERVICE.equals(n.category);
    }

    private String appName(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(info));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static String text(CharSequence s) {
        return s == null ? "" : s.toString().trim();
    }
}
