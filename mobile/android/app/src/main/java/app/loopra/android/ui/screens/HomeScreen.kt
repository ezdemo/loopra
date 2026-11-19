package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.data.Workspace
import app.loopra.android.ui.components.AppIcons
import app.loopra.android.ui.components.ClaudeIcon
import app.loopra.android.ui.components.GlassSurface
import app.loopra.android.ui.components.LoopraMark
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.state.HomeTab
import app.loopra.android.ui.state.SessionRow
import app.loopra.android.ui.state.ThreadKey
import app.loopra.android.ui.theme.LocalLoopraDark
import app.loopra.android.ui.theme.wallpaper
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop

/** 工作列表：会话/项目页 + 底部玻璃坞，对齐移动版 MobileWorkspace 结构。 */
@Composable
fun HomeScreen(
    state: AppState,
    onOpenSession: (SessionRow) -> Unit,
    onNewSession: (String) -> Unit,
    onSelectWorkspace: (String?) -> Unit,
    onSelectTab: (HomeTab) -> Unit,
    onSearch: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onReconnect: () -> Unit,
    onRefresh: () -> Unit,
) {
    val backdrop = rememberLayerBackdrop()
    val online = state.connectionState == "connected"
    Box(
        Modifier
            .fillMaxSize()
            .wallpaper(),
    ) {
        Box(
            Modifier
                .matchParentSize()
                .layerBackdrop(backdrop),
        )
        Column(
            Modifier
                .fillMaxSize()
                .widthIn(max = 510.dp)
                .align(Alignment.TopCenter)
                .statusBarsPadding(),
        ) {
            // 头部：应用标 + 状态 + 实例名，右侧刷新与设置。
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(RoundedCornerShape(14.dp)),
                ) { LoopraMark(size = 40.dp, halo = false) }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Loopra", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(7.dp))
                        Box(
                            Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(
                                    if (online) androidx.compose.ui.graphics.Color(0xFF3D9B50)
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                ),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            state.instanceName ?: state.relayHost ?: "",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                HeaderCircle(backdrop, state.reduceTransparency, "刷新", Icons.Filled.Refresh, onRefresh)
                Spacer(Modifier.width(8.dp))
                HeaderCircle(backdrop, state.reduceTransparency, "设置", AppIcons.Sliders, onOpenSettings)
            }

            Box(Modifier.weight(1f)) {
                when (state.tab) {
                    HomeTab.SESSIONS -> SessionList(state, online, onOpenSession, onRefresh, onSelectWorkspace, onSearch, onNewSession)
                    HomeTab.PROJECTS -> ProjectGrid(state, online, onRefresh) { hash ->
                        onSelectWorkspace(hash)
                        onSelectTab(HomeTab.SESSIONS)
                    }
                }
            }
        }

        // 底部玻璃坞：两个等宽页签 + 分隔线 + 新建。
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 16.dp, start = 16.dp, end = 16.dp)
                .widthIn(max = 480.dp)
                .fillMaxWidth(),
        ) {
            Dock(state, backdrop, online, onSelectTab) {
                val target = state.workspaceFilter ?: Workspace.CHAT.hash
                onNewSession(target)
            }
        }
    }
}

@Composable
private fun HeaderCircle(
    backdrop: com.kyant.backdrop.Backdrop,
    reduce: Boolean,
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    GlassSurface(
        backdrop = backdrop,
        reduceTransparency = reduce,
        modifier = Modifier
            .size(48.dp)
            .semantics { contentDescription = label }
            .clickable(role = Role.Button, onClick = onClick),
        shape = CircleShape,
        fallbackColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Icon(icon, label, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
private fun SessionList(
    state: AppState,
    online: Boolean,
    onOpenSession: (SessionRow) -> Unit,
    onRefresh: () -> Unit,
    onSelectWorkspace: (String?) -> Unit,
    onSearch: (String) -> Unit,
    onNewSession: (String) -> Unit,
) {
    val rows = state.sessionRows()
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text("会话", fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(
                "${rows.size}",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        Spacer(Modifier.height(14.dp))

        // 搜索框
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .height(46.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Search, null,
                Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BasicTextField(
                value = state.searchQuery,
                onValueChange = onSearch,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 10.dp),
                singleLine = true,
                textStyle = androidx.compose.ui.text.TextStyle(
                    fontSize = 15.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                decorationBox = { inner ->
                    Box {
                        if (state.searchQuery.isEmpty()) {
                            Text("搜索会话", fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        inner()
                    }
                },
            )
            if (state.searchQuery.isNotEmpty()) {
                Icon(
                    Icons.Filled.Close, "清除搜索",
                    Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .clickable { onSearch("") }
                        .padding(2.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(12.dp))

        // 项目筛选 pills
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterPill("全部", state.workspaceFilter == null) { onSelectWorkspace(null) }
            for (workspace in state.workspaces) {
                FilterPill(
                    workspace.displayName ?: workspace.name,
                    state.workspaceFilter == workspace.hash,
                ) { onSelectWorkspace(workspace.hash) }
            }
        }
        Spacer(Modifier.height(12.dp))

        Box(Modifier.weight(1f)) {
            when {
                state.catalogLoading && rows.isEmpty() -> EmptyHint("加载会话…")
                rows.isNotEmpty() -> LazyColumn(
                    Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp)
                        .clip(RoundedCornerShape(26.dp))
                        .background(
                            if (LocalLoopraDark.current) {
                                androidx.compose.ui.graphics.Color(0xFF242522).copy(alpha = 0.88f)
                            } else {
                                androidx.compose.ui.graphics.Color.White.copy(alpha = 0.88f)
                            },
                        ),
                ) {
                    items(rows, key = { "${it.session.name}@${it.workspace.hash}" }) { row ->
                        SessionListRow(state, row, onOpenSession)
                    }
                }
                else -> EmptyState(
                    filtered = state.searchQuery.isNotEmpty() || state.workspaceFilter != null,
                    onClearFilters = { onSearch(""); onSelectWorkspace(null) },
                    onNew = { onNewSession(state.workspaceFilter ?: Workspace.CHAT.hash) },
                )
            }
        }
        if (online && state.catalogError != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    state.catalogError,
                    Modifier.weight(1f),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.error,
                )
                Text(
                    "重试",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onRefresh)
                        .padding(8.dp),
                )
            }
        }
    }
}

@Composable
private fun FilterPill(label: String, selected: Boolean, onClick: () -> Unit) {
    val dark = LocalLoopraDark.current
    val bg = if (selected) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurface.copy(alpha = if (dark) 0.14f else 0.07f)
    }
    Box(
        Modifier
            .height(34.dp)
            .clip(RoundedCornerShape(17.dp))
            .background(bg)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            color = if (selected) MaterialTheme.colorScheme.onPrimary
            else MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SessionListRow(state: AppState, row: SessionRow, onOpenSession: (SessionRow) -> Unit) {
    val thread = state.threads[ThreadKey(row.workspace.hash, row.session.name)]
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button) { onOpenSession(row) }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(Modifier.heightIn(min = 64.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentTile(row.session.agentId)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    row.session.title.ifEmpty { row.session.name },
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    row.workspace.displayName ?: row.workspace.name,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    relativeTime(row.session.mtime),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (thread?.running == true) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(top = 4.dp),
                    ) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(androidx.compose.ui.graphics.Color(0xFF3D9B50)),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text("回复中", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Spacer(
            Modifier
                .fillMaxWidth()
                .height(0.5.dp)
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
    }
}

/** 智能体标识：与 web/src/components/AgentIcon.tsx 同源的矢量图形。 */
@Composable
fun AgentTile(agentId: String?, size: androidx.compose.ui.unit.Dp = 38.dp) {
    val dark = LocalLoopraDark.current
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(12.dp))
            .background(
                MaterialTheme.colorScheme.onSurface.copy(alpha = if (dark) 0.14f else 0.08f),
            ),
        contentAlignment = Alignment.Center,
    ) {
        val iconSize = size * 0.55f
        when (agentId) {
            null, "", "native" -> LoopraMark(size = iconSize, halo = false)
            "codex" -> Icon(
                AppIcons.Codex, null, Modifier.size(iconSize),
                tint = MaterialTheme.colorScheme.onSurface,
            )
            "devin" -> Icon(
                AppIcons.Devin, null, Modifier.size(iconSize),
                tint = androidx.compose.ui.graphics.Color(0xFF6D5DF6),
            )
            "claude", "claude-code" -> ClaudeIcon(
                tint = androidx.compose.ui.graphics.Color(0xFFD97757),
                modifier = Modifier.size(iconSize),
            )
            else -> Icon(
                AppIcons.Bot, null, Modifier.size(iconSize),
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

fun relativeTime(mtime: Long): String {
    if (mtime <= 0L) return ""
    val diff = System.currentTimeMillis() - mtime
    val minutes = diff / 60_000
    val hours = diff / 3_600_000
    val days = diff / 86_400_000
    return when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "${minutes} 分钟前"
        hours < 24 -> "${hours} 小时前"
        days < 2 -> "昨天"
        days < 30 -> "${days} 天前"
        else -> {
            val date = java.text.SimpleDateFormat("M月d日", java.util.Locale.CHINA)
                .format(java.util.Date(mtime))
            date
        }
    }
}

@Composable
private fun EmptyHint(text: String) {
    Box(Modifier.fillMaxSize().heightIn(min = 166.dp), contentAlignment = Alignment.Center) {
        Text(text, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyState(filtered: Boolean, onClearFilters: () -> Unit, onNew: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .heightIn(min = 166.dp)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            if (filtered) "没有找到会话" else "还没有会话",
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(14.dp))
        Box(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.primary)
                .clickable(role = Role.Button, onClick = if (filtered) onClearFilters else onNew)
                .padding(horizontal = 18.dp, vertical = 9.dp),
        ) {
            Text(
                if (filtered) "清除筛选" else "新建会话",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onPrimary,
            )
        }
    }
}

@Composable
private fun ProjectGrid(
    state: AppState,
    online: Boolean,
    onRefresh: () -> Unit,
    onOpenProject: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text("项目", fontSize = 32.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Text(
                "${state.workspaces.size}",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        Spacer(Modifier.height(14.dp))
        if (state.catalogLoading && state.workspaces.isEmpty()) {
            EmptyHint("加载项目…")
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.workspaces, key = { it.hash }) { workspace ->
                    val count = state.sessionsByWorkspace[workspace.hash]?.size ?: 0
                    val isChat = workspace.hash == Workspace.CHAT.hash
                    Box(
                        Modifier
                            .heightIn(min = 148.dp)
                            .clip(RoundedCornerShape(22.dp))
                            .background(
                                if (LocalLoopraDark.current) {
                                    androidx.compose.ui.graphics.Color(0xFF242522).copy(alpha = 0.88f)
                                } else {
                                    androidx.compose.ui.graphics.Color.White.copy(alpha = 0.88f)
                                },
                            )
                            .clickable(role = Role.Button) { onOpenProject(workspace.hash) }
                            .padding(16.dp),
                    ) {
                        AgentTile(if (isChat) "native" else null, 38.dp)
                        Icon(
                            Icons.Filled.KeyboardArrowRight, null,
                            Modifier
                                .align(Alignment.TopEnd)
                                .size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Column(Modifier.align(Alignment.BottomStart)) {
                            Text(
                                workspace.displayName ?: workspace.name,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                "$count 个会话",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
        if (online && state.catalogError != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    state.catalogError,
                    Modifier.weight(1f),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.error,
                )
                Text(
                    "重试",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onRefresh)
                        .padding(8.dp),
                )
            }
        }
    }
}

@Composable
private fun Dock(
    state: AppState,
    backdrop: com.kyant.backdrop.Backdrop,
    online: Boolean,
    onSelectTab: (HomeTab) -> Unit,
    onNewSession: () -> Unit,
) {
    val dark = LocalLoopraDark.current
    GlassSurface(
        backdrop = backdrop,
        reduceTransparency = state.reduceTransparency,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(28.dp),
        fallbackColor = if (dark) {
            androidx.compose.ui.graphics.Color(0xFF242522)
        } else {
            androidx.compose.ui.graphics.Color.White.copy(alpha = 0.96f)
        },
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(60.dp)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DockTab("会话", AppIcons.Chat, state.tab == HomeTab.SESSIONS, Modifier.weight(1f)) {
                onSelectTab(HomeTab.SESSIONS)
            }
            DockTab("项目", AppIcons.Folder, state.tab == HomeTab.PROJECTS, Modifier.weight(1f)) {
                onSelectTab(HomeTab.PROJECTS)
            }
            Spacer(
                Modifier
                    .width(1.dp)
                    .height(28.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant),
            )
            Box(
                Modifier
                    .padding(start = 10.dp)
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .semantics { contentDescription = "新建会话" }
                    .clickable(enabled = online, role = Role.Button, onClick = onNewSession),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Add, "新建会话",
                    tint = MaterialTheme.colorScheme.onPrimary,
                )
            }
        }
    }
}

@Composable
private fun DockTab(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)
                else androidx.compose.ui.graphics.Color.Transparent,
            )
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            icon, label, Modifier.size(20.dp),
            tint = if (selected) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            label,
            fontSize = 11.sp,
            color = if (selected) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
