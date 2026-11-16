package io.github.kriisshh.homedeck.notify;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends notifications to the wake service (POST /notify, /notifications/dismiss) on one background
 * thread. Anything that can't be sent (Wi-Fi or Tailscale down) waits in a small queue and goes out
 * with the next send or when the network comes back.
 */
final class Forwarder {
    static final String PREFS = "settings";
    static final String DEFAULT_URL = "http://100.107.6.16:9009";     // always-on phone over Tailscale
    static final String DEFAULT_LAN_URL = "http://192.168.3.6:9009";  // the same phone on home Wi-Fi
    private static final int QUEUE_MAX = 100;
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    private Forwarder() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Queue one request (path + JSON body) and flush the queue in the background. */
    static void enqueue(Context context, String path, JSONObject body) {
        Context app = context.getApplicationContext();
        WORKER.execute(() -> {
            synchronized (Forwarder.class) {
                JSONArray queue = load(app);
                try {
                    queue.put(new JSONObject().put("path", path).put("body", body));
                } catch (JSONException ignored) {
                    return;
                }
                while (queue.length() > QUEUE_MAX) queue.remove(0);
                save(app, queue);
            }
            flushNow(app);
        });
    }

    static void flush(Context context) {
        Context app = context.getApplicationContext();
        WORKER.execute(() -> flushNow(app));
    }

    private static void flushNow(Context app) {
        SharedPreferences p = prefs(app);
        // Tailscale first (works anywhere); without Tailscale, the home Wi-Fi address still works at home.
        java.util.List<String> bases = addresses(p);
        String key = p.getString("key", "").trim();
        if (key.isEmpty()) return;
        while (true) {
            JSONObject next;
            synchronized (Forwarder.class) {
                JSONArray queue = load(app);
                if (queue.length() == 0) return;
                next = queue.optJSONObject(0);
            }
            int status = 200;
            if (next != null) {
                for (String base : bases) {
                    if (base.isEmpty()) continue;
                    status = post(base + next.optString("path"), key, next.optJSONObject("body"));
                    if (status != 0) break; // reached the server (even if it said no): don't try the other address
                }
            }
            if (status == 401) {
                status(app, "Wrong key - check it below");
                return; // keep the queue; it goes out once the key is fixed
            }
            if (status < 200 || status >= 300) {
                status(app, status == 0 ? "Waiting for the network (" + pending(app) + " queued)" : "Server answered HTTP " + status);
                return;
            }
            synchronized (Forwarder.class) {
                JSONArray queue = load(app);
                if (queue.length() > 0) queue.remove(0);
                save(app, queue);
            }
            status(app, "Last sent " + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(new java.util.Date()));
        }
    }

    /** Tailscale address first, then each home address (several allowed, separated by commas or spaces). */
    static java.util.List<String> addresses(SharedPreferences p) {
        java.util.List<String> out = new java.util.ArrayList<>();
        out.add(clean(p.getString("url", DEFAULT_URL)));
        for (String part : p.getString("lanUrl", DEFAULT_LAN_URL).split("[,\\s]+")) out.add(clean(part));
        out.removeIf(String::isEmpty);
        return out;
    }

    static String clean(String url) {
        return url == null ? "" : url.trim().replaceAll("/+$", "");
    }

    /** POST JSON; returns the HTTP status, or 0 if the server couldn't be reached. */
    static int post(String url, String key, JSONObject body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("X-Key", key);
            byte[] data = (body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(data.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(data);
            }
            int code = conn.getResponseCode();
            try { (code < 400 ? conn.getInputStream() : conn.getErrorStream()).close(); } catch (IOException | NullPointerException ignored) {}
            return code;
        } catch (IOException e) {
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static int pending(Context app) {
        synchronized (Forwarder.class) {
            return load(app).length();
        }
    }

    static String status(Context app) {
        return prefs(app).getString("status", "Nothing sent yet");
    }

    private static void status(Context app, String text) {
        prefs(app).edit().putString("status", text).apply();
    }

    private static JSONArray load(Context app) {
        try {
            return new JSONArray(prefs(app).getString("queue", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void save(Context app, JSONArray queue) {
        prefs(app).edit().putString("queue", queue.toString()).commit();
    }
}
