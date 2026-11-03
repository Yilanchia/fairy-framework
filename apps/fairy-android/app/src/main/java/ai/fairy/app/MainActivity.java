package ai.fairy.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Her app: a window onto the page she already serves, with two things the browser cannot give —
 * a background connection (LinkService) and a button that updates the app itself.
 *
 * The page is the app's real UI. Nothing is duplicated here on purpose: when the console changes,
 * every installed copy changes with it, and only the shell needs a new APK.
 */
public class MainActivity extends Activity {
  /** Where she lives. Override nothing: one owner, one host. */
  static final String HOME = "https://fairy.lycoreco.cn/fairy/app/";
  static final String VERSION_URL = "https://fairy.lycoreco.cn/fairy/app/version.json";
  static final String APK_URL = "https://fairy.lycoreco.cn/fairy/app/download/fairy.apk";

  /** True while a window is in front, so notifications are only for when it is not. */
  static boolean visible = false;

  private WebView web;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private long downloading = -1;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    web = new WebView(this);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    // The page is ours and HTTPS; a mixed-content exception is not needed.
    web.setWebViewClient(new WebViewClient());
    web.setWebChromeClient(new WebChromeClient());
    // The page hands its device token to the shell, so the background service can speak for it.
    web.addJavascriptInterface(new Bridge(), "FairyApp");
    web.loadUrl(HOME);
    setContentView(web);

    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
    }
    checkForUpdate();
  }

  @Override
  protected void onResume() {
    super.onResume();
    visible = true;
  }

  @Override
  protected void onPause() {
    super.onPause();
    visible = false;
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    worker.shutdownNow();
    super.onDestroy();
  }

  /** Called by the page: the token the background service uses, and nothing else. */
  private class Bridge {
    @JavascriptInterface
    public void token(String value) {
      if (value == null || value.isEmpty()) return;
      getSharedPreferences("fairy", MODE_PRIVATE).edit().putString("token", value).apply();
      LinkService.ensureRunning(MainActivity.this);
    }

    @JavascriptInterface
    public void stop() {
      getSharedPreferences("fairy", MODE_PRIVATE).edit().remove("token").apply();
    }
  }

  // ── updating, which is the whole reason this is an app and not a bookmark ─────────────────

  private void checkForUpdate() {
    worker.execute(
        () -> {
          try {
            JSONObject json = new JSONObject(read(VERSION_URL));
            String latest = json.optString("version", "");
            if (latest.isEmpty() || latest.equals(BuildConfig.VERSION_NAME)) return;
            String notes = json.optString("notes", "");
            runOnUiThread(() -> askToUpdate(latest, notes));
          } catch (Exception ignored) {
            // A phone without her host reachable is still a usable app; try again next launch.
          }
        });
  }

  private void askToUpdate(String version, String notes) {
    new AlertDialog.Builder(this)
        .setTitle("有新版本 " + version)
        .setMessage(notes.isEmpty() ? "装好之后仍然是原来的她，只是外壳新一些。" : notes)
        .setPositiveButton("更新", (dialog, which) -> download())
        .setNegativeButton("稍后", null)
        .show();
  }

  private void download() {
    File target = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "fairy.apk");
    if (target.exists() && !target.delete()) return;
    DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
    downloading =
        manager.enqueue(
            new DownloadManager.Request(Uri.parse(APK_URL))
                .setTitle("Fairy")
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "fairy.apk")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE));
    registerReceiver(
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != downloading) return;
            unregisterReceiver(this);
            install(new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "fairy.apk"));
          }
        },
        new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
        Build.VERSION.SDK_INT >= 33 ? RECEIVER_EXPORTED : 0);
  }

  /** Hands the APK to the system installer; the last tap is the system's, not ours. */
  private void install(File apk) {
    if (!apk.exists()) {
      Toast.makeText(this, "下载没成功，再试一次。", Toast.LENGTH_LONG).show();
      return;
    }
    Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
    intent.setData(ApkProvider.uriFor(apk));
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
      Toast.makeText(this, "先在设置里允许 Fairy 安装应用。", Toast.LENGTH_LONG).show();
      startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
      return;
    }
    startActivity(intent);
  }

  private static String read(String address) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
    connection.setConnectTimeout(8000);
    connection.setReadTimeout(8000);
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "utf-8"))) {
      StringBuilder text = new StringBuilder();
      String line;
      while ((line = reader.readLine()) != null) text.append(line);
      return text.toString();
    } finally {
      connection.disconnect();
    }
  }
}
