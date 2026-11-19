package app.loopra.android.chat

import app.loopra.android.data.PermissionOption

enum class Role { USER, ASSISTANT }

enum class BlockType { CONTENT, REASONING, REASONING_STARTED, TOOL_CALL, CHOICE, SUB_AGENT, FILE_CHANGES, NOTICE }

enum class ToolStatus { RUNNING, SUCCESS, FAILED }

data class FileChange(
    val path: String,
    val additions: Int = 0,
    val deletions: Int = 0,
    val created: Boolean = false,
)

/**
 * 与桌面端 ChatBlock 对齐的不可变块模型。语义状态用枚举表示，文案由 UI 决定。
 */
data class ChatBlock(
    val id: String,
    val type: BlockType,
    val content: String = "",
    val toolCallId: String? = null,
    val name: String? = null,
    val status: ToolStatus? = null,
    val args: String? = null,
    val result: String? = null,
    val duration: String? = null,
    val question: String? = null,
    val description: String? = null,
    val options: List<PermissionOption> = emptyList(),
    val selected: String? = null,
    val permissionRequestId: String? = null,
    val subId: String? = null,
    val blocks: List<ChatBlock> = emptyList(),
    val changes: List<FileChange> = emptyList(),
)

data class ChatMessage(
    val id: String,
    val role: Role,
    val text: String = "",
    val blocks: List<ChatBlock> = emptyList(),
    val time: String = "",
)

const val USER_STOPPED_REPLY = "{{用户主动打断}}"

val TOOL_RUNNING_LABEL = "执行中"
