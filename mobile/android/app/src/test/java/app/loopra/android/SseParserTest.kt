package app.loopra.android

import app.loopra.android.data.SseException
import app.loopra.android.data.SseParser
import app.loopra.android.data.StreamEvent
import app.loopra.android.data.Utf8StreamDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SseParserTest {

    private fun collect(): Pair<SseParser, MutableList<StreamEvent>> {
        val events = mutableListOf<StreamEvent>()
        return SseParser(events::add) to events
    }

    private fun parseAll(text: String, end: Boolean = false): List<StreamEvent> {
        val (parser, events) = collect()
        parser.push(text, end = end)
        return events
    }

    @Test
    fun frameSplitAcrossChunks() {
        val (parser, events) = collect()
        parser.push("event: content\nda")
        assertEquals(0, events.size)
        parser.push("ta: \"hel")
        parser.push("lo\"\n\n")
        assertEquals(1, events.size)
        assertEquals("content", events[0].type)
        assertEquals("hello", events[0].content)
    }

    @Test
    fun crlfAndComments() {
        val (parser, events) = collect()
        parser.push(": keep-alive\r\nevent: reasoning\r\ndata: \"a\"\r\n\r\n")
        assertEquals("reasoning", events.single().type)
        assertEquals("a", events.single().content)
    }

    @Test
    fun multilineDataJoinedBeforeParse() {
        // 多行 data 先按 \n 连接，再整体 JSON.parse。
        val (parser, events) = collect()
        parser.push("event: x\ndata: {\"a\":1,\ndata:\"b\":2}\n\n")
        assertEquals("x", events.single().type)
        assertEquals(1, events.single().json!!.optInt("a"))
    }

    @Test
    fun nonJsonDataBecomesContentString() {
        val (parser, events) = collect()
        parser.push("data: plain text\n\n")
        assertEquals("content", events.single().type)
        assertEquals("plain text", events.single().content)
    }

    @Test
    fun objectFrameCarriesType() {
        val (parser, events) = collect()
        parser.push("event: tool_call\ndata: {\"toolCallId\":\"t1\",\"name\":\"read\",\"args\":\"{}\"}\n\n")
        val event = events.single()
        assertEquals("tool_call", event.type)
        assertEquals("t1", event.string("toolCallId"))
        assertEquals("read", event.string("name"))
    }

    @Test
    fun missingEventDefaultsToContent() {
        val (parser, events) = collect()
        parser.push("data: \"hi\"\n\n")
        assertEquals("content", events.single().type)
    }

    @Test
    fun doneMarker() {
        val (parser, events) = collect()
        parser.push("data: [DONE]\n\n")
        assertEquals("done", events.single().type)
    }

    @Test
    fun trailingFrameFlushedAtEnd() {
        val (parser, events) = collect()
        parser.push("event: content\ndata: \"tail\"", end = false)
        assertEquals(0, events.size)
        parser.push("", end = true)
        assertEquals(1, events.size)
        assertEquals("tail", events.single().content)
    }

    @Test
    fun oversizedFrameRejected() {
        val (parser, _) = collect()
        try {
            parser.push("data: " + "x".repeat(SseParser.MAX_FRAME_CHARS + 16) + "\n\n")
            fail("expected SseException")
        } catch (expected: SseException) {
        }
    }

    @Test
    fun utf8DecoderSplitsMultibyte() {
        val decoder = Utf8StreamDecoder()
        val text = "回复中断，请重试"
        val bytes = text.toByteArray(Charsets.UTF_8)
        // 在第一个汉字内部切开。
        val split = 4
        val a = decoder.decode(bytes.copyOfRange(0, split))
        val b = decoder.decode(bytes.copyOfRange(split, bytes.size), end = true)
        assertEquals(text, a + b)
    }

    @Test
    fun utf8DecoderHandlesSingleByteDribble() {
        val decoder = Utf8StreamDecoder()
        val bytes = "中文".toByteArray(Charsets.UTF_8)
        val out = StringBuilder()
        for (i in bytes.indices) out.append(decoder.decode(byteArrayOf(bytes[i])))
        out.append(decoder.decode(ByteArray(0), end = true))
        assertEquals("中文", out.toString())
    }

    @Test
    fun utf8DecoderEverySplitPointRoundTrips() {
        val text = "回复中断，请重试 — ASCII 也混进来 €"
        val bytes = text.toByteArray(Charsets.UTF_8)
        for (split in 0..bytes.size) {
            val decoder = Utf8StreamDecoder()
            val a = decoder.decode(bytes.copyOfRange(0, split))
            val b = decoder.decode(bytes.copyOfRange(split, bytes.size), end = true)
            assertEquals("split=$split", text, a + b)
        }
    }

    @Test
    fun utf8DecoderFlushesPartialAtEnd() {
        val decoder = Utf8StreamDecoder()
        val bytes = "中文".toByteArray(Charsets.UTF_8)
        // 结尾缺半个字符：end=true 必须把残留字节换成替换符而不是丢弃。
        val out = decoder.decode(bytes.copyOfRange(0, bytes.size - 1), end = true)
        assertTrue(out.startsWith("中"))
        assertTrue(out.contains("�"))
    }

    @Test
    fun malformedStructuredEventFails() {
        try {
            parseAll("event: complete\ndata: not-json\n\n")
            fail("expected SseException")
        } catch (expected: SseException) {
        }
    }

    @Test
    fun malformedDoneFails() {
        // event: done 是结构化事件；data 不是 JSON 对象时必须显式失败，
        // 不能退化成文本帧被当成正常终点。
        try {
            parseAll("event: done\ndata: not-json\n\n")
            fail("expected SseException")
        } catch (expected: SseException) {
        }
    }

    @Test
    fun rawTextContentStillAllowed() {
        val events = parseAll("data: plain text 中文\n\nevent: done\ndata: [DONE]\n\n", end = true)
        assertEquals(StreamEvent.text("content", "plain text 中文"), events[0])
        assertEquals("done", events[1].type)
    }
}
