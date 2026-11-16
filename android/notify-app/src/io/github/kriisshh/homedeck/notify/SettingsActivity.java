package io.github.kriisshh.homedeck.notify;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

/** The one screen: server address, key, notification access, a test, and the last send status. */
public class SettingsActivity extends Activity {
    private EditText url;
    private EditText key;
    private TextView access;
    private TextView status;
    private Button accessButton;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(24);
        col.setPadding(pad, dp(40), pad, pad);

        TextView title = text("Home Deck Notify", 28, true);
        col.addView(title);
        col.addView(text("Sends this phone's notifications to Home Deck, through the always-on phone. It only runs when a notification arrives.", 15, false), gap(8));

        col.addView(label("Server"), gap(28));
        url = input(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        col.addView(url);
        col.addView(label("Notification key"), gap(16));
        key = input(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        key.setHint("ABCD-EFGH");
        col.addView(key);

        Button save = button("Save");
        save.setOnClickListener(v -> save(true));
        col.addView(save, gap(16));

        access = text("", 15, false);
        col.addView(access, gap(28));
        accessButton = button("Allow notification access");
        accessButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        col.addView(accessButton, gap(8));

        Button test = button("Send a test notification");
        test.setOnClickListener(v -> sendTest());
        col.addView(test, gap(28));
        status = text("", 14, false);
        status.setAlpha(0.6f);
        col.addView(status, gap(8));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);

        url.setText(Forwarder.prefs(this).getString("url", Forwarder.DEFAULT_URL));
        key.setText(Forwarder.prefs(this).getString("key", ""));
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean on = hasAccess();
        access.setText(on ? "Notification access is on." : "Notification access is off. Turn it on for Home Deck Notify, or nothing will be sent.");
        accessButton.setText(on ? "Notification access settings" : "Allow notification access");
        status.setText(Forwarder.status(this) + (Forwarder.pending(this) > 0 ? " - " + Forwarder.pending(this) + " waiting" : ""));
    }

    private void save(boolean toast) {
        String u = url.getText().toString().trim().replaceAll("/+$", "");
        if (!u.startsWith("http")) u = "http://" + u;
        Forwarder.prefs(this).edit().putString("url", u).putString("key", key.getText().toString().trim()).apply();
        url.setText(u);
        Forwarder.flush(this);
        if (toast) Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
    }

    private void sendTest() {
        save(false);
        String u = Forwarder.prefs(this).getString("url", Forwarder.DEFAULT_URL);
        String k = Forwarder.prefs(this).getString("key", "");
        status.setText("Sending…");
        new Thread(() -> {
            int code;
            try {
                code = Forwarder.post(u + "/notify", k, new JSONObject()
                        .put("app", "Home Deck Notify").put("pkg", getPackageName())
                        .put("title", "Test notification").put("text", "If you can read this on the Surface, it works."));
            } catch (JSONException e) {
                code = -1;
            }
            int c = code;
            runOnUiThread(() -> status.setText(c >= 200 && c < 300 ? "Test sent - check Home Deck"
                    : c == 401 ? "Wrong key" : c == 0 ? "Can't reach " + u + " (is Tailscale on?)" : "Server answered HTTP " + c));
        }).start();
    }

    private boolean hasAccess() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(new ComponentName(this, ForwardService.class).flattenToString());
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s.toUpperCase(), 13, false);
        t.setAlpha(0.6f);
        return t;
    }

    private EditText input(int type) {
        EditText e = new EditText(this);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTypeface(Typeface.MONOSPACE);
        return e;
    }

    private Button button(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setGravity(Gravity.CENTER);
        return b;
    }

    private LinearLayout.LayoutParams gap(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        return lp;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }
}
