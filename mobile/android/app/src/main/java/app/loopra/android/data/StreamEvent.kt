package app.loopra.android.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条 SSE 事件。对象帧的字段保存在 [json]；裸 JSON 字符串帧保存在 [text]。
 * 字段访问保持宽容：未知事件类型由归约层安全忽略。
 */
data class StreamEvent(val type: String, val json: JSONObject? = null, val text: String? = null) {
    val content: String
        get() = text ?: when {
            json?.has("content") == true -> json.optString("content")
            json?.has("token") == true -> json.optString("token")
            else -> ""
        }
    fun string(key: String): String? = json?.optString(key)?.takeIf { it.isNotEmpty() }
    fun has(key: String): Boolean = json?.has(key) == true && !json.isNull(key)
    fun obj(key: String): JSONObject? = json?.optJSONObject(key)
    fun array(key: String): JSONArray? = json?.optJSONArray(key)
    val permissionRequestId: String? get() = string("permissionRequestId")
    val subId: String? get() = string("subId")

    companion object {
        fun text(type: String, content: String) = StreamEvent(type, text = content)
    }
}
