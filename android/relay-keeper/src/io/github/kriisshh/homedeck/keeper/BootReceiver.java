package io.github.kriisshh.homedeck.keeper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the keeper after every reboot (and after an update of this app). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        KeeperService.start(context);
    }
}
