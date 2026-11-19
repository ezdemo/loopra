package app.loopra.android.ui.components

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy
import app.loopra.android.ui.theme.LocalLoopraDark

/**
 * 统一的液态玻璃面板。Android 12+ 且未开“减少透明效果”时绘制真实的
 * Backdrop 采样模糊与折射；否则退化为不透明的语义底色，保证可读性。
 * 调用方必须保证 [backdrop] 只采集背景与滚动内容，绝不能采集玻璃自身。
 */
@Composable
fun GlassSurface(
    backdrop: Backdrop,
    reduceTransparency: Boolean,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(28.dp),
    cornerRadius: Dp? = null,
    /** 覆写玻璃底色与透明度；不传时保持原有语义底色。 */
    tint: Color? = null,
    tintAlpha: Float? = null,
    fallbackColor: Color? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    val dark = LocalLoopraDark.current
    val actualShape = cornerRadius?.let { RoundedCornerShape(it) } ?: shape
    val tintColor = tint ?: if (dark) Color(0xFF1D2126) else Color.White
    val alpha = tintAlpha ?: if (dark) 0.72f else 0.62f
    val edge = if (dark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.06f)
    val glass = if (Build.VERSION.SDK_INT >= 31 && !reduceTransparency) {
        Modifier.drawBackdrop(
            backdrop = backdrop,
            shape = { actualShape },
            effects = {
                vibrancy()
                blur(18.dp.toPx())
                if (Build.VERSION.SDK_INT >= 33) lens(12.dp.toPx(), 24.dp.toPx())
            },
            onDrawSurface = { drawRect(tintColor.copy(alpha = alpha)) },
        )
    } else {
        // 降级为不透明语义底色：低版本/减少透明时保持可读性。
        Modifier.background(fallbackColor ?: MaterialTheme.colorScheme.surfaceContainer, actualShape)
    }
    Box(
        modifier
            .then(glass)
            .border(1.dp, edge, actualShape)
            .clip(actualShape),
        content = content,
    )
}

/** 非浮层的小面积玻璃（如「回到最新」提示），同样遵守降级策略。 */
@Composable
fun GlassChip(
    backdrop: Backdrop,
    reduceTransparency: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    GlassSurface(
        backdrop = backdrop,
        reduceTransparency = reduceTransparency,
        modifier = modifier,
        cornerRadius = 20.dp,
        content = content,
    )
}
