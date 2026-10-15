package site.sorghum.loopra.bin.agent.context;

import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.tool.interact.FinishTool;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * 会话上下文 —— 在内存中管理消息历史。
 * <p>
 * 消息按角色累积：
 * <ul>
 *   <li>{@code user} — 用户输入</li>
 *   <li>{@code assistant} — 模型回复（可能含 tool_calls、reasoning_content）</li>
 *   <li>{@code tool} — 工具执行结果</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class ConversationContext {
    private static final List<String> NO_TO_JSONL = List.of(
            FinishTool.TIPS
    );

    private final List<ChatMessage> history = new ArrayList<>();
    private final PromptPrefix prefix;
    /**
     * 持久化存储（可选）
      * -- 设置器 --
     *  绑定会话存储，所有后续消息将通过此存储持久化。
     *  传入 null 可解除绑定（停止持久化）。
     *
     */
    @Setter
    @Getter
    private SessionStore sessionStore = null;

    public ConversationContext(PromptPrefix prefix) {
        this.prefix = Objects.requireNonNull(prefix, "prefix must not be null");
    }

    /**
     * 添加用户消息（支持纯文本和多模态）。
     *
     * @param msg 用户消息对象（纯文本或文本+图片）
     */
    public void addUser(UserMessage msg) {
        ChatMessage chatMsg;
        if (msg != null && msg.hasImages()) {
            chatMsg = ChatMessage.ofUser(msg.getText(), msg.getImages());
        } else {
            String text = msg != null ? msg.getText() : null;
            chatMsg = ChatMessage.ofUser(text);
        }
        // 传递快照检查点 ID 到 ChatMessage，以便 JSONL 持久化
        if (msg != null && msg.getSnapshotId() != null) {
            chatMsg.setSnapshotId(msg.getSnapshotId());
        }
        if (msg != null && msg.getRollbackId() != null) {
            chatMsg.setRollbackId(msg.getRollbackId());
        }
        if (msg != null) {
            chatMsg.setWebHidden(msg.isWebHidden());
        }
        history.add(chatMsg);
        persist(chatMsg);
    }

    /**
     * 添加纯文本用户消息（便捷方法，内部调用 {@link #addUser(UserMessage)}）。
     */
    public void addUser(String content) {
        addUser(UserMessage.of(content));
    }

    /**
     * 添加系统消息到上下文（用于系统通知、目标恢复提醒等）。
     * 消息角色为 "system"，将被包含在历史中发送给模型。
     *
     * @param content 系统消息内容
     * @deprecated 历史中的 system 消息会被 Anthropic/Responses 协议提升回顶层
     *             {@code system} 字段，与 system prompt 合并后再次破坏前缀缓存，
     *             且消息时序被打乱。请改用 {@link #addSystemNotice(String)}。
     */
    @Deprecated(since = "26.9.91", forRemoval = true)
    public void addSystemMessage(String content) {
        ChatMessage msg = ChatMessage.ofSystem(content);
        history.add(msg);
        persist(msg);
    }

    /**
     * 追加一条「系统状态通知」—— 模型可见、Web 历史隐藏、落 JSONL。
     * <p>
     * 实现为 {@code role=user + webHidden=true}，而不是 {@code role=system}：
     * 历史中的 system 消息在 Anthropic/Responses 协议下会被提升回顶层
     * {@code system} 字段，等于把易变状态又塞回 system prompt，前缀缓存照样失效；
     * webHidden 则是既有通道 —— 模型照常读到，Web 聊天界面不渲染气泡，
     * JSONL 与原始记录仍可审计。
     * </p>
     *
     * @param content 通知正文（应自带 system-reminder 信封与卫生尾巴）
     * @return 已追加的消息，调用方可据此读取指纹或就地更新
     */
    public ChatMessage addSystemNotice(String content) {
        UserMessage notice = UserMessage.of(content);
        notice.setWebHidden(true);
        addUser(notice);
        return history.get(history.size() - 1);
    }

    /**
     * 声明式 system 前缀 —— 子代理自拼 system 时由宿主提供，主循环返回空串。
     * <p>
     * 供 {@code LoopraPromptPlugin} 识别「已有外部 system」的来源，取代按提示词
     * 内容嗅探（内容一改就失效）。
     * </p>
     */
    public String prefixSystem() {
        String system = prefix.system;
        return system == null ? "" : system;
    }

    /**
     * 添加 assistant 消息到上下文。
     * <p>
     * 防御性逻辑（四分支）：
     * <ol>
     *   <li>三者皆空（content/toolCalls/reasoning 都无）→ content 设为 "" 避免空消息</li>
     *   <li>仅有 reasoning（无 content 无 toolCalls）→ content 保持 null，
     *       让 {@code toMap()} 不输出 content 字段，避免 {@code "content":""} 导致 API 400</li>
     *   <li>有 content 或 toolCalls → 正常传递</li>
     * </ol>
     * </p>
     *
     * @param content         文本内容（可为 null）
     * @param toolCalls       工具调用列表（可为 null）
     * @param reasoningContent 推理内容（可为 null）
     */
    public void addAssistant(String content, List<ToolCallEntry> toolCalls, String reasoningContent) {
        addAssistant(content, toolCalls, reasoningContent, List.of());
    }

    public void addAssistant(String content, List<ToolCallEntry> toolCalls, String reasoningContent,
                             List<FileChange> fileChanges) {
        addAssistant(content, toolCalls, reasoningContent, null, fileChanges);
    }

    public void addAssistant(String content, List<ToolCallEntry> toolCalls, String reasoningContent,
                             List<String> thinkingBlocks, List<FileChange> fileChanges) {
        // 防御：assistant 消息必须至少包含 content、tool_calls 或 reasoning_content 之一
        boolean hasContent = content != null && !content.isEmpty();
        boolean hasToolCalls = toolCalls != null && !toolCalls.isEmpty();
        boolean hasReasoning = reasoningContent != null && !reasoningContent.isEmpty();
        if (!hasContent && !hasToolCalls && !hasReasoning) {
            content = "";
        } else if (!hasContent && !hasToolCalls && hasReasoning) {
            // 只有 reasoning_content 没有 content/tool_calls → 保持 content 为 null，
            // 让 toMap() 不输出 content 字段，避免 "content":"" 导致 API 400
            content = null;
        }
        ChatMessage msg = ChatMessage.assistant(content, toolCalls, reasoningContent);
        if (thinkingBlocks != null && !thinkingBlocks.isEmpty()) {
            msg.setThinkingBlocks(new ArrayList<>(thinkingBlocks));
        }
        if (fileChanges != null && !fileChanges.isEmpty()) {
            msg.setFileChanges(new ArrayList<>(fileChanges));
        }
        history.add(msg);
        persist(msg);
    }

    public void setLatestAssistantFileChanges(List<FileChange> fileChanges) {
        if (fileChanges == null || fileChanges.isEmpty()) return;
        for (int i = history.size() - 1; i >= 0; i--) {
            ChatMessage message = history.get(i);
            if (message.isAssistant()) {
                message.setFileChanges(new ArrayList<>(fileChanges));
                rewriteStore();
                return;
            }
        }
    }

    public void addToolResult(String toolCallId, String result) {
        addToolResult(ChatMessage.tool(toolCallId, result));
    }

    public void addToolResult(ChatMessage msg) {
        history.add(msg);
        persist(msg);
    }

    /**
     * 将消息追加写入 JSONL 文件。
     * 如果 sessionStore 未设置或写入失败，静默忽略。
     */
    private void persist(ChatMessage msg) {
        if (msg.hasContent() && NO_TO_JSONL.contains(msg.getContent())){
            return;
        }
        // 空消息不持久化
        if (msg.isAssistant() && !msg.hasContent() && !msg.hasToolCalls() && !msg.hasReasoningContent() && !msg.hasToolCallId()){
            return;
        }
        if (sessionStore != null) {
            try {
                sessionStore.append(msg);
            } catch (IOException e) {
                log.error("[session] jsonl 写入失败: {}", e.getMessage());
            }
        }
    }

    // ---- 读取 ----

    /**
     * 构建发给 API 的消息列表 = prefix（system msg） + history。
     * prefix 始终保持不变 → DeepSeek 前缀缓存命中。
     */
    public List<ChatMessage> buildMessages() {
        List<ChatMessage> prefixMsgs = prefix.toMessages();
        List<ChatMessage> msgs = new ArrayList<>(prefixMsgs.size() + history.size());
        msgs.addAll(prefixMsgs);
        msgs.addAll(history);
        return msgs;
    }

    /**
     * 加载历史会话时注入消息到上下文，不触发持久化。
     * 用于 /load 命令从 JSONL 文件恢复会话。
     */
    public void injectHistory(ChatMessage msg) {
        history.add(msg);
    }

    public int size() {
        return history.size();
    }

    /**
     * 清除所有历史消息（新建会话时用）。
     * 同时触发持久化回写。
     */
    public void clear() {
        history.clear();
        rewriteStore();
    }

    /**
     * 仅清除内存中的历史消息，不触发持久化回写。
     * 用于创建新会话时清空上下文，但保留旧会话内容。
     */
    public void clearHistory() {
        history.clear();
    }

    /**
     * 从末尾反向查找第 N 条用户消息（0=最后一条），移除该消息及其后所有消息。
     * 同时同步持久化。
     */
    private String removeFromNthUserFromEnd(int nFromEnd) {
        int count = 0;
        for (int i = history.size() - 1; i >= 0; i--) {
            if (history.get(i).isUser()) {
                if (count == nFromEnd) {
                    String text = history.get(i).getContent();
                    history.subList(i, history.size()).clear();
                    rewriteStore();
                    return text;
                }
                count++;
            }
        }
        return null;
    }

    /**
     * 撤回最后一条用户消息及其后的所有消息，返回被撤回的用户消息内容。
     * 用于 /retry 命令。同时同步持久化。
     */
    public String retryLastUser() {
        return removeFromNthUserFromEnd(0);
    }

    /**
     * 回退到第 N 条用户消息（从前往后数，0-based），移除之后的所有消息。
     * 用于 /rewind N 命令。同时同步持久化。
     */
    public String rewindToUser(int userIndex) {
        int count = 0;
        for (int i = 0; i < history.size(); i++) {
            if (history.get(i).isUser()) {
                if (count == userIndex) {
                    String text = history.get(i).getContent();
                    history.subList(i, history.size()).clear();
                    rewriteStore();
                    return text;
                }
                count++;
            }
        }
        return null;
    }

    /**
     * 将当前历史持久化回写到 session store。
     * <p>供宿主就地修改历史消息（如更新状态通知正文）后同步落盘。</p>
     */
    public void rewriteSession() {
        rewriteStore();
    }

    /**
     * 将当前历史持久化回写到 session store
     */
    private void rewriteStore() {
        if (sessionStore != null) {
            try {
                sessionStore.rewrite(history);
            } catch (IOException e) {
                log.error("[session] rewrite 失败: {}", e.getMessage());
            }
        }
    }

    /**
     * 折叠历史：用折叠后的消息列表替换当前历史。
     * 由 AgentLoop 的预检调用，将旧消息替换为摘要。
     */
    public void compact(List<ChatMessage> foldedMessages) {
        history.clear();
        history.addAll(foldedMessages);
        // 持久化回写
        rewriteStore();
    }

    /**
     * 截断历史：保留前 keepBefore 条消息，删除之后的所有消息，并持久化回写。
     *
     * @param keepBefore 保留的消息条数（0 表示清空所有）
     */
    public void truncate(int keepBefore) {
        if (keepBefore < 0) keepBefore = 0;
        if (keepBefore >= history.size()) return; // 无需截断
        history.subList(keepBefore, history.size()).clear();
        rewriteStore();
    }

    /**
     * 获取完整历史消息列表的副本（用于调试）。
     */
    public List<ChatMessage> getHistory() {
        return new ArrayList<>(history);
    }

    /**
     * 获取最后一条 assistant 消息的 content（用于用户中断时返回已生成内容）。
     *
     * @return 最后一条 assistant 消息的 content，如果没有则返回 null
     */
    public String getLastAssistantContent() {
        for (int i = history.size() - 1; i >= 0; i--) {
            ChatMessage msg = history.get(i);
            if (msg.isAssistant()) {
                String content = msg.getContent();
                if (content != null && !content.isEmpty()) {
                    return content;
                }
            }
        }
        return null;
    }
}
