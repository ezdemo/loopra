package app.loopra.android.data

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.nio.charset.StandardCharsets

/** 配对的持久化边界，便于 JVM 测试替换。配对内容永不进入日志。 */
interface PairingStore {
    fun load(): Pairing?
    fun save(pairing: Pairing)
    fun clear()
}

/**
 * 存储在应用私有 noBackupFilesDir 中：不出现在 adb backup、设备迁移或
 * savedInstanceState 中；删除只清理这一个应用自有文件。
 */
class AtomicPairingStore(context: Context) : PairingStore {
    private val file = AtomicFile(File(context.noBackupFilesDir, "pairing.json"))

    override fun load(): Pairing? = runCatching {
        // AtomicFile 在写入中断后只留有 .bak；openRead 会先把备份归位再读，
        // 因此不能先检查 baseFile 是否存在，否则丢失可恢复的配对。
        val json = try {
            String(file.readFully(), StandardCharsets.UTF_8)
        } catch (missing: java.io.FileNotFoundException) {
            return null
        }
        Pairing.fromJson(json)
    }.getOrNull()

    override fun save(pairing: Pairing) {
        // 写失败向上抛：调用方据此放弃无法持久化的候选连接。
        val out = file.startWrite()
        try {
            out.write(pairing.toJson().toByteArray(StandardCharsets.UTF_8))
            file.finishWrite(out)
        } catch (error: Exception) {
            file.failWrite(out)
            throw error
        }
    }

    override fun clear() {
        runCatching { file.delete() }
    }
}
