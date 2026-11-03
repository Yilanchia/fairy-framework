package ai.fairy.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * One WebSocket, held open by a foreground service, so her words arrive with the screen off.
 *
 * This is the reason the app exists: browser push needs Google's services on most Android phones,
 * while a socket this app opens itself needs nothing but the network. It costs battery, which is
 * why it is a visible foreground service and can be switched off from the page.
 */
public class LinkService extends Service {
  static final String SOCKET = "wss://fairy.lycoreco.cn/fairy/link/v1";
  private static final String CHANNEL = "fairy-link";
  private static final int FOREGROUND_ID = 1;

  private OkHttpClient client;
  private WebSocket socket;
  private String token;
  private volatile boolean stopped = false;

  static void ensureRunning(Context context) {
    Intent intent = new Intent(context, LinkService.class);
    if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
    else context.startService(intent);
  }

  @Override
  public void onCreate() {
    super.onCreate();
    channel();
    client = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(FOREGROUND_ID, ongoing());
    token = getSharedPreferences("fairy", MODE_PRIVATE).getString("token", "");
    if (token.isEmpty()) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (socket == null) connect();
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopped = true;
    if (socket != null) socket.close(1000, "app closed");
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void connect() {
    Request request = new Request.Builder().url(SOCKET).build();
    socket =
        client.newWebSocket(
            request,
            new WebSocketListener() {
              @Override
              public void onOpen(WebSocket webSocket, Response response) {
                JSONObject hello = new JSONObject();
                try {
                  hello.put("type", "hello");
                  hello.put("id", "hello-" + System.currentTimeMillis());
                  hello.put("protocol", 1);
                  hello.put("token", token);
                  hello.put(
                      "device",
                      new JSONObject().put("name", deviceName()).put("kind", "app"));
                  hello.put("accepts", new org.json.JSONArray().put("push"));
                  webSocket.send(hello.toString());
                } catch (Exception ignored) {
                  // A frame we cannot build is a frame we do not send; the socket will retry.
                }
              }

              @Override
              public void onMessage(WebSocket webSocket, String text) {
                onFrame(text);
              }

              @Override
              public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                socket = null;
                retry();
              }

              @Override
              public void onClosed(WebSocket webSocket, int code, String reason) {
                socket = null;
                if (code == 4401 || code == 4403) stopSelf(); // not paired, or revoked
                else retry();
              }
            });
  }

  private void retry() {
    if (stopped) return;
    new Thread(
            () -> {
              try {
                Thread.sleep(15_000);
              } catch (InterruptedException ignored) {
                return;
              }
              if (!stopped && socket == null) connect();
            })
        .start();
  }

  /** Only what she needs the owner to hear: she wants to talk. */
  private void onFrame(String text) {
    try {
      JSONObject frame = new JSONObject(text);
      String type = frame.optString("type");
      if ("urge".equals(type)) notify("她找你", frame.optString("about", ""));
      else if ("reply.done".equals(type) && !MainActivity.visible) notify("Fairy", frame.optString("text", "").split("\n")[0]);
      else if ("error".equals(type) && frame.optString("message").contains("token")) stopSelf();
    } catch (Exception ignored) {
      // A frame that is not JSON is not ours.
    }
  }

  private void notify(String title, String body) {
    if (MainActivity.visible) return;
    Intent open = new Intent(this, MainActivity.class);
    PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification.Builder builder =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body.length() > 120 ? body.substring(0, 120) : body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(tap)
            .setAutoCancel(true);
    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify((int) (System.currentTimeMillis() % 100000), builder.build());
  }

  private Notification ongoing() {
    Intent open = new Intent(this, MainActivity.class);
    PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setContentTitle("Fairy 在线")
        .setContentText("她有事找你的时候，这里会响。")
        .setContentIntent(tap)
        .setOngoing(true)
        .build();
  }

  private void channel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationChannel link = new NotificationChannel(CHANNEL, "Fairy", NotificationManager.IMPORTANCE_DEFAULT);
    link.setDescription("她的消息和提醒");
    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(link);
  }

  private String deviceName() {
    String name = getSharedPreferences("fairy", MODE_PRIVATE).getString("name", "");
    return name.isEmpty() ? (Build.MODEL == null ? "Android" : Build.MODEL) : name;
  }
}
