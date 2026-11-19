package app.loopra.android.data

import android.content.Context
import android.content.SharedPreferences

/** UI 偏好边界；真实实现走私有 SharedPreferences，测试用内存实现。 */
interface NativePreferences {
    var themeMode: String
    var reduceTransparency: Boolean
    var fontSize: Int
}

class SharedPrefsPreferences(context: Context) : NativePreferences {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("loopra-native-prefs", Context.MODE_PRIVATE)

    override var themeMode: String
        get() = prefs.getString(KEY_THEME, "system") ?: "system"
        set(value) = prefs.edit().putString(KEY_THEME, value).apply()

    override var reduceTransparency: Boolean
        get() = prefs.getBoolean(KEY_TRANSPARENCY, false)
        set(value) = prefs.edit().putBoolean(KEY_TRANSPARENCY, value).apply()

    override var fontSize: Int
        get() = prefs.getInt(KEY_FONT_SIZE, 16).takeIf { it in FONT_SIZES } ?: 16
        set(value) = prefs.edit().putInt(KEY_FONT_SIZE, value.takeIf { it in FONT_SIZES } ?: 16).apply()

    private companion object {
        val FONT_SIZES = intArrayOf(15, 16, 18)
        const val KEY_FONT_SIZE = "font_size"
        const val KEY_THEME = "theme_mode"
        const val KEY_TRANSPARENCY = "reduce_transparency"
    }
}
