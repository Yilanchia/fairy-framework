package ai.fairy.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot the socket is gone; bring it back if the owner ever paired. */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
    if (context.getSharedPreferences("fairy", Context.MODE_PRIVATE).getString("token", "").isEmpty()) return;
    LinkService.ensureRunning(context);
  }
}
