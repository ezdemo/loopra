package app.loopra.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import app.loopra.android.data.ActiveConnection
import app.loopra.android.data.AtomicPairingStore
import app.loopra.android.data.LoopraRepository
import app.loopra.android.data.RelayClient
import app.loopra.android.data.SharedPrefsPreferences
import app.loopra.android.service.RelayConnectionService
import app.loopra.android.ui.AppRoot
import app.loopra.android.ui.LoopraViewModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val viewModel: LoopraViewModel by viewModels {
        viewModelFactory {
            initializer {
                LoopraViewModel(
                    pairingStore = AtomicPairingStore(applicationContext),
                    preferences = SharedPrefsPreferences(applicationContext),
                    connectionFactory = { pairing ->
                        val client = RelayClient(pairing)
                        ActiveConnection(client, LoopraRepository(client))
                    },
                )
            }
        }
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let {
            viewModel.connectWithLink(it)
            maybeAskNotifications()
        }
    }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 拒绝不阻塞连接 */ }

    private var serviceConnectionId: String? = null
    private var notificationsAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        notificationsAsked = savedInstanceState?.getBoolean(KEY_NOTIFIED) == true
        setContent {
            AppRoot(
                viewModel = viewModel,
                onConnectRequested = ::maybeAskNotifications,
                onScan = ::launchScanner,
                onFinish = ::finish,
            )
        }
        handleDeepLink(intent)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.state.collect { state -> syncService(state) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(KEY_NOTIFIED, notificationsAsked)
        super.onSaveInstanceState(outState)
    }

    override fun finish() {
        // 根退出：关连接、停前台服务；桌面端回合不被取消。
        viewModel.shutdown()
        RelayConnectionService.shutdown(this)
        serviceConnectionId = null
        super.finish()
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "loopra" && data.host == "connect") {
            viewModel.onDeepLink(data.toString())
            // 消费掉，避免旋转后再次触发确认。
            intent.data = null
        }
    }

    private fun launchScanner() {
        scanner.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("对准桌面端配对二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(true),
        )
    }

    /** 只在用户明确发起连接后询问一次；拒绝不影响连接本身。 */
    private fun maybeAskNotifications() {
        // 连接没有真正发起（链接无效等）时不弹权限请求。
        if (notificationsAsked || !viewModel.state.value.connecting) return
        notificationsAsked = true
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /**
     * 前台服务仅跟随“用户发起且已连接”的连接；ownerId 每次连接唯一，
     * 旧回调不能停掉替换连接的服务。start 失败不记为已同步，下次状态变化重试。
     */
    private fun syncService(state: app.loopra.android.ui.state.AppState) {
        val wanted = if (state.keepAliveService) state.serviceConnectionId else null
        if (wanted == serviceConnectionId) return
        serviceConnectionId?.let { RelayConnectionService.stop(this, it) }
        serviceConnectionId = null
        if (wanted != null) {
            val started = runCatching { RelayConnectionService.start(this, wanted) }.isSuccess
            if (started) serviceConnectionId = wanted
        }
    }

    private companion object {
        const val KEY_NOTIFIED = "loopra.notifications_asked"
    }
}
