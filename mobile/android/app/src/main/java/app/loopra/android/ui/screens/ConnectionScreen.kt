package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.ui.components.GlassSurface
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.theme.LocalLoopraDark
import app.loopra.android.ui.theme.wallpaper
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop

/** 连接管理：重命名、状态、重连、连接其他桌面、移除。对齐 MobileConnections。 */
@Composable
fun ConnectionScreen(
    state: AppState,
    onBack: () -> Unit,
    onRename: (String) -> Boolean,
    onReconnect: () -> Unit,
    onConnectAnother: () -> Unit,
    onForget: () -> Unit,
) {
    val backdrop = rememberLayerBackdrop()
    val dark = LocalLoopraDark.current
    val online = state.connectionState == "connected"
    val displayName = state.instanceName ?: state.relayHost ?: ""
    var draft by rememberSaveable(displayName) { mutableStateOf(displayName) }
    var confirming by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().wallpaper()) {
        Box(Modifier.matchParentSize().layerBackdrop(backdrop))
        Column(
            Modifier
                .fillMaxSize()
                .widthIn(max = 510.dp)
                .align(Alignment.TopCenter)
                .statusBarsPadding(),
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp)) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .semantics { contentDescription = "返回" }
                        .clickable(role = Role.Button, onClick = onBack),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", Modifier.size(22.dp))
                }
                Text(
                    "连接管理",
                    Modifier.align(Alignment.Center),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
            ) {
                GlassSurface(
                    backdrop = backdrop,
                    reduceTransparency = state.reduceTransparency,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(22.dp),
                    fallbackColor = if (dark) {
                        androidx.compose.ui.graphics.Color(0xFF242522)
                    } else {
                        androidx.compose.ui.graphics.Color.White.copy(alpha = 0.9f)
                    },
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Text("实例名称", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(8.dp))
                        BasicTextField(
                            value = draft,
                            onValueChange = { if (it.length <= 40) draft = it },
                            singleLine = true,
                            textStyle = TextStyle(
                                fontSize = 15.sp,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                                .semantics { contentDescription = "实例名称" }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(
                            onClick = { onRename(draft) },
                            enabled = draft.trim() != displayName,
                            modifier = Modifier.fillMaxWidth().height(44.dp),
                        ) { Text("保存") }
                    }
                }
                Spacer(Modifier.height(12.dp))
                GlassSurface(
                    backdrop = backdrop,
                    reduceTransparency = state.reduceTransparency,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(22.dp),
                    fallbackColor = if (dark) {
                        androidx.compose.ui.graphics.Color(0xFF242522)
                    } else {
                        androidx.compose.ui.graphics.Color.White.copy(alpha = 0.9f)
                    },
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("状态", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.weight(1f))
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
                                if (online) "已连接" else "已断开",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        Row {
                            Text("中继", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.weight(1f))
                            Text(state.relayHost ?: "", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
                Row {
                    OutlinedButton(
                        onClick = onReconnect,
                        modifier = Modifier.weight(1f).height(46.dp),
                    ) { Text("重新连接") }
                    Spacer(Modifier.width(10.dp))
                    OutlinedButton(
                        onClick = onConnectAnother,
                        modifier = Modifier.weight(1f).height(46.dp),
                    ) { Text("连接其他桌面") }
                }
                state.connectionError?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(20.dp))
                if (confirming) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "移除这个连接？",
                            Modifier.weight(1f),
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Text(
                            "取消",
                            fontSize = 13.sp,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { confirming = false }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                        Text(
                            "移除",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.error,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .clickable(onClick = onForget)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                } else {
                    Text(
                        "移除连接",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { confirming = true }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}
