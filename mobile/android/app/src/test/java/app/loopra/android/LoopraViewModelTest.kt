package app.loopra.android

import app.loopra.android.data.ActiveConnection
import app.loopra.android.data.AgentConfigOption
import app.loopra.android.data.AgentEngine
import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.ApiException
import app.loopra.android.data.ConfigType
import app.loopra.android.data.ConfigValue
import app.loopra.android.data.LoopraApi
import app.loopra.android.data.NativePreferences
import app.loopra.android.data.Pairing
import app.loopra.android.data.PairingStore
import app.loopra.android.data.PermissionChoice
import app.loopra.android.data.PreparedSession
import app.loopra.android.data.RelayConnection
import app.loopra.android.data.RelayRequest
import app.loopra.android.data.RelayStatus
import app.loopra.android.data.RemoteSession
import app.loopra.android.data.ResponseHead
import app.loopra.android.data.SessionStatus
import app.loopra.android.data.StreamEvent
import app.loopra.android.data.StreamInterruptedException
import app.loopra.android.data.Workspace
import app.loopra.android.ui.LoopraViewModel
import app.loopra.android.ui.state.Stage
import app.loopra.android.ui.state.ThreadKey
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LoopraViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setMain() = Dispatchers.setMain(dispatcher)

    @After
    fun reset() {
        Dispatchers.resetMain()
    }

    private val pairing = Pairing("https://relay.example.com", "A".repeat(43), displayName = "测试台")

    private class FakeStore : PairingStore {
        var stored: Pairing? = null
        var saves = AtomicInteger()
        var saveError: Exception? = null
        override fun load(): Pairing? = stored
        override fun save(pairing: Pairing) {
            saves.incrementAndGet()
            saveError?.let { throw it }
            stored = pairing
        }
        override fun clear() { stored = null }
    }

    private class FakePrefs : NativePreferences {
        override var themeMode: String = "system"
        override var reduceTransparency: Boolean = false
        override var fontSize: Int = 16
    }

    private class FakeRelay(override val pairing: Pairing) : RelayConnection {
        var status = RelayStatus("connected", null, 1)
        var closed = false
        override fun statusNow(): RelayStatus = status
        override suspend fun check() {}
        override suspend fun send(request: RelayRequest): ResponseHead = ResponseHead(200, emptyMap())
        override fun readBody(requestId: String): Flow<ByteArray> = flow { }
        override fun cancel(requestId: String) {}
        override fun close() { closed = true }
    }

    private class FakeApi : LoopraApi {
        var workspacesResult = listOf(Workspace.CHAT, Workspace("ws1", "项目A", "/a"))
        var sessionsResult = mapOf("ws1" to listOf(RemoteSession("s1", "已有会话", 1000L, 3, "native", null)))
        var historyResult: JSONArray? = null
        var statusResult = SessionStatus(false, null, null)
        var abortError: Exception? = null
        var permissionError: Exception? = null
        var permissionsResult = emptyList<PermissionChoice>()
        var prepareResult = PreparedSession("new-1", "native")
        var prepareGate: CompletableDeferred<PreparedSession>? = null
        var stream: (JSONObject, String) -> Flow<StreamEvent> = { _, _ -> flow { } }
        val streamBodies = mutableListOf<Pair<JSONObject, String>>()
        val aborts = mutableListOf<Triple<String, String, String>>()
        val permissionPosts = mutableListOf<String>()
        var workspacesGate: CompletableDeferred<List<Workspace>>? = null
        var configResult = emptyList<AgentConfigOption>()
        var configGate: CompletableDeferred<List<AgentConfigOption>>? = null
        var configUpdateGate: CompletableDeferred<List<AgentConfigOption>>? = null
        var configUpdateError: Exception? = null
        var configUpdateResult: List<AgentConfigOption>? = null
        val configReads = mutableListOf<Pair<String, String>>()
        val configWrites = mutableListOf<Triple<String, String, Pair<String, ConfigValue>>>()
        val prepareCalls = mutableListOf<Pair<String, String>>()
        var enginesResult = emptyList<AgentEngine>()
        var elicitationsResult = emptyList<ElicitationRequest>()
        var elicitationsGate: CompletableDeferred<List<ElicitationRequest>>? = null
        var elicitationError: Exception? = null
        val elicitationPosts = mutableListOf<Triple<String, String, JSONObject>>()
        override suspend fun agentEngines(): List<AgentEngine> = enginesResult
        override suspend fun elicitations(workspaceHash: String, sessionName: String): List<ElicitationRequest> =
            elicitationsGate?.await() ?: elicitationsResult
        override suspend fun answerElicitation(
            workspaceHash: String, sessionName: String, elicitationRequestId: String,
            action: String, content: Map<String, Any>,
        ) {
            elicitationError?.let { throw it }
            val json = JSONObject()
            for ((k, v) in content) json.put(k, if (v is List<*>) JSONArray(v) else v)
            elicitationPosts.add(Triple("$workspaceHash/$sessionName/$elicitationRequestId", action, json))
        }

        override suspend fun workspaces(): List<Workspace> =
            workspacesGate?.await() ?: workspacesResult
        override suspend fun sessions(workspaceHash: String): List<RemoteSession> =
            sessionsResult[workspaceHash] ?: emptyList()
        override suspend fun prepare(workspaceHash: String, agentId: String): PreparedSession {
            prepareCalls.add(workspaceHash to agentId)
            return prepareGate?.await() ?: prepareResult
        }
        override suspend fun history(workspaceHash: String, sessionName: String): JSONArray =
            historyResult ?: throw ApiException("历史不可用")
        override suspend fun sessionStatus(workspaceHash: String, sessionName: String): SessionStatus = statusResult
        override suspend fun permissions(workspaceHash: String, sessionName: String): List<PermissionChoice> = permissionsResult
        override suspend fun resolvePermission(workspaceHash: String, sessionName: String, permissionRequestId: String, optionId: String) {
            permissionError?.let { throw it }
            permissionPosts.add("$workspaceHash/$sessionName/$permissionRequestId/$optionId")
        }
        override suspend fun abort(workspaceHash: String, sessionName: String, requestId: String) {
            abortError?.let { throw it }
            aborts.add(Triple(workspaceHash, sessionName, requestId))
        }
        override fun chatStream(body: JSONObject, requestId: String): Flow<StreamEvent> {
            streamBodies.add(body to requestId)
            return stream(body, requestId)
        }
        override suspend fun replyConfig(workspaceHash: String, sessionName: String): List<AgentConfigOption> {
            configReads.add(workspaceHash to sessionName)
            return configGate?.await() ?: configResult
        }
        override suspend fun updateReplyConfig(
            workspaceHash: String,
            sessionName: String,
            configId: String,
            value: ConfigValue,
        ): List<AgentConfigOption> {
            configWrites.add(Triple(workspaceHash, sessionName, configId to value))
            configUpdateGate?.await()
            configUpdateError?.let { throw it }
            return configUpdateResult ?: configResult
        }
    }

    private fun TestScope.harness(store: FakeStore = FakeStore()): Triple<LoopraViewModel, FakeApi, FakeRelay> {
        val api = FakeApi()
        val relay = FakeRelay(pairing)
        val vm = LoopraViewModel(
            pairingStore = store,
            preferences = FakePrefs(),
            connectionFactory = { ActiveConnection(relay, api) },
            statusPollMs = 30,
            recoveryPollMs = 30,
            scope = backgroundScope,
        )
        return Triple(vm, api, relay)
    }

    private fun TestScope.connect(vm: LoopraViewModel) {
        vm.connectWithLink(linkFor(pairing))
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
    }

    private fun linkFor(p: Pairing): String =
        "loopra://connect?u=${java.net.URLEncoder.encode(p.relayUrl, "UTF-8")}&k=${p.connectCode}&v=1&e2e=1"

    @Test
    fun connectLoadsCatalogAndSessions() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        connect(vm)
        val state = vm.state.value
        assertEquals(Stage.HOME, state.stage)
        assertEquals("connected", state.connectionState)
        assertEquals(2, state.workspaces.size)
        assertEquals("已有会话", state.sessionRows().single { it.session.name == "s1" }.session.title)
    }

    @Test
    fun invalidLinkRejectedWithoutPersist() = runTest(dispatcher) {
        val store = FakeStore()
        val (vm, _, _) = harness(store)
        vm.connectWithLink("not-a-link")
        runCurrent()
        assertEquals(Stage.PAIRING, vm.state.value.stage)
        assertTrue(vm.state.value.connectError != null)
        assertNull(store.stored)
    }

    @Test
    fun sendStreamsEventsIntoThread() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ ->
            flow {
                emit(StreamEvent.text("content", "你好"))
                emit(StreamEvent("done"))
            }
        }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        advanceTimeBy(200)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(false, thread.running)
        val assistant = thread.messages.last()
        assertEquals("你好", assistant.blocks.single().content)
        // 发送请求体精确绑定工作区、会话与 requestId。
        val (body, requestId) = api.streamBodies.single()
        assertEquals(Workspace.CHAT.hash, body.getString("workspaceHash"))
        assertEquals(key.sessionName, body.getString("sessionName"))
        assertEquals(requestId, body.getString("requestId"))
        assertTrue(vm.state.value.drafts[key] == null)
    }

    @Test
    fun failedSendRestoresDraft() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow { throw ApiException("会话忙", reason = "thread_active_writer") } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "重要输入")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(false, thread.running)
        assertTrue(thread.error != null)
        assertEquals("重要输入", vm.state.value.drafts[key])
        // 握手被拒：两条推测消息都按 ID 移除，不留下半截气泡。
        assertEquals(0, thread.messages.size)
    }

    @Test
    fun selectionChangeKeepsStreamAlive() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val channel = Channel<StreamEvent>(Channel.UNLIMITED)
        api.stream = { _, _ -> channel.consumeAsFlow() }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        channel.trySend(StreamEvent.text("content", "前一半"))
        runCurrent()
        // 切走再切回：流继续写同一个线程。
        vm.backToHome()
        runCurrent()
        channel.trySend(StreamEvent.text("content", "后一半"))
        channel.trySend(StreamEvent("done"))
        channel.close()
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals("前一半后一半", thread.messages.last().blocks.single().content)
        assertEquals(false, thread.running)
    }

    @Test
    fun stopPostsExactAbortIdentity() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow { kotlinx.coroutines.delay(60_000) } }
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "干活")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val requestId = vm.state.value.threads.getValue(key).activeRequestId!!
        vm.stop(key)
        runCurrent()
        assertEquals(Triple("ws1", key.sessionName, requestId), api.aborts.single())
    }

    @Test
    fun staleConnectionResultsCannotOverwrite() = runTest(dispatcher) {
        val store = FakeStore()
        val slow = CompletableDeferred<List<Workspace>>()
        val api1 = FakeApi().also { it.workspacesGate = slow }
        val relay1 = FakeRelay(pairing)
        val api2 = FakeApi()
        val relay2 = FakeRelay(pairing)
        var gen = 0
        val vm = LoopraViewModel(
            pairingStore = store,
            preferences = FakePrefs(),
            connectionFactory = {
                gen++
                if (gen == 1) ActiveConnection(relay1, api1) else ActiveConnection(relay2, api2)
            },
            statusPollMs = 30,
            recoveryPollMs = 30,
            scope = backgroundScope,
        )
        vm.connectWithLink(linkFor(pairing))
        runCurrent() // gen1 开始 refresh，被 slow 挂住
        // 重新连接：gen2 立即完成目录加载。
        vm.connectWithLink(linkFor(pairing))
        runCurrent()
        assertEquals(api2.workspacesResult, vm.state.value.workspaces)
        // 旧 gen1 的迟到结果不能覆盖。
        slow.complete(listOf(Workspace.CHAT))
        runCurrent()
        assertEquals(api2.workspacesResult, vm.state.value.workspaces)
        assertTrue(relay1.closed)
    }

    @Test
    fun externalSessionPreservesAgentIds() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.sessionsResult = mapOf(
            "ws1" to listOf(RemoteSession("ext", "外部会话", 1L, 2, "claude", "custom-9")),
        )
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        val row = vm.state.value.sessionRows().single { it.session.name == "ext" }
        vm.openSession(row)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "继续")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val (body, _) = api.streamBodies.single()
        assertEquals("claude", body.getString("agentId"))
        assertEquals("custom-9", body.getString("customAgentId"))
    }

    @Test
    fun reconnectDoesNotReplayWrites() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "一次")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        advanceTimeBy(200)
        runCurrent()
        assertEquals(1, api.streamBodies.size)
        // 状态轮询与 refresh 永不重发写请求。
        vm.reconnect()
        advanceTimeBy(500)
        runCurrent()
        assertEquals(1, api.streamBodies.size)
        assertTrue(api.aborts.isEmpty())
    }

    @Test
    fun disconnectClosesConnectionAndClearsPairing() = runTest(dispatcher) {
        val store = FakeStore()
        val (vm, _, relay) = harness(store)
        connect(vm)
        vm.disconnect()
        runCurrent()
        assertTrue(relay.closed)
        assertNull(store.stored)
        assertEquals(Stage.PAIRING, vm.state.value.stage)
    }

    @Test
    fun permissionPostsExactIds() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.resolvePermission(key, "perm-1", "allow_once")
        runCurrent()
        assertEquals("ws1/${key.sessionName}/perm-1/allow_once", api.permissionPosts.single())
    }

    @Test
    fun abortFailureKeepsStreamAlive() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow { kotlinx.coroutines.delay(60_000) } }
        api.abortError = ApiException("暂时无法停止")
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "干活")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        vm.stop(key)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        // abort 失败：不取消读流、不标中断，stopping 解除并提示错误。
        assertEquals(true, thread.running)
        assertEquals(false, thread.stopping)
        assertTrue(thread.error != null)
        assertEquals(false, thread.interrupted)
        assertTrue(api.aborts.isEmpty())
    }

    @Test
    fun staleHistoryCannotRecreateThreadAfterRePair() = runTest(dispatcher) {
        val store = FakeStore()
        val api1 = FakeApi()
        api1.sessionsResult = mapOf(
            "ws1" to listOf(RemoteSession("s1", "旧会话", 1L, 5, "native", null)),
        )
        // 旧连接的历史读取挂起：重配后完成也不能落进新状态。
        val historyGate = CompletableDeferred<JSONArray>()
        api1.historyResult = null
        var gen = 0
        val relay1 = FakeRelay(pairing)
        val api2 = FakeApi()
        val relay2 = FakeRelay(pairing)
        val vm = LoopraViewModel(
            pairingStore = store,
            preferences = FakePrefs(),
            connectionFactory = {
                gen++
                val api = if (gen == 1) object : LoopraApi by api1 {
                    override suspend fun history(workspaceHash: String, sessionName: String) = historyGate.await()
                } else api2
                ActiveConnection(if (gen == 1) relay1 else relay2, api)
            },
            statusPollMs = 30,
            recoveryPollMs = 30,
            scope = backgroundScope,
        )
        connect(vm)
        val row = vm.state.value.sessionRows().single { it.session.name == "s1" }
        vm.openSession(row)
        runCurrent()
        val key = ThreadKey("ws1", "s1")
        // 重新配对：状态重置，旧连接的迟到历史不得复活同键线程。
        vm.connectWithLink(linkFor(pairing))
        runCurrent()
        assertTrue(key !in vm.state.value.threads)
        historyGate.complete(JSONArray().put(JSONObject().put("role", "assistant").put("content", "旧历史")))
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertTrue(key !in vm.state.value.threads)
    }

    @Test
    fun permissionFailureRetainsCardAndDeduplicates() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.permissionsResult = listOf(
            PermissionChoice(
                permissionRequestId = "p1",
                title = "审批",
                description = null,
                options = emptyList(),
            ),
        )
        api.permissionError = ApiException("网络错误")
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.selectThread(key)
        runCurrent()
        // 两次快速点击：第一次还在处理中时第二次必须被去重。
        api.permissionError = null
        vm.resolvePermission(key, "p1", "a")
        vm.resolvePermission(key, "p1", "a")
        runCurrent()
        assertEquals(1, api.permissionPosts.size)
        assertTrue(api.permissionPosts.single().contains("p1"))
    }

    @Test
    fun permissionSubmitFailureKeepsCard() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.permissionError = ApiException("提交失败")
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "干活")
        api.stream = { _, _ ->
            flow {
                val obj = JSONObject().put("permissionRequestId", "p1")
                    .put("title", "审批")
                    .put("options", JSONArray().put(JSONObject().put("title", "允许").put("value", "allow")))
                emit(StreamEvent("choice", obj))
                emit(StreamEvent("done"))
            }
        }
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        advanceTimeBy(200)
        runCurrent()
        vm.resolvePermission(key, "p1", "allow")
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        // 失败不清卡：choice 块仍未标记已选，错误可见。
        val choice = thread.messages.last().blocks.single { it.type == app.loopra.android.chat.BlockType.CHOICE }
        assertEquals(null, choice.selected)
        assertTrue(thread.error != null)
        assertTrue(thread.resolvingPermissionIds.isEmpty())
    }

    @Test
    fun connectingOrDisconnectedStatusKeepsCancelActionable() = runTest(dispatcher) {
        val (vm, _, relay) = harness()
        relay.status = RelayStatus("connecting", null, 1)
        vm.connectWithLink(linkFor(pairing))
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        // 首次连接迟迟未 established：必须停在配对页并保留取消入口。
        assertEquals(Stage.PAIRING, vm.state.value.stage)
        assertEquals(true, vm.state.value.connecting)
        relay.status = RelayStatus("disconnected", "网络不可达", 2)
        advanceTimeBy(200)
        runCurrent()
        assertEquals(Stage.PAIRING, vm.state.value.stage)
        assertEquals(true, vm.state.value.connecting)
        assertEquals("网络不可达", vm.state.value.connectError)
        vm.cancelConnect()
        runCurrent()
        assertEquals(false, vm.state.value.connecting)
        assertTrue(relay.closed)
    }

    @Test
    fun closedStatusIsTerminalAndReleasesKeepAlive() = runTest(dispatcher) {
        val (vm, _, relay) = harness()
        connect(vm)
        assertEquals(true, vm.state.value.keepAliveService)
        assertTrue(vm.state.value.serviceConnectionId != null)
        relay.status = RelayStatus("closed", "对端关闭", 2)
        advanceTimeBy(100)
        runCurrent()
        val state = vm.state.value
        assertEquals("closed", state.connectionState)
        assertEquals(false, state.keepAliveService)
        assertNull(state.serviceConnectionId)
    }

    @Test
    fun pairingSaveFailureAbandonsCandidate() = runTest(dispatcher) {
        // 旧配对已保存且自动连上；新候选在发布 connected 前提交存储，
        // 写入失败回到落地页，旧配对与原样标签保留。
        val store = FakeStore().also {
            it.stored = pairing
            it.saveError = java.io.IOException("磁盘已满")
        }
        val (vm, _, relay) = harness(store)
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        assertEquals(Stage.HOME, vm.state.value.stage)
        vm.connectWithLink(linkFor(pairing))
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        val state = vm.state.value
        assertEquals("无法保存配对，请重试", state.connectError)
        assertEquals(Stage.PAIRING, state.stage)
        assertEquals("disconnected", state.connectionState)
        assertEquals(false, state.connecting)
        assertEquals(false, state.keepAliveService)
        assertNull(state.serviceConnectionId)
        assertNull(state.instanceName)
        assertNull(state.relayHost)
        assertTrue(relay.closed)
        // 保存失败不覆盖旧配对，落地页仍可重连。
        assertEquals(pairing, store.stored)
        assertEquals("测试台", state.savedConnectionName)
    }

    @Test
    fun interruptedStreamBeforeFirstEventRecovers() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow<StreamEvent> { throw StreamInterruptedException() } }
        api.statusResult = SessionStatus(false, null, null)
        api.historyResult = JSONArray()
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        advanceTimeBy(200)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        // 首事件前的传输中断：恢复循环确认空闲后收尾，不再永远 running。
        assertEquals(false, thread.running)
        assertEquals("问题", vm.state.value.drafts[key])
        // 恢复后可以再次手动发送。
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        assertEquals(2, api.streamBodies.size)
    }

    @Test
    fun storedPairingAutoConnects() = runTest(dispatcher) {
        val store = FakeStore().also { it.stored = pairing }
        val (vm, _, _) = harness(store)
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        assertEquals(Stage.HOME, vm.state.value.stage)
        assertEquals("connected", vm.state.value.connectionState)
    }

    // ---- 回复设置 ----------------------------------------------------------

    private fun sampleConfig() = listOf(
        AgentConfigOption(
            id = "model", name = "模型", type = ConfigType.SELECT, category = "model",
            current = ConfigValue.Text("magpie:deepseek-v4"),
            options = listOf(
                app.loopra.android.data.ConfigChoice("magpie:deepseek-v4", "Magpie / DeepSeek V4"),
                app.loopra.android.data.ConfigChoice("magpie:gpt-5", "Magpie / GPT-5"),
            ),
        ),
        AgentConfigOption(
            id = "effort", name = "思考强度", type = ConfigType.SELECT, category = "thought_level",
            current = ConfigValue.Text("high"),
            options = listOf(
                app.loopra.android.data.ConfigChoice("low", "低"),
                app.loopra.android.data.ConfigChoice("high", "高"),
                app.loopra.android.data.ConfigChoice("max", "最大"),
            ),
        ),
        AgentConfigOption(
            id = "fast", name = "快速模式", type = ConfigType.BOOLEAN, category = "model_config",
            current = ConfigValue.Toggle(false), options = emptyList(),
        ),
    )

    private fun TestScope.openExistingSession(vm: LoopraViewModel, api: FakeApi): ThreadKey {
        val row = vm.state.value.sessionRows().single { it.session.name == "s1" }
        vm.openSession(row)
        runCurrent()
        return vm.state.value.selectedThread!!
    }

    @Test
    fun prepareSeedsReplyConfigWithoutGet() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val options = sampleConfig()
        api.prepareResult = PreparedSession("new-1", "native", configOptions = options)
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        // 本地草稿阶段不发请求：prepare 推迟到首次发送。
        assertTrue(key.sessionName.startsWith("draft:"))
        assertTrue(api.prepareCalls.isEmpty())
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        key = vm.state.value.selectedThread!!
        assertEquals("new-1", key.sessionName)
        assertEquals(Workspace.CHAT.hash to "native", api.prepareCalls.single())
        // prepare 响应已带配置：会话直接可用，不触发额外 GET。
        assertEquals(options, vm.state.value.threads.getValue(key).replyConfig.options)
        assertTrue(api.configReads.isEmpty())
    }

    @Test
    fun replyConfigLoadsOnceThenDedupes() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.configResult = sampleConfig()
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        assertEquals(1, api.configReads.size)
        assertEquals("ws1" to "s1", api.configReads.single())
        vm.loadReplyConfig(key)
        runCurrent()
        assertEquals(1, api.configReads.size)
        vm.loadReplyConfig(key, force = true)
        runCurrent()
        assertEquals(2, api.configReads.size)
    }

    @Test
    fun changeReplyConfigWritesAndAppliesResponse() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.configResult = sampleConfig()
        api.configUpdateResult = sampleConfig().map {
            if (it.id == "effort") it.copy(current = ConfigValue.Text("max")) else it
        }
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        vm.changeReplyConfig(key, "effort", ConfigValue.Text("max"))
        runCurrent()
        val (ws, session, idValue) = api.configWrites.single()
        assertEquals("ws1", ws)
        assertEquals("s1", session)
        assertEquals("effort", idValue.first)
        assertEquals(ConfigValue.Text("max"), idValue.second)
        val thread = vm.state.value.threads.getValue(key)
        val effort = thread.replyConfig.options!!.single { it.id == "effort" }
        assertEquals(ConfigValue.Text("max"), effort.current)
        assertEquals(false, thread.replyConfig.saving)
        assertNull(thread.replyConfig.error)
    }

    @Test
    fun changeReplyConfigFailureRetainsOptions() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val options = sampleConfig()
        api.configResult = options
        api.configUpdateError = ApiException("配置值无效", 400)
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        vm.changeReplyConfig(key, "effort", ConfigValue.Text("low"))
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(options, thread.replyConfig.options)
        assertEquals(false, thread.replyConfig.saving)
        assertEquals("配置值无效", thread.replyConfig.error)
    }

    @Test
    fun changeReplyConfigRejectsUnknownOptionAndValue() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.configResult = sampleConfig()
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        vm.changeReplyConfig(key, "missing", ConfigValue.Text("x"))
        vm.changeReplyConfig(key, "effort", ConfigValue.Text("nope"))
        runCurrent()
        assertTrue(api.configWrites.isEmpty())
    }

    @Test
    fun sendBlockedWhileConfigSaving() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.configResult = sampleConfig()
        api.configUpdateGate = CompletableDeferred()
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        vm.changeReplyConfig(key, "effort", ConfigValue.Text("low"))
        runCurrent()
        assertEquals(true, vm.state.value.threads.getValue(key).replyConfig.saving)
        vm.updateDraft(key, "你好")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        assertTrue(api.streamBodies.isEmpty())
        api.configUpdateGate!!.complete(sampleConfig())
        runCurrent()
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        assertEquals(1, api.streamBodies.size)
    }

    @Test
    fun staleConfigReadCannotOverwriteNewerWrite() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.configResult = sampleConfig()
        connect(vm)
        var key = openExistingSession(vm, api)
        runCurrent()
        // 已取到配置后挂起一次 force 读，随后写操作开始：写成功后
        // 迟到的旧读结果必须被代际校验丢弃。
        api.configGate = CompletableDeferred()
        vm.loadReplyConfig(key, force = true)
        runCurrent()
        val updated = sampleConfig().map {
            if (it.id == "effort") it.copy(current = ConfigValue.Text("low")) else it
        }
        api.configUpdateResult = updated
        vm.changeReplyConfig(key, "effort", ConfigValue.Text("low"))
        runCurrent()
        api.configGate!!.complete(sampleConfig())
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(updated, thread.replyConfig.options)
        assertEquals(false, thread.replyConfig.saving)
    }

    @Test
    fun configOptionsStreamEventApplies() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val pushed = JSONArray()
        pushed.put(JSONObject().apply {
            put("id", "effort")
            put("name", "思考强度")
            put("type", "select")
            put("category", "thought_level")
            put("currentValue", "max")
            put("options", JSONArray().apply {
                put(JSONObject().apply { put("value", "max"); put("name", "最大") })
            })
        })
        api.stream = { _, _ ->
            flow {
                emit(StreamEvent("config_options", JSONObject().apply { put("configOptions", pushed) }))
                emit(StreamEvent("done"))
            }
        }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val thread = vm.state.value.threads.getValue(key)
        val effort = thread.replyConfig.options!!.single { it.id == "effort" }
        assertEquals(ConfigValue.Text("max"), effort.current)
    }
    @Test
    fun queuedMessagesDrainAfterIdle() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val channel = Channel<StreamEvent>(Channel.UNLIMITED)
        api.stream = { _, _ -> channel.consumeAsFlow() }
        api.statusResult = SessionStatus(true, "r1", null)
        api.historyResult = JSONArray()
        connect(vm)
        var key = openExistingSession(vm, api)
        // 服务端在跑：send 入队而不是新建回合。
        vm.updateDraft(key, "第一条")
        vm.send(key)
        runCurrent()
        vm.updateDraft(key, "第二条")
        vm.send(key)
        runCurrent()
        var thread = vm.state.value.threads.getValue(key)
        assertEquals(2, thread.queued.size)
        assertTrue(api.streamBodies.isEmpty())
        // 服务端转空闲：恢复确认后按序派发队列。
        api.statusResult = SessionStatus(false, null, null)
        api.historyResult = JSONArray()
        channel.trySend(StreamEvent("done"))
        channel.close()
        advanceTimeBy(120)
        runCurrent()
        assertEquals(2, api.streamBodies.size)
        assertEquals("第一条", api.streamBodies[0].first.getString("message"))
        assertEquals("第二条", api.streamBodies[1].first.getString("message"))
        // 第二条的空流 EOF 投递结果未知：标记需复核而非重复发送。
        val tail = vm.state.value.threads.getValue(key).queued
        assertTrue(tail.isEmpty() || tail.single().requiresReview)
    }

    @Test
    fun queuedEditOnlyWhenComposerBlank() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.statusResult = SessionStatus(true, "r1", null)
        connect(vm)
        var key = openExistingSession(vm, api)
        vm.updateDraft(key, "排队内容")
        vm.send(key)
        runCurrent()
        val id = vm.state.value.threads.getValue(key).queued.single().id
        // 草稿非空：编辑被拒绝，队列与输入都不丢。
        vm.updateDraft(key, "正在输入")
        assertEquals(false, vm.editQueued(key, id))
        assertEquals("正在输入", vm.state.value.drafts[key])
        vm.updateDraft(key, "")
        assertEquals(true, vm.editQueued(key, id))
        assertEquals("排队内容", vm.state.value.drafts[key])
        assertTrue(vm.state.value.threads.getValue(key).queued.isEmpty())
    }

    @Test
    fun promoteQueuedStopsCurrentRun() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val channel = Channel<StreamEvent>(Channel.UNLIMITED)
        api.stream = { _, _ -> channel.consumeAsFlow() }
        connect(vm)
        var key = openExistingSession(vm, api)
        vm.updateDraft(key, "先发")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val requestId = vm.state.value.threads.getValue(key).activeRequestId!!
        vm.updateDraft(key, "排队A")
        vm.send(key)
        vm.updateDraft(key, "插队B")
        vm.send(key)
        runCurrent()
        val queued = vm.state.value.threads.getValue(key).queued
        assertEquals(2, queued.size)
        vm.promoteQueued(key, queued[1].id)
        runCurrent()
        assertEquals(queued[1].id, vm.state.value.threads.getValue(key).queued.first().id)
        assertEquals(requestId, api.aborts.single().third)
    }

    @Test
    fun sendFailureBeforeAcceptMarksQueueForReview() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.statusResult = SessionStatus(true, "r1", null)
        api.historyResult = JSONArray()
        connect(vm)
        var key = openExistingSession(vm, api)
        vm.updateDraft(key, "存疑消息")
        vm.send(key)
        runCurrent()
        val queuedId = vm.state.value.threads.getValue(key).queued.single().id
        // 服务端转空闲但投递被握手拒绝：条目标记需复核且不自动重试。
        api.statusResult = SessionStatus(false, null, null)
        api.stream = { _, _ -> flow { throw ApiException("会话忙", reason = "thread_active_writer") } }
        advanceTimeBy(120)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(true, thread.queued.single { it.id == queuedId }.requiresReview)
        assertEquals(1, api.streamBodies.size)
        // 复核条目可编辑取回，不会被再次自动派发。
        assertEquals(true, vm.editQueued(key, queuedId))
    }

    @Test
    fun elicitationSseAddsAndResolves() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val channel = Channel<StreamEvent>(Channel.UNLIMITED)
        api.stream = { _, _ -> channel.consumeAsFlow() }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "问题")
        vm.send(key)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val elicitationJson = """{"elicitationRequestId":"e1","message":"选择环境","schema":{"type":"object","required":["env"],"properties":{"env":{"type":"string","title":"环境","enum":["dev","prod"],"enumNames":["开发","生产"]}}}}"""
        channel.trySend(StreamEvent("elicitation", JSONObject(elicitationJson)))
        runCurrent()
        val request = vm.state.value.threads.getValue(key).elicitations.single()
        assertEquals("e1", request.elicitationRequestId)
        vm.answerElicitation(key, "e1", "accept", mapOf("env" to "dev"))
        runCurrent()
        val (scope, action, content) = api.elicitationPosts.single()
        assertEquals(Workspace.CHAT.hash + "/new-1/e1", scope)
        assertEquals("accept", action)
        assertEquals("dev", content.getString("env"))
        assertTrue(vm.state.value.threads.getValue(key).elicitations.isEmpty())
    }

    @Test
    fun lateElicitationSnapshotDoesNotResurrectResolved() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        connect(vm)
        var key = openExistingSession(vm, api)
        // 运行中：快照到达后以快照为准，未 resolving 的旧条目被替换。
        api.elicitationsResult = listOf(
            ElicitationRequest("e1", "旧问题", emptyList(), false),
        )
        api.statusResult = SessionStatus(true, "r2", null)
        runCurrent()
        advanceTimeBy(60)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertTrue(thread.elicitations.all { it.elicitationRequestId == "e1" })
    }

    @Test
    fun draftPrepareIsScopedToEngineAndWorkspace() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.prepareResult = PreparedSession("new-1", "codex")
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        api.enginesResult = listOf(
            AgentEngine("codex", "Codex", available = true, hidden = false),
            AgentEngine("hidden-x", "Hidden", available = true, hidden = true),
        )
        connect(vm)
        // 项目草稿保留所选引擎：ws1 + codex 精确 prepare。
        vm.newSession("ws1")
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.selectDraftEngine(key, "codex")
        vm.updateDraft(key, "干活")
        vm.send(key)
        runCurrent()
        assertEquals("ws1" to "codex", api.prepareCalls.single())
        // 隐藏/不可用引擎不可选。
        vm.newSession("ws1")
        runCurrent()
        key = vm.state.value.selectedThread!!
        vm.selectDraftEngine(key, "hidden-x")
        assertEquals("native", vm.state.value.threads.getValue(key).agentId)
        vm.selectDraftEngine(key, "codex")
        // 切到纯聊天工作区：引擎归一化为 native，不携带项目引擎。
        vm.selectDraftWorkspace(key, Workspace.CHAT.hash)
        runCurrent()
        key = vm.state.value.selectedThread!!
        assertEquals(Workspace.CHAT.hash, key.workspaceHash)
        assertEquals("native", vm.state.value.threads.getValue(key).agentId)
        vm.updateDraft(key, "干活")
        vm.send(key)
        runCurrent()
        assertEquals(Workspace.CHAT.hash to "native", api.prepareCalls.last())
        // 草稿不在目录行里出现。
        assertTrue(vm.state.value.sessionRows().none { it.session.name.startsWith("draft:") })
    }

    @Test
    fun renameConnectionKeepsTransportAndUpdatesName() = runTest(dispatcher) {
        val store = FakeStore()
        val (vm, _, relay) = harness(store)
        connect(vm)
        assertTrue(vm.renameConnection("  新名字  "))
        runCurrent()
        assertEquals("新名字", vm.state.value.instanceName)
        assertEquals("新名字", store.stored?.displayName)
        assertEquals(false, relay.closed)
        assertFalse(vm.renameConnection("   "))
    }

    @Test
    fun connectAnotherPreservesSavedPairingForReconnect() = runTest(dispatcher) {
        val store = FakeStore()
        val (vm, _, relay) = harness(store)
        connect(vm)
        vm.connectAnother()
        runCurrent()
        assertEquals(Stage.PAIRING, vm.state.value.stage)
        assertTrue(relay.closed)
        assertEquals("relay.example.com", vm.state.value.savedConnectionName)
        assertNotNull(store.stored)
        // 取消未完成的连接也不清除已保存配对。
        vm.reconnectSaved()
        advanceTimeBy(100)
        runCurrent()
        assertEquals(Stage.HOME, vm.state.value.stage)
    }

    @Test
    fun draftReplyConfigPreparesAndPutsRealSession() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.prepareResult = PreparedSession("new-1", "native", configOptions = sampleConfig())
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        // 只打开回复设置就触发 prepare，且不拿草稿键发 GET。
        vm.loadReplyConfig(key, force = true)
        runCurrent()
        assertEquals(Workspace.CHAT.hash to "native", api.prepareCalls.single())
        assertTrue(api.configReads.isEmpty())
        assertEquals(
            sampleConfig(),
            vm.state.value.threads.getValue(key).replyConfig.options,
        )
        // PUT 打在 prepare 出来的真实会话名上，草稿键绝不上送。
        vm.changeReplyConfig(key, "model", ConfigValue.Text("magpie:gpt-5"))
        runCurrent()
        val write = api.configWrites.single()
        assertEquals(Workspace.CHAT.hash, write.first)
        assertEquals("new-1", write.second)
        // 已 prepare 过的草稿重开设置：按真实会话名重取，
        // PUT 之后的值不被旧 prepare 快照回滚。
        val changed = sampleConfig().map {
            if (it.id == "model") it.copy(current = ConfigValue.Text("magpie:gpt-5")) else it
        }
        api.configResult = changed
        vm.loadReplyConfig(key, force = true)
        runCurrent()
        assertEquals(Workspace.CHAT.hash to "new-1", api.configReads.single())
        assertEquals(changed, vm.state.value.threads.getValue(key).replyConfig.options)
        // 发送复用同一份 prepare：不再发起第二次。
        vm.updateDraft(key, "开工")
        vm.send(key)
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertEquals(1, api.prepareCalls.size)
        key = vm.state.value.selectedThread!!
        assertEquals("new-1", key.sessionName)
    }

    @Test
    fun rapidDraftSendsShareSinglePrepare() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.prepareGate = CompletableDeferred()
        api.historyResult = JSONArray()
        api.stream = { _, _ -> flow { emit(StreamEvent("done")) } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "开工")
        vm.send(key)
        // prepare 挂起期间快速二发：不入队、不清输入，等转正完成。
        vm.send(key)
        runCurrent()
        assertEquals(1, api.prepareCalls.size)
        assertTrue(vm.state.value.threads.getValue(key).queued.isEmpty())
        assertEquals("开工", vm.state.value.drafts[key])
        api.prepareGate!!.complete(PreparedSession("new-1", "native"))
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        // 全程只有一次 prepare、一条流。
        assertEquals(1, api.prepareCalls.size)
        assertEquals(1, api.streamBodies.size)
        key = vm.state.value.selectedThread!!
        assertEquals("new-1", key.sessionName)
    }

    @Test
    fun firstSendRejectionKeepsLocalDraft() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.stream = { _, _ -> flow<StreamEvent> { throw ApiException("忙", 409) } }
        connect(vm)
        vm.newSession(Workspace.CHAT.hash)
        runCurrent()
        var key = vm.state.value.selectedThread!!
        vm.updateDraft(key, "开工")
        vm.send(key)
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        key = vm.state.value.selectedThread ?: key
        val thread = vm.state.value.threads.getValue(key)
        // 首条被拒：已 prepare 的会话键转正但仍是草稿，
        // 目录不出幻影会话，文本还回输入框。
        assertEquals("new-1", key.sessionName)
        assertEquals(true, thread.isDraft)
        assertTrue(vm.state.value.sessionRows().none { it.session.name == "new-1" })
        assertEquals("开工", vm.state.value.drafts[key])
    }

    @Test
    fun stalePrepareAfterEngineSwapDiscarded() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.prepareGate = CompletableDeferred()
        api.enginesResult = listOf(
            AgentEngine("codex", "Codex", available = true, hidden = false),
        )
        connect(vm)
        vm.newSession("ws1")
        runCurrent()
        val key = vm.state.value.selectedThread!!
        // 打开回复设置：按 native 发起第一次 prepare（挂起）。
        vm.loadReplyConfig(key)
        runCurrent()
        // 挂起期间换引擎：代际递增，迟到的 native prepare 作废。
        vm.selectDraftEngine(key, "codex")
        runCurrent()
        assertEquals(listOf("ws1" to "native", "ws1" to "codex"), api.prepareCalls)
        api.prepareGate!!.complete(
            PreparedSession("new-1", "codex", configOptions = sampleConfig()),
        )
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals("codex", thread.agentId)
        assertEquals(sampleConfig(), thread.replyConfig.options)
        assertTrue(key.sessionName.startsWith("draft:"))
    }

    @Test
    fun queueFullKeepsDraftAndRejects() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        val channel = Channel<StreamEvent>(Channel.UNLIMITED)
        api.stream = { _, _ -> channel.consumeAsFlow() }
        api.statusResult = SessionStatus(true, "r1", null)
        api.historyResult = JSONArray()
        connect(vm)
        val key = openExistingSession(vm, api)
        vm.updateDraft(key, "首条")
        vm.send(key)
        runCurrent()
        repeat(50) { index ->
            vm.updateDraft(key, "排队$index")
            vm.send(key)
        }
        runCurrent()
        assertEquals(50, vm.state.value.threads.getValue(key).queued.size)
        // 第 51 条被拒绝：草稿保留、不写线程错误，队列不被顶掉。
        vm.updateDraft(key, "放不下")
        vm.send(key)
        runCurrent()
        val thread = vm.state.value.threads.getValue(key)
        assertEquals(50, thread.queued.size)
        assertNull(thread.error)
        assertEquals("放不下", vm.state.value.drafts[key])
    }

    @Test
    fun staleElicitationSnapshotAfterResolveDiscarded() = runTest(dispatcher) {
        val (vm, api, _) = harness()
        api.statusResult = SessionStatus(true, "r2", null)
        api.elicitationsResult = listOf(
            ElicitationRequest("e1", "旧问题", emptyList(), false),
        )
        connect(vm)
        val key = openExistingSession(vm, api)
        runCurrent()
        advanceTimeBy(60)
        runCurrent()
        assertEquals("e1", vm.state.value.threads.getValue(key).elicitations.single().elicitationRequestId)
        // 第二次快照挂起期间本地已解决该问询。
        api.elicitationsGate = CompletableDeferred()
        vm.selectThread(key)
        runCurrent()
        vm.answerElicitation(key, "e1", "accept", emptyMap())
        runCurrent()
        assertTrue(vm.state.value.threads.getValue(key).elicitations.isEmpty())
        api.elicitationsGate!!.complete(
            listOf(ElicitationRequest("e1", "旧问题", emptyList(), false)),
        )
        runCurrent()
        // 迟到的快照不能复活已解决的请求。
        assertTrue(vm.state.value.threads.getValue(key).elicitations.isEmpty())
    }

}
