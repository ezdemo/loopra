package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeContentPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import app.loopra.android.ui.components.LoopraMark
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.theme.LocalLoopraDark
import app.loopra.android.ui.theme.wallpaper
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop

/** 未配对落地页：品牌行 + 连接面板 + 已保存实例入口。对齐移动版连接页结构。 */
@Composable
fun ConnectScreen(
    state: AppState,
    onConnect: (String) -> Unit,
    onScan: () -> Unit,
    onCancelConnect: () -> Unit,
    onReconnectSaved: () -> Unit,
    onForgetSaved: () -> Unit,
) {
    val backdrop = rememberLayerBackdrop()
    val dark = LocalLoopraDark.current
    // 配对码是凭证：只活在本组合内存中，绝不进 savedInstanceState。
    var link by remember { mutableStateOf("") }

    Box(Modifier.fillMaxSize().wallpaper()) {
        Box(Modifier.matchParentSize().layerBackdrop(backdrop))
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .safeContentPadding()
                .imePadding()
                .padding(horizontal = 20.dp)
                .widthIn(max = 400.dp)
                .align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LoopraMark(size = 28.dp, halo = false)
                Spacer(Modifier.width(8.dp))
                Text("Loopra", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            }
            Spacer(Modifier.height(22.dp))
            GlassSurface(
                backdrop = backdrop,
                reduceTransparency = state.reduceTransparency,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(30.dp),
                fallbackColor = if (dark) {
                    androidx.compose.ui.graphics.Color(0xFF1C1C1A)
                } else {
                    androidx.compose.ui.graphics.Color.White.copy(alpha = 0.96f)
                },
            ) {
                Column(Modifier.padding(19.dp)) {
                    Text("连接桌面", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "扫描二维码，或粘贴配对链接。",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    if (state.connecting) {
                        OutlinedButton(
                            onClick = onCancelConnect,
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                        ) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("取消")
                        }
                    } else {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(48.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(MaterialTheme.colorScheme.primary)
                                .semantics { contentDescription = "扫描二维码" }
                                .clickable(role = Role.Button, onClick = onScan),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("扫描二维码", color = MaterialTheme.colorScheme.onPrimary)
                        }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Spacer(
                                Modifier
                                    .weight(1f)
                                    .height(0.5.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant),
                            )
                            Text(
                                "或",
                                Modifier.padding(horizontal = 12.dp),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(
                                Modifier
                                    .weight(1f)
                                    .height(0.5.dp)
                                    .background(MaterialTheme.colorScheme.outlineVariant),
                            )
                        }
                        BasicTextField(
                            value = link,
                            onValueChange = { link = it },
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(
                                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f),
                                )
                                .semantics { contentDescription = "配对链接" }
                                .padding(12.dp),
                            minLines = 3,
                            textStyle = TextStyle(
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            decorationBox = { inner ->
                                Box {
                                    if (link.isEmpty()) {
                                        Text(
                                            "loopra://connect?…",
                                            fontSize = 13.sp,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    inner()
                                }
                            },
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(
                            onClick = { onConnect(link) },
                            enabled = link.isNotBlank(),
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                        ) { Text("连接") }
                    }
                    state.connectError?.let { error ->
                        Spacer(Modifier.height(12.dp))
                        Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            Text(
                "在桌面端打开 设置 → 连接与帮助 → 远程访问",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            state.savedConnectionName?.let { saved ->
                Spacer(Modifier.height(20.dp))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(saved, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    }
                    Text(
                        "重新连接",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClick = onReconnectSaved)
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        "移除",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClick = onForgetSaved)
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}
