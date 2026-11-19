package app.loopra.android.chat

/** 行内片段样式：加粗与行内代码两种，不做完整 Markdown。 */
internal enum class InlineStyle { PLAIN, STRONG, CODE }

internal data class InlineRun(val text: String, val style: InlineStyle)

/**
 * 聊天文本的行内解析：单趟扫描识别成对的 `**` 与单反引号，代码段内
 * 的分隔符按字面处理（`**` 可以包住代码段，反之则代码内容原样）。
 * 反斜杠转义只保留分隔符本身，未闭合的分隔符和流式残尾原样输出。
 * ``` 围栏行与围栏内的内容不做行内解析，围栏标记保留原文。
 */
internal fun inlineChatRuns(text: String): List<InlineRun> {
    if (text.isEmpty()) return emptyList()
    val runs = mutableListOf<InlineRun>()
    var inFence = false
    val lines = text.split('\n')
    for ((index, line) in lines.withIndex()) {
        // 行分隔符在行前追加，尾部空行也保留原有的结尾换行。
        if (index > 0) runs.add(InlineRun("\n", InlineStyle.PLAIN))
        if (line.trimStart().startsWith("```")) {
            inFence = !inFence
            runs.add(InlineRun(line, InlineStyle.PLAIN))
        } else if (inFence) {
            runs.add(InlineRun(line, InlineStyle.PLAIN))
        } else {
            parseLineInto(line, runs)
        }
    }
    return merge(runs)
}

private fun parseLineInto(line: String, runs: MutableList<InlineRun>) {
    var i = 0
    var start = 0
    var strong = false
    var marker = -1
    var code = false

    fun flush(end: Int) {
        if (end > start) {
            runs.add(
                InlineRun(
                    unescape(line.substring(start, end)),
                    if (strong) InlineStyle.STRONG else InlineStyle.PLAIN,
                ),
            )
        }
        start = end
    }

    while (i < line.length) {
        if (code) {
            if (line[i] == '`') {
                // 代码段内容不做转义处理，保持逐字。
                runs.add(InlineRun(line.substring(start, i), InlineStyle.CODE))
                start = i + 1
                code = false
            }
            i++
            continue
        }
        if (line[i] == '\\' && i + 1 < line.length &&
            (line[i + 1] == '*' || line[i + 1] == '`')
        ) {
            i += 2
            continue
        }
        if (line[i] == '`') {
            flush(i)
            // 反引号不计入代码内容，起点记在后一位。
            start = i + 1
            code = true
            i++
            continue
        }
        if (line[i] == '*' && i + 1 < line.length && line[i + 1] == '*') {
            flush(i)
            if (!strong) marker = runs.size
            strong = !strong
            i += 2
            start = i
            continue
        }
        i++
    }
    if (code) {
        // 未闭合反引号：连分隔符一起按当前样式原样输出。
        start--
        flush(line.length)
    } else {
        flush(line.length)
    }
    if (strong && marker >= 0) {
        // 未闭合 `**`：还原为字面文本，内部已解析的代码段保留。
        for (j in marker until runs.size) {
            if (runs[j].style == InlineStyle.STRONG) {
                runs[j] = runs[j].copy(style = InlineStyle.PLAIN)
            }
        }
        runs.add(marker.coerceIn(0, runs.size), InlineRun("**", InlineStyle.PLAIN))
    }
}

private fun merge(runs: List<InlineRun>): List<InlineRun> {
    val out = mutableListOf<InlineRun>()
    var style: InlineStyle? = null
    val current = StringBuilder()
    for (run in runs) {
        if (run.text.isEmpty()) continue
        if (style != run.style) {
            style?.let { out.add(InlineRun(current.toString(), it)) }
            current.setLength(0)
            style = run.style
        }
        current.append(run.text)
    }
    style?.let { out.add(InlineRun(current.toString(), it)) }
    return out
}

private fun unescape(text: String): String {
    if (!text.contains('\\')) return text
    val out = StringBuilder(text.length)
    var i = 0
    while (i < text.length) {
        if (text[i] == '\\' && i + 1 < text.length &&
            (text[i + 1] == '*' || text[i + 1] == '`')
        ) {
            out.append(text[i + 1])
            i += 2
        } else {
            out.append(text[i])
            i++
        }
    }
    return out.toString()
}
