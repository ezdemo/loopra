package app.loopra.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.loopra.android.ui.screens.ChatScreen
import app.loopra.android.ui.screens.ConnectScreen
import app.loopra.android.ui.screens.ConnectionScreen
import app.loopra.android.ui.screens.HomeScreen
import app.loopra.android.ui.screens.SettingsSheet
import app.loopra.android.ui.state.Stage
import app.loopra.android.ui.theme.LoopraTheme

/** 工作台根：阶段路由 + 深链确认 + 设置弹层 + 连接管理页。 */
@Composable
fun AppRoot(
    viewModel: LoopraViewModel,
    onConnectRequested: () -> Unit,
    onScan: () -> Unit,
    onFinish: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // 界面字号偏好：在系统 fontScale 上乘以 15/16/18 相对档位，
    // 不覆盖系统无障碍缩放本身。
    val baseDensity = LocalDensity.current
    val scaledDensity = Density(
        baseDensity.density,
        baseDensity.fontScale * state.fontSize / 16f,
    )

    CompositionLocalProvider(LocalDensity provides scaledDensity) {
        LoopraTheme(state.themeMode) {
            when (state.stage) {
                Stage.PAIRING -> {
                    // 连接中返回键取消首次尝试；未配对时显式退出，
                    // 不留看不见的后台连接。
                    BackHandler {
                        if (state.connecting) viewModel.cancelConnect() else onFinish()
                    }
                    ConnectScreen(
                        state = state,
                        onConnect = { link ->
                            viewModel.connectWithLink(link)
                            onConnectRequested()
                        },
                        onScan = onScan,
                        onCancelConnect = viewModel::cancelConnect,
                        onReconnectSaved = {
                            viewModel.reconnectSaved()
                            onConnectRequested()
                        },
                        onForgetSaved = viewModel::disconnect,
                    )
                }
                Stage.HOME -> {
                    val thread = state.thread()
                    when {
                        state.showConnections -> {
                            BackHandler { viewModel.setShowConnections(false) }
                            ConnectionScreen(
                                state = state,
                                onBack = { viewModel.setShowConnections(false) },
                                onRename = viewModel::renameConnection,
                                onReconnect = viewModel::reconnect,
                                onConnectAnother = viewModel::connectAnother,
                                onForget = {
                                    viewModel.setShowConnections(false)
                                    viewModel.disconnect()
                                },
                            )
                        }
                        thread != null -> {
                            BackHandler { viewModel.backToHome() }
                            ChatScreen(
                                state = state,
                                thread = thread,
                                onBack = viewModel::backToHome,
                                onDraftChange = { text -> viewModel.updateDraft(thread.key, text) },
                                onSend = { viewModel.send(thread.key) },
                                onStop = { viewModel.stop(thread.key) },
                                onRefresh = { viewModel.refreshThread(thread.key) },
                                onResolvePermission = { id, option ->
                                    viewModel.resolvePermission(thread.key, id, option)
                                },
                                onChooseOption = { text -> viewModel.chooseOption(thread.key, text) },
                                onReplyConfigLoad = {
                                    viewModel.loadReplyConfig(thread.key, force = true)
                                },
                                onReplyConfigChange = { configId, value ->
                                    viewModel.changeReplyConfig(thread.key, configId, value)
                                },
                                onRemoveQueued = { id -> viewModel.removeQueued(thread.key, id) },
                                onEditQueued = { id -> viewModel.editQueued(thread.key, id) },
                                onPromoteQueued = { id -> viewModel.promoteQueued(thread.key, id) },
                                onAnswerElicitation = { id, action, content ->
                                    viewModel.answerElicitation(thread.key, id, action, content)
                                },
                                onSelectDraftEngine = { agentId ->
                                    viewModel.selectDraftEngine(thread.key, agentId)
                                },
                                onSelectDraftWorkspace = { hash ->
                                    viewModel.selectDraftWorkspace(thread.key, hash)
                                },
                            )
                        }
                        else -> {
                            // 工作列表根：返回键显式 finish，而不是被系统默认退到后台。
                            BackHandler { onFinish() }
                            HomeScreen(
                                state = state,
                                onOpenSession = viewModel::openSession,
                                onNewSession = viewModel::newSession,
                                onSelectWorkspace = viewModel::selectWorkspace,
                                onSelectTab = viewModel::setTab,
                                onSearch = viewModel::updateSearch,
                                onOpenSettings = { viewModel.setShowSettings(true) },
                                onReconnect = viewModel::reconnect,
                                onRefresh = viewModel::refresh,
                            )
                        }
                    }
                }
            }

            state.pendingPairingName?.let { name ->
                AlertDialog(
                    onDismissRequest = viewModel::dismissPendingLink,
                    title = { Text("更换连接") },
                    text = {
                        Text(
                            if (state.relayHost == null) "连接到 $name？"
                            else "连接到 $name？当前连接会断开。",
                        )
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            viewModel.confirmPendingLink()
                            onConnectRequested()
                        }) { Text("连接") }
                    },
                    dismissButton = {
                        TextButton(onClick = viewModel::dismissPendingLink) { Text("取消") }
                    },
                )
            }

            if (state.showSettings) {
                SettingsSheet(
                    state = state,
                    onDismiss = { viewModel.setShowSettings(false) },
                    onThemeMode = viewModel::setThemeMode,
                    onFontSize = viewModel::setFontSize,
                    onReduceTransparency = viewModel::setReduceTransparency,
                    onOpenConnections = {
                        viewModel.setShowSettings(false)
                        viewModel.setShowConnections(true)
                    },
                )
            }
        }
    }
}
