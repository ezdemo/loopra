package app.loopra.android

import app.loopra.android.chat.InlineStyle
import app.loopra.android.chat.inlineChatRuns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 行内解析：只识别成对 `**` 与单反引号，其余原样输出。 */
class InlineChatTextTest {

    private fun styles(text: String) = inlineChatRuns(text).map { it.style }
    private fun runs(text: String) = inlineChatRuns(text).map { it.text to it.style }

    @Test
    fun plainTextPassesThrough() {
        assertEquals(
            listOf("普通文本" to InlineStyle.PLAIN),
            runs("普通文本"),
        )
    }

    @Test
    fun strongAndCodeSpansParsed() {
        assertEquals(
            listOf(
                "查看 " to InlineStyle.PLAIN,
                "README.md" to InlineStyle.CODE,
                " 然后 " to InlineStyle.PLAIN,
                "重启服务" to InlineStyle.STRONG,
                "。" to InlineStyle.PLAIN,
            ),
            runs("查看 `README.md` 然后 **重启服务**。"),
        )
    }

    @Test
    fun strongMaySurroundCode() {
        val parsed = runs("**`loopra --serve`**")
        assertEquals(1, parsed.size)
        assertEquals("loopra --serve", parsed.single().first)
        assertEquals(InlineStyle.CODE, parsed.single().second)
    }

    @Test
    fun unmatchedDelimitersStayLiteral() {
        assertEquals(listOf("a **b" to InlineStyle.PLAIN), runs("a **b"))
        assertEquals(listOf("a `b" to InlineStyle.PLAIN), runs("a `b"))
        // 流式残尾：先出现的片段保留已解析结构。
        val parsed = runs("已解析 `code` 与 **未完")
        assertEquals(InlineStyle.CODE, parsed[1].second)
        assertEquals(" 与 **未完", parsed.last().first)
    }

    @Test
    fun escapedDelimitersStayLiteral() {
        assertEquals(listOf("a `b` c" to InlineStyle.PLAIN), runs("a \\`b\\` c"))
        assertEquals(listOf("**x**" to InlineStyle.PLAIN), runs("\\**x**"))
    }

    @Test
    fun chineseContentSupported() {
        val parsed = runs("把 `编译` 输出 **加粗**")
        assertEquals(InlineStyle.CODE, parsed[1].second)
        assertEquals("编译", parsed[1].first)
        assertEquals(InlineStyle.STRONG, parsed[3].second)
        assertEquals("加粗", parsed[3].first)
    }

    @Test
    fun fencedContentPreservedVerbatim() {
        val text = "代码块：\n```\nconst x = `a` **b**\n```\n结束"
        val parsed = runs(text)
        assertTrue(parsed.all { it.second == InlineStyle.PLAIN })
        assertEquals(text, parsed.joinToString("") { it.first })
    }

    @Test
    fun strongInsideCodeStaysCode() {
        val parsed = runs("`a **b** c`")
        assertEquals(listOf("a **b** c" to InlineStyle.CODE), parsed)
    }

    @Test
    fun fencedBlockAtEndWithoutTrailingNewline() {
        val text = "前缀\n```\ncode `x` **y**\n```"
        val parsed = runs(text)
        assertTrue(parsed.all { it.second == InlineStyle.PLAIN })
        assertEquals(text, parsed.joinToString("") { it.first })
    }

    @Test
    fun unterminatedFenceKeepsFinalLineVerbatim() {
        val text = "开头\n```\nconst x = `a` **b**"
        val parsed = runs(text)
        assertTrue(parsed.all { it.second == InlineStyle.PLAIN })
        assertEquals(text, parsed.joinToString("") { it.first })
    }

    @Test
    fun textEndingWithNewlinePreserved() {
        // 结尾换行作为独立的普通片段保留，不被末尾裁剪吃掉。
        val parsed = runs("一段 `code`\n")
        assertEquals(
            listOf(
                "一段 " to InlineStyle.PLAIN,
                "code" to InlineStyle.CODE,
                "\n" to InlineStyle.PLAIN,
            ),
            parsed,
        )
        val fenced = "```\nx\n```\n"
        assertEquals(fenced, runs(fenced).joinToString("") { it.first })
    }
}
