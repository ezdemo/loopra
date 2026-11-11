package app.loopra.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class RelayBackgroundArgs {
  lateinit var connectionId: String
}

@TauriPlugin
class RelayBackgroundPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(RelayBackgroundArgs::class.java)
    activity.runOnUiThread {
      try {
        RelayConnectionService.start(activity, args.connectionId)
        // Notification permission is optional for the service; denial must not break the connection.
        val preferences = activity.getSharedPreferences("relay-background", Activity.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 &&
          ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
          !preferences.getBoolean("notificationPermissionAsked", false)) {
          preferences.edit().putBoolean("notificationPermissionAsked", true).apply()
          try {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0x4C52)
          } catch (error: Exception) {
            Log.w("LoopraRelay", "Notification permission request unavailable", error)
          }
        }
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject("无法启动后台连接服务，请回到前台重试", error)
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    val args = invoke.parseArgs(RelayBackgroundArgs::class.java)
    activity.runOnUiThread {
      RelayConnectionService.stop(activity, args.connectionId)
      invoke.resolve()
    }
  }
}
