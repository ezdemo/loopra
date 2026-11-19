package app.loopra.android.data

import org.json.JSONArray
import org.json.JSONObject

/** 桌面端引擎目录条目；available && !hidden 才可被新会话选择。 */
data class AgentEngine(
    val id: String,
    val name: String,
    val available: Boolean,
    val hidden: Boolean,
) {
    val selectable: Boolean get() = available && !hidden
}

/** 选项值保持服务端原始标量类型，回写时不再二次转换。 */
data class ElicitationOption(val value: Any, val title: String, val description: String?)

data class ElicitationField(
    val name: String,
    val type: String?,
    val title: String,
    val description: String?,
    val required: Boolean,
    val options: List<ElicitationOption>,
    val isArray: Boolean,
    val minLength: Int?,
    val maxLength: Int?,
    val minimum: Double?,
    val maximum: Double?,
    val minItems: Int?,
    val maxItems: Int?,
    val isSecret: Boolean,
    /** 无法可靠映射为本地控件的字段禁止提交，提示回桌面端完成。 */
    val unsupported: Boolean,
    /** 伴生说明字段指向的宿主字段名；对齐 web/src/elicitation.ts 的分页。 */
    val companionTo: String? = null,
)

data class ElicitationRequest(
    val elicitationRequestId: String,
    val message: String,
    val fields: List<ElicitationField>,
    val allowOther: Boolean,
) {
    companion object {
        fun parse(json: JSONObject): ElicitationRequest? {
            val id = json.optString("elicitationRequestId").takeIf { it.isNotEmpty() } ?: return null
            val schema = json.optJSONObject("schema")
            val properties = schema?.optJSONObject("properties")
            val required = mutableSetOf<String>()
            schema?.optJSONArray("required")?.let { array ->
                for (i in 0 until array.length()) {
                    (array.opt(i) as? String)?.let(required::add)
                }
            }
            val fields = mutableListOf<ElicitationField>()
            val names = properties?.keys() ?: return ElicitationRequest(id, json.optString("message"), emptyList(), allowOther(json))
            while (names.hasNext()) {
                val name = names.next()
                val raw = properties.optJSONObject(name) ?: continue
                fields.add(parseField(name, raw, required.contains(name)))
            }
            return ElicitationRequest(id, json.optString("message"), fields, allowOther(json))
        }

        private fun allowOther(json: JSONObject): Boolean {
            val meta = json.optJSONObject("meta") ?: return false
            return meta.optBoolean("cognition.ai/allowOther") || meta.optBoolean("allowOther")
        }

        private fun parseField(name: String, raw: JSONObject, required: Boolean): ElicitationField {
            val options = mutableListOf<ElicitationOption>()
            raw.optJSONArray("oneOf")?.let { collectOptions(it, options) }
            if (options.isEmpty()) raw.optJSONArray("anyOf")?.let { collectOptions(it, options) }
            if (options.isEmpty()) {
                raw.optJSONArray("enum")?.let { array ->
                    val names = raw.optJSONArray("enumNames")
                    for (i in 0 until array.length()) {
                        val value = array.opt(i) ?: continue
                        if (value is String || value is Number || value is Boolean) {
                            options.add(
                                ElicitationOption(
                                    value = value,
                                    title = names?.optString(i)?.takeIf { it.isNotEmpty() }
                                        ?: value.toString(),
                                    description = null,
                                ),
                            )
                        }
                    }
                }
            }
            val type = raw.optString("type").takeIf { it.isNotEmpty() }
            val items = raw.optJSONObject("items")
            val isArray = type == "array"
            val unsupported = when {
                isArray -> items != null && items.optJSONArray("enum") == null &&
                    items.optJSONArray("oneOf") == null && items.optJSONArray("anyOf") == null &&
                    items.optString("type") !in setOf("string", "number", "integer", "boolean")
                type != null -> type !in setOf("string", "number", "integer", "boolean", "array")
                else -> false
            }
            val codex = raw.optJSONObject("_meta")?.optJSONObject("codex")
            val companionTo = when {
                codex?.optString("role") == "user_note" -> codex.opt("questionId") as? String
                name.endsWith("_note") -> name.removeSuffix("_note")
                type == "string" && CLAUDE_CUSTOM.matches(name) -> name.removeSuffix("_custom")
                else -> null
            }
            return ElicitationField(
                name = name,
                type = type,
                title = raw.optString("title").takeIf { it.isNotEmpty() } ?: name,
                description = raw.optString("description").takeIf { it.isNotEmpty() },
                required = required,
                options = options,
                isArray = isArray,
                minLength = intBound(raw, "minLength"),
                maxLength = intBound(raw, "maxLength"),
                minimum = if (raw.has("minimum")) raw.optDouble("minimum") else null,
                maximum = if (raw.has("maximum")) raw.optDouble("maximum") else null,
                minItems = intBound(raw, "minItems"),
                maxItems = intBound(raw, "maxItems"),
                isSecret = codex?.optBoolean("isSecret") == true,
                unsupported = unsupported,
                companionTo = companionTo,
            )
        }

        private fun collectOptions(array: JSONArray, out: MutableList<ElicitationOption>) {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val value = item.opt("const") ?: continue
                if (value !is String && value !is Number && value !is Boolean) continue
                val description = item.optString("description").takeIf { it.isNotEmpty() }
                    ?: item.optJSONObject("_meta")
                        ?.optString("cognition.ai/description")?.takeIf { it.isNotEmpty() }
                out.add(
                    ElicitationOption(
                        value = value,
                        title = item.optString("title").takeIf { it.isNotEmpty() }
                            ?: value.toString(),
                        description = description,
                    ),
                )
            }
        }

        /** Claude ACP 对普通客户端发 question_<index>_custom 伴生字段，不带元数据。 */
        private val CLAUDE_CUSTOM = Regex("question_[0-9]+_custom")

        private fun intBound(raw: JSONObject, key: String): Int? =
            when (val value = raw.opt(key)) {
                is Int -> value
                is Long -> value.takeIf { it in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() }?.toInt()
                is Double -> value.takeIf { it == it.toInt().toDouble() }?.toInt()
                else -> null
            }
    }
}

/**
 * 伴生字段随宿主同页（即便 JSON 顺序在前）；宿主缺失的伴生字段
 * 独立成页，绝不丢字段。对齐 elicitationPages。
 */
internal fun elicitationPages(fields: List<ElicitationField>): List<List<ElicitationField>> {
    val names = fields.mapTo(HashSet()) { it.name }
    val companions = fields.mapNotNull { field ->
        field.companionTo
            ?.takeIf { it != field.name && it in names }
            ?.let { field.name to it }
    }.toMap()
    val notes = fields.filter { it.name in companions }.groupBy { companions.getValue(it.name) }
    val roots = fields.filterNot { it.name in companions }
    val rendered = roots.mapTo(HashSet()) { it.name }
    return roots.map { listOf(it) + notes[it.name].orEmpty() } +
        fields
            .filter { it.name in companions && companions.getValue(it.name) !in rendered }
            .map { listOf(it) }
}

/** 校验当前答案集；返回空串表示可提交。对齐 web/src/elicitation.ts。 */
fun elicitationError(request: ElicitationRequest, answers: Map<String, Any>): String {
    val content = elicitationContent(request, answers)
    for (field in request.fields) {
        if (field.required && !content.containsKey(field.name)) return "请填写“${field.title}”"
    }
    for ((name, value) in content) {
        val field = request.fields.firstOrNull { it.name == name } ?: continue
        if (field.options.isNotEmpty() && !request.allowOther &&
            field.options.none { it.value == value }
        ) return "请选择“${field.title}”的有效选项"
        if (value is String) {
            if (field.minLength != null && value.length < field.minLength) return "“${field.title}”的长度不符合要求"
            if (field.maxLength != null && value.length > field.maxLength) return "“${field.title}”的长度不符合要求"
        }
        if (value is Number) {
            val d = value.toDouble()
            if (field.type == "integer" && d != d.toLong().toDouble()) return "“${field.title}”的数值不符合要求"
            if (field.minimum != null && d < field.minimum) return "“${field.title}”的数值不符合要求"
            if (field.maximum != null && d > field.maximum) return "“${field.title}”的数值不符合要求"
        }
        if (value is List<*>) {
            if (field.minItems != null && value.size < field.minItems) return "“${field.title}”的选项数量不符合要求"
            if (field.maxItems != null && value.size > field.maxItems) return "“${field.title}”的选项数量不符合要求"
        }
    }
    return ""
}

/** 提交内容：空串/空数组剥掉，数组内空串占位也剥掉。 */
fun elicitationContent(request: ElicitationRequest, answers: Map<String, Any>): Map<String, Any> {
    val out = linkedMapOf<String, Any>()
    for (field in request.fields) {
        val value = answers[field.name] ?: continue
        if (value is List<*>) {
            val items = value.filter { it != "" }
            if (items.isNotEmpty()) out[field.name] = items
            continue
        }
        if (value is String && value.isEmpty()) continue
        if (value is Double && !value.isFinite()) continue
        out[field.name] = value
    }
    return out
}
