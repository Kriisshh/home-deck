package io.github.kriisshh.homedeck.keeper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.IBinder;

/**
 * Keeps the always-on phone's Wi-Fi from napping: a high-performance Wi-Fi lock, plus a tiny packet
 * to the router every 150 ms for chips that ignore the lock (Samsung's). It runs as a foreground
 * service with a silent, minimal notification, so Android doesn't stop it.
 */
public class KeeperService extends Service {
    private static final String CHANNEL = "keeper";
    private WifiManager.WifiLock wifiLock;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, KeeperService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Relay Keeper", NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_wifi)
                .setContentTitle("Keeping Wi-Fi responsive")
                .setContentText("For Home Deck and Wake-on-LAN")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        startForeground(1, n);

        WifiManager wm = getApplicationContext().getSystemService(WifiManager.class);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "homedeck:relay");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
        startPinger();
    }

    // Samsung's Wi-Fi driver ignores the lock's "no power saving" request, but its chip stays awake
    // while it's sending. A tiny packet to the router every 150 ms (about 400 bytes/s, discarded by
    // the router) keeps incoming packets at ~3 ms instead of 0.3-3 s.
    private static final int PING_MS = 150;
    private volatile boolean pinging;

    private void startPinger() {
        if (pinging) return;
        pinging = true;
        Thread t = new Thread(() -> {
            byte[] payload = new byte[] { 'h', 'd' };
            java.net.DatagramSocket sock = null;
            int misses = 0;
            while (pinging) {
                try {
                    if (sock == null) sock = new java.net.DatagramSocket();
                    java.net.InetAddress gw = gateway();
                    if (gw != null) sock.send(new java.net.DatagramPacket(payload, payload.length, gw, 9)); // port 9: discard
                    else if (++misses % 200 == 1) android.util.Log.w("RelayKeeper", "no Wi-Fi gateway");
                } catch (Exception e) {
                    if (++misses % 200 == 1) android.util.Log.w("RelayKeeper", "keep-alive failed: " + e);
                    if (sock != null) sock.close();
                    sock = null;
                }
                try {
                    Thread.sleep(PING_MS);
                } catch (InterruptedException e) {
                    break;
                }
            }
            if (sock != null) sock.close();
        }, "keeper-ping");
        t.setDaemon(true);
        t.start();
    }

    private java.net.InetAddress gateway() {
        try {
            WifiManager wm = getApplicationContext().getSystemService(WifiManager.class);
            int gw = wm.getDhcpInfo().gateway;
            if (gw == 0) return null; // not on Wi-Fi
            byte[] b = { (byte) gw, (byte) (gw >> 8), (byte) (gw >> 16), (byte) (gw >> 24) };
            return java.net.InetAddress.getByAddress(b);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        return START_STICKY; // restarted by Android if it's ever killed
    }

    @Override
    public void onDestroy() {
        pinging = false;
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
