package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.compose.BackHandler
import app.loopra.android.data.AgentEngine
import app.loopra.android.data.AgentConfigOption
import app.loopra.android.data.ConfigChoice
import app.loopra.android.data.ConfigType
import app.loopra.android.data.ConfigValue
import app.loopra.android.data.ReplyConfig
import app.loopra.android.ui.state.ReplyConfigState
import app.loopra.android.ui.state.ThreadView
import app.loopra.android.ui.theme.LocalLoopraDark

private val ShellDark = Color(0xFF242522)
private val GroupLight = Color(0xB3FFFFFF)
private val GroupDark = Color(0x59FFFFFF)
private val ChipFillDark = Color(0xFFE9E9E4)
private val ChipFillLight = Color(0xFF2E2F2C)

/**
 * 回复设置底部面板：模型子页 + 思考强度 + 其余配置项。
 * 全部数据来自 thread.replyConfig，由 ViewModel 与后端同步。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReplySettingsSheet(
    thread: ThreadView,
    initialPage: SheetPage,
    controlsEnabled: Boolean,
    reduceTransparency: Boolean,
    engines: List<AgentEngine> = emptyList(),
    onSelectEngine: (String) -> Unit = {},
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onChange: (String, ConfigValue) -> Unit,
) {
    val dark = LocalLoopraDark.current
    var page by remember(thread.key) { mutableStateOf(initialPage) }
    val enabled = controlsEnabled && !thread.replyConfig.saving
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        scrimColor = Color.Black.copy(alpha = if (reduceTransparency) 0.32f else 0.18f),
        containerColor = if (dark) {
            ShellDark
        } else if (reduceTransparency) {
            Color.White
        } else {
            Color.White.copy(alpha = 0.96f)
        },
        shape = RoundedCornerShape(28.dp),
        dragHandle = {
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(width = 36.dp, height = 4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)),
                )
            }
        },
        modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
    ) {
        BackHandler(enabled = page == SheetPage.Models) { page = SheetPage.Settings }
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = LocalConfiguration.current.screenHeightDp.dp * 0.88f)
                .imePadding()
                .navigationBarsPadding(),
        ) {
            SheetHeader(
                title = if (page == SheetPage.Models) "模型" else "回复设置",
                onBack = if (page == SheetPage.Models) ({ page = SheetPage.Settings }) else null,
                onClose = onDismiss,
            )
            val config = thread.replyConfig
            when {
                config.loading && config.options == null -> Box(
                    Modifier.fillMaxWidth().padding(32.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) }
                config.options == null -> Column(
                    Modifier.fillMaxWidth().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        config.error ?: "回复设置不可用",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = onRetry) { Text("重试") }
                }
                page == SheetPage.Models -> ModelPage(
                    config = config,
                    enabled = enabled,
                    onChange = onChange,
                    onDone = { page = SheetPage.Settings },
                )
                else -> SettingsPage(
                    thread = thread,
                    enabled = enabled,
                    engines = engines,
                    onSelectEngine = onSelectEngine,
                    onOpenModels = { page = SheetPage.Models },
                    onRetry = onRetry,
                    onChange = onChange,
                    onDone = onDismiss,
                )
            }
        }
    }
}

@Composable
private fun SheetHeader(title: String, onBack: (() -> Unit)?, onClose: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 12.dp, top = 4.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Box(
                Modifier
                    .size(48.dp)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "返回",
                    modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.width(4.dp))
        }
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        Box(
            Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.14f))
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Close, contentDescription = "关闭", modifier = Modifier.size(16.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsPage(
    thread: ThreadView,
    enabled: Boolean,
    engines: List<AgentEngine>,
    onSelectEngine: (String) -> Unit,
    onOpenModels: () -> Unit,
    onRetry: () -> Unit,
    onChange: (String, ConfigValue) -> Unit,
    onDone: () -> Unit,
) {
    val dark = LocalLoopraDark.current
    val config = thread.replyConfig
    val options = config.options.orEmpty()
    val model = remember(options) { ReplyConfig.modelOption(options) }
    val effort = remember(options) { ReplyConfig.effortOption(options) }
    val extras = remember(options) { ReplyConfig.extraOptions(options) }
    var showExtras by rememberSaveable(thread.key) { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f, fill = false)
                .verticalScroll(rememberScrollState()),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .clip(RoundedCornerShape(22.dp))
                    .background(if (dark) GroupDark else GroupLight),
            ) {
                Text(
                    if (thread.agentId == "native") {
                        "Loopra Native"
                    } else {
                        thread.customAgentId ?: thread.agentId
                    },
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp),
                )
                if (engines.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("智能体", fontSize = 14.sp)
                        androidx.compose.foundation.layout.FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                            modifier = Modifier.padding(top = 8.dp),
                        ) {
                            val choices = (
                                listOf(AgentEngine("native", "Loopra Native", true, false)) +
                                    engines.filter { it.selectable && it.id != "native" }
                                ).distinctBy { it.id }
                            for (engine in choices) {
                                Box(
                                    Modifier
                                        .heightIn(min = 34.dp)
                                        .clip(RoundedCornerShape(17.dp))
                                        .background(
                                            if (thread.agentId == engine.id) {
                                                MaterialTheme.colorScheme.primary
                                            } else {
                                                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)
                                            },
                                        )
                                        .selectable(
                                            selected = thread.agentId == engine.id,
                                            enabled = enabled,
                                            role = Role.RadioButton,
                                        ) { onSelectEngine(engine.id) }
                                        .padding(horizontal = 14.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        engine.name,
                                        fontSize = 13.sp,
                                        color = if (thread.agentId == engine.id) {
                                            MaterialTheme.colorScheme.onPrimary
                                        } else {
                                            MaterialTheme.colorScheme.onSurface
                                        },
                                    )
                                }
                            }
                        }
                    }
                    GroupDivider()
                }
                if (model != null) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(enabled = enabled) { onOpenModels() }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("模型", fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Text(
                            ReplyConfig.currentLabel(model),
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.End,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 12.dp),
                        )
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (effort != null) {
                    if (model != null) GroupDivider()
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("思考强度", fontSize = 14.sp, modifier = Modifier.weight(1f))
                            Text(
                                ReplyConfig.currentLabel(effort),
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        ChoiceChips(
                            choices = effort.options.map {
                                it.copy(label = ReplyConfig.choiceLabel(effort, it))
                            },
                            selected = (effort.current as? ConfigValue.Text)?.value,
                            enabled = enabled,
                        ) { onChange(effort.id, ConfigValue.Text(it)) }
                    }
                }
                if (extras.isNotEmpty()) {
                    GroupDivider()
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { showExtras = !showExtras }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("更多配置", fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Text(
                            "${extras.size}",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Icon(
                            Icons.Filled.KeyboardArrowDown,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (showExtras) {
                        for ((index, option) in extras.withIndex()) {
                            if (index > 0) GroupDivider()
                            ExtraOptionRow(option, enabled, onChange)
                        }
                    }
                }
            }
            config.error?.let {
                Text(
                    it,
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
            if (config.saving || config.loading) {
                Row(
                    Modifier.fillMaxWidth().padding(top = 10.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (config.saving) "保存中…" else "加载中…",
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!config.loading && config.options != null && config.error != null) {
                TextButton(onClick = onRetry, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text("重新加载")
                }
            }
        }
        DoneFooter(onDone)
    }
}

@Composable
private fun GroupDivider() {
    HorizontalDivider(
        Modifier.padding(start = 16.dp),
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.12f),
    )
}

@Composable
private fun ExtraOptionRow(
    option: AgentConfigOption,
    enabled: Boolean,
    onChange: (String, ConfigValue) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        when (option.type) {
            ConfigType.BOOLEAN -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(option.name, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Switch(
                        checked = (option.current as? ConfigValue.Toggle)?.value == true,
                        onCheckedChange = { onChange(option.id, ConfigValue.Toggle(it)) },
                        enabled = enabled,
                    )
                }
            }
            ConfigType.SELECT -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(option.name, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Text(
                        ReplyConfig.currentLabel(option),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (option.options.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    ChoiceChips(
                        choices = option.options,
                        selected = (option.current as? ConfigValue.Text)?.value,
                        enabled = enabled,
                    ) { onChange(option.id, ConfigValue.Text(it)) }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChoiceChips(
    choices: List<ConfigChoice>,
    selected: String?,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    val dark = LocalLoopraDark.current
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (choice in choices) {
            val isSelected = choice.value == selected
            // 38dp 视觉芯片外套 48dp 触控区。
            Box(
                Modifier
                    .heightIn(min = 48.dp)
                    .selectable(
                        selected = isSelected,
                        enabled = enabled,
                        role = Role.Button,
                    ) { onSelect(choice.value) },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .heightIn(min = 38.dp)
                        .clip(RoundedCornerShape(19.dp))
                        .background(
                            when {
                                isSelected -> if (dark) ChipFillDark else ChipFillLight
                                else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.10f)
                            },
                        )
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        choice.label,
                        fontSize = 13.sp,
                        color = if (isSelected) {
                            if (dark) Color(0xFF1C1C1A) else Color(0xFFF4F4F2)
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun ModelPage(
    config: ReplyConfigState,
    enabled: Boolean,
    onChange: (String, ConfigValue) -> Unit,
    onDone: () -> Unit,
) {
    val model = ReplyConfig.modelOption(config.options)
    var query by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxWidth()) {
        BasicTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .clip(RoundedCornerShape(19.dp))
                .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.10f))
                .semantics { contentDescription = "搜索模型" },
            textStyle = TextStyle(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface),
            singleLine = true,
            cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
            decorationBox = { inner ->
                Box(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (query.isEmpty()) {
                        Text(
                            "搜索模型",
                            fontSize = 14.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                    inner()
                }
            },
        )
        Spacer(Modifier.height(10.dp))
        if (config.saving || config.loading) {
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 16.dp))
        }
        config.error?.let {
            Text(
                it,
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
        if (model == null || model.options.isEmpty()) {
            Text(
                "暂无可用模型",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
            )
        } else {
            val current = (model.current as? ConfigValue.Text)?.value
            val groups = remember(model.options) {
                val out = linkedMapOf<String, MutableList<Pair<ConfigChoice, String>>>()
                for (choice in model.options) {
                    val parts = choice.label.split(" / ")
                    val group = choice.group ?: if (parts.size >= 2) parts.first() else ""
                    val name = if (choice.group == null && parts.size >= 2) {
                        parts.drop(1).joinToString(" / ")
                    } else {
                        choice.label
                    }
                    out.getOrPut(group) { mutableListOf() }.add(choice to name)
                }
                out
            }
            val visibleGroups = remember(groups, query) {
                groups.mapValues { (group, rows) ->
                    rows.filter {
                        query.isBlank() ||
                            it.second.contains(query, true) ||
                            it.first.value.contains(query, true) ||
                            group.contains(query, true)
                    }
                }.filterValues { it.isNotEmpty() }
            }
            LazyColumn(
                Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .padding(horizontal = 8.dp),
            ) {
                if (visibleGroups.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            "没有匹配的模型",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 16.dp),
                        )
                    }
                }
                for ((group, items) in visibleGroups) {
                    if (group.isNotEmpty()) {
                        item(key = "group-$group") {
                            Text(
                                group,
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 12.dp, top = 10.dp, bottom = 4.dp),
                            )
                        }
                    }
                    for ((choice, name) in items) {
                        item(key = "model-${choice.value}") {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(14.dp))
                                    .selectable(
                                        selected = choice.value == current,
                                        enabled = enabled,
                                        role = Role.RadioButton,
                                    ) {
                                        onChange(model.id, ConfigValue.Text(choice.value))
                                    }
                                    .padding(horizontal = 12.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(name, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    choice.description?.let {
                                        Text(
                                            it,
                                            fontSize = 12.sp,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                                if (choice.value == current) {
                                    Icon(
                                        Icons.Filled.Check,
                                        contentDescription = "当前模型",
                                        modifier = Modifier.size(18.dp),
                                        tint = MaterialTheme.colorScheme.onSurface,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        DoneFooter(onDone)
    }
}

/** 底部「完成」按钮：暗色反色，浅色用近黑底。 */
@Composable
private fun DoneFooter(onDone: () -> Unit) {
    val dark = LocalLoopraDark.current
    Button(
        onClick = onDone,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 14.dp)
            .height(48.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (dark) ChipFillDark else ChipFillLight,
            contentColor = if (dark) Color(0xFF1C1C1A) else Color(0xFFF4F4F2),
        ),
    ) {
        Text("完成", fontSize = 15.sp, fontWeight = FontWeight.Medium)
    }
}
