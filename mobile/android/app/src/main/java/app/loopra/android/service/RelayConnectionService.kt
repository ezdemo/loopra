package app.loopra.android.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.loopra.android.MainActivity
import app.loopra.android.R

/**
 * remoteMessaging 前台服务：只在用户发起连接期间保持
 * 桌面隧道，不提供省电白名单或锁屏常驻保证。
 */
class RelayConnectionService : Service() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                CHANNEL,
                getString(R.string.relay_connection_channel),
                NotificationManager.IMPORTANCE_LOW,
            )
            channel.setSound(null, null)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_relay_connection)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.relay_connection_notification))
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else 0
        ServiceCompat.startForeground(this, NOTIFICATION, notification, type)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 已关闭连接的迟到 start 不能复活它的服务。
        if (ownership.owner == null) stopSelf()
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 任务被划掉：清掉所有权并停掉服务，不依赖系统回调顺序。
        ownership.clear()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "loopra-native-relay"
        private const val NOTIFICATION = 0x4C53
        private val ownership = RelayServiceOwnership()

        // 调用方在 Android 主线程上串行执行这些操作。
        fun start(context: Context, connectionId: String) {
            val previous = ownership.claim(connectionId)
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, RelayConnectionService::class.java),
                )
            } catch (error: Exception) {
                ownership.rollback(connectionId, previous)
                throw error
            }
        }

        fun stop(context: Context, connectionId: String) {
            if (!ownership.close(connectionId)) return
            context.stopService(Intent(context, RelayConnectionService::class.java))
        }

        fun shutdown(context: Context) {
            ownership.clear()
            context.stopService(Intent(context, RelayConnectionService::class.java))
        }
    }
}
