package app.loopra.android.data

import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * 隧道字节流的最小抽象：生产实现是 OkHttp WebSocket，JVM 测试可注入
 * 脚本化假实现，避免把状态机耦合到具体网络库上。
 */
internal interface RelaySocket {
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
    fun cancel()
}

internal interface RelaySocketListener {
    fun onOpen(socket: RelaySocket)
    fun onText(text: String)
    fun onBinary(bytes: ByteArray)
    fun onClosed(reason: String)
    fun onFailure(reason: String)
}

internal fun interface RelaySocketFactory {
    fun open(url: String, listener: RelaySocketListener): RelaySocket
}

/** 真实网络层：系统 TLS 证书校验与主机名验证、正常代理与连接池行为。 */
internal class OkHttpSocketFactory(private val http: OkHttpClient) : RelaySocketFactory {

    override fun open(url: String, listener: RelaySocketListener): RelaySocket {
        val request = Request.Builder().url(url).build()
        val socket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    listener.onOpen(OkHttpSocket(webSocket))
                }

                override fun onMessage(webSocket: WebSocket, text: String) =
                    listener.onText(text)

                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) =
                    listener.onBinary(bytes.toByteArray())

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                    listener.onClosed("中继已断开，正在重新连接")

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                    // 不把 TLS/对端细节透到界面；按阶段给固定文案。
                    listener.onFailure("中继已断开，正在重新连接")
            },
        )
        return OkHttpSocket(socket)
    }

    private class OkHttpSocket(private val socket: WebSocket) : RelaySocket {
        override fun sendText(text: String): Boolean = socket.send(text)
        override fun sendBinary(bytes: ByteArray): Boolean = socket.send(bytes.toByteString())
        override fun cancel() = socket.cancel()
    }

    companion object {
        // 同一进程内所有配对共享一个客户端，复用连接池与调度器线程。
        private val sharedClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .followRedirects(false)
                .followSslRedirects(false)
                // OkHttp 自动维护协议层 ping/pong；隧道活性由 __probe 端到端探测判定。
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
        }

        fun defaultClient(): OkHttpClient = sharedClient
    }
}
