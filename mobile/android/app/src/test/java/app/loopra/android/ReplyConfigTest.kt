package app.loopra.android

import app.loopra.android.data.ConfigType
import app.loopra.android.data.ConfigValue
import app.loopra.android.data.LoopraRepository
import app.loopra.android.data.Pairing
import app.loopra.android.data.RelayConnection
import app.loopra.android.data.RelayRequest
import app.loopra.android.data.RelayStatus
import app.loopra.android.data.ReplyConfig
import app.loopra.android.data.ResponseHead
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回复设置解析与 GET/PUT 走线的边界测试。 */
class ReplyConfigTest {

    private fun optionsJson(): JSONArray = JSONArray().apply {
        put(JSONObject().apply {
            put("id", "model")
            put("name", "模型")
            put("category", "model")
            put("type", "select")
            put("currentValue", "magpie:deepseek-v4")
            put("options", JSONArray().apply {
                put(JSONObject().apply {
                    put("value", "magpie:deepseek-v4")
                    put("name", "Magpie / DeepSeek V4")
                })
                put(JSONObject().apply {
                    put("value", "astra:gpt-5")
                    put("name", "Astra / GPT-5")
                    put("group", "Astra")
                })
            })
        })
        put(JSONObject().apply {
            put("id", "effort")
            put("name", "思考强度")
            put("category", "thought_level")
            put("type", "select")
            put("currentValue", "high")
            // 原生引擎的 effort 选项名就是英文值，文案在客户端映射。
            put("options", JSONArray().apply {
                put(JSONObject().apply { put("value", "low"); put("name", "low") })
                put(JSONObject().apply { put("value", "high"); put("name", "high") })
                put(JSONObject().apply { put("value", "max"); put("name", "max") })
            })
        })
        put(JSONObject().apply {
            put("id", "fast")
            put("name", "快速模式")
            put("category", "model_config")
            put("type", "boolean")
            put("currentValue", false)
            put("options", JSONArray())
        })
        put(JSONObject().apply {
            put("id", "legacy-toggle")
            put("name", "遗留开关")
            put("category", "custom")
            put("type", "boolean")
            put("currentValue", "on")
        })
        put(JSONObject().apply {
            put("id", "bad-select")
            put("type", "select")
            put("currentValue", 42)
        })
        put(JSONObject().apply {
            put("id", "unknown")
            put("type", "color")
            put("currentValue", "red")
        })
    }

    @Test
    fun parsesNativeModelEffortAndToggle() {
        val options = ReplyConfig.parse(optionsJson())
        assertEquals(4, options.size)
        val model = ReplyConfig.modelOption(options)!!
        assertEquals(ConfigType.SELECT, model.type)
        assertEquals(ConfigValue.Text("magpie:deepseek-v4"), model.current)
        assertEquals("Magpie / DeepSeek V4", model.options[0].label)
        assertEquals("Astra", model.options[1].group)
        assertEquals("DeepSeek V4", ReplyConfig.modelShortLabel(model))
        val effort = ReplyConfig.effortOption(options)!!
        assertEquals("thought_level", effort.category)
        assertEquals("高", ReplyConfig.currentLabel(effort))
        // 英文原始值映射为中文芯片文案。
        assertEquals(
            listOf("低", "高", "最大"),
            effort.options.map { ReplyConfig.choiceLabel(effort, it) },
        )
        // 服务端新增值没有映射时回退原始值。
        val custom = effort.copy(current = ConfigValue.Text("turbo"))
        assertEquals("turbo", ReplyConfig.currentLabel(custom))
        val fast = options.single { it.id == "fast" }
        assertEquals(ConfigType.BOOLEAN, fast.type)
        assertEquals(ConfigValue.Toggle(false), fast.current)
        // 遗留 on/off 字符串布尔被接受。
        assertEquals(ConfigValue.Toggle(true), options.single { it.id == "legacy-toggle" }.current)
    }

    @Test
    fun skipsMalformedAndUnsupportedEntries() {
        val options = ReplyConfig.parse(optionsJson())
        assertTrue(options.none { it.id == "bad-select" })
        assertTrue(options.none { it.id == "unknown" })
    }

    @Test
    fun dedupesOptionIdsAndChoiceValues() {
        val data = JSONArray().apply {
            put(JSONObject().apply {
                put("id", "mode")
                put("type", "select")
                put("currentValue", "auto")
                put("options", JSONArray().apply {
                    put(JSONObject().apply { put("value", "auto"); put("name", "自动") })
                    put(JSONObject().apply { put("value", "auto"); put("name", "重复") })
                    put(JSONObject().apply { put("value", 7); put("name", "非法") })
                })
            })
            put(JSONObject().apply {
                put("id", "mode")
                put("type", "select")
                put("currentValue", "free")
            })
        }
        val options = ReplyConfig.parse(data)
        assertEquals(1, options.size)
        val mode = options.single()
        assertEquals(ConfigValue.Text("auto"), mode.current)
        assertEquals(1, mode.options.size)
        assertEquals("自动", mode.options.single().label)
    }

    @Test
    fun externalCategoryFallbackFindsByCategory() {
        val options = ReplyConfig.parse(optionsJson())
        // id 不匹配时按 category 兜底，与网页端 findAgentOption 一致。
        val byCategory = ReplyConfig.find(options, "thinking", "thought_level")
        assertEquals("effort", byCategory?.id)
        assertNull(ReplyConfig.find(options, "thinking", null))
        assertEquals(2, ReplyConfig.extraOptions(options).size)
    }

    private class CaptureConnection(private val body: String) : RelayConnection {
        override val pairing = Pairing("https://relay.example.com", "A".repeat(43))
        val requests = mutableListOf<RelayRequest>()
        override fun statusNow() = RelayStatus("connected", null, 1)
        override suspend fun check() {}
        override suspend fun send(request: RelayRequest): ResponseHead {
            requests.add(request)
            return ResponseHead(200, mapOf("content-type" to "application/json"))
        }
        override fun readBody(requestId: String): Flow<ByteArray> =
            flow { emit(body.toByteArray(Charsets.UTF_8)) }
        override fun cancel(requestId: String) {}
        override fun close() {}
    }

    private fun envelope(options: JSONArray) = JSONObject().apply {
        put("success", true)
        put("data", JSONObject().apply { put("configOptions", options) })
    }.toString()

    @Test
    fun replyConfigGetEncodesQuery() = runBlocking {
        val conn = CaptureConnection(envelope(optionsJson()))
        val repo = LoopraRepository(conn)
        val options = repo.replyConfig("ws 1&", "会话/x")
        assertEquals(4, options.size)
        val path = conn.requests.single().path
        assertEquals("GET", conn.requests.single().method)
        assertTrue(path.startsWith("/api/agent-engines/config?"))
        assertTrue(path.contains("workspaceHash=ws+1%26"))
        assertTrue(path.contains("sessionName=${java.net.URLEncoder.encode("会话/x", "UTF-8")}"))
    }

    @Test
    fun replyConfigPutSendsTypedValues() = runBlocking {
        val conn = CaptureConnection(envelope(optionsJson()))
        val repo = LoopraRepository(conn)
        repo.updateReplyConfig("w", "s", "effort", ConfigValue.Text("max"))
        repo.updateReplyConfig("w", "s", "fast", ConfigValue.Toggle(true))
        assertEquals(2, conn.requests.size)
        val (first, second) = conn.requests
        assertEquals("PUT", first.method)
        assertEquals("/api/agent-engines/config", first.path)
        val firstBody = JSONObject(String(first.body, Charsets.UTF_8))
        assertEquals("w", firstBody.getString("workspaceHash"))
        assertEquals("s", firstBody.getString("sessionName"))
        assertEquals("effort", firstBody.getString("configId"))
        assertEquals("max", firstBody.get("value"))
        val secondBody = JSONObject(String(second.body, Charsets.UTF_8))
        assertEquals(true, secondBody.get("value"))
    }

    @Test
    fun prepareParsesConfigOptionsWhenPresent() = runBlocking {
        val prepareEnvelope = JSONObject().apply {
            put("success", true)
            put("data", JSONObject().apply {
                put("sessionName", "s1")
                put("agentId", "native")
                put("configOptions", optionsJson())
            })
        }.toString()
        val conn = CaptureConnection(prepareEnvelope)
        val repo = LoopraRepository(conn)
        val prepared = repo.prepare("w")
        assertEquals(4, prepared.configOptions!!.size)
        val bare = JSONObject().apply {
            put("success", true)
            put("data", JSONObject().apply {
                put("sessionName", "s2")
                put("agentId", "native")
            })
        }.toString()
        val repo2 = LoopraRepository(CaptureConnection(bare))
        assertNull(repo2.prepare("w").configOptions)
    }
}
