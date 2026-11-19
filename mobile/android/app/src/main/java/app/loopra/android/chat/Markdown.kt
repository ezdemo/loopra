package app.loopra.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.loopra.android.ui.theme.LocalLoopraDark
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MdText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/**
 * CommonMark AST → Compose。只解析语法树不执行 HTML/图片加载；
 * 链接仅放行显式 http(s)，其余按纯文本呈现。
 */
object Markdown {
    private val parser: Parser by lazy {
        Parser.builder().extensions(listOf(TablesExtension.create())).build()
    }

    fun parse(text: String): Node = parser.parse(text)
}

@Composable
fun MarkdownContent(text: String, modifier: Modifier = Modifier) {
    val root = remember(text) { Markdown.parse(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        var block = root.firstChild
        while (block != null) {
            MarkdownBlock(block)
            block = block.next
        }
    }
}

@Composable
private fun MarkdownBlock(node: Node) {
    when (node) {
        is Heading -> {
            val size = when (node.level) {
                1 -> 22.sp; 2 -> 19.sp; 3 -> 17.sp; else -> 16.sp
            }
            Text(
                inlineText(node),
                fontSize = size,
                fontWeight = FontWeight.SemiBold,
                lineHeight = size * 1.45f,
            )
        }
        is Paragraph -> Text(inlineText(node), fontSize = 16.sp, lineHeight = 26.sp)
        is BulletList -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            var item = node.firstChild
            while (item != null) {
                Row(Modifier.fillMaxWidth()) {
                    Text("•  ", fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f)) { ListBlocks(item) }
                }
                item = item.next
            }
        }
        is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            var index = node.markerStartNumber
            var item = node.firstChild
            while (item != null) {
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        "${index}.  ",
                        fontSize = 16.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Column(Modifier.weight(1f)) { ListBlocks(item) }
                }
                index++
                item = item.next
            }
        }
        is BlockQuote -> Row {
            Box(
                Modifier
                    .widthIn(min = 3.dp)
                    .heightIn(min = 20.dp)
                    .padding(end = 10.dp)
                    .background(MaterialTheme.colorScheme.outlineVariant),
            )
            Column(Modifier.weight(1f)) {
                var child = node.firstChild
                while (child != null) { MarkdownBlock(child); child = child.next }
            }
        }
        is FencedCodeBlock -> CodeBlock(node.literal, node.info)
        is IndentedCodeBlock -> CodeBlock(node.literal, null)
        is HtmlBlock -> Text(node.literal ?: "", fontSize = 16.sp, lineHeight = 26.sp)
        is ThematicBreak -> Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp)
                .heightIn(min = 1.dp)
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
        is TableBlock -> MarkdownTable(node)
        else -> {
            var child = node.firstChild
            while (child != null) { MarkdownBlock(child); child = child.next }
        }
    }
}

@Composable
private fun ListBlocks(item: Node) {
    var child = item.firstChild
    var first = true
    while (child != null) {
        // 列表项首个段落不另起段落间距。
        if (first && child is Paragraph) {
            Text(inlineText(child), fontSize = 16.sp, lineHeight = 26.sp)
        } else {
            MarkdownBlock(child)
        }
        first = false
        child = child.next
    }
}

@Composable
private fun CodeBlock(code: String, info: String?) {
    val dark = LocalLoopraDark.current
    val surface = if (dark) androidx.compose.ui.graphics.Color(0xFF1A1B18)
    else androidx.compose.ui.graphics.Color(0xFFE7E7E2)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(surface)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        info?.takeIf { it.isNotBlank() }?.let {
            Text(
                it.trim(),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        SelectionContainer {
            Text(
                code.trimEnd('\n'),
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            )
        }
    }
}

@Composable
private fun MarkdownTable(node: TableBlock) {
    val outline = MaterialTheme.colorScheme.outlineVariant
    Column(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .border(1.dp, outline, RoundedCornerShape(10.dp)),
    ) {
        var section = node.firstChild
        while (section != null) {
            var row = section.firstChild
            val isHead = section is TableHead
            while (row != null) {
                Row {
                    var cell = (row as? TableRow)?.firstChild
                    while (cell != null) {
                        Box(
                            Modifier
                                .widthIn(min = 72.dp)
                                .border(0.5.dp, outline)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                inlineText(cell),
                                fontSize = 14.sp,
                                fontWeight = if (isHead) FontWeight.SemiBold else null,
                            )
                        }
                        cell = cell.next
                    }
                }
                row = row.next
            }
            section = section.next
        }
    }
}

/** 内联节点 → AnnotatedString：粗/斜/行内代码/安全链接；HTML 按字面量。 */
@Composable
private fun inlineText(node: Node): AnnotatedString {
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = if (LocalLoopraDark.current) {
        androidx.compose.ui.graphics.Color(0xFF33332F)
    } else {
        androidx.compose.ui.graphics.Color(0xFFDEDED9)
    }
    return buildAnnotatedString {
        fun walk(n: Node, strong: Boolean, em: Boolean, code: Boolean) {
            var child = n.firstChild
            while (child != null) {
                when (child) {
                    is MdText -> withStyle(
                        SpanStyle(
                            fontWeight = if (strong) FontWeight.SemiBold else null,
                            fontStyle = if (em) FontStyle.Italic else null,
                            fontFamily = if (code) FontFamily.Monospace else null,
                            background = if (code) codeBackground else androidx.compose.ui.graphics.Color.Unspecified,
                        ),
                    ) { append(child.literal) }
                    is Code -> withStyle(
                        SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground),
                    ) { append(" ${child.literal} ") }
                    is StrongEmphasis -> walk(child, true, em, code)
                    is Emphasis -> walk(child, strong, true, code)
                    is Link -> {
                        val dest = child.destination ?: ""
                        val safe = dest.startsWith("https://") || dest.startsWith("http://")
                        if (safe) {
                            val start = length
                            walk(child, strong, em, code)
                            @Suppress("DEPRECATION")
                            addLink(
                                LinkAnnotation.Url(
                                    dest,
                                    TextLinkStyles(
                                        style = SpanStyle(
                                            color = linkColor,
                                            textDecoration = TextDecoration.Underline,
                                        ),
                                    ),
                                ),
                                start, length,
                            )
                        } else {
                            walk(child, strong, em, code)
                        }
                    }
                    is Image -> {
                        // 不信任的远端图片不加载：只保留替代文本。
                        var alt = ""
                        var c = child.firstChild
                        while (c != null) { if (c is MdText) alt += c.literal; c = c.next }
                        if (alt.isNotEmpty()) append(alt)
                    }
                    is HtmlInline -> append(child.literal ?: "")
                    is HardLineBreak -> append("\n")
                    is SoftLineBreak -> append("\n")
                    else -> walk(child, strong, em, code)
                }
                child = child.next
            }
        }
        walk(node, strong = false, em = false, code = false)
    }
}
