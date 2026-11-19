@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.loopra.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.data.ElicitationField
import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.elicitationContent
import app.loopra.android.data.elicitationError
import app.loopra.android.data.elicitationPages
import app.loopra.android.ui.theme.LocalLoopraDark

/**
 * 代理问询表单：按服务端 schema 渲染受支持字段类型；
 * 不支持的字段给桌面端提示，绝不上交残缺的应答。
 */
@Composable
fun ElicitationCard(
    request: ElicitationRequest,
    resolving: Boolean,
    modifier: Modifier = Modifier,
    onAnswer: (action: String, content: Map<String, Any>) -> Unit,
) {
    val dark = LocalLoopraDark.current
    // 与桌面端一致的单题分页：伴生说明字段并入宿主同页。
    val pages = remember(request.fields) { elicitationPages(request.fields) }
    var pageIndex by remember(request.elicitationRequestId) { mutableIntStateOf(0) }
    val current = pageIndex.coerceIn(0, (pages.size - 1).coerceAtLeast(0))
    val last = current >= pages.lastIndex
    var error by remember(request.elicitationRequestId) { mutableStateOf("") }
    val answers = remember(request.elicitationRequestId) { mutableStateMapOf<String, Any>() }
    val unsupported = request.fields.any { it.unsupported }

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (dark) androidx.compose.ui.graphics.Color(0xFF2A2B28)
                else androidx.compose.ui.graphics.Color(0xFFF2F1EC),
            )
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Agent 提问",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (pages.size > 1) {
                Text(
                    "问题 ${current + 1} / ${pages.size}",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            request.message.ifEmpty { "请回答以下问题" },
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Spacer(Modifier.height(10.dp))
        if (unsupported) {
            Text(
                "此表单需在桌面端完成",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = { onAnswer("decline", emptyMap()) },
                enabled = !resolving,
                modifier = Modifier.fillMaxWidth().height(42.dp),
            ) { Text("跳过") }
        } else {
            for (field in pages.getOrNull(current).orEmpty()) {
                ElicitationFieldRow(
                    field = field,
                    allowOther = request.allowOther,
                    value = answers[field.name],
                    enabled = !resolving,
                ) {
                    answers[field.name] = it
                    error = ""
                }
            }
            if (error.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(error, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(12.dp))
            Row {
                OutlinedButton(
                    onClick = { onAnswer("decline", emptyMap()) },
                    enabled = !resolving,
                    modifier = Modifier.weight(1f).height(42.dp),
                ) { Text("跳过") }
                if (pages.size > 1) {
                    Spacer(Modifier.width(10.dp))
                    OutlinedButton(
                        onClick = {
                            error = ""
                            pageIndex = current - 1
                        },
                        enabled = !resolving && current > 0,
                        modifier = Modifier.weight(1f).height(42.dp),
                    ) { Text("上一题") }
                }
                Spacer(Modifier.width(10.dp))
                androidx.compose.material3.Button(
                    onClick = {
                        if (!last) {
                            // 与桌面端一致：未答完也允许先看下一题。
                            error = ""
                            pageIndex = current + 1
                        } else {
                            val validation = elicitationError(request, answers)
                            if (validation.isEmpty()) {
                                onAnswer("accept", elicitationContent(request, answers))
                            } else {
                                // 跳到第一个仍缺答案的页。
                                val invalid = pages.indexOfFirst { page ->
                                    elicitationError(
                                        request.copy(fields = page),
                                        answers,
                                    ).isNotEmpty()
                                }
                                if (invalid >= 0) pageIndex = invalid
                                error = validation
                            }
                        }
                    },
                    enabled = !resolving,
                    modifier = Modifier.weight(1f).height(42.dp),
                ) { Text(if (resolving) "提交中…" else if (last) "提交" else "下一题") }
            }
        }
    }
}

@Composable
private fun ElicitationFieldRow(
    field: ElicitationField,
    allowOther: Boolean,
    value: Any?,
    enabled: Boolean,
    onChange: (Any) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(
            field.title + if (field.required) " *" else "",
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
        field.description?.let {
            Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(6.dp))
        when {
            field.isArray && field.options.isNotEmpty() -> {
                val selected = (value as? List<*>) ?: emptyList<Any>()
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (option in field.options) {
                        val on = selected.contains(option.value)
                        OptionChip(option.title, on, enabled) {
                            onChange(
                                if (on) selected.filter { it != option.value }
                                else selected + option.value,
                            )
                        }
                    }
                }
            }
            field.options.isNotEmpty() -> {
                androidx.compose.foundation.layout.FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (option in field.options) {
                        OptionChip(option.title, value == option.value, enabled) {
                            onChange(option.value)
                        }
                    }
                    if (allowOther) {
                        val other = value is String &&
                            field.options.none { it.value == value } &&
                            (value as? String)?.isNotEmpty() == true
                        OptionChip("其他", other, enabled) { onChange(" ") }
                    }
                }
            }
            field.type == "boolean" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(
                    checked = value as? Boolean ?: false,
                    onCheckedChange = { onChange(it) },
                    enabled = enabled,
                )
            }
            else -> {
                val isNumber = field.type == "number" || field.type == "integer"
                BasicTextField(
                    value = when (value) {
                        is String -> value
                        null -> ""
                        else -> value.toString()
                    },
                    onValueChange = { raw ->
                        onChange(
                            if (isNumber) {
                                raw.toDoubleOrNull() ?: raw.toLongOrNull() ?: raw
                            } else {
                                raw
                            },
                        )
                    },
                    enabled = enabled,
                    singleLine = !field.isSecret,
                    visualTransformation = if (field.isSecret) PasswordVisualTransformation()
                    else androidx.compose.ui.text.input.VisualTransformation.None,
                    keyboardOptions = if (isNumber) {
                        KeyboardOptions(keyboardType = KeyboardType.Number)
                    } else {
                        KeyboardOptions.Default
                    },
                    textStyle = TextStyle(
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurface,
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f))
                        .semantics { contentDescription = field.title }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun OptionChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .heightIn(min = 36.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
            )
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            color = if (selected) MaterialTheme.colorScheme.onPrimary
            else MaterialTheme.colorScheme.onSurface,
        )
    }
}
