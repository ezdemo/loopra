package app.loopra.android.data

import java.net.URI
import java.net.URLDecoder
import kotlin.io.encoding.ExperimentalEncodingApi
import org.json.JSONObject

/**
 * 与桌面端 `mobile/src/relay/pairing.ts` 及 Rust `Pairing::validate` 一致的配对模型。
 * 链接格式：loopra://connect?u=<relayUrl>&k=<connectCode>&v=1&e2e=1
 */
data class Pairing(
    val relayUrl: String,
    val connectCode: String,
    val version: Int = 1,
    val displayName: String? = null,
) {
    /** 配对码是凭证：任何日志/toString 路径都不允许带出。 */
    override fun toString(): String =
        "Pairing(relayUrl=$relayUrl, version=$version, displayName=$displayName)"
    /** 私有存储使用的 camelCase JSON。绝不写入日志。 */
    fun toJson(): String {
        val obj = JSONObject()
        obj.put("relayUrl", relayUrl)
        obj.put("connectCode", connectCode)
        obj.put("version", version)
        if (displayName != null) obj.put("displayName", displayName)
        return obj.toString()
    }

    /** 仅用于界面展示的中继主机名，不包含配对码。 */
    val relayHost: String
        get() = runCatching { URI(relayUrl).host ?: relayUrl }.getOrDefault(relayUrl)

    companion object {
        private const val MAX_LINK_LENGTH = 4096
        private const val MAX_NAME_CHARS = 40
        private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")

        fun normalizeDisplayName(value: String?): String? {
            if (value == null) return null
            val compact = value
                .replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
            val name = compact.take(MAX_NAME_CHARS)
            return name.ifEmpty { null }
        }

        /** @throws PairingException 链接或字段无效时抛出。 */
        fun parse(link: String): Pairing {
            if (link.length > MAX_LINK_LENGTH) throw PairingException("配对链接过长")
            val uri = parseUri(link.trim())
            if (uri.scheme?.lowercase() != "loopra" ||
                uri.host?.lowercase() != "connect" ||
                !uri.rawPath.isNullOrEmpty() ||
                uri.port >= 0 ||
                uri.rawFragment != null ||
                uri.rawUserInfo != null
            ) {
                throw PairingException("请使用 Loopra 桌面端的配对二维码或链接")
            }
            val params = queryParams(uri.rawQuery)
            for (name in listOf("u", "k", "v", "e2e")) {
                if (params.getOrDefault(name, emptyList()).size != 1) {
                    throw PairingException("配对链接无效")
                }
            }
            if (params.getValue("e2e").single() != "1") {
                throw PairingException("请使用 Loopra 桌面端的配对二维码或链接")
            }
            if (params.getValue("v").single() != "1") {
                throw PairingException("不支持这个配对协议版本，请更新 Loopra")
            }
            return validate(
                relayUrl = params.getValue("u").single(),
                connectCode = params.getValue("k").single(),
                version = 1,
                displayName = null,
            )
        }

        fun validate(
            relayUrl: String,
            connectCode: String,
            version: Int,
            displayName: String?,
        ): Pairing {
            if (version != 1) throw PairingException("不支持这个配对协议版本，请更新 Loopra")
            if (relayUrl.length > 2048) throw PairingException("中继地址无效")
            val relay = parseUri(relayUrl)
            val scheme = relay.scheme?.lowercase()
            val host = relay.host ?: throw PairingException("中继地址需要有效的 HTTPS 域名")
            val local = LOCAL_HOSTS.contains(host.lowercase()) || LOCAL_HOSTS.contains("[${host.lowercase()}]")
            if (scheme != "https" && !(scheme == "http" && local)) {
                throw PairingException("中继地址需要有效的 HTTPS 域名")
            }
            if (relay.rawUserInfo != null || relay.rawQuery != null || relay.rawFragment != null) {
                throw PairingException("中继地址需要有效的 HTTPS 域名")
            }
            if (!relay.rawPath.isNullOrEmpty() && relay.rawPath != "/") {
                throw PairingException("中继地址需要有效的 HTTPS 域名")
            }
            val code = decodeCode(connectCode)
            if (CONNECT_CODE_CODEC.encode(code) != connectCode) throw PairingException("配对码无效")
            val name = normalizeDisplayName(displayName)
            // 归一化为 scheme://host[:port] 形式，与桌面端 relay.origin 一致。
            val port = if (relay.port >= 0) ":${relay.port}" else ""
            val normalized = "$scheme://${host.lowercase()}$port"
            return Pairing(normalized, connectCode, 1, name)
        }

        fun fromJson(json: String): Pairing? = runCatching {
            val obj = JSONObject(json)
            validate(
                relayUrl = obj.optString("relayUrl"),
                connectCode = obj.optString("connectCode"),
                version = obj.optInt("version", -1),
                displayName = if (obj.has("displayName")) obj.optString("displayName") else null,
            )
        }.getOrNull()

        // java.util.Base64 需要 API26；kotlin 标准库的 URL-safe Base64
        // 在 JVM 与 Android 24+ 上一致可用。
        @OptIn(ExperimentalEncodingApi::class)
        private val CONNECT_CODE_CODEC = kotlin.io.encoding.Base64.UrlSafe
            .withPadding(kotlin.io.encoding.Base64.PaddingOption.ABSENT)

        private fun decodeCode(code: String): ByteArray {
            if (code.isEmpty() || code.length % 4 == 1 || !code.matches(Regex("[A-Za-z0-9_-]+"))) {
                throw PairingException("配对码无效")
            }
            @OptIn(ExperimentalEncodingApi::class)
            val bytes = try {
                CONNECT_CODE_CODEC.decode(code)
            } catch (error: IllegalArgumentException) {
                throw PairingException("配对码无效")
            }
            if (bytes.size != 32) throw PairingException("配对码无效")
            return bytes
        }

        private fun parseUri(value: String): URI = try {
            URI(value)
        } catch (error: Exception) {
            throw PairingException("配对链接无效")
        }

        private fun queryParams(rawQuery: String?): Map<String, List<String>> {
            if (rawQuery.isNullOrEmpty()) return emptyMap()
            val result = LinkedHashMap<String, MutableList<String>>()
            for (part in rawQuery.split('&')) {
                if (part.isEmpty()) continue
                val eq = part.indexOf('=')
                val key = decodeComponent(if (eq >= 0) part.substring(0, eq) else part)
                val value = decodeComponent(if (eq >= 0) part.substring(eq + 1) else "")
                result.getOrPut(key) { mutableListOf() }.add(value)
            }
            return result
        }

        private fun decodeComponent(value: String): String = try {
            // Charset 重载需要 API33；用名字符串兼容 minSdk 24。
            URLDecoder.decode(value, "UTF-8")
        } catch (error: Exception) {
            throw PairingException("配对链接无效")
        }
    }
}

class PairingException(message: String) : Exception(message)
