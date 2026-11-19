package app.loopra.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin

/** material-icons-core 没有的小图标，沿用 Material 24dp 画幅与官方 path 数据。 */
object AppIcons {

    /** stop */
    val Stop: ImageVector by lazy {
        materialIcon("Filled.Stop") {
            materialPath {
                moveTo(6f, 6f)
                horizontalLineTo(18f)
                verticalLineTo(18f)
                horizontalLineTo(6f)
                close()
            }
        }
    }

    /** crop_free，用作扫码取景框 */
    val Scan: ImageVector by lazy {
        materialIcon("Filled.ScanFrame") {
            materialPath {
                moveTo(3f, 5f)
                verticalLineTo(9f)
                horizontalLineTo(5f)
                verticalLineTo(5f)
                horizontalLineTo(9f)
                verticalLineTo(3f)
                horizontalLineTo(5f)
                curveTo(3.9f, 3f, 3f, 3.9f, 3f, 5f)
                close()
                moveTo(5f, 15f)
                horizontalLineTo(3f)
                verticalLineTo(19f)
                curveTo(3f, 20.1f, 3.9f, 21f, 5f, 21f)
                horizontalLineTo(9f)
                verticalLineTo(19f)
                horizontalLineTo(5f)
                verticalLineTo(15f)
                close()
                moveTo(19f, 19f)
                horizontalLineTo(15f)
                verticalLineTo(21f)
                horizontalLineTo(19f)
                curveTo(20.1f, 21f, 21f, 20.1f, 21f, 19f)
                verticalLineTo(15f)
                horizontalLineTo(19f)
                verticalLineTo(19f)
                close()
                moveTo(19f, 3f)
                horizontalLineTo(15f)
                verticalLineTo(5f)
                horizontalLineTo(19f)
                verticalLineTo(9f)
                horizontalLineTo(21f)
                verticalLineTo(5f)
                curveTo(21f, 3.9f, 20.1f, 3f, 19f, 3f)
                close()
            }
        }
    }

    /** folder */
    val Folder: ImageVector by lazy {
        materialIcon("Filled.Folder") {
            materialPath {
                moveTo(10f, 4f)
                horizontalLineTo(4f)
                curveTo(2.9f, 4f, 2.01f, 4.9f, 2.01f, 6f)
                lineTo(2f, 18f)
                curveTo(2f, 19.1f, 2.9f, 20f, 4f, 20f)
                horizontalLineTo(20f)
                curveTo(21.1f, 20f, 22f, 19.1f, 22f, 18f)
                verticalLineTo(8f)
                curveTo(22f, 6.9f, 21.1f, 6f, 20f, 6f)
                horizontalLineTo(12f)
                lineTo(10f, 4f)
                close()
            }
        }
    }

    /** chat bubble */
    val Chat: ImageVector by lazy {
        materialIcon("Filled.Chat") {
            materialPath {
                moveTo(20f, 2f)
                horizontalLineTo(4f)
                curveTo(2.9f, 2f, 2.01f, 2.9f, 2.01f, 4f)
                lineTo(2f, 22f)
                lineTo(6f, 18f)
                horizontalLineTo(20f)
                curveTo(21.1f, 18f, 22f, 17.1f, 22f, 16f)
                verticalLineTo(4f)
                curveTo(22f, 2.9f, 21.1f, 2f, 20f, 2f)
                close()
            }
        }
    }

    /** tune：三条横线加滑块短刻，回复设置入口 */
    val Sliders: ImageVector by lazy {
        materialIcon("Filled.Sliders") {
            materialPath {
                moveTo(3f, 17f)
                verticalLineTo(19f)
                horizontalLineTo(9f)
                verticalLineTo(17f)
                horizontalLineTo(3f)
                close()
                moveTo(3f, 5f)
                verticalLineTo(7f)
                horizontalLineTo(13f)
                verticalLineTo(5f)
                horizontalLineTo(3f)
                close()
                moveTo(13f, 21f)
                verticalLineTo(19f)
                horizontalLineTo(21f)
                verticalLineTo(17f)
                horizontalLineTo(13f)
                verticalLineTo(15f)
                horizontalLineTo(11f)
                verticalLineTo(21f)
                horizontalLineTo(13f)
                close()
                moveTo(7f, 9f)
                verticalLineTo(11f)
                horizontalLineTo(3f)
                verticalLineTo(13f)
                horizontalLineTo(7f)
                verticalLineTo(15f)
                horizontalLineTo(9f)
                verticalLineTo(9f)
                horizontalLineTo(7f)
                close()
                moveTo(21f, 13f)
                verticalLineTo(11f)
                horizontalLineTo(11f)
                verticalLineTo(13f)
                horizontalLineTo(21f)
                close()
                moveTo(15f, 9f)
                horizontalLineTo(17f)
                verticalLineTo(7f)
                horizontalLineTo(21f)
                verticalLineTo(5f)
                horizontalLineTo(17f)
                verticalLineTo(3f)
                horizontalLineTo(15f)
                verticalLineTo(9f)
                close()
            }
        }
    }

    /** arrow_upward：发送键 */
    val ArrowUp: ImageVector by lazy {
        materialIcon("Filled.ArrowUp") {
            materialPath {
                moveTo(4f, 12f)
                lineTo(5.41f, 13.41f)
                lineTo(11f, 7.83f)
                lineTo(11f, 20f)
                lineTo(13f, 20f)
                lineTo(13f, 7.83f)
                lineTo(18.59f, 13.41f)
                lineTo(20f, 12f)
                lineTo(12f, 4f)
                close()
            }
        }
    }

    /** 子代理：两个拼合方块 */
    val SubAgent: ImageVector by lazy {
        materialIcon("Filled.SubAgent") {
            materialPath {
                moveTo(4f, 4f)
                horizontalLineTo(11f)
                verticalLineTo(11f)
                horizontalLineTo(4f)
                close()
                moveTo(13f, 13f)
                horizontalLineTo(20f)
                verticalLineTo(20f)
                horizontalLineTo(13f)
                close()
                moveTo(15f, 4f)
                lineTo(20f, 9f)
                lineTo(15f, 9f)
                close()
            }
        }
    }

    /** codex 标识：path 数据沿用 web/src/components/AgentIcon.tsx
     *（同文件注记 vendored 自 lobehub openai.svg），viewBox -1.5 -1.5 27 27。 */
    val Codex: ImageVector by lazy {
        ImageVector.Builder(
            name = "AgentCodex",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
                pathData = addPathNodes("M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"),
                pathFillType = PathFillType.EvenOdd,
                fill = SolidColor(Color.Black),
        ).build()
    }

    /** devin 标识：path 数据沿用 AgentIcon.tsx（vendored 自 devin.ai favicon）。 */
    val Devin: ImageVector by lazy {
        ImageVector.Builder(
            name = "AgentDevin",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 425f,
            viewportHeight = 425f,
        ).addPath(
            pathData = addPathNodes("M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z"),
            fill = SolidColor(Color.Black),
        ).build()
    }

    /** 未知引擎通用 Bot：与 AgentIcon.tsx default 分支同一组图形。 */
    val Bot: ImageVector by lazy {
        ImageVector.Builder(
            name = "AgentBot",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).addPath(
            pathData = addPathNodes(
                "M8 6h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4z"
            ),
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ).addPath(
            pathData = addPathNodes("M12 3v3M8 11v2m8-2v2m-7 3h6"),
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ).build()
    }
}

/** claude-code 标识：24 画幅内 12 条绕中心每 30° 的圆头短线。 */
@Composable
fun ClaudeIcon(tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val unit = size.minDimension / 24f
        val center = Offset(size.minDimension / 2f, size.minDimension / 2f)
        for (index in 0 until 12) {
            val angle = Math.toRadians((index * 30).toDouble())
            val dx = sin(angle).toFloat()
            val dy = (-cos(angle)).toFloat()
            drawLine(
                color = tint,
                start = Offset(center.x + dx * 9.5f * unit, center.y + dy * 9.5f * unit),
                end = Offset(center.x + dx * 3.5f * unit, center.y + dy * 3.5f * unit),
                strokeWidth = 2.2f * unit,
                cap = StrokeCap.Round,
            )
        }
    }
}
