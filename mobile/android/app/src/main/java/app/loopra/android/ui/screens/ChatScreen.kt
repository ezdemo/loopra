package app.loopra.android.ui.screens

import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.chat.BlockType
import app.loopra.android.chat.ChatBlock
import app.loopra.android.chat.ChatMessage
import app.loopra.android.chat.InlineStyle
import app.loopra.android.chat.Role
import app.loopra.android.chat.ToolStatus
import app.loopra.android.chat.MarkdownContent
import app.loopra.android.chat.inlineChatRuns
import app.loopra.android.data.ConfigValue
import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.Workspace
import app.loopra.android.data.PermissionChoice
import app.loopra.android.data.PermissionOption
import app.loopra.android.data.ReplyConfig
import app.loopra.android.ui.components.AppIcons
import app.loopra.android.ui.components.GlassSurface
import app.loopra.android.ui.components.LoopraMark
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.state.QueuedMessage
import app.loopra.android.ui.state.ThreadView
import app.loopra.android.ui.theme.LocalLoopraDark
import app.loopra.android.ui.theme.wallpaper
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalClipboardManager
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import kotlinx.coroutines.launch

private val ComposerDark = Color(0xFF2A2B28)
private const val BottomSentinel = "bottom-sentinel"

/** 会话视图：截图式中性背景 + 整块转写面板 + 底部玻璃输入区。 */
@Composable
fun ChatScreen(
    state: AppState,
    thread: ThreadView,
    onBack: () -> Unit,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
    onReplyConfigLoad: () -> Unit,
    onReplyConfigChange: (String, ConfigValue) -> Unit,
    onRemoveQueued: (String) -> Unit,
    onEditQueued: (String) -> Boolean,
    onPromoteQueued: (String) -> Unit,
    onAnswerElicitation: (String, String, Map<String, Any>) -> Unit,
    onSelectDraftEngine: (String) -> Unit,
    onSelectDraftWorkspace: (String) -> Unit,
) {
    val backdrop = rememberLayerBackdrop()
    val listState = key(thread.key) { rememberLazyListState() }
    val scope = rememberCoroutineScope()
    val draft = state.drafts[thread.key] ?: ""
    val density = LocalDensity.current
    val dark = LocalLoopraDark.current
    var composerHeight by remember { mutableStateOf(120.dp) }
    var sheetPage by remember(thread.key) { mutableStateOf<SheetPage?>(null) }
    val composerFocus = remember { FocusRequester() }
    val clipboard = LocalClipboardManager.current
    // 待确认的草稿替换：消息重编辑与排队取回共用，绝不静默丢弃输入。
    var pendingDraftReplace by remember(thread.key) { mutableStateOf<String?>(null) }
    var pendingQueuedEdit by remember(thread.key) { mutableStateOf<QueuedMessage?>(null) }
    val focusComposer: () -> Unit = {
        scope.launch {
            runCatching { composerFocus.requestFocus() }
        }
    }
    val editMessage: (String) -> Unit = { text ->
        if (draft.isEmpty() || draft == text) {
            onDraftChange(text)
            focusComposer()
        } else {
            pendingDraftReplace = text
        }
    }

    // 底部哨兵项：内容增长时锚定真正的列表末尾，而不是巨大助手块的顶部。
    val lastItemIndex = (if (thread.messages.isEmpty()) 1 else 0) +
        thread.messages.size + thread.permissions.size + thread.elicitations.size +
        (if (thread.error != null) 1 else 0) +
        (if (thread.running || thread.sendPending) 1 else 0)
    val atEnd by remember(listState) { derivedStateOf { !listState.canScrollForward } }
    // 跟随标记只由用户手势改变；程序滚动不把跟随打开。
    var userDragging by remember(thread.key) { mutableStateOf(false) }
    var following by remember(thread.key) { mutableStateOf(true) }
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> userDragging = true
                is DragInteraction.Stop, is DragInteraction.Cancel -> userDragging = false
            }
        }
    }
    LaunchedEffect(atEnd, userDragging) {
        if (atEnd) following = true else if (userDragging) following = false
    }
    var newReplies by remember(thread.key) { mutableStateOf(false) }
    val last = thread.messages.lastOrNull()
    val contentSignature = thread.messages.size to
        (last?.blocks?.size ?: 0) to (last?.blocks?.lastOrNull()?.content?.length ?: last?.text?.length ?: 0)
    LaunchedEffect(
        contentSignature, thread.running, thread.permissions.size,
        thread.error != null, composerHeight,
    ) {
        if (following && !userDragging && lastItemIndex >= 0) {
            listState.requestScrollToItem(lastItemIndex)
        }
    }
    // 「有新回复」只在用户离开底部期间出现新内容时点亮，回到底部即熄灭。
    LaunchedEffect(contentSignature) { if (!atEnd) newReplies = true }
    LaunchedEffect(atEnd) { if (atEnd) newReplies = false }

    // 转写面板与输入区沿用 mobile.css --app-chat 的半透明层次；
    // 减少透明效果时退化为不透明面板色。
    val transcriptColor = when {
        state.reduceTransparency -> MaterialTheme.colorScheme.surface
        dark -> Color(0x9E111113)
        else -> Color(0x96FFFFFF)
    }
    val blurUnderSheet = sheetPage != null &&
        Build.VERSION.SDK_INT >= 31 && !state.reduceTransparency

    Box(Modifier.fillMaxSize().imePadding().navigationBarsPadding()) {
        // 被玻璃采集的底图：背景渐变 + 整幅转写面板。玻璃浮层绝不能在此层内。
        Column(
            Modifier
                .fillMaxSize()
                .then(if (blurUnderSheet) Modifier.blur(18.dp) else Modifier)
                .layerBackdrop(backdrop)
                .wallpaper()
                .statusBarsPadding(),
        ) {
            Spacer(Modifier.height(70.dp))
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp)
                    .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                    .background(transcriptColor),
            ) {
                MessageList(
                    state, thread, listState, onResolvePermission, onChooseOption, onRefresh,
                    onAnswerElicitation = { request, action, content ->
                        onAnswerElicitation(request, action, content)
                    },
                    onEditMessage = editMessage,
                    onCopy = { text -> clipboard.setText(AnnotatedString(text)) },
                    bottomPadding = composerHeight + 14.dp,
                )
            }
        }
        ChatToolbar(
            thread = thread,
            backdrop = backdrop,
            reduceTransparency = state.reduceTransparency,
            onBack = onBack,
            onOpenSettings = {
                onReplyConfigLoad()
                sheetPage = SheetPage.Settings
            },
        )
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .onGloballyPositioned { coords ->
                    composerHeight = with(density) { coords.size.height.toDp() }
                },
        ) {
            if (!following) {
                GlassSurface(
                    backdrop = backdrop,
                    reduceTransparency = state.reduceTransparency,
                    cornerRadius = 20.dp,
                    modifier = Modifier
                        .align(Alignment.CenterHorizontally)
                        .padding(bottom = 8.dp),
                ) {
                    Text(
                        if (newReplies) "↓ 有新回复" else "↓ 回到最新",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier
                            .clickable {
                                following = true
                                scope.launch { listState.animateScrollToItem(lastItemIndex) }
                            }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                }
            }
            if (thread.key.sessionName.startsWith("draft:") && state.workspaces.size > 1) {
                var workspaceMenu by remember { mutableStateOf(false) }
                Box(Modifier.padding(bottom = 6.dp)) {
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(14.dp))
                            .background(
                                if (dark) Color(0xFF2A2B28) else Color.White.copy(alpha = 0.8f),
                            )
                            .clickable(role = androidx.compose.ui.semantics.Role.Button) {
                                workspaceMenu = true
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            AppIcons.Folder, null, Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            state.workspaces
                                .firstOrNull { it.hash == thread.key.workspaceHash }
                                ?.let { it.displayName ?: it.name } ?: "纯聊天",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    androidx.compose.material3.DropdownMenu(
                        expanded = workspaceMenu,
                        onDismissRequest = { workspaceMenu = false },
                    ) {
                        for (workspace in state.workspaces) {
                            androidx.compose.material3.DropdownMenuItem(
                                text = { Text(workspace.displayName ?: workspace.name) },
                                onClick = {
                                    workspaceMenu = false
                                    onSelectDraftWorkspace(workspace.hash)
                                },
                            )
                        }
                    }
                }
            }
            if (thread.queued.isNotEmpty()) {
                QueueCard(
                    thread = thread,
                    onEdit = { id ->
                        if (!onEditQueued(id)) {
                            thread.queued.firstOrNull { it.id == id }
                                ?.let { pendingQueuedEdit = it }
                        }
                    },
                    onRemove = onRemoveQueued,
                    onPromote = onPromoteQueued,
                    modifier = Modifier
                        .padding(bottom = 8.dp)
                        .heightIn(max = 140.dp),
                )
            }
            Composer(
                state = state,
                thread = thread,
                draft = draft,
                backdrop = backdrop,
                onDraftChange = onDraftChange,
                onSend = onSend,
                onStop = onStop,
                onOpenModel = {
                    onReplyConfigLoad()
                    sheetPage = SheetPage.Models
                },
                onOpenSettings = {
                    onReplyConfigLoad()
                    sheetPage = SheetPage.Settings
                },
                focusRequester = composerFocus,
                modifier = Modifier
                    .padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 10.dp),
            )
        }
        pendingDraftReplace?.let { text ->
            AlertDialog(
                onDismissRequest = { pendingDraftReplace = null },
                confirmButton = {
                    TextButton(onClick = {
                        pendingDraftReplace = null
                        onDraftChange(text)
                        focusComposer()
                    }) { Text("替换") }
                },
                dismissButton = {
                    TextButton(onClick = { pendingDraftReplace = null }) { Text("取消") }
                },
                title = { Text("重新编辑消息") },
                text = { Text("替换当前输入框内容？") },
            )
        }
        pendingQueuedEdit?.let { entry ->
            AlertDialog(
                onDismissRequest = { pendingQueuedEdit = null },
                confirmButton = {
                    TextButton(onClick = {
                        pendingQueuedEdit = null
                        onDraftChange(entry.text)
                        onRemoveQueued(entry.id)
                        focusComposer()
                    }) { Text("替换") }
                },
                dismissButton = {
                    TextButton(onClick = { pendingQueuedEdit = null }) { Text("取消") }
                },
                title = { Text("编辑排队消息") },
                text = { Text("替换当前输入框内容？") },
            )
        }
        val page = sheetPage
        if (page != null) {
            ReplySettingsSheet(
                thread = thread,
                initialPage = page,
                controlsEnabled = state.connectionState == "connected" &&
                    !thread.running && !thread.sendPending,
                reduceTransparency = state.reduceTransparency,
                engines = if (thread.key.sessionName.startsWith("draft:") &&
                    thread.key.workspaceHash != Workspace.CHAT.hash
                ) {
                    state.engines
                } else {
                    emptyList()
                },
                onSelectEngine = onSelectDraftEngine,
                onDismiss = { sheetPage = null },
                onRetry = onReplyConfigLoad,
                onChange = onReplyConfigChange,
            )
        }
    }
}

enum class SheetPage { Settings, Models }

/** 顶栏：两个等宽圆形玻璃键保证标题真正居中。 */
@Composable
private fun ChatToolbar(
    thread: ThreadView,
    backdrop: com.kyant.backdrop.Backdrop,
    reduceTransparency: Boolean,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .height(66.dp)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RoundGlassButton(backdrop, reduceTransparency, onBack) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "返回",
                modifier = Modifier.size(20.dp),
            )
        }
        Column(
            Modifier
                .weight(1f)
                .padding(horizontal = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                thread.title,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (thread.workspaceName.isNotEmpty()) {
                Text(
                    thread.workspaceName,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        RoundGlassButton(backdrop, reduceTransparency, onOpenSettings) {
            Icon(
                AppIcons.Sliders,
                contentDescription = "回复设置",
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
private fun RoundGlassButton(
    backdrop: com.kyant.backdrop.Backdrop,
    reduceTransparency: Boolean,
    onClick: () -> Unit,
    icon: @Composable () -> Unit,
) {
    Box(
        Modifier
            .size(48.dp)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        GlassSurface(
            backdrop = backdrop,
            reduceTransparency = reduceTransparency,
            shape = CircleShape,
            modifier = Modifier.size(42.dp),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { icon() }
        }
    }
}

@Composable
private fun MessageList(
    state: AppState,
    thread: ThreadView,
    listState: androidx.compose.foundation.lazy.LazyListState,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
    onRefresh: () -> Unit,
    onAnswerElicitation: (String, String, Map<String, Any>) -> Unit,
    onEditMessage: (String) -> Unit,
    onCopy: (String) -> Unit,
    bottomPadding: androidx.compose.ui.unit.Dp,
) {
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 12.dp, bottom = bottomPadding),
    ) {
        if (thread.messages.isEmpty()) {
            item(key = "empty") {
                if (!thread.historyLoaded) {
                    Row(
                        Modifier.padding(vertical = 24.dp).fillMaxWidth(),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "读取聊天记录…",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 96.dp, bottom = 60.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        LoopraMark(size = 44.dp, halo = false)
                        Spacer(Modifier.height(14.dp))
                        Text(
                            if (thread.isDraft) "今天想做些什么？" else "开始这段对话",
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
        items(thread.messages, key = { it.id }) { message ->
            if (message.role == Role.USER) {
                UserBubble(message, onEditMessage, onCopy)
            } else {
                AssistantMessage(state, thread, message, onResolvePermission, onChooseOption, onCopy)
            }
        }
        for (permission in thread.permissions) {
            item(key = "perm-${permission.permissionRequestId}") {
                PermissionCard(
                    permission,
                    resolving = permission.permissionRequestId in thread.resolvingPermissionIds,
                ) { option ->
                    onResolvePermission(permission.permissionRequestId, option.value)
                }
            }
        }
        for (request in thread.elicitations) {
            item(key = "elic-${request.elicitationRequestId}") {
                ElicitationCard(
                    request = request,
                    resolving = request.elicitationRequestId in thread.resolvingElicitationIds,
                    modifier = Modifier.padding(vertical = 6.dp),
                ) { action, content ->
                    onAnswerElicitation(request.elicitationRequestId, action, content)
                }
            }
        }
        if (thread.error != null) {
            item(key = "error") {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        thread.error,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = onRefresh) {
                        Text("重试", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (thread.running || thread.sendPending) {
            item(key = "running") {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 6.dp)) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (thread.sendPending) "正在发送…" else "回复中…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        // 滚动锚定哨兵：自动跟随永远滚到列表真正的底部。
        item(key = BottomSentinel) { Spacer(Modifier.height(1.dp)) }
    }
}

@Composable
private fun UserBubble(
    message: ChatMessage,
    onEditMessage: (String) -> Unit,
    onCopy: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            SelectionContainer {
                Text(
                    message.text,
                    fontSize = 15.sp,
                    lineHeight = 25.sp,
                    color = if (LocalLoopraDark.current) Color(0xFF1C1C1A) else Color(0xFFF4F4F2),
                    modifier = Modifier
                        .fillMaxWidth(0.86f)
                        .clip(
                            RoundedCornerShape(
                                topStart = 20.dp, topEnd = 20.dp,
                                bottomEnd = 6.dp, bottomStart = 20.dp,
                            ),
                        )
                        .background(if (LocalLoopraDark.current) Color(0xFFE9E9E4) else Color(0xFF2E2F2C))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (message.time.isNotEmpty()) {
                Text(
                    message.time,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
            MessageAction("重新编辑消息", "✎") { onEditMessage(message.text) }
            MessageAction("复制消息", "⧉") { onCopy(message.text) }
        }
    }
    Spacer(Modifier.height(10.dp))
}

/** 消息尾部小号动作键：44dp 起点的可点击热区。 */
@Composable
private fun MessageAction(label: String, glyph: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(44.dp)
            .semantics { contentDescription = label }
            .clickable(
                role = androidx.compose.ui.semantics.Role.Button,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            glyph,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AssistantMessage(
    state: AppState,
    thread: ThreadView,
    message: ChatMessage,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
    onCopy: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        var index = 0
        val blocks = message.blocks
        while (index < blocks.size) {
            val block = blocks[index]
            if (block.type in ActivityTypes) {
                val group = mutableListOf<ChatBlock>()
                while (index < blocks.size && blocks[index].type in ActivityTypes) {
                    group.add(blocks[index])
                    index++
                }
                ActivityGroupRow(group)
            } else {
                ChatBlockView(state, thread, block, onResolvePermission, onChooseOption)
                index++
            }
        }
        if (blocks.isEmpty() && (thread.running || thread.sendPending)) {
            Text(
                "…",
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // 正在流式输出的这条助手消息不显示动作键，避免复制到半截内容。
        val liveReply = message.id.startsWith("live-") &&
            (thread.running || thread.sendPending)
        val copyable = blocks
            .filter { it.type == BlockType.CONTENT && it.content.isNotEmpty() }
            .joinToString("\n\n") { it.content }
        if (!liveReply && (message.time.isNotEmpty() || copyable.isNotEmpty())) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (message.time.isNotEmpty()) {
                    Text(
                        message.time,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    )
                }
                if (copyable.isNotEmpty()) {
                    MessageAction("复制回复", "⧉") { onCopy(copyable) }
                }
            }
        }
    }
    Spacer(Modifier.height(6.dp))
}

private val ActivityTypes = setOf(
    BlockType.REASONING,
    BlockType.REASONING_STARTED,
    BlockType.TOOL_CALL,
)

/** 相邻思考/工具块折叠为一行 `N 次思考 · M 次工具`，展开后复用原有渲染器。 */
@Composable
private fun ActivityGroupRow(group: List<ChatBlock>) {
    var expanded by remember(group.first().id) { mutableStateOf(false) }
    val reasoning = group.count {
        it.type == BlockType.REASONING_STARTED ||
            (it.type == BlockType.REASONING && it.content.isNotEmpty())
    }
    val tools = group.mapNotNull {
        if (it.type == BlockType.TOOL_CALL) it.toolCallId ?: it.id else null
    }.toSet().size
    val label = listOfNotNull(
        if (reasoning > 0) "$reasoning 次思考" else null,
        if (tools > 0) "$tools 次工具" else null,
    ).joinToString(" · ")

    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .clickable { expanded = !expanded }
                .semantics { stateDescription = if (expanded) "已展开" else "已折叠" }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier
                    .size(16.dp)
                    .rotate(if (expanded) 180f else 0f),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AnimatedVisibility(expanded) {
            Column {
                for (block in group) {
                    when (block.type) {
                        BlockType.TOOL_CALL -> ToolBlock(block)
                        else -> ReasoningBlock(block)
                    }
                }
            }
        }
    }
}

@Composable
private fun inlineAnnotated(text: String): AnnotatedString {
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
    return remember(text, codeBackground) {
        buildAnnotatedString {
            for (run in inlineChatRuns(text)) {
                when (run.style) {
                    InlineStyle.STRONG ->
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(run.text) }
                    InlineStyle.CODE ->
                        withStyle(
                            SpanStyle(
                                fontFamily = FontFamily.Monospace,
                                background = codeBackground,
                            ),
                        ) { append(run.text) }
                    InlineStyle.PLAIN -> append(run.text)
                }
            }
        }
    }
}

@Composable
private fun ChatBlockView(
    state: AppState,
    thread: ThreadView,
    block: ChatBlock,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
) {
    when (block.type) {
        BlockType.CONTENT -> SelectionContainer {
            MarkdownContent(
                block.content,
                modifier = Modifier.padding(vertical = 2.dp),
            )
        }
        BlockType.REASONING, BlockType.REASONING_STARTED -> ReasoningBlock(block)
        BlockType.TOOL_CALL -> ToolBlock(block)
        BlockType.SUB_AGENT -> SubAgentBlock(state, thread, block, onResolvePermission, onChooseOption)
        BlockType.CHOICE -> ChoiceBlock(thread, block, onResolvePermission, onChooseOption)
        BlockType.FILE_CHANGES -> FileChangesBlock(block)
        BlockType.NOTICE -> Text(
            block.name ?: block.content,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 4.dp),
        )
    }
}

@Composable
private fun ReasoningBlock(block: ChatBlock) {
    var expanded by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
            .clickable { expanded = !expanded }
            .padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(4.dp))
            Text(
                "思考过程",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AnimatedVisibility(expanded) {
            SelectionContainer {
                if (block.type == BlockType.REASONING_STARTED) {
                    Text(
                        "（思考内容已隐藏）",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                } else {
                    MarkdownContent(
                        block.content,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolBlock(block: ChatBlock) {
    var expanded by remember { mutableStateOf(false) }
    val statusColor = when (block.status) {
        ToolStatus.RUNNING -> MaterialTheme.colorScheme.primary
        ToolStatus.FAILED -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val statusText = when (block.status) {
        ToolStatus.RUNNING -> "执行中"
        ToolStatus.FAILED -> "失败"
        else -> "完成"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .clickable { expanded = !expanded }
            .padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.Build,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = statusColor,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                block.name ?: "工具",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                statusText + (block.duration?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelSmall,
                color = statusColor,
            )
        }
        AnimatedVisibility(expanded) {
            SelectionContainer {
                Column(Modifier.padding(top = 6.dp)) {
                    block.args?.let {
                        Text("参数", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    block.result?.let {
                        Spacer(Modifier.height(6.dp))
                        Text("结果", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun SubAgentBlock(
    state: AppState,
    thread: ThreadView,
    block: ChatBlock,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val statusText = when (block.status) {
        ToolStatus.RUNNING -> "执行中"
        ToolStatus.FAILED -> "失败"
        else -> "完成"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.06f))
            .clickable { expanded = !expanded }
            .padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                AppIcons.SubAgent,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "子代理 · ${block.name ?: ""}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(statusText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AnimatedVisibility(expanded) {
            Column(Modifier.padding(top = 6.dp, start = 8.dp)) {
                for (inner in block.blocks) {
                    ChatBlockView(state, thread, inner, onResolvePermission, onChooseOption)
                }
            }
        }
    }
}

@Composable
private fun ChoiceBlock(
    thread: ThreadView,
    block: ChatBlock,
    onResolvePermission: (String, String) -> Unit,
    onChooseOption: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
            .padding(12.dp),
    ) {
        Text(
            block.question ?: "请选择",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        block.description?.let {
            Spacer(Modifier.height(4.dp))
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(8.dp))
        if (block.selected != null) {
            Text(
                "已选择：${block.selected}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (block.subId != null && block.permissionRequestId == null) {
            // 旧式子会话审批没有可路由的 permissionRequestId，只能在桌面端处理。
            Text(
                "请在桌面端处理此请求",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            for (option in block.options) {
                val permissionId = block.permissionRequestId
                OutlinedButton(
                    onClick = {
                        if (permissionId != null) {
                            onResolvePermission(permissionId, option.value)
                        } else {
                            onChooseOption(option.title.ifEmpty { option.value })
                        }
                    },
                    enabled = when {
                        permissionId != null ->
                            permissionId !in thread.resolvingPermissionIds
                        else -> !thread.running && !thread.sendPending
                    },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                ) {
                    Text(option.title.ifEmpty { option.value }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun PermissionCard(
    permission: PermissionChoice,
    resolving: Boolean,
    onResolve: (PermissionOption) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f))
            .padding(12.dp),
    ) {
        Text(permission.title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
        permission.description?.let {
            Spacer(Modifier.height(4.dp))
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(8.dp))
        for (option in permission.options) {
            Button(
                onClick = { onResolve(option) },
                enabled = !resolving,
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            ) {
                Text(option.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun FileChangesBlock(block: ChatBlock) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(10.dp),
    ) {
        Text("文件变更", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (change in block.changes.take(8)) {
            Text(
                "${change.path}  +${change.additions} -${change.deletions}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 输入区：纯文本输入 + 当前模型/强度快捷入口 + 圆形发送/停止键。 */
@Composable
private fun Composer(
    state: AppState,
    thread: ThreadView,
    draft: String,
    backdrop: com.kyant.backdrop.Backdrop,
    focusRequester: FocusRequester,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onOpenModel: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dark = LocalLoopraDark.current
    val options = thread.replyConfig.options
    val model = remember(options) { ReplyConfig.modelOption(options) }
    val effort = remember(options) { ReplyConfig.effortOption(options) }
    GlassSurface(
        backdrop = backdrop,
        reduceTransparency = state.reduceTransparency,
        cornerRadius = 26.dp,
        tint = if (dark) Color(0xFF1D1D1F) else Color.White,
        tintAlpha = if (dark) 0.85f else 0.84f,
        fallbackColor = if (dark) ComposerDark else Color.White,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column {
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 130.dp)
                    .focusRequester(focusRequester)
                    .semantics { contentDescription = "消息输入" },
                textStyle = TextStyle(
                    fontSize = 15.sp,
                    lineHeight = 22.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                ),
                maxLines = 5,
                cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                decorationBox = { inner ->
                    Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp)) {
                        if (draft.isEmpty()) {
                            Text(
                                "发消息给 Loopra…",
                                fontSize = 15.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
                            )
                        }
                        inner()
                    }
                },
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (model != null) {
                    Row(
                        Modifier
                            .weight(1f, fill = false)
                            .clip(RoundedCornerShape(14.dp))
                            .clickable(enabled = !thread.running && !thread.sendPending) { onOpenModel() }
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            ReplyConfig.modelShortLabel(model),
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Icon(
                            Icons.Filled.KeyboardArrowDown,
                            contentDescription = "选择模型",
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (effort != null) {
                    Text(
                        ReplyConfig.currentLabel(effort),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        modifier = Modifier
                            .clip(RoundedCornerShape(14.dp))
                            .clickable(enabled = !thread.running && !thread.sendPending) { onOpenSettings() }
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                val active = thread.running || thread.sendPending
                val canStop = thread.running && thread.activeRequestId != null && !thread.stopping
                // 回合进行中发送键改为「加入队列」；队列满（50）时禁用。
                val canSend = draft.isNotBlank() && !thread.replyConfig.saving &&
                    state.connectionState == "connected" && thread.queued.size < 50
                if (thread.running) {
                    Box(
                        Modifier
                            .size(48.dp)
                            .clickable(
                                enabled = canStop,
                                role = androidx.compose.ui.semantics.Role.Button,
                                onClick = { if (canStop) onStop() },
                            )
                            .semantics { contentDescription = "停止回复" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(42.dp)
                                .clip(CircleShape)
                                .background(
                                    if (canStop) {
                                        if (dark) Color(0xFFECECE7) else Color(0xFF1D1D1B)
                                    } else {
                                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.25f)
                                    },
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                AppIcons.Stop,
                                contentDescription = null,
                                tint = if (canStop) {
                                    if (dark) Color(0xFF1C1C1A) else Color(0xFFF4F4F2)
                                } else {
                                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                                },
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                    Spacer(Modifier.width(6.dp))
                }
                val canTap = canSend
                Box(
                    Modifier
                        .size(48.dp)
                        .clickable(
                            enabled = canTap,
                            role = androidx.compose.ui.semantics.Role.Button,
                        ) { onSend() }
                        .semantics {
                            contentDescription = if (active) "加入队列" else "发送"
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier
                            .size(42.dp)
                            .clip(CircleShape)
                            .background(
                                if (canTap) {
                                    if (dark) Color(0xFFECECE7) else Color(0xFF1D1D1B)
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.25f)
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            AppIcons.ArrowUp,
                            contentDescription = null,
                            tint = if (canTap) {
                                if (dark) Color(0xFF1C1C1A) else Color(0xFFF4F4F2)
                            } else {
                                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                            },
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
}


/** 排队消息卡：点击进入草稿，X 撤回，活动回合时可插队。 */
@Composable
private fun QueueCard(
    thread: ThreadView,
    onEdit: (String) -> Unit,
    onRemove: (String) -> Unit,
    onPromote: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (LocalLoopraDark.current) Color(0xFF2A2B28)
                else Color.White.copy(alpha = 0.9f),
            )
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            "排队 ${thread.queued.size}",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        thread.queued.forEachIndexed { index, item ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    item.text + if (item.requiresReview) "（需确认）" else "",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { onEdit(item.id) }
                        .semantics { contentDescription = "编辑排队消息" }
                        .padding(vertical = 6.dp),
                )
                if (thread.running && index > 0) {
                    Text(
                        "↳",
                        fontSize = 14.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onPromote(item.id) }
                            .semantics { contentDescription = "优先发送" }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    Icons.Filled.Close,
                    contentDescription = "撤回排队消息",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .clickable { onRemove(item.id) }
                        .padding(3.dp),
                )
            }
        }
    }
}
