package app.loopra.android

import app.loopra.android.chat.BlockType
import app.loopra.android.chat.ChatMessage
import app.loopra.android.chat.ChatReducer
import app.loopra.android.chat.Role
import app.loopra.android.chat.ToolStatus
import app.loopra.android.chat.USER_STOPPED_REPLY
import app.loopra.android.data.StreamEvent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatReducerTest {

    private fun message() = ChatMessage(id = "m", role = Role.ASSISTANT)

    private fun event(type: String, vararg fields: Pair<String, Any?>): StreamEvent {
        val obj = JSONObject()
        for ((key, value) in fields) obj.put(key, value)
        return StreamEvent(type, obj)
    }

    @Test
    fun parallelToolResultsMatchByIdOutOfOrder() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, event("tool_call", "toolCallId" to "a", "name" to "read"))
        msg = ChatReducer.applyEvent(msg, event("tool_call", "toolCallId" to "b", "name" to "shell"))
        // B 先完成，结果必须按 toolCallId 回填而不是按顺序。
        msg = ChatReducer.applyEvent(msg, event("tool_result", "toolCallId" to "b", "name" to "shell", "result" to "rb", "status" to "completed"))
        msg = ChatReducer.applyEvent(msg, event("tool_result", "toolCallId" to "a", "name" to "read", "result" to "ra", "status" to "failed"))
        val tools = msg.blocks.filter { it.type == BlockType.TOOL_CALL }
        assertEquals(2, tools.size)
        assertEquals("rb", tools.first { it.toolCallId == "b" }.result)
        assertEquals(ToolStatus.SUCCESS, tools.first { it.toolCallId == "b" }.status)
        assertEquals("ra", tools.first { it.toolCallId == "a" }.result)
        assertEquals(ToolStatus.FAILED, tools.first { it.toolCallId == "a" }.status)
    }

    @Test
    fun completeDoesNotDuplicateStreamedContent() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "你好"))
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "，世界"))
        msg = ChatReducer.applyEvent(msg, event("complete", "content" to "你好，世界"))
        val contents = msg.blocks.filter { it.type == BlockType.CONTENT }
        assertEquals(1, contents.size)
        assertEquals("你好，世界", contents.single().content)
    }

    @Test
    fun completeFillsEmptyReply() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, event("tool_call", "toolCallId" to "a", "name" to "read"))
        msg = ChatReducer.applyEvent(msg, event("complete", "content" to "最终回复"))
        val contents = msg.blocks.filter { it.type == BlockType.CONTENT }
        assertEquals("最终回复", contents.single().content)
    }

    @Test
    fun streamResetKeepsCompletedTools() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, event("tool_call", "toolCallId" to "a", "name" to "read"))
        msg = ChatReducer.applyEvent(msg, event("tool_result", "toolCallId" to "a", "result" to "ok", "status" to "completed"))
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("reasoning", "思考中"))
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "半截回复"))
        msg = ChatReducer.applyEvent(msg, StreamEvent("stream_reset", JSONObject()))
        assertEquals(1, msg.blocks.size)
        assertEquals(BlockType.TOOL_CALL, msg.blocks.single().type)
        assertEquals("ok", msg.blocks.single().result)
        // 重发的新文本追加在保留的工具块之后。
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "重发回复"))
        assertEquals("重发回复", msg.blocks.last().content)
    }

    @Test
    fun subEventsStayScoped() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "父级文本"))
        msg = ChatReducer.applyEvent(msg, event("sub_start", "subId" to "s1", "task" to "调研"))
        msg = ChatReducer.applyEvent(msg, event("sub_content", "subId" to "s1", "token" to "子级输出"))
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "父级继续"))
        val sub = msg.blocks.single { it.type == BlockType.SUB_AGENT }
        assertEquals("调研", sub.name)
        assertEquals("子级输出", sub.blocks.single { it.type == BlockType.CONTENT }.content)
        // 子代理 delta 绝不混入父级 content 块；父级文本跨子代理块连续。
        val main = msg.blocks.filter { it.type == BlockType.CONTENT }
        assertEquals(1, main.size)
        assertEquals("父级文本父级继续", main.single().content)
    }

    @Test
    fun permissionResolvedMarksSelection() {
        var msg = message()
        val options = JSONArray()
        options.put(JSONObject().put("title", "允许一次").put("value", "allow_once"))
        options.put(JSONObject().put("title", "拒绝").put("value", "reject_once"))
        msg = ChatReducer.applyEvent(
            msg,
            event(
                "choice",
                "permissionRequestId" to "p1",
                "title" to "审批",
                "options" to options,
            ),
        )
        msg = ChatReducer.applyEvent(
            msg,
            event("permission_resolved", "permissionRequestId" to "p1", "optionId" to "allow_once"),
        )
        val choice = msg.blocks.single { it.type == BlockType.CHOICE }
        assertEquals("允许一次", choice.selected)
    }

    @Test
    fun elicitationShowsDesktopNotice() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, event("elicitation", "elicitationRequestId" to "e1", "message" to "填写表单"))
        val notice = msg.blocks.single { it.type == BlockType.NOTICE }
        assertTrue(notice.content.contains("桌面端"))
    }

    @Test
    fun stoppedReplyAppendedOnce() {
        var msg = message()
        msg = ChatReducer.applyEvent(msg, StreamEvent.text("content", "前半句"))
        msg = ChatReducer.applyEvent(msg, StreamEvent("native_reply_stopped"))
        msg = ChatReducer.applyEvent(msg, StreamEvent("native_reply_stopped"))
        val content = msg.blocks.filter { it.type == BlockType.CONTENT }
        assertEquals(1, content.size)
        assertTrue(content.single().content.endsWith(USER_STOPPED_REPLY))
    }

    @Test
    fun historyCoalescesAndRestores() {
        val rows = JSONArray()
        rows.put(JSONObject().put("role", "user").put("content", "问题一"))
        rows.put(
            JSONObject()
                .put("role", "assistant")
                .put("reasoning_content", "想一下")
                .put("tool_calls", JSONArray().put(
                    JSONObject().put("id", "t1").put("function",
                        JSONObject().put("name", "read").put("arguments", "{\"p\":1}")),
                )),
        )
        rows.put(JSONObject().put("role", "tool").put("tool_call_id", "t1").put("content", "结果").put("tool_status", "completed"))
        rows.put(JSONObject().put("role", "assistant").put("content", "回答"))
        rows.put(JSONObject().put("role", "user").put("content", "隐藏").put("web_hidden", true))
        rows.put(JSONObject().put("role", "system").put("content", "跳过"))
        val messages = ChatReducer.historyMessages(rows)
        assertEquals(2, messages.size)
        assertEquals(Role.USER, messages[0].role)
        val assistant = messages[1]
        assertEquals("想一下", assistant.blocks.single { it.type == BlockType.REASONING }.content)
        val tool = assistant.blocks.single { it.type == BlockType.TOOL_CALL }
        assertEquals("结果", tool.result)
        assertEquals(ToolStatus.SUCCESS, tool.status)
        assertEquals("回答", assistant.blocks.single { it.type == BlockType.CONTENT }.content)
    }
}
