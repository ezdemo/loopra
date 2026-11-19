package app.loopra.android.ui.state

import app.loopra.android.chat.ChatMessage
import app.loopra.android.data.AgentEngine
import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.AgentConfigOption
import app.loopra.android.data.PermissionChoice
import app.loopra.android.data.RemoteSession
import app.loopra.android.data.Workspace

data class ThreadKey(val workspaceHash: String, val sessionName: String)

/**
 * 回复设置的线程级状态：options 为 null 表示尚未取过。
 * loading / saving 互斥，error 为最近一次本地可见的失败。
 */
data class QueuedMessage(val id: String, val text: String, val requiresReview: Boolean = false)

data class ReplyConfigState(
    val options: List<AgentConfigOption>? = null,
    val loading: Boolean = false,
    val saving: Boolean = false,
    val error: String? = null,
)

data class ThreadView(
    val key: ThreadKey,
    val title: String,
    val workspaceName: String,
    val messages: List<ChatMessage> = emptyList(),
    val historyLoaded: Boolean = false,
    /** 服务端回合仍在进行（本地流可能存活也可能已断开待恢复）。 */
    val running: Boolean = false,
    /** 消息提交中：流尚未建立，禁止重复提交。 */
    val sendPending: Boolean = false,
    /** abort 请求已发出、等待服务端确认回合收尾。 */
    val stopping: Boolean = false,
    val interrupted: Boolean = false,
    val error: String? = null,
    /** 新建会话：已 prepare 但尚未发出第一条消息，列表里还看不到。 */
    val isDraft: Boolean = false,
    val agentId: String = "native",
    val customAgentId: String? = null,
    val activeRequestId: String? = null,
    val permissions: List<PermissionChoice> = emptyList(),
    val elicitations: List<ElicitationRequest> = emptyList(),
    val resolvingElicitationIds: Set<String> = emptySet(),
    val queued: List<QueuedMessage> = emptyList(),
    val queuedDispatchId: String? = null,
    /** 已提交、等待服务端响应的审批 ID：防止重复点击发出第二次请求。 */
    val resolvingPermissionIds: Set<String> = emptySet(),
    val replyConfig: ReplyConfigState = ReplyConfigState(),
)

enum class Stage { PAIRING, HOME }
enum class HomeTab { SESSIONS, PROJECTS }
enum class ThemeMode { SYSTEM, LIGHT, DARK;

    companion object {
        fun of(value: String): ThemeMode = entries.firstOrNull { it.name.equals(value, true) } ?: SYSTEM
        fun persist(mode: ThemeMode): String = mode.name.lowercase()
    }
}

data class SessionRow(
    val session: RemoteSession,
    val workspace: Workspace,
)

data class AppState(
    val stage: Stage = Stage.PAIRING,
    /** connecting | connected | disconnected | closed */
    val connectionState: String = "disconnected",
    val connectionError: String? = null,
    /** 配对校验通过且正在建立连接（用于落地页按钮态）。 */
    val connecting: Boolean = false,
    val connectError: String? = null,
    /** ACTION_VIEW 深链解析出的候选实例（链接本体留在 ViewModel 内存中）。 */
    val pendingPairingName: String? = null,
    /** prepare 进行中：禁用重复的新会话入口。 */
    val preparingNewSession: Boolean = false,
    val instanceName: String? = null,
    val savedConnectionName: String? = null,
    val showConnections: Boolean = false,
    val engines: List<AgentEngine> = emptyList(),
    val relayHost: String? = null,
    /** 前台服务是否应保持（已连接且连接由用户发起）。 */
    val keepAliveService: Boolean = false,
    val serviceConnectionId: String? = null,
    val workspaces: List<Workspace> = emptyList(),
    val sessionsByWorkspace: Map<String, List<RemoteSession>> = emptyMap(),
    val catalogLoading: Boolean = false,
    val catalogError: String? = null,
    val threads: Map<ThreadKey, ThreadView> = emptyMap(),
    val selectedThread: ThreadKey? = null,
    val workspaceFilter: String? = null,
    val tab: HomeTab = HomeTab.SESSIONS,
    val drafts: Map<ThreadKey, String> = emptyMap(),
    val searchQuery: String = "",
    val showSettings: Boolean = false,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val reduceTransparency: Boolean = false,
    val fontSize: Int = 16,
) {
    /** 扁平化、过滤后的会话列表（含草稿会话）。 */
    fun sessionRows(): List<SessionRow> {
        val rows = mutableListOf<SessionRow>()
        for (workspace in workspaces) {
            if (workspaceFilter != null && workspace.hash != workspaceFilter) continue
            val sessions = sessionsByWorkspace[workspace.hash] ?: emptyList()
            for (session in sessions) rows.add(SessionRow(session, workspace))
            // 目录里还没有的本地已转正线程（刚发出还没刷新的会话）单独补进来；
            // 本地草稿与 prepare 后首条被拒的会话不算真实会话。
            for ((key, thread) in threads) {
                if (key.workspaceHash == workspace.hash &&
                    !key.sessionName.startsWith("draft:") &&
                    !thread.isDraft &&
                    sessions.none { it.name == key.sessionName }
                ) {
                    rows.add(SessionRow(RemoteSession(key.sessionName, thread.title, 0L, 0, thread.agentId, thread.customAgentId), workspace))
                }
            }
        }
        val query = searchQuery.trim()
        val filtered = if (query.isEmpty()) rows else rows.filter {
            it.session.title.contains(query, true) || it.workspace.name.contains(query, true)
        }
        return filtered.sortedByDescending { it.session.mtime }
    }

    fun thread(): ThreadView? = selectedThread?.let { threads[it] }
}
