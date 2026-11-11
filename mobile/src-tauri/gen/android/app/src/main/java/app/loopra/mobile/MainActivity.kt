package app.loopra.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class MainActivity : TauriActivity() {
  private var darkMode = false
  private var webView: WebView? = null
  private var pendingScanId: String? = null
  private val scanResults = ConcurrentHashMap<String, String>()
  private val qrScanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    completeQrScan(result.resultCode, result.data)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          finish()
          return
        }
        view.evaluateJavascript("(typeof window.__loopraBack === 'function' && window.__loopraBack() === true)") { handled ->
          if (handled != "true") finish()
        }
      }
    })
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      applySystemBars()
    }
  }

  override fun onResume() {
    super.onResume()
    applySystemBars()
    window.decorView.post { webView?.evaluateJavascript("window.__loopraResume && window.__loopraResume();", null) }
  }

  override fun onDestroy() {
    if (isFinishing) RelayConnectionService.shutdown(this)
    super.onDestroy()
  }

  @SuppressLint("JavascriptInterface")
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.addJavascriptInterface(SystemBarsBridge(this), "LoopraSystemBars")
    webView.addJavascriptInterface(QrScannerBridge(this), "LoopraQrScanner")
  }

  fun setDarkMode(dark: Boolean) {
    darkMode = dark
    applySystemBars()
  }

  private fun applySystemBars() {
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !darkMode
      isAppearanceLightNavigationBars = !darkMode
    }
  }

  fun startQrScan(id: String) {
    if (pendingScanId != null) return
    pendingScanId = id
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      launchQrScanner()
      return
    }
    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), QR_PERMISSION_REQUEST)
  }

  fun cancelQrScan(id: String) {
    if (pendingScanId != id) return
    pendingScanId = null
    storeQrResult(id, null, "cancelled")
  }

  fun takeQrResult(id: String): String? = scanResults.remove(id)

  private fun launchQrScanner() {
    val intent = IntentIntegrator(this)
      .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
      .setPrompt("扫描 Loopra 配对二维码")
      .setBeepEnabled(false)
      .createScanIntent()
    qrScanLauncher.launch(intent)
  }

  private fun storeQrResult(id: String, content: String?, error: String?) {
    scanResults[id] = JSONObject().put("content", content ?: JSONObject.NULL).put("error", error ?: JSONObject.NULL).toString()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != QR_PERMISSION_REQUEST) return
    val id = pendingScanId ?: return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      launchQrScanner()
    } else {
      pendingScanId = null
      storeQrResult(id, null, "未获得相机权限")
    }
  }

  private fun completeQrScan(resultCode: Int, data: Intent?) {
    val id = pendingScanId ?: return
    pendingScanId = null
    val result = IntentIntegrator.parseActivityResult(resultCode, data)
    val content = result?.contents
    if (resultCode == Activity.RESULT_OK && !content.isNullOrBlank()) storeQrResult(id, content, null)
    else storeQrResult(id, null, "cancelled")
  }

  companion object {
    private const val QR_PERMISSION_REQUEST = 0x4C51
  }
}

private class SystemBarsBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun setDarkMode(dark: Boolean) {
    activity.runOnUiThread { activity.setDarkMode(dark) }
  }
}

private class QrScannerBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun scan(id: String) {
    activity.runOnUiThread { activity.startQrScan(id) }
  }

  @JavascriptInterface
  fun cancel(id: String) {
    activity.runOnUiThread { activity.cancelQrScan(id) }
  }

  @JavascriptInterface
  fun result(id: String): String? = activity.takeQrResult(id)
}
