package app.loopra.android

import app.loopra.android.data.ElicitationRequest
import app.loopra.android.data.elicitationContent
import app.loopra.android.data.elicitationError
import app.loopra.android.data.elicitationPages
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ElicitationTest {
    @Test
    fun parseTypedSchema() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{
                "elicitationRequestId": "e1",
                "message": "确认参数",
                "schema": {"type":"object","required":["count","mode"],"properties":{
                    "mode":{"type":"string","title":"模式","oneOf":[
                        {"const":"a","title":"自动"},
                        {"const":"m","title":"手动","_meta":{"cognition.ai/description":"手动选择"}}
                    ]},
                    "count":{"type":"integer","title":"次数","minimum":1,"maximum":5},
                    "secret":{"type":"string","title":"密钥","_meta":{"codex":{"isSecret":true}}},
                    "tags":{"type":"array","title":"标签","items":{"type":"string"},"minItems":1}
                }},
                "meta": {"cognition.ai/allowOther": true}
                }""",
            ),
        )!!
        assertEquals("e1", request.elicitationRequestId)
        assertTrue(request.allowOther)
        val mode = request.fields.single { it.name == "mode" }
        assertEquals(2, mode.options.size)
        assertEquals("手动选择", mode.options[1].description)
        assertTrue(mode.required)
        val count = request.fields.single { it.name == "count" }
        assertEquals(1.0, count.minimum!!, 0.0)
        assertEquals(5.0, count.maximum!!, 0.0)
        assertTrue(request.fields.single { it.name == "secret" }.isSecret)
        assertTrue(request.fields.single { it.name == "tags" }.isArray)
    }

    @Test
    fun enumNamesFallbackOptions() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{"elicitationRequestId":"e2","schema":{"properties":{
                    "env":{"type":"string","enum":["dev","prod"],"enumNames":["开发","生产"]}
                }}}""",
            ),
        )!!
        val env = request.fields.single()
        assertEquals("开发", env.options[0].title)
        assertEquals("dev", env.options[0].value)
    }

    @Test
    fun validationRequiredAndBounds() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{"elicitationRequestId":"e3","schema":{"required":["n"],"properties":{
                    "n":{"type":"integer","title":"数量","minimum":1,"maximum":3},
                    "t":{"type":"string","title":"文本","minLength":2}
                }}}""",
            ),
        )!!
        assertEquals("请填写“数量”", elicitationError(request, emptyMap()))
        assertEquals("“数量”的数值不符合要求", elicitationError(request, mapOf("n" to 10)))
        assertEquals("“文本”的长度不符合要求", elicitationError(request, mapOf("n" to 2, "t" to "x")))
        assertEquals("", elicitationError(request, mapOf("n" to 2, "t" to "ok")))
    }

    @Test
    fun contentStripsEmptyValues() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{"elicitationRequestId":"e4","schema":{"properties":{
                    "a":{"type":"string"}, "b":{"type":"array","items":{"type":"string"}}
                }}}""",
            ),
        )!!
        val content = elicitationContent(request, mapOf("a" to "", "b" to listOf("", "x")))
        assertFalse(content.containsKey("a"))
        assertEquals(listOf("x"), content["b"])
    }

    @Test
    fun companionFieldsJoinParentPage() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{"elicitationRequestId":"e5","schema":{"properties":{
                    "q_note":{"type":"string","title":"q 备注"},
                    "q":{"type":"string","title":"问题","enum":["a","b"]},
                    "question_1_custom":{"type":"string","title":"自定义"},
                    "question_1":{"type":"string","enum":["x","y"]},
                    "orphan_note":{"type":"string","title":"孤儿备注"}
                }}}""",
            ),
        )!!
        // 伴生字段随宿主同页，即便 JSON 顺序在前；
        // question_1_custom 通过命名规则归到 question_1。
        val pages = elicitationPages(request.fields).map { page -> page.map { it.name } }
        // org.json 不保证属性顺序：页内分组确定（宿主在前伴生在后），页序不限。
        assertEquals(
            setOf(setOf("q", "q_note"), setOf("question_1", "question_1_custom"), setOf("orphan_note")),
            pages.map { it.toSet() }.toSet(),
        )
        assertEquals(
            listOf("question_1", "question_1_custom"),
            pages.single { "question_1" in it },
        )
    }

    @Test
    fun codexMetaUserNoteMarksCompanion() {
        val request = ElicitationRequest.parse(
            JSONObject(
                """{"elicitationRequestId":"e6","schema":{"properties":{
                    "note":{"type":"string","_meta":{"codex":{"role":"user_note","questionId":"env"}}},
                    "env":{"type":"string","enum":["dev","prod"]}
                }}}""",
            ),
        )!!
        val pages = elicitationPages(request.fields).map { page -> page.map { it.name } }
        assertEquals(listOf(listOf("env", "note")), pages)
    }
}
