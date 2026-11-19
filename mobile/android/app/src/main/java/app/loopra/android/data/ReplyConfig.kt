package app.loopra.android.data

import org.json.JSONArray
import org.json.JSONObject

/** 回复设置的可写值：select 写字符串，boolean 写布尔。 */
sealed interface ConfigValue {
    data class Text(val value: String) : ConfigValue
    data class Toggle(val value: Boolean) : ConfigValue
}

data class ConfigChoice(
    val value: String,
    val label: String,
    val description: String? = null,
    val group: String? = null,
)

enum class ConfigType { SELECT, BOOLEAN }

data class AgentConfigOption(
    val id: String,
    val name: String,
    val type: ConfigType,
    val category: String?,
    val current: ConfigValue,
    val options: List<ConfigChoice>,
    val description: String? = null,
)

/**
 * `web/src/agent-config.ts` 的 Kotlin 边界：原生引擎暴露 model / effort /
 * mode / fast，外部 ACP 走声明的类型。解析宽容但不做不安全强转。
 */
object ReplyConfig {

    private val effortLabels = mapOf(
        "none" to "无",
        "minimal" to "最小",
        "low" to "低",
        "medium" to "中",
        "high" to "高",
        "xhigh" to "超高",
        "max" to "最大",
        "default" to "默认",
    )

    fun parse(data: JSONArray): List<AgentConfigOption> {
        val out = mutableListOf<AgentConfigOption>()
        val seenIds = HashSet<String>()
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val id = (item.opt("id") as? String)?.takeIf { it.isNotBlank() } ?: continue
            if (!seenIds.add(id)) continue
            val type = when (item.optString("type")) {
                "select" -> ConfigType.SELECT
                "boolean" -> ConfigType.BOOLEAN
                else -> continue
            }
            val raw = item.opt("currentValue")
            val current = when (type) {
                ConfigType.SELECT ->
                    if (raw is String) ConfigValue.Text(raw) else continue
                ConfigType.BOOLEAN -> when (raw) {
                    is Boolean -> ConfigValue.Toggle(raw)
                    // 旧实现把布尔写成 on/off 字符串；只接受这一种遗留表示。
                    "on" -> ConfigValue.Toggle(true)
                    "off" -> ConfigValue.Toggle(false)
                    else -> continue
                }
            }
            val choices = mutableListOf<ConfigChoice>()
            val seenChoices = HashSet<String>()
            item.optJSONArray("options")?.let { array ->
                for (j in 0 until array.length()) {
                    val choice = array.optJSONObject(j) ?: continue
                    val value = (choice.opt("value") as? String)
                        ?.takeIf { it.isNotBlank() } ?: continue
                    if (!seenChoices.add(value)) continue
                    choices.add(
                        ConfigChoice(
                            value = value,
                            label = (choice.opt("name") as? String)
                                ?.takeIf { it.isNotBlank() } ?: value,
                            description = (choice.opt("description") as? String)
                                ?.takeIf { it.isNotEmpty() },
                            group = (choice.opt("group") as? String)
                                ?.takeIf { it.isNotEmpty() },
                        ),
                    )
                }
            }
            out.add(
                AgentConfigOption(
                    id = id,
                    name = (item.opt("name") as? String)?.takeIf { it.isNotBlank() } ?: id,
                    type = type,
                    category = (item.opt("category") as? String)?.takeIf { it.isNotEmpty() },
                    current = current,
                    options = choices,
                    description = (item.opt("description") as? String)?.takeIf { it.isNotEmpty() },
                ),
            )
        }
        return out
    }

    fun parse(data: JSONObject): List<AgentConfigOption> {
        val array = data.optJSONArray("configOptions")
            ?: throw ApiException("回复设置响应格式不正确")
        return parse(array)
    }

    /** 与网页端 findAgentOption 一致：先按 id，再按 category 兜底。 */
    fun find(options: List<AgentConfigOption>?, id: String, category: String?): AgentConfigOption? {
        if (options == null) return null
        return options.firstOrNull { it.id == id }
            ?: category?.let { cat -> options.firstOrNull { it.category == cat } }
    }

    fun modelOption(options: List<AgentConfigOption>?) = find(options, "model", "model")
    fun effortOption(options: List<AgentConfigOption>?) = find(options, "effort", "thought_level")

    /** 设置页里独立展示的两项之外的其余配置。 */
    fun extraOptions(options: List<AgentConfigOption>?): List<AgentConfigOption> {
        val model = modelOption(options)
        val effort = effortOption(options)
        return options.orEmpty().filter { it.id != model?.id && it.id != effort?.id }
    }

    /** 选项显示文案：原生 effort 的选项名就是英文值，按共享文案映射。 */
    fun choiceLabel(option: AgentConfigOption, choice: ConfigChoice): String =
        if (option.id == "effort" || option.category == "thought_level") {
            effortLabels[choice.value] ?: choice.label
        } else {
            choice.label
        }

    /** 当前值的显示文案：优先选项自带名称，其次原始值。 */
    fun currentLabel(option: AgentConfigOption): String = when (val current = option.current) {
        is ConfigValue.Text ->
            option.options.firstOrNull { it.value == current.value }?.let { choiceLabel(option, it) }
                ?: if (option.id == "effort" || option.category == "thought_level") {
                    effortLabels[current.value] ?: current.value
                } else {
                    current.value
                }
        is ConfigValue.Toggle -> if (current.value) "开启" else "关闭"
    }

    /** 模型选项的短名：`频道 / 模型` 的模型部分。 */
    fun modelShortLabel(option: AgentConfigOption): String {
        val label = currentLabel(option)
        val parts = label.split(" / ")
        return if (parts.size >= 2) parts.last() else label
    }
}
