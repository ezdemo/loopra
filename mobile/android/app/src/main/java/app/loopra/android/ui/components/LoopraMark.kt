package app.loopra.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.loopra.android.ui.theme.MarkBlue
import app.loopra.android.ui.theme.MarkDeep

/**
 * Loopra 标识：圆角方框描边 + 内部 L 形笔画，与 mobile/icons/launcher.svg
 * 同一矢量结构。halo 用于落地页的柔和光晕。
 */
@Composable
fun LoopraMark(
    size: Dp,
    modifier: Modifier = Modifier,
    halo: Boolean = false,
    description: String? = "Loopra",
) {
    Canvas(
        modifier
            .size(size)
            .semantics { if (description != null) contentDescription = description },
    ) {
        val s = this.size.minDimension / 72f
        if (halo) {
            drawCircle(
                color = MarkBlue.copy(alpha = 0.16f),
                radius = this.size.minDimension * 0.72f,
                center = center,
            )
            drawCircle(
                color = Color(0xFF36C2D8).copy(alpha = 0.10f),
                radius = this.size.minDimension * 0.55f,
                center = center + Offset(this.size.minDimension * 0.18f, -this.size.minDimension * 0.12f),
            )
        }
        drawRoundRect(
            color = MarkBlue,
            topLeft = Offset(16f * s, 16f * s),
            size = Size(40f * s, 40f * s),
            cornerRadius = CornerRadius(13f * s),
            style = Stroke(width = 5f * s),
        )
        val path = Path().apply {
            moveTo(30f * s, 25f * s)
            lineTo(30f * s, 40f * s)
            cubicTo(30f * s, 44f * s, 32.5f * s, 46f * s, 36.5f * s, 46f * s)
            lineTo(44f * s, 46f * s)
        }
        drawPath(
            path = path,
            color = MarkDeep,
            style = Stroke(width = 4.5f * s, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
    }
}
