package app.loopra.android.data

/** 一个配对会话的活动连接：隧道客户端 + 其上的 API 仓库。 */
class ActiveConnection(val client: RelayConnection, val api: LoopraApi) {
    fun close() = client.close()
}
