package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.ui.state.AppState
import app.loopra.android.ui.state.ThemeMode
import app.loopra.android.ui.theme.LocalLoopraDark

/** 应用设置：外观与桌面连接入口。分组沿用回复设置的玻璃风格。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(
    state: AppState,
    onDismiss: () -> Unit,
    onThemeMode: (ThemeMode) -> Unit,
    onFontSize: (Int) -> Unit,
    onReduceTransparency: (Boolean) -> Unit,
    onOpenConnections: () -> Unit,
) {
    val dark = LocalLoopraDark.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        scrimColor = androidx.compose.ui.graphics.Color.Black.copy(
            alpha = if (state.reduceTransparency) 0.32f else 0.18f,
        ),
        containerColor = if (dark) {
            androidx.compose.ui.graphics.Color(0xFF242522)
        } else if (state.reduceTransparency) {
            androidx.compose.ui.graphics.Color.White
        } else {
            androidx.compose.ui.graphics.Color.White.copy(alpha = 0.96f)
        },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding(),
        ) {
            Text(
                "设置",
                Modifier.padding(horizontal = 20.dp),
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                SheetGroup {
                    Text(
                        "外观",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                    SettingRow("主题") {
                        SingleChoiceSegmentedButtonRow {
                            val modes = listOf(
                                ThemeMode.SYSTEM to "自动",
                                ThemeMode.LIGHT to "浅色",
                                ThemeMode.DARK to "深色",
                            )
                            modes.forEachIndexed { index, (mode, label) ->
                                SegmentedButton(
                                    selected = state.themeMode == mode,
                                    onClick = { onThemeMode(mode) },
                                    shape = SegmentedButtonDefaults.itemShape(index = index, count = modes.size),
                                ) { Text(label, fontSize = 12.sp) }
                            }
                        }
                    }
                    SettingRow("字号") {
                        SingleChoiceSegmentedButtonRow {
                            val sizes = listOf(15 to "小", 16 to "标准", 18 to "大")
                            sizes.forEachIndexed { index, (size, label) ->
                                SegmentedButton(
                                    selected = state.fontSize == size,
                                    onClick = { onFontSize(size) },
                                    shape = SegmentedButtonDefaults.itemShape(index = index, count = sizes.size),
                                ) { Text(label, fontSize = 12.sp) }
                            }
                        }
                    }
                    SettingRow("减少透明效果") {
                        Switch(checked = state.reduceTransparency, onCheckedChange = onReduceTransparency)
                    }
                }
                Spacer(Modifier.height(14.dp))
                SheetGroup {
                    Text(
                        "桌面连接",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(role = Role.Button, onClick = onOpenConnections)
                            .semantics { contentDescription = "连接管理" }
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(
                                    if (state.connectionState == "connected") {
                                        androidx.compose.ui.graphics.Color(0xFF3D9B50)
                                    } else {
                                        MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                ),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                state.instanceName ?: state.relayHost ?: "当前实例",
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                            )
                            Text(
                                if (state.connectionState == "connected") "已连接" else "离线",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight, null,
                            Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp)
                    .height(46.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.primary)
                    .semantics { contentDescription = "完成" }
                    .clickable(role = Role.Button, onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) {
                Text("完成", color = MaterialTheme.colorScheme.onPrimary)
            }
        }
    }
}

@Composable
private fun SheetGroup(content: @Composable () -> Unit) {
    val dark = LocalLoopraDark.current
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(
                androidx.compose.ui.graphics.Color.White.copy(alpha = if (dark) 0.06f else 0.7f),
            ),
    ) { content() }
}

@Composable
private fun SettingRow(label: String, control: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), fontSize = 14.sp)
        control()
    }
}
