package io.github.kriisshh.homedeck.keeper;

import android.app.Activity;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Opening the app starts the keeper (it also starts on boot) and says what it does. */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        KeeperService.start(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24, getResources().getDisplayMetrics());
        col.setPadding(pad, pad * 2, pad, pad);
        TextView title = new TextView(this);
        title.setText("Relay Keeper is on");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        col.addView(title);
        TextView body = new TextView(this);
        body.setText("It keeps this phone's Wi-Fi from napping, so Home Deck and Wake-on-LAN get instant answers. "
                + "It starts by itself after a reboot. Nothing else to do - you can close this screen.");
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        body.setPadding(0, pad / 2, 0, 0);
        col.addView(body);
        setContentView(col);
    }
}
