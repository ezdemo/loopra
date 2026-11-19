package app.loopra.android.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import app.loopra.android.ui.state.ThemeMode

/** 主题实际生效的明暗：跟随应用主题设置而非系统，供玻璃与光晕统一取色。 */
val LocalLoopraDark = compositionLocalOf { false }

val NeutralBackgroundLight = Color(0xFFE9E9E6)
val NeutralBackgroundDark = Color(0xFF09090A)
val InkLight = Color(0xFF181817)
val InkDark = Color(0xFFF3F3EF)
val SecondaryLight = Color(0xFF676762)
val SecondaryDark = Color(0xFFA8A8A2)
val PrimaryLight = Color(0xFF1B1B19)
val PrimaryDark = Color(0xFFF1F1ED)
val MarkBlue = Color(0xFF3385F2)
val MarkDeep = Color(0xFF1B427A)

private val LightColors = lightColorScheme(
    primary = PrimaryLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD9D9D4),
    onPrimaryContainer = Color(0xFF181817),
    secondary = SecondaryLight,
    onSecondary = Color.White,
    background = NeutralBackgroundLight,
    onBackground = InkLight,
    surface = NeutralBackgroundLight,
    onSurface = InkLight,
    surfaceVariant = Color(0xFFDDDDD8),
    onSurfaceVariant = SecondaryLight,
    surfaceContainer = Color(0xFFE3E3E0),
    surfaceContainerHigh = Color(0xFFDEDEDA),
    outline = Color(0xFF9B9B94),
    outlineVariant = Color(0xFFD4D4CE),
    error = Color(0xFFBA2B2B),
)

private val DarkColors = darkColorScheme(
    primary = PrimaryDark,
    onPrimary = Color(0xFF141413),
    primaryContainer = Color(0xFF3A3A37),
    onPrimaryContainer = Color(0xFFF3F3EF),
    secondary = SecondaryDark,
    onSecondary = Color(0xFF141413),
    background = NeutralBackgroundDark,
    onBackground = InkDark,
    surface = NeutralBackgroundDark,
    onSurface = InkDark,
    surfaceVariant = Color(0xFF262624),
    onSurfaceVariant = SecondaryDark,
    surfaceContainer = Color(0xFF141413),
    surfaceContainerHigh = Color(0xFF1C1C1A),
    outline = Color(0xFF6E6E68),
    outlineVariant = Color(0xFF33332F),
    error = Color(0xFFF0736B),
)

@Composable
fun LoopraTheme(mode: ThemeMode, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.isAppearanceLightStatusBars = !dark
            controller.isAppearanceLightNavigationBars = !dark
        }
    }
    CompositionLocalProvider(LocalLoopraDark provides dark) {
        MaterialTheme(
            colorScheme = if (dark) DarkColors else LightColors,
            content = content,
        )
    }
}

/**
 * 工作台共享壁纸：斜向中性底色 + 右上冷亮斑 + 左侧暖光，
 * 与移动版 mobile.css 的暖灰层次一致，无蓝洗。
 * drawWithCache 让三层渐变只在尺寸/主题变化时重建。
 */
fun Modifier.wallpaper(): Modifier = composed {
    val dark = LocalLoopraDark.current
    this.drawWithCache {
        val base = Brush.linearGradient(
            colors = if (dark) {
                listOf(Color(0xFF121213), Color(0xFF080809))
            } else {
                listOf(Color(0xFFEFEFEC), Color(0xFFE3E3E0))
            },
            start = Offset.Zero,
            end = Offset(size.width * 0.7f, size.height),
        )
        val topRight = Brush.radialGradient(
            colors = listOf(
                (if (dark) Color(0xFF3E3E38) else Color(0xFFFCFCFA))
                    .copy(alpha = if (dark) 0.55f else 0.9f),
                Color.Transparent,
            ),
            center = Offset(size.width * 1.05f, size.height * 0.02f),
            radius = size.maxDimension * 0.9f,
        )
        val left = Brush.radialGradient(
            colors = listOf(
                (if (dark) Color(0xFF26231B) else Color(0xFFEAE3D6))
                    .copy(alpha = if (dark) 0.6f else 0.65f),
                Color.Transparent,
            ),
            center = Offset(-size.width * 0.15f, size.height * 0.35f),
            radius = size.maxDimension * 0.8f,
        )
        onDrawBehind {
            drawRect(base)
            drawRect(left)
            drawRect(topRight)
        }
    }
}

/** @Deprecated 兼容旧调用点；新代码用 [Modifier.wallpaper]。 */
@Composable
fun washBrush(): Brush {
    val dark = LocalLoopraDark.current
    return Brush.linearGradient(
        colors = if (dark) {
            listOf(Color(0xFF121213), Color(0xFF080809))
        } else {
            listOf(Color(0xFFEFEFEC), Color(0xFFE3E3E0))
        },
        start = Offset.Zero,
        end = Offset(700f, 1600f),
    )
}
