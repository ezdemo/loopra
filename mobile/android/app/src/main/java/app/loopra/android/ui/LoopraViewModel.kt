package app.loopra.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.loopra.android.chat.ChatMessage
import app.loopra.android.chat.ChatReducer
import app.loopra.android.chat.Role
import app.loopra.android.data.ActiveConnection
import app.loopra.android.data.ApiException
import app.loopra.android.data.AgentEngine
import app.loopra.android.data.ConfigType
import app.loopra.android.data.ConfigValue
import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.PreparedSession
import app.loopra.android.data.ReplyConfig
import app.loopra.android.data.NativePreferences
import app.loopra.android.data.Pairing
import app.loopra.android.data.PairingException
import app.loopra.android.data.PairingStore
import app.loopra.android.data.PermissionChoice
import app.loopra.android.data.RemoteSession
import app.loopra.android.data.StreamEvent
import app.loopra.android.data.StreamFailedException
import app.loopra.android.data.StreamInterruptedException
import app.loopra.android.data.Workspace
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.state.HomeTab
import app.loopra.android.ui.state.SessionRow
import app.loopra.android.ui.state.QueuedMessage
import app.loopra.android.ui.state.ReplyConfigState
import app.loopra.android.ui.state.Stage
import app.loopra.android.ui.state.ThemeMode
import app.loopra.android.ui.state.ThreadKey
import app.loopra.android.ui.state.ThreadView
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlin.coroutines.coroutineContext
import org.json.JSONObject

/**
 * 工作台状态所有者。所有异步结果都按捕获的连接代际与线程键回写，
 * 旧连接、旧选择或已取消流的迟到结果不会污染当前状态。
 */
class LoopraViewModel(
    private val pairingStore: PairingStore,
    private val preferences: NativePreferences,
    private val connectionFactory: (Pairing) -> ActiveConnection,
    private val statusPollMs: Long = 750,
    private val recoveryPollMs: Long = 3000,
    // 测试注入 backgroundScope 可避免常驻轮询阻塞 runTest；生产恒为 viewModelScope。
    private val scope: CoroutineScope? = null,
) : ViewModel() {
    private val workScope: CoroutineScope
        get() = scope ?: viewModelScope

    private val _state = MutableStateFlow(
        AppState(
            themeMode = ThemeMode.of(preferences.themeMode),
            reduceTransparency = preferences.reduceTransparency,
            fontSize = preferences.fontSize,
        ),
    )
    val state: StateFlow<AppState> = _state.asStateFlow()

    private var connection: ActiveConnection? = null
    private var connectionGen = 0
    private var catalogRevision = 0
    private var statusJob: Job? = null
    private var catalogJob: Job? = null
    private var prepareJob: Job? = null
    private var connectionJob: Job? = null
    private val streamJobs = HashMap<ThreadKey, Job>()
    private val recoveryJobs = HashMap<ThreadKey, Job>()
    private val historyJobs = HashMap<ThreadKey, Job>()
    private val replyConfigJobs = HashMap<ThreadKey, Job>()
    /** 回复设置读/写代际：SSE 推送或新写开始都会使在途读失效。 */
    private val replyConfigSeqs = HashMap<ThreadKey, Long>()
    private var pendingDeepLink: Pairing? = null
    /** 上次成功认证的配对；未认证成功的候选绝不覆盖它。 */
    private var savedPairing: Pairing? = null
    /** 已建立候选但尚未首次认证成功：首次 connected 才提交存储。 */
    private var pendingSave: Pairing? = null
    private val draftPrepared = HashMap<ThreadKey, PreparedSession>()
    private val elicitationJobs = HashMap<ThreadKey, Job>()
    /** 问询快照代际：SSE 增量或已解决应答使在途快照作废。 */
    private val elicitationSeqs = HashMap<ThreadKey, Long>()
    private var serviceOwnerId = UUID.randomUUID().toString()

    private companion object {
        /** 本地草稿会话键前缀：转正前绝不发给服务端。 */
        const val DRAFT_PREFIX = "draft:"
    }

    init {
        // 恢复的配对已持久化过，不重复写。
        pairingStore.load()?.let { saved ->
            savedPairing = saved
            _state.update { it.copy(savedConnectionName = saved.displayName ?: saved.relayHost) }
            open(saved, persist = false)
        }
    }

    // ---- 连接生命周期 ------------------------------------------------------

    /** 用配对链接建立连接；无效链接在落地页就地报错，不写存储。 */
    fun connectWithLink(link: String) {
        val pairing = try {
            Pairing.parse(link)
        } catch (error: PairingException) {
            _state.update { it.copy(connectError = error.message, connecting = false) }
            return
        }
        open(pairing.withDeviceName())
    }

    /**
     * 深链接入：先解析校验；无论当前是否已配对都要用户确认后才替换，
     * 外部 intent 不能直接触发持久化。
     */
    fun onDeepLink(link: String) {
        val pairing = try {
            Pairing.parse(link)
        } catch (error: PairingException) {
            _state.update { it.copy(connectError = error.message) }
            return
        }
        pendingDeepLink = pairing
        _state.update { it.copy(pendingPairingName = pairing.displayName ?: pairing.relayHost) }
    }

    fun confirmPendingLink() {
        val pairing = pendingDeepLink ?: return
        pendingDeepLink = null
        _state.update { it.copy(pendingPairingName = null) }
        open(pairing.withDeviceName())
    }

    fun dismissPendingLink() {
        pendingDeepLink = null
        _state.update { it.copy(pendingPairingName = null) }
    }

    /**
     * 建立新连接：先创建候选客户端，成功后才拆除旧连接；任何失败都保留
     * 现有连接与状态。首次 connected 前停留在连接页并可取消。
     */
    private fun open(pairing: Pairing, persist: Boolean = true) {
        val candidate = try {
            connectionFactory(pairing)
        } catch (error: LinkageError) {
            // 原生库缺失/不匹配不是用户能修复的配对问题，给独立提示。
            _state.update {
                it.copy(connecting = false, connectError = "原生组件不可用，请重新构建应用")
            }
            return
        } catch (error: Exception) {
            _state.update {
                it.copy(connecting = false, connectError = error.message ?: "无法创建连接")
            }
            return
        }
        // 候选配对先不写存储：首次认证成功才提交，失败/取消时保留旧配对。
        if (persist) pendingSave = pairing else savedPairing = pairing

        val previous = connection
        connection = candidate
        val gen = ++connectionGen
        catalogRevision++
        tearDownWork()
        connectionJob = SupervisorJob(workScope.coroutineContext[Job])
        serviceOwnerId = UUID.randomUUID().toString()
        _state.update { old ->
            // 换实例：只保留外观偏好，会话/目录/草稿一律重置。
            AppState(
                stage = Stage.PAIRING,
                connecting = true,
                connectionState = "connecting",
                instanceName = pairing.displayName ?: pairing.relayHost,
                relayHost = pairing.relayHost,
                themeMode = old.themeMode,
                reduceTransparency = old.reduceTransparency,
                fontSize = old.fontSize,
                savedConnectionName = old.savedConnectionName,
            )
        }
        previous?.close()
        startStatusLoop(candidate, gen)
    }

    /** 取消尚未完成的首次连接：候选连接销毁，已暂存的配对一并清掉。 */
    fun cancelConnect() {
        if (!_state.value.connecting) return
        connectionGen++
        catalogRevision++
        tearDownWork()
        connection?.close()
        connection = null
        pendingSave = null
        _state.update { old ->
            AppState(
                themeMode = old.themeMode,
                reduceTransparency = old.reduceTransparency,
                fontSize = old.fontSize,
                savedConnectionName = savedPairing?.displayName ?: savedPairing?.relayHost,
            )
        }
    }

    private fun tearDownWork() {
        statusJob?.cancel()
        statusJob = null
        catalogJob?.cancel()
        catalogJob = null
        prepareJob?.cancel()
        prepareJob = null
        connectionJob?.cancel()
        connectionJob = null
        streamJobs.values.forEach { it.cancel() }
        streamJobs.clear()
        recoveryJobs.values.forEach { it.cancel() }
        recoveryJobs.clear()
        historyJobs.values.forEach { it.cancel() }
        historyJobs.clear()
        replyConfigJobs.values.forEach { it.cancel() }
        replyConfigJobs.clear()
        replyConfigSeqs.clear()
        elicitationJobs.values.forEach { it.cancel() }
        elicitationJobs.clear()
        elicitationSeqs.clear()
        draftPrepared.clear()
    }

    /** 所有连接相关工作的承载 scope；随连接代际销毁，迟到的旧任务不会回写。 */
    private fun workScopeFor(gen: Int): CoroutineScope? {
        val job = connectionJob ?: return null
        if (gen != connectionGen || !job.isActive) return null
        return CoroutineScope(workScope.coroutineContext + job)
    }

    private fun startStatusLoop(active: ActiveConnection, gen: Int) {
        val ownerId = serviceOwnerId
        statusJob = workScopeFor(gen)?.launch {
            var wasConnected = false
            while (gen == connectionGen) {
                val status = runCatching { active.client.statusNow() }.getOrNull() ?: break
                val firstConnect = status.state == "connected" && !wasConnected
                // 先提交候选配对再发布 connected：保存失败直接回到落地页，
                // 已保存的旧配对保持不动。
                if (firstConnect && pendingSave != null) {
                    val candidate = pendingSave ?: return@launch
                    pendingSave = null
                    val saved = runCatching { pairingStore.save(candidate) }.isSuccess
                    if (!saved) {
                        active.close()
                        connection = null
                        _state.update { old ->
                            AppState(
                                stage = Stage.PAIRING,
                                connectError = "无法保存配对，请重试",
                                themeMode = old.themeMode,
                                reduceTransparency = old.reduceTransparency,
                                fontSize = old.fontSize,
                                savedConnectionName = old.savedConnectionName,
                            )
                        }
                        break
                    }
                    savedPairing = candidate
                    _state.update {
                        it.copy(savedConnectionName = candidate.displayName ?: candidate.relayHost)
                    }
                }
                _state.update { state ->
                    // 已连接即保持前台服务；closed 是终态，必须释放服务所有权。
                    val keepAlive = status.state != "closed" &&
                        (state.keepAliveService || status.state == "connected")
                    state.copy(
                        // 首次连上才离开连接页；之后的瞬断停留在工作台。
                        stage = if (status.state == "connected") Stage.HOME else state.stage,
                        connecting = state.stage == Stage.PAIRING &&
                            status.state != "connected" && status.state != "closed",
                        connectError = when {
                            status.state == "connected" -> null
                            status.state == "closed" && !wasConnected ->
                                status.error ?: "连接被对端关闭，请检查桌面端远程访问"
                            state.stage == Stage.PAIRING -> status.error ?: state.connectError
                            else -> state.connectError
                        },
                        connectionState = status.state,
                        connectionError = if (state.stage == Stage.HOME) status.error else null,
                        keepAliveService = keepAlive,
                        serviceConnectionId = ownerId.takeIf { keepAlive },
                    )
                }
                if (firstConnect) {
                    wasConnected = true
                    refresh(gen)
                    // 断线重连：仍在运行的会话按服务端状态恢复历史与审批。
                    recoverRunningThreads(gen)
                } else if (status.state != "connected") {
                    wasConnected = false
                }
                if (status.state == "closed") break
                delay(statusPollMs)
            }
        }
    }

    fun reconnect() {
        val active = connection ?: return
        val gen = connectionGen
        workScopeFor(gen)?.launch {
            runCatching { active.client.check() }
            if (gen == connectionGen) refresh(gen)
        }
    }

    /** 移除配对并断开：只清理本应用的配对文件与连接。 */
    fun disconnect() {
        connectionGen++
        catalogRevision++
        tearDownWork()
        connection?.close()
        connection = null
        pendingSave = null
        savedPairing = null
        pairingStore.clear()
        _state.update {
            AppState(
                stage = Stage.PAIRING,
                themeMode = it.themeMode,
                reduceTransparency = it.reduceTransparency,
                fontSize = it.fontSize,
            )
        }
    }

    /** 重连已保存的实例；无保存配对时为空操作。 */
    fun reconnectSaved() {
        val saved = savedPairing ?: return
        open(saved, persist = false)
    }

    /** 断开当前连接但保留已保存配对，回到落地页可再连或连接其他实例。 */
    fun connectAnother() {
        connectionGen++
        catalogRevision++
        tearDownWork()
        connection?.close()
        connection = null
        pendingSave = null
        _state.update {
            AppState(
                stage = Stage.PAIRING,
                themeMode = it.themeMode,
                reduceTransparency = it.reduceTransparency,
                fontSize = it.fontSize,
                savedConnectionName = savedPairing?.displayName ?: savedPairing?.relayHost,
            )
        }
    }

    /** 重命名已保存实例：只更新显示名，不动传输与加密会话。 */
    fun renameConnection(name: String): Boolean {
        val normalized = Pairing.normalizeDisplayName(name) ?: return false
        val saved = savedPairing ?: return false
        val next = Pairing(
            relayUrl = saved.relayUrl,
            connectCode = saved.connectCode,
            version = saved.version,
            displayName = normalized,
        )
        try {
            pairingStore.save(next)
        } catch (error: Exception) {
            _state.update { it.copy(connectionError = "无法保存名称") }
            return false
        }
        savedPairing = next
        _state.update {
            it.copy(
                instanceName = normalized,
                savedConnectionName = normalized,
            )
        }
        return true
    }

    fun setShowConnections(show: Boolean) = _state.update { it.copy(showConnections = show) }

    fun setFontSize(size: Int) {
        val value = size.takeIf { it == 15 || it == 16 || it == 18 } ?: 16
        preferences.fontSize = value
        _state.update { it.copy(fontSize = value) }
    }

    /** 页面退出（Activity finish）：关闭连接与前台服务，不终止桌面端回合。 */
    fun shutdown() {
        connectionGen++
        catalogRevision++
        tearDownWork()
        connection?.close()
        connection = null
        _state.update { it.copy(keepAliveService = false, serviceConnectionId = null) }
    }

    override fun onCleared() {
        shutdown()
    }

    // ---- 目录与刷新 --------------------------------------------------------

    fun refresh() = refresh(connectionGen)

    private fun refresh(gen: Int) {
        val active = connection ?: return
        val scope = workScopeFor(gen) ?: return
        val revision = ++catalogRevision
        catalogJob?.cancel()
        _state.update { it.copy(catalogLoading = true, catalogError = null) }
        catalogJob = scope.launch {
            val workspaces = runCatching { active.api.workspaces() }
            if (gen != connectionGen || revision != catalogRevision) return@launch
            workspaces.fold(
                onSuccess = { list ->
                    _state.update { it.copy(workspaces = list, catalogError = null) }
                    val engines = runCatching { active.api.agentEngines() }.getOrNull()
                    if (gen == connectionGen && revision == catalogRevision && engines != null) {
                        _state.update { it.copy(engines = engines) }
                    }
                    loadAllSessions(active, gen, revision, list)
                },
                onFailure = { error ->
                    if (error is CancellationException) throw error
                    _state.update {
                        it.copy(catalogLoading = false, catalogError = error.message ?: "加载失败")
                    }
                },
            )
        }
    }

    private suspend fun loadAllSessions(
        active: ActiveConnection,
        gen: Int,
        revision: Int,
        workspaces: List<Workspace>,
    ) {
        // 受限并发拉取各工作区会话；失败的工作区保留已有条目，区分失败与真为空。
        val gate = Semaphore(4)
        val results = java.util.concurrent.ConcurrentHashMap<String, List<RemoteSession>>()
        coroutineScope {
            for (workspace in workspaces) {
                launch {
                    val sessions = gate.withPermit {
                        runCatching { active.api.sessions(workspace.hash) }.getOrElse { error ->
                            if (error is CancellationException) throw error
                            null
                        }
                    }
                    if (sessions != null) results[workspace.hash] = sessions
                }
            }
        }
        if (gen != connectionGen || revision != catalogRevision) return
        _state.update { state ->
            val merged = state.sessionsByWorkspace.toMutableMap()
            for ((hash, sessions) in results) merged[hash] = sessions
            state.copy(sessionsByWorkspace = merged, catalogLoading = false)
        }
    }

    // ---- 选择与浏览 --------------------------------------------------------

    fun selectWorkspace(hash: String?) {
        _state.update { it.copy(workspaceFilter = hash) }
    }

    fun selectThread(key: ThreadKey?) {
        _state.update { it.copy(selectedThread = key) }
        if (key == null) return
        val gen = connectionGen
        val active = connection ?: return
        if (key.isLocalDraft()) {
            // 本地草稿没有服务端会话：只按需准备回复设置。
            loadReplyConfig(key)
            return
        }
        loadHistory(active, gen, key, force = false)
        loadReplyConfig(key)
        loadElicitations(active, gen, key)
        workScopeFor(gen)?.launch { refreshThreadMeta(active, gen, key) }
        // 选中时仍有安全排队条目且无活动回合：按服务端空闲确认后再派发。
        val thread = _state.value.threads[key]
        if (thread != null && thread.queued.any { !it.requiresReview } &&
            !thread.running && streamJobs[key]?.isActive != true
        ) {
            startRecovery(active, gen, key)
        }
    }

    /** 手动刷新：草稿重试回复设置，真实会话强制重读历史并确认空闲。 */
    fun refreshThread(key: ThreadKey) {
        if (key.isLocalDraft()) {
            updateThread(key) { it.copy(error = null) }
            loadReplyConfig(key, force = true)
            return
        }
        val active = connection ?: return
        loadHistory(active, connectionGen, key, force = true)
    }

    /** 按线程键的最新历史加载任务：重复进入/刷新只保留最新一次。 */
    private fun loadHistory(active: ActiveConnection, gen: Int, key: ThreadKey, force: Boolean) {
        historyJobs[key]?.cancel()
        val job = workScopeFor(gen)?.launch {
            val thread = _state.value.threads[key] ?: return@launch
            if (!force && thread.historyLoaded) return@launch
            if (streamJobs[key]?.isActive == true) return@launch
            val messages = runCatching {
                ChatReducer.historyMessages(active.api.history(key.workspaceHash, key.sessionName))
            }.getOrElse { error ->
                if (error is CancellationException) throw error
                null
            }
            if (gen != connectionGen) return@launch
            // 只许最新一次历史任务落库；被更新的加载取代的任务静默丢弃。
            if (historyJobs[key] !== coroutineContext[Job]) return@launch
            if (streamJobs[key]?.isActive == true) return@launch
            if (messages != null) {
                updateThread(key) { it.copy(messages = messages, historyLoaded = true, error = null) }
                // 强制刷新成功清错后，排队条目仍需服务端空闲确认才能派发。
                if (force && _state.value.threads[key]?.queued?.isNotEmpty() == true) {
                    startRecovery(active, gen, key)
                }
            } else {
                // 加载失败不标已读：再次进入或手动刷新可重试。
                updateThread(key) { it.copy(error = it.error ?: "历史加载失败，请重试") }
            }
        }
        if (job == null) return
        historyJobs[key] = job
        job.invokeOnCompletion { historyJobs.remove(key, job) }
    }

    fun backToHome() {
        _state.update { it.copy(selectedThread = null) }
    }

    fun setTab(tab: HomeTab) = _state.update { it.copy(tab = tab) }
    fun updateSearch(query: String) = _state.update { it.copy(searchQuery = query) }
    fun setShowSettings(show: Boolean) = _state.update { it.copy(showSettings = show) }
    fun clearConnectError() = _state.update { it.copy(connectError = null) }

    fun setThemeMode(mode: ThemeMode) {
        preferences.themeMode = ThemeMode.persist(mode)
        _state.update { it.copy(themeMode = mode) }
    }

    fun setReduceTransparency(reduce: Boolean) {
        preferences.reduceTransparency = reduce
        _state.update { it.copy(reduceTransparency = reduce) }
    }

    /** 新建会话单飞：prepare 未完成或离线时不允许再次发起。 */
    fun newSession(workspaceHash: String) {
        if (_state.value.connectionState != "connected") return
        // 先开本地草稿会话：prepare 推迟到首次发送/打开回复设置时，
        // 放弃草稿不会在目录里留下空会话。
        val key = ThreadKey(workspaceHash, "$DRAFT_PREFIX${UUID.randomUUID()}")
        val workspaceName = _state.value.workspaces
            .firstOrNull { it.hash == workspaceHash }
            ?.let { it.displayName ?: it.name } ?: workspaceHash
        ensureThread(key) {
            ThreadView(
                key = key, title = "新会话", workspaceName = workspaceName,
                historyLoaded = true, isDraft = true, agentId = "native",
            )
        }
        _state.update { it.copy(selectedThread = key) }
    }

    /** 草稿会话切换引擎：清掉缓存的 prepare 结果，下一次按新引擎准备。 */
    fun selectDraftEngine(key: ThreadKey, agentId: String) {
        if (!key.isLocalDraft()) return
        val thread = _state.value.threads[key] ?: return
        if (thread.sendPending || thread.replyConfig.saving) return
        if (thread.agentId == agentId) return
        // 只接受 native 或目录中可用且未隐藏的引擎。
        if (agentId != "native") {
            val engine = _state.value.engines.firstOrNull { it.id == agentId } ?: return
            if (!engine.available || engine.hidden) return
        }
        nextConfigSeq(key)
        replyConfigJobs.remove(key)?.cancel()
        draftPrepared.remove(key)
        updateThread(key) {
            it.copy(agentId = agentId, replyConfig = ReplyConfigState())
        }
        loadReplyConfig(key)
    }

    /** 草稿会话换目标项目：只搬本地键，服务端还没有任何资源。 */
    fun selectDraftWorkspace(key: ThreadKey, workspaceHash: String) {
        if (!key.isLocalDraft()) return
        val thread = _state.value.threads[key] ?: return
        if (thread.sendPending || thread.replyConfig.saving) return
        val target = _state.value.workspaces.firstOrNull { it.hash == workspaceHash } ?: return
        val real = key.copy(workspaceHash = workspaceHash)
        if (real == key) return
        nextConfigSeq(key)
        replyConfigJobs.remove(key)?.cancel()
        draftPrepared.remove(key)
        _state.update { state ->
            val view = state.threads[key] ?: return@update state
            // 纯聊天工作区固定 native，不携带项目引擎。
            val agentId = if (workspaceHash == Workspace.CHAT.hash) "native" else view.agentId
            state.copy(
                threads = state.threads - key +
                    (real to view.copy(
                        key = real,
                        workspaceName = target.displayName ?: target.name,
                        agentId = agentId,
                        replyConfig = ReplyConfigState(),
                    )),
                selectedThread = if (state.selectedThread == key) real else state.selectedThread,
                drafts = state.drafts[key]?.let { state.drafts - key + (real to it) } ?: state.drafts,
            )
        }
        loadReplyConfig(real)
    }

    private fun ThreadKey.isLocalDraft() = sessionName.startsWith(DRAFT_PREFIX)

    /** 草稿键的真实会话名：未 prepare 前没有服务端会话可寻址。 */
    private fun ThreadKey.apiSessionName(): String? =
        if (isLocalDraft()) draftPrepared[this]?.sessionName else sessionName

    /** 取草稿的 prepare 结果：命中缓存直接返回，否则向服务端发起一次。 */
    private suspend fun prepareDraft(
        active: ActiveConnection,
        key: ThreadKey,
        agentId: String,
    ): PreparedSession = draftPrepared[key] ?: active.api.prepare(key.workspaceHash, agentId)

    /** 草稿键转正：prepare 结果按当前工作区+引擎缓存；切换或过期即重取。 */
    private suspend fun ensureRealKey(active: ActiveConnection, gen: Int, key: ThreadKey): ThreadKey {
        if (!key.isLocalDraft()) return key
        val agentId = _state.value.threads[key]?.agentId ?: "native"
        val prepared = prepareDraft(active, key, agentId)
        coroutineContext.ensureActive()
        // prepare 期间换引擎/断开：迟到的结果不许转正或污染缓存。
        if (gen != connectionGen) return key
        val current = _state.value.threads[key] ?: return key
        if (current.agentId != agentId) return key
        if (draftPrepared[key] == null) draftPrepared[key] = prepared
        val real = ThreadKey(key.workspaceHash, prepared.sessionName)
        _state.update { state ->
            val view = state.threads[key] ?: return@update state
            val moved = view.copy(
                key = real,
                sendPending = false,
                agentId = prepared.agentId,
                replyConfig = view.replyConfig.copy(
                    options = view.replyConfig.options ?: prepared.configOptions,
                ),
            )
            state.copy(
                threads = state.threads - key + (real to moved),
                selectedThread = if (state.selectedThread == key) real else state.selectedThread,
                drafts = state.drafts[key]?.let { state.drafts - key + (real to it) } ?: state.drafts,
            )
        }
        draftPrepared.remove(key)
        return real
    }

    /** 发送入口：草稿键先转正再交给真实发送；非草稿直接发送。 */
    private fun dispatchSend(key: ThreadKey, text: String, queuedId: String?) {
        val active = connection ?: return
        if (!key.isLocalDraft()) {
            sendNow(key, text, queuedId)
            return
        }
        val current = _state.value.threads[key] ?: return
        if (_state.value.connectionState != "connected" ||
            current.sendPending || current.replyConfig.saving
        ) return
        // 在途的回复设置读取作废：转正会以 prepare 结果为准。
        if (current.replyConfig.loading) {
            nextConfigSeq(key)
            replyConfigJobs.remove(key)?.cancel()
        }
        updateThread(key) {
            it.copy(sendPending = true, replyConfig = it.replyConfig.copy(loading = false))
        }
        val scope = workScopeFor(connectionGen)
        if (scope == null) {
            updateThread(key) { it.copy(sendPending = false) }
            return
        }
        val gen = connectionGen
        scope.launch {
            val real = try {
                ensureRealKey(active, gen, key)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (gen == connectionGen) {
                    // 转正失败：保留草稿让用户重试。
                    updateThread(key) {
                        it.copy(
                            sendPending = false,
                            error = error.message ?: "会话创建失败",
                        )
                    }
                }
                return@launch
            }
            if (gen == connectionGen && !real.isLocalDraft()) {
                sendNow(real, text, queuedId)
            } else if (gen == connectionGen) {
                // 转正被并发切换作废：不拿草稿键发请求。
                updateThread(key) { it.copy(sendPending = false) }
            }
        }
    }

    // ---- 草稿与发送 --------------------------------------------------------

    fun updateDraft(key: ThreadKey, text: String) {
        _state.update { it.copy(drafts = it.drafts + (key to text)) }
    }

    fun send(key: ThreadKey) {
        val text = _state.value.drafts[key]?.trim() ?: return
        if (text.isEmpty()) return
        val thread = _state.value.threads[key] ?: return
        if (_state.value.connectionState != "connected" || thread.replyConfig.saving) return
        // 草稿转正中重复点发送：不入队也不清输入，等转正完成。
        if (key.isLocalDraft() && thread.sendPending) return
        val busy = thread.running || thread.sendPending || thread.queuedDispatchId != null ||
            thread.queued.any { !it.requiresReview }
        if (busy) {
            enqueueQueued(key, text)
            return
        }
        dispatchSend(key, text, null)
    }

    /** 直接发送一段文本（普通 choice 选项走这里），不经过草稿。 */
    fun send(key: ThreadKey, text: String) {
        dispatchSend(key, text, null)
    }



    private fun sendNow(key: ThreadKey, text: String, queuedId: String?) {
        val active = connection ?: return
        val scope = workScopeFor(connectionGen) ?: return
        val thread = _state.value.threads[key] ?: return
        if (_state.value.connectionState != "connected" ||
            text.isBlank() || thread.running || thread.sendPending ||
            thread.replyConfig.saving
        ) return
        val gen = connectionGen
        // 发送前清掉该线程迟到的历史/恢复任务，避免旧结果覆盖本轮乐观状态。
        historyJobs.remove(key)?.cancel()
        recoveryJobs.remove(key)?.cancel()
        val requestId = UUID.randomUUID().toString()
        val userId = "user-${UUID.randomUUID()}"
        val assistantId = "live-${UUID.randomUUID()}"
        updateThread(key) {
            it.copy(
                running = true,
                sendPending = true,
                stopping = false,
                interrupted = false,
                error = null,
                activeRequestId = requestId,
                messages = it.messages + listOf(
                    ChatMessage(id = userId, role = Role.USER, text = text),
                    ChatMessage(id = assistantId, role = Role.ASSISTANT),
                ),
            )
        }
        val body = JSONObject()
        body.put("message", text)
        body.put("requestId", requestId)
        body.put("workspaceHash", key.workspaceHash)
        body.put("sessionName", key.sessionName)
        body.put("agentId", thread.agentId.ifEmpty { "native" })
        thread.customAgentId?.let { body.put("customAgentId", it) }

        val job = scope.launch(start = CoroutineStart.LAZY) {
            var accepted = false
            var draftCleared = false
            var finished = false
            try {
                active.api.chatStream(body, requestId).collect { event ->
                    if (gen != connectionGen) return@collect
                    accepted = true
                    if (queuedId != null) {
                        // 首个事件确认服务端已收：从队列摘除该条。
                        updateThread(key) { t ->
                            t.copy(queued = t.queued.filter { it.id != queuedId })
                        }
                    }
                    // 服务端推送的引擎配置（其他端改动或自身回合内同步）：
                    // 权威值直接落库，并使在途 GET/PUT 结果作废。
                    if (event.type == "config_options") {
                        val array = event.array("configOptions")
                        if (array != null) {
                            replyConfigSeqs[key] = (replyConfigSeqs[key] ?: 0L) + 1L
                            val options = ReplyConfig.parse(array)
                            updateThread(key) { current ->
                                current.copy(
                                    replyConfig = current.replyConfig.copy(
                                        options = options,
                                        loading = false,
                                        saving = false,
                                    ),
                                )
                            }
                        }
                    }
                    if (event.type == "elicitation") {
                        event.json?.let { ElicitationRequest.parse(it) }?.let { request ->
                            invalidateElicitations(key)
                            updateThread(key) { t ->
                                t.copy(
                                    elicitations = t.elicitations
                                        .filter { it.elicitationRequestId != request.elicitationRequestId } +
                                        request,
                                )
                            }
                        }
                    }
                    if (event.type == "elicitation_resolved") {
                        event.string("elicitationRequestId")?.let { resolvedId ->
                            invalidateElicitations(key)
                            updateThread(key) { t ->
                                t.copy(
                                    elicitations = t.elicitations
                                        .filter { it.elicitationRequestId != resolvedId },
                                    resolvingElicitationIds = t.resolvingElicitationIds - resolvedId,
                                )
                            }
                        }
                    }
                    if (!draftCleared && queuedId == null) {
                        draftCleared = true
                        // 首个服务端事件：只清与本次发送一致的草稿，不覆盖新输入。
                        // 排队派发的条目不碰输入框，用户此时可能在写新内容。
                        _state.update { state ->
                            if (state.drafts[key]?.trim() == text) {
                                state.copy(drafts = state.drafts - key)
                            } else {
                                state
                            }
                        }
                    }
                    updateThread(key) { current ->
                        val updated = current.messages.map { message ->
                            if (message.id == assistantId) {
                                ChatReducer.applyEvent(message, event)
                            } else {
                                message
                            }
                        }
                        var next = current.copy(
                            messages = updated,
                            sendPending = false,
                            isDraft = false,
                        )
                        val resolvedId = if (event.type == "permission_resolved") {
                            event.permissionRequestId
                        } else {
                            null
                        }
                        if (resolvedId != null) {
                            next = next.copy(
                                permissions = next.permissions
                                    .filter { it.permissionRequestId != resolvedId },
                                resolvingPermissionIds = next.resolvingPermissionIds - resolvedId,
                            )
                        }
                        next
                    }
                }
                finished = true
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                if (gen == connectionGen) {
                    when (error) {
                        is ApiException -> updateThread(key) { current ->
                            if (accepted) {
                                current.copy(
                                    sendPending = false,
                                    interrupted = true,
                                    error = error.message,
                                )
                            } else {
                                // 握手被拒（如 409）：按 ID 移除两条推测消息；
                                // 排队条目保留并标记需人工复核，不自动重发。
                                current.copy(
                                    running = false,
                                    sendPending = false,
                                    stopping = false,
                                    error = error.message,
                                    activeRequestId = null,
                                    queued = if (queuedId == null) {
                                        current.queued
                                    } else {
                                        current.queued.map {
                                            if (it.id == queuedId) it.copy(requiresReview = true) else it
                                        }
                                    },
                                    messages = current.messages.filter {
                                        it.id != userId && it.id != assistantId
                                    },
                                )
                            }
                        }
                        is StreamFailedException, is StreamInterruptedException ->
                            updateThread(key) {
                                it.copy(
                                    interrupted = true,
                                    sendPending = false,
                                    error = error.message ?: "回复中断",
                                )
                            }
                        else -> updateThread(key) {
                            it.copy(
                                interrupted = true,
                                sendPending = false,
                                error = error.message ?: "回复中断",
                            )
                        }
                    }
                }
            }
            if (gen != connectionGen) return@launch
            if (!accepted) {
                // 未被服务端接受：把输入还回草稿（用户已改写过则不动）。
                // 排队条目投递结果未知（含空流 EOF）：标记需人工复核，
                // 绝不自动重发，避免重复写入。
                if (queuedId == null) {
                    _state.update { state ->
                        val existing = state.drafts[key]
                        if (existing.isNullOrEmpty() || existing.trim() == text) {
                            state.copy(drafts = state.drafts + (key to text))
                        } else {
                            state
                        }
                    }
                } else {
                    updateThread(key) { t ->
                        t.copy(
                            queued = t.queued.map {
                                if (it.id == queuedId) it.copy(requiresReview = true) else it
                            },
                        )
                    }
                }
            }
            // 先摘掉流标记再进恢复：恢复路径据此判断不再有活动流。
            streamJobs.remove(key, coroutineContext[Job])
            updateThread(key) {
                it.copy(
                    sendPending = false,
                    queuedDispatchId = if (it.queuedDispatchId == queuedId) null else it.queuedDispatchId,
                )
            }
            // 流结束不代表服务端回合结束；idle 以 session-status 为准。
            // 首事件前的传输/EOF 失败同样要进恢复，否则线程会一直停在 running。
            if (finished) refreshCatalogQuietly(gen)
            if (finished || accepted || _state.value.threads[key]?.running == true) {
                startRecovery(active, gen, key)
            }
        }
        streamJobs[key] = job
        job.invokeOnCompletion { streamJobs.remove(key, job) }
        job.start()
    }

    // ---- 排队消息 ----------------------------------------------------------

    private fun enqueueQueued(key: ThreadKey, text: String) {
        val thread = _state.value.threads[key] ?: return
        // 满了直接拒绝：保留输入框内容，由界面计数/禁用提示，不写线程错误。
        if (thread.queued.size >= 50) return
        val id = "queued-" + UUID.randomUUID()
        updateThread(key) { it.copy(queued = it.queued + QueuedMessage(id, text)) }
        // 只清与本次入队一致的草稿，不覆盖新输入。
        _state.update { state ->
            if (state.drafts[key]?.trim() == text) {
                state.copy(drafts = state.drafts - key)
            } else {
                state
            }
        }
    }

    fun removeQueued(key: ThreadKey, id: String) {
        updateThread(key) { thread ->
            if (thread.queuedDispatchId == id) {
                thread
            } else {
                thread.copy(queued = thread.queued.filter { it.id != id })
            }
        }
        // 移除复核项后队尾仍有安全条目且线程空闲：经服务端空闲确认再派发。
        val state = _state.value
        val thread = state.threads[key] ?: return
        if (key.isLocalDraft()) return
        if (state.connectionState == "connected" && !thread.running &&
            !thread.sendPending && thread.error == null &&
            thread.queuedDispatchId == null && thread.queued.any { !it.requiresReview } &&
            streamJobs[key]?.isActive != true
        ) {
            connection?.let { startRecovery(it, connectionGen, key) }
        }
    }

    /** 取回排队消息编辑：草稿非空时拒绝，绝不丢弃用户输入。 */
    fun editQueued(key: ThreadKey, id: String): Boolean {
        val state = _state.value
        val thread = state.threads[key] ?: return false
        val entry = thread.queued.firstOrNull { it.id == id } ?: return false
        if (thread.queuedDispatchId == id) return false
        if (!state.drafts[key].isNullOrEmpty()) return false
        _state.update { it.copy(drafts = it.drafts + (key to entry.text)) }
        updateThread(key) { it.copy(queued = it.queued.filter { q -> q.id != id }) }
        return true
    }

    /** 插队到队首并停止当前回合：显式操作视为已确认安全，清除复核标记。 */
    fun promoteQueued(key: ThreadKey, id: String) {
        val thread = _state.value.threads[key] ?: return
        val entry = thread.queued.firstOrNull { it.id == id } ?: return
        if (thread.queuedDispatchId == id) return
        updateThread(key) {
            it.copy(
                queued = listOf(entry.copy(requiresReview = false)) +
                    it.queued.filter { q -> q.id != id },
            )
        }
        if (thread.running && thread.activeRequestId != null && !thread.stopping) stop(key)
    }

    /**
     * 队列消费的唯一入口：仅当已连接、服务端确认空闲、无错误、无配置保存、
     * 无活动流时才派发队首安全条目；存疑条目不自动重试。
     */
    private fun drainQueued(key: ThreadKey) {
        val state = _state.value
        val thread = state.threads[key] ?: return
        if (state.connectionState != "connected" ||
            thread.running || thread.sendPending || thread.replyConfig.saving ||
            thread.error != null || thread.queuedDispatchId != null ||
            streamJobs[key]?.isActive == true
        ) return
        val next = thread.queued.firstOrNull { !it.requiresReview } ?: return
        updateThread(key) { it.copy(queuedDispatchId = next.id) }
        dispatchSend(key, next.text, next.id)
    }

    /**
     * 精确停止：abort 只绑定捕获的 requestId/workspace/session；
     * 不取消本地读流——服务端会给这条流收尾，reader 自然结束。
     */
    fun stop(key: ThreadKey) {
        val active = connection ?: return
        val scope = workScopeFor(connectionGen) ?: return
        val thread = _state.value.threads[key] ?: return
        val requestId = thread.activeRequestId ?: return
        if (thread.stopping) return
        val gen = connectionGen
        updateThread(key) { it.copy(stopping = true) }
        scope.launch {
            val result = runCatching {
                active.api.abort(key.workspaceHash, key.sessionName, requestId)
            }
            if (gen != connectionGen) return@launch
            val failure = result.exceptionOrNull()
            if (failure != null) {
                if (failure is CancellationException) throw failure
                updateThread(key) { current ->
                    // 只有还是同一个回合才允许解除 stopping 并显示错误；
                    // 已被新请求替换的回合不能被旧 abort 的迟到失败污染。
                    if (current.activeRequestId == requestId) {
                        current.copy(
                            stopping = false,
                            error = failure.message ?: "停止失败，请重试",
                        )
                    } else {
                        current
                    }
                }
                if ((failure as? ApiException)?.status == 409) {
                    // 旧请求 ID 已失效：只刷新服务端状态，不动新回合。
                    refreshThreadMeta(active, gen, key)
                }
                return@launch
            }
            if (streamJobs[key]?.isActive != true) {
                // 本地流已不存在：只能靠状态轮询确认回合收尾。
                startRecovery(active, gen, key)
            }
        }
    }

    // ---- 审批与选择 --------------------------------------------------------

    fun resolvePermission(key: ThreadKey, permissionRequestId: String, optionId: String) {
        val active = connection ?: return
        val scope = workScopeFor(connectionGen) ?: return
        val thread = _state.value.threads[key] ?: return
        if (permissionRequestId in thread.resolvingPermissionIds) return
        val gen = connectionGen
        updateThread(key) {
            it.copy(resolvingPermissionIds = it.resolvingPermissionIds + permissionRequestId)
        }
        scope.launch {
            val result = runCatching {
                active.api.resolvePermission(key.workspaceHash, key.sessionName, permissionRequestId, optionId)
            }
            if (gen != connectionGen) return@launch
            val failure = result.exceptionOrNull()
            if (failure != null && failure is CancellationException) throw failure
            val stale = (failure as? ApiException)?.status == 409
            if (result.isSuccess || stale) {
                updateThread(key) { thread ->
                    val resolved = JSONObject()
                    resolved.put("permissionRequestId", permissionRequestId)
                    resolved.put("optionId", optionId)
                    val event = StreamEvent("permission_resolved", resolved)
                    thread.copy(
                        permissions = thread.permissions.filter {
                            it.permissionRequestId != permissionRequestId
                        },
                        resolvingPermissionIds = thread.resolvingPermissionIds - permissionRequestId,
                        messages = thread.messages.map { ChatReducer.applyEvent(it, event) },
                    )
                }
            } else {
                updateThread(key) {
                    it.copy(
                        resolvingPermissionIds = it.resolvingPermissionIds - permissionRequestId,
                        error = failure?.message ?: "审批提交失败，请重试",
                    )
                }
            }
        }
    }

    /** 普通 choice（无审批 ID）：预填选项文本到草稿，不自动发送。 */
    fun chooseOption(key: ThreadKey, optionText: String) {
        _state.update { state ->
            if (state.drafts[key].isNullOrBlank()) {
                state.copy(drafts = state.drafts + (key to optionText))
            } else {
                state
            }
        }
    }

    // ---- 回复设置 ----------------------------------------------------------

    private fun nextConfigSeq(key: ThreadKey): Long {
        val seq = (replyConfigSeqs[key] ?: 0L) + 1L
        replyConfigSeqs[key] = seq
        return seq
    }

    /**
     * 读取会话引擎配置：prepare 已带值时不重复取；打开设置面板可 force。
     * 在途写或 SSE 推送会使旧读作废，结果只认捕获的代际。
     */
    fun loadReplyConfig(key: ThreadKey, force: Boolean = false) {
        val active = connection ?: return
        val thread = _state.value.threads[key] ?: return
        val config = thread.replyConfig
        if (_state.value.connectionState != "connected") return
        if (config.loading || config.saving) return
        // 草稿转正中不允许再触发读取，避免并发 prepare。
        if (key.isLocalDraft() && thread.sendPending) return
        if (!force && config.options != null) return
        val gen = connectionGen
        val scope = workScopeFor(gen) ?: return
        val seq = nextConfigSeq(key)
        updateThread(key) { it.copy(replyConfig = it.replyConfig.copy(loading = true, error = null)) }
        val job = scope.launch {
            val result = runCatching {
                if (key.isLocalDraft()) {
                    // 本地草稿没有真实 sessionName：首次 prepare 的
                    // configOptions 即权威；已 prepare 过的按真实
                    // 会话名重取，PUT 之后的值不被旧快照回滚。
                    val previous = draftPrepared[key]
                    val prepared = previous ?: prepareDraft(active, key, thread.agentId)
                    coroutineContext.ensureActive()
                    if (gen != connectionGen || seq != replyConfigSeqs[key] ||
                        _state.value.threads[key]?.agentId != thread.agentId
                    ) return@launch
                    if (previous != null) {
                        active.api.replyConfig(key.workspaceHash, previous.sessionName)
                    } else {
                        draftPrepared[key] = prepared
                        prepared.configOptions
                            ?: active.api.replyConfig(key.workspaceHash, prepared.sessionName)
                    }
                } else {
                    active.api.replyConfig(key.workspaceHash, key.sessionName)
                }
            }
            // 写操作、SSE 推送或连接更换后，迟到的读结果一律丢弃。
            if (gen != connectionGen || seq != replyConfigSeqs[key]) return@launch
            result.fold(
                onSuccess = { options ->
                    updateThread(key) { it.copy(replyConfig = ReplyConfigState(options = options)) }
                },
                onFailure = { error ->
                    if (error is CancellationException) throw error
                    updateThread(key) {
                        it.copy(
                            replyConfig = it.replyConfig.copy(
                                loading = false,
                                error = error.message ?: "无法读取回复设置",
                            ),
                        )
                    }
                },
            )
        }
        replyConfigJobs[key] = job
        job.invokeOnCompletion { replyConfigJobs.remove(key, job) }
    }

    /**
     * 修改一项配置：校验选项仍存在且值合法后才发 PUT，不做乐观提交；
     * 服务端 {configOptions} 响应为权威结果，失败保留旧值就地报错。
     */
    fun changeReplyConfig(key: ThreadKey, configId: String, value: ConfigValue) {
        val active = connection ?: return
        val scope = workScopeFor(connectionGen) ?: return
        val thread = _state.value.threads[key] ?: return
        if (_state.value.connectionState != "connected" ||
            thread.running || thread.sendPending
        ) return
        val config = thread.replyConfig
        if (config.saving) return
        val option = config.options?.firstOrNull { it.id == configId } ?: return
        // 本地草稿只有 prepare 过才有真实会话名，否则无法寻址 PUT。
        val sessionName = key.apiSessionName() ?: return
        val valid = when (value) {
            is ConfigValue.Text ->
                option.type == ConfigType.SELECT && option.options.any { it.value == value.value }
            is ConfigValue.Toggle -> option.type == ConfigType.BOOLEAN
        }
        if (!valid) return
        val gen = connectionGen
        // 写操作使在途读作废：代际递增后旧读结果会被丢弃。
        val seq = nextConfigSeq(key)
        replyConfigJobs[key]?.cancel()
        updateThread(key) {
            it.copy(replyConfig = it.replyConfig.copy(loading = false, saving = true, error = null))
        }
        val job = scope.launch {
            val result = runCatching {
                active.api.updateReplyConfig(key.workspaceHash, sessionName, configId, value)
            }
            if (gen != connectionGen || seq != replyConfigSeqs[key]) return@launch
            result.fold(
                onSuccess = { options ->
                    updateThread(key) { it.copy(replyConfig = ReplyConfigState(options = options)) }
                    // 配置落盘后队列才可能解锁：按服务端空闲确认派发。
                    if (_state.value.threads[key]?.queued?.isNotEmpty() == true) {
                        if (key.isLocalDraft()) drainQueued(key)
                        else startRecovery(active, gen, key)
                    }
                },
                onFailure = { error ->
                    if (error is CancellationException) throw error
                    updateThread(key) {
                        it.copy(
                            replyConfig = it.replyConfig.copy(
                                saving = false,
                                error = error.message ?: "保存失败，请重试",
                            ),
                        )
                    }
                },
            )
        }
        replyConfigJobs[key] = job
        job.invokeOnCompletion { replyConfigJobs.remove(key, job) }
    }

    // ---- 问询表单（elicitations） -------------------------------------------

    /** SSE 增量或已解决应答使在途快照作废：递增代际并取消旧读取。 */
    private fun invalidateElicitations(key: ThreadKey) {
        elicitationSeqs[key] = (elicitationSeqs[key] ?: 0L) + 1L
        elicitationJobs.remove(key)?.cancel()
    }

    /** 拉取待处理问询：快照与最新 SSE 调和，仍在 resolving 的保留到 resolved 事件。 */
    private fun loadElicitations(active: ActiveConnection, gen: Int, key: ThreadKey) {
        if (key.isLocalDraft()) return
        if (elicitationJobs[key]?.isActive == true) return
        val scope = workScopeFor(gen) ?: return
        val seq = elicitationSeqs[key] ?: 0L
        val job = scope.launch {
            val list = runCatching {
                active.api.elicitations(key.workspaceHash, key.sessionName)
            }.getOrElse { error ->
                if (error is CancellationException) throw error
                null
            }
            coroutineContext.ensureActive()
            // SSE 已更新或已解决后，迟到的快照不许复活旧请求。
            if (gen != connectionGen || seq != (elicitationSeqs[key] ?: 0L) || list == null) return@launch
            updateThread(key) { thread ->
                val snapshotIds = list.map { it.elicitationRequestId }.toSet()
                val merged = list + thread.elicitations.filter {
                    it.elicitationRequestId !in snapshotIds &&
                        it.elicitationRequestId in thread.resolvingElicitationIds
                }
                thread.copy(elicitations = merged.distinctBy { it.elicitationRequestId })
            }
        }
        elicitationJobs[key] = job
        job.invokeOnCompletion { elicitationJobs.remove(key, job) }
    }

    /** 提交/拒绝问询：成功或确认冲突才移除；失败保留卡片与草稿。 */
    fun answerElicitation(
        key: ThreadKey,
        elicitationRequestId: String,
        action: String,
        content: Map<String, Any>,
    ) {
        val active = connection ?: return
        val scope = workScopeFor(connectionGen) ?: return
        if (_state.value.connectionState != "connected") return
        val thread = _state.value.threads[key] ?: return
        if (action != "accept" && action != "decline") return
        if (thread.elicitations.none { it.elicitationRequestId == elicitationRequestId }) return
        if (elicitationRequestId in thread.resolvingElicitationIds) return
        // 拒绝一律提交空对象，表单内容只在接受时上送。
        val payload = if (action == "decline") emptyMap() else content
        val gen = connectionGen
        updateThread(key) {
            it.copy(resolvingElicitationIds = it.resolvingElicitationIds + elicitationRequestId)
        }
        scope.launch {
            val result = runCatching {
                active.api.answerElicitation(
                    key.workspaceHash, key.sessionName, elicitationRequestId, action, payload,
                )
            }
            if (gen != connectionGen) return@launch
            result.fold(
                onSuccess = {
                    invalidateElicitations(key)
                    updateThread(key) { t ->
                        t.copy(
                            elicitations = t.elicitations
                                .filter { it.elicitationRequestId != elicitationRequestId },
                            resolvingElicitationIds = t.resolvingElicitationIds - elicitationRequestId,
                        )
                    }
                },
                onFailure = { error ->
                    if (error is CancellationException) throw error
                    // 409 类冲突：服务端已处理，按已解决移除。
                    val conflict = (error as? ApiException)?.status == 409
                    if (conflict) invalidateElicitations(key)
                    updateThread(key) { t ->
                        t.copy(
                            elicitations = if (conflict) {
                                t.elicitations.filter { it.elicitationRequestId != elicitationRequestId }
                            } else {
                                t.elicitations
                            },
                            resolvingElicitationIds = t.resolvingElicitationIds - elicitationRequestId,
                            error = if (conflict) t.error else error.message ?: "提交失败，请重试",
                        )
                    }
                },
            )
        }
    }

    // ---- 恢复 --------------------------------------------------------------

    /** 流丢失/重连/流结束后：按服务端状态轮询，确认空闲后再读取历史与待处理审批。 */
    private fun startRecovery(active: ActiveConnection, gen: Int, key: ThreadKey) {
        if (recoveryJobs[key]?.isActive == true) return
        val scope = workScopeFor(gen) ?: return
        val job = scope.launch {
            var attempts = 0
            try {
                while (gen == connectionGen) {
                    val status = runCatching {
                        active.api.sessionStatus(key.workspaceHash, key.sessionName)
                    }.getOrElse { error ->
                        if (error is CancellationException) throw error
                        null
                    }
                    if (status == null) {
                        if (++attempts > 40) break
                        delay(recoveryPollMs)
                        continue
                    }
                    if (status.running) {
                        // 服务端仍在跑：同步 requestId 与待处理审批，不碰本地内容。
                        refreshThreadMeta(active, gen, key)
                        delay(recoveryPollMs)
                        continue
                    }
                    if (gen != connectionGen) break
                    // 服务端确认空闲且本地无活动流：历史是此时唯一真相来源。
                    if (streamJobs[key]?.isActive != true) {
                        val messages = runCatching {
                            ChatReducer.historyMessages(
                                active.api.history(key.workspaceHash, key.sessionName),
                            )
                        }.getOrElse { error ->
                            if (error is CancellationException) throw error
                            null
                        }
                        if (gen != connectionGen) break
                        coroutineContext.ensureActive()
                        // 读取历史期间可能已有新流接管：再次确认后才允许回写。
                        if (streamJobs[key]?.isActive != true) {
                            var refreshCatalog = false
                            updateThread(key) { thread ->
                                // 草稿会话经恢复拿到了真实历史：转正并补目录刷新。
                                val becameReal = thread.isDraft && !messages.isNullOrEmpty()
                                if (becameReal) refreshCatalog = true
                                thread.copy(
                                    running = false,
                                    activeRequestId = null,
                                    stopping = false,
                                    interrupted = false,
                                    sendPending = false,
                                    isDraft = if (becameReal) false else thread.isDraft,
                                    historyLoaded = messages != null || thread.historyLoaded,
                                    messages = messages ?: thread.messages,
                                )
                            }
                            if (refreshCatalog) refreshCatalogQuietly(gen)
                        }
                    }
                    refreshThreadMeta(active, gen, key)
                    // 服务端确认空闲：只此时允许派发队列中的安全条目。
                    drainQueued(key)
                    break
                }
            } finally {
                recoveryJobs.remove(key, coroutineContext[Job])
            }
        }
        recoveryJobs[key] = job
        job.invokeOnCompletion { recoveryJobs.remove(key, job) }
    }

    private fun recoverRunningThreads(gen: Int) {
        val active = connection ?: return
        for ((key, thread) in _state.value.threads) {
            if (thread.running || thread.interrupted) startRecovery(active, gen, key)
        }
    }

    /** 会话元数据刷新：服务端 running 状态、requestId 与待处理审批。 */
    private suspend fun refreshThreadMeta(active: ActiveConnection, gen: Int, key: ThreadKey) {
        if (key.isLocalDraft()) return
        val status = runCatching {
            active.api.sessionStatus(key.workspaceHash, key.sessionName)
        }.getOrNull()
        val permissions = runCatching {
            active.api.permissions(key.workspaceHash, key.sessionName)
        }.getOrNull()
        // 读取期间线程可能已被新流接管：落库前确认任务与代际仍有效。
        coroutineContext.ensureActive()
        if (gen != connectionGen) return
        var needsRecovery = false
        updateThread(key) { thread ->
            var updated = thread.copy(title = status?.title ?: thread.title)
            if (permissions != null) {
                // 待处理卡片与流内 choice 块按 ID 去重。
                val inBlocks = thread.messages.flatMap { it.blocks }
                    .mapNotNull { it.permissionRequestId }.toSet()
                updated = updated.copy(
                    permissions = permissions.filter { it.permissionRequestId !in inBlocks },
                )
            }
            if (status?.running == true && streamJobs[key]?.isActive != true) {
                // 其他端发起的回合：本地无流，记录服务端 requestId 供精确 abort。
                needsRecovery = true
                updated = updated.copy(running = true, activeRequestId = status.requestId)
            } else if (status?.running == false && streamJobs[key]?.isActive != true) {
                updated = updated.copy(
                    running = false,
                    stopping = false,
                    activeRequestId = null,
                    // 服务端确认空闲：待处理问询与 resolving 标记一并清掉。
                    elicitations = emptyList(),
                    resolvingElicitationIds = emptySet(),
                )
            }
            updated
        }
        if (needsRecovery) startRecovery(active, gen, key)
        // 仅运行中的会话需要待处理问询快照；空闲时已在上一步清空。
        if (status?.running == true) loadElicitations(active, gen, key)
    }

    /** 新会话首次回合结束后补一次目录刷新，让刚发出的会话出现在列表里。 */
    private fun refreshCatalogQuietly(gen: Int) {
        val scope = workScopeFor(gen) ?: return
        scope.launch { refresh(gen) }
    }

    private fun updateThread(key: ThreadKey, transform: (ThreadView) -> ThreadView) {
        _state.update { state ->
            val thread = state.threads[key] ?: return@update state
            state.copy(threads = state.threads + (key to transform(thread)))
        }
    }

    /** 新建线程视图；已存在（如有活动流）时保留原视图。 */
    private fun ensureThread(key: ThreadKey, create: () -> ThreadView) {
        _state.update { state ->
            if (key in state.threads) state
            else state.copy(threads = state.threads + (key to create()))
        }
    }

    /** 从会话列表行打开已有会话（保留外部会话的 agentId / customAgentId）。 */
    fun openSession(row: SessionRow) {
        val key = ThreadKey(row.workspace.hash, row.session.name)
        ensureThread(key) {
            ThreadView(
                key = key,
                title = row.session.title,
                workspaceName = row.workspace.name,
                agentId = row.session.agentId ?: "native",
                customAgentId = row.session.customAgentId,
            )
        }
        selectThread(key)
    }

    private fun Pairing.withDeviceName(): Pairing =
        if (displayName != null) this else copy(displayName = relayHost)
}
