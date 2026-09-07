package site.sorghum.loopra.bin.agent.model;

import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.snack4.annotation.ONodeAttr;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 聊天消息 —— 替代 Map&lt;String, Object&gt; 表示消息的强类型封装。
 * <p>
 * 统一表示 OpenAI 兼容 API 的四种消息角色：system / user / assistant / tool。
 * </p>
 * <p>
 * {@link #content} 支持两种模式：
 * <ul>
 *   <li>纯文本模式 —— {@code content} 为普通字符串</li>
 *   <li>多模态模式 —— {@link #contentParts} 非空时，{@code content} 被忽略，
 *       序列化为 JSON 数组 {@code [{"type":"text",...},{"type":"image_url",...}]}</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Data
public class ChatMessage {

    private final String role;

    @ONodeAttr(name = "content")
    private String content;

    /**
     * 多模态内容段（图片 + 文本）。
     * 非空时优先于 {@link #content} 序列化。
     */
    private List<ContentPart> contentParts;

    @ONodeAttr(name = "tool_calls")
    private List<ToolCallEntry> toolCalls;

    @ONodeAttr(name = "tool_call_id")
    private String toolCallId;

    /**
     * 工具返回的视觉输入，仅由 read_image 或 browser_screenshot 产生。
     * 在不同模型 API 协议中会转换为对应的图片型工具结果。
     */
    @ONodeAttr(name = "tool_image_url")
    private String toolImageUrl;

    @ONodeAttr(name = "tool_image_detail")
    private String toolImageDetail;

    @ONodeAttr(name = "reasoning_content")
    private String reasoningContent;

    /**
     * 原始 thinking / redacted_thinking 内容块 JSON（Anthropic 协议专用）。
     * 元素为服务端返回的块原文（含 signature），多轮对话时需原样回传，不能拼接或伪造。
     * 例如 {"type":"thinking","thinking":"...","signature":"..."}。
     */
    @ONodeAttr(name = "thinking_blocks")
    private List<String> thinkingBlocks;

    /**
     * Responses API 本轮推理 item 的原始 JSON。
     * 该 item 属于 assistant response，而不是单个工具调用。
     */
    @ONodeAttr(name = "response_reasoning")
    private String responseReasoning;

     /** 与该助手工具调用消息关联的实际写入/编辑变更。 */
    @ONodeAttr(name = "file_changes")
    private List<FileChange> fileChanges;

    /**
     * 快照检查点 ID（仅 user 消息有效）。
     * 非空时表示该消息发送前项目已保存快照，可用于撤回 AI 修改。
     */
    @ONodeAttr(name = "snapshot_id")
    private String snapshotId;

    /**
     * 消息撤回定位 ID（仅 user 消息有效）。没有项目快照时，仍可据此撤回会话消息。
     */
    @ONodeAttr(name = "rollback_id")
    private String rollbackId;

    /** 内部用户消息：保留在模型上下文中，但 Web 历史渲染时隐藏。 */
    @ONodeAttr(name = "web_hidden")
    private boolean webHidden;

    /**
     * 消息时间戳（Unix 毫秒），用于前端渲染消息时间。
     */
    @ONodeAttr(name = "timestamp")
    private Long timestamp;

    /**
     * 助手回合开始时间（Unix 毫秒）。与消息 timestamp 区分：
     * timestamp 是单条消息产生时间，turnStartedAt 用于恢复整轮耗时。
     */
    @ONodeAttr(name = "turn_started_at")
    private Long turnStartedAt;

    /** 助手回合结束时间（Unix 毫秒）。 */
    @ONodeAttr(name = "turn_finished_at")
    private Long turnFinishedAt;

    /** 助手回合实际耗时（毫秒）。 */
    @ONodeAttr(name = "elapsed_ms")
    private Long elapsedMs;

    /**
     * 工具实际开始执行的时间（Unix 毫秒），仅由本地执行记录使用。
     */
    @ONodeAttr(name = "tool_started_at")
    private Long toolStartedAt;

    /** 工具实际执行结束的时间（Unix 毫秒）。 */
    @ONodeAttr(name = "tool_finished_at")
    private Long toolFinishedAt;

    /** 工具实际执行耗时（毫秒）。 */
    @ONodeAttr(name = "tool_duration_ms")
    private Long toolDurationMs;

    // ==================== 内容段模型 ====================

    public static ChatMessage ofUser(String content) {
        ChatMessage msg = new ChatMessage("user");
        msg.content = content;
        msg.timestamp = System.currentTimeMillis();
        return msg;
    }

    // ==================== 工厂方法 ====================

    public static ChatMessage ofSystem(String content) {
        ChatMessage msg = new ChatMessage("system");
        msg.content = content;
        return msg;
    }

    /**
     * 创建多模态用户消息（文本 + 图片）。
     *
     * @param text   文本内容
     * @param images 图片 URL 列表（公开 URL 或 Base64 Data URI）
     * @return 用户消息
     */
    public static ChatMessage ofUser(String text, List<String> images) {
        ChatMessage msg = new ChatMessage("user");
        msg.contentParts = new ArrayList<>();
        for (String img : images) {
            msg.contentParts.add(ContentPart.imageUrl(img));
        }
        if (text != null && !text.isEmpty()) {
            msg.contentParts.add(ContentPart.text(text));
        }
        msg.timestamp = System.currentTimeMillis();
        return msg;
    }

    public static ChatMessage fromMap(Map<String, Object> m) {
        String role = String.valueOf(m.getOrDefault("role", "user"));
        ChatMessage msg = new ChatMessage(role);
        Object content = m.get("content");
        if (content instanceof List) {
            // 多模态内容段：[{"type":"text",...},{"type":"image_url",...}]
            //noinspection unchecked
            List<Map<String, Object>> parts = (List<Map<String, Object>>) content;
            msg.contentParts = new ArrayList<>();
            for (Map<String, Object> part : parts) {
                String type = String.valueOf(part.get("type"));
                ContentPart cp = new ContentPart();
                cp.setType(type);
                if ("text".equals(type)) {
                    Object textVal = part.get("text");
                    cp.setText(textVal != null ? textVal.toString() : null);
                } else if ("image_url".equals(type)) {
                    //noinspection unchecked
                    Map<String, Object> iuMap = (Map<String, Object>) part.get("image_url");
                    if (iuMap != null) {
                        ContentPart.ImageUrl iu = new ContentPart.ImageUrl();
                        Object urlVal = iuMap.get("url");
                        iu.setUrl(urlVal != null ? urlVal.toString() : null);
                        Object detailVal = iuMap.get("detail");
                        iu.setDetail(detailVal != null ? detailVal.toString() : null);
                        cp.setImageUrl(iu);
                    }
                }
                msg.contentParts.add(cp);
            }
        } else {
            msg.content = content != null ? content.toString() : null;
        }
        Object reasoning = m.get("reasoning_content");
        msg.reasoningContent = reasoning != null ? reasoning.toString() : null;
        Object thinkingBlocks = m.get("thinking_blocks");
        if (thinkingBlocks instanceof List<?> blockList && !blockList.isEmpty()) {
            msg.thinkingBlocks = new ArrayList<>();
            for (Object block : blockList) {
                if (block instanceof String text) {
                    msg.thinkingBlocks.add(text);
                } else if (block != null) {
                    // 反序列化得到的是 Map，需转回 JSON 字符串
                    msg.thinkingBlocks.add(ONode.serialize(block));
                }
            }
        }
        Object responseReasoning = m.get("response_reasoning");
        msg.responseReasoning = responseReasoning != null ? responseReasoning.toString() : null;
        Object fileChanges = m.get("file_changes");
        if (fileChanges instanceof List<?> changeMaps) {
            msg.fileChanges = new ArrayList<>();
            for (Object item : changeMaps) {
                if (!(item instanceof Map<?, ?> change)) continue;
                Object path = change.get("path");
                if (path == null) continue;
                Object diff = change.get("diff");
                msg.fileChanges.add(new FileChange(path.toString(),
                        asInt(change.get("additions")), asInt(change.get("deletions")),
                        Boolean.parseBoolean(String.valueOf(change.get("created"))),
                        diff == null ? "" : diff.toString()));
            }
        }
        Object toolCallId = m.get("tool_call_id");
        msg.toolCallId = toolCallId != null ? toolCallId.toString() : null;
        Object toolImageUrl = m.get("tool_image_url");
        msg.toolImageUrl = toolImageUrl != null ? toolImageUrl.toString() : null;
        Object toolImageDetail = m.get("tool_image_detail");
        msg.toolImageDetail = toolImageDetail != null ? toolImageDetail.toString() : null;
        Object snapshotId = m.get("snapshot_id");
        msg.snapshotId = snapshotId != null ? snapshotId.toString() : null;
        Object rollbackId = m.get("rollback_id");
        msg.rollbackId = rollbackId != null ? rollbackId.toString() : null;
        Object webHidden = m.get("web_hidden");
        msg.webHidden = Boolean.parseBoolean(String.valueOf(webHidden));
        Object timestamp = m.get("timestamp");
        if (timestamp instanceof Number) {
            msg.timestamp = ((Number) timestamp).longValue();
        } else if (timestamp != null) {
            try {
                msg.timestamp = Long.parseLong(timestamp.toString());
            } catch (NumberFormatException e) {
                // 忽略无效的时间戳
            }
        }
        msg.toolStartedAt = asLong(m.get("tool_started_at"));
        msg.toolFinishedAt = asLong(m.get("tool_finished_at"));
        msg.toolDurationMs = asLong(m.get("tool_duration_ms"));
        msg.turnStartedAt = asLong(m.get("turn_started_at"));
        if (msg.turnStartedAt == null) msg.turnStartedAt = asLong(m.get("turnStartedAt"));
        msg.turnFinishedAt = asLong(m.get("turn_finished_at"));
        if (msg.turnFinishedAt == null) msg.turnFinishedAt = asLong(m.get("turnFinishedAt"));
        msg.elapsedMs = asLong(m.get("elapsed_ms"));
        if (msg.elapsedMs == null) msg.elapsedMs = asLong(m.get("elapsedMs"));
        if (m.containsKey("tool_calls")) {
            List<Map<String, Object>> tcMaps = (List<Map<String, Object>>) m.get("tool_calls");
            if (tcMaps != null) {
                msg.toolCalls = new ArrayList<>();
                for (Map<String, Object> tc : tcMaps) {
                    String tcId = String.valueOf(tc.getOrDefault("id", "unknown"));
                    String tcName;
                    Object tcArgsObj;
                    Object legacyResponseReasoning = tc.get("response_reasoning");
                    Object funcObj = tc.get("function");
                    if (funcObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> func = (Map<String, Object>) funcObj;
                        tcName = String.valueOf(func.getOrDefault("name", "unknown"));
                        tcArgsObj = func.get("arguments");
                    } else {
                        tcName = String.valueOf(tc.getOrDefault("name", "unknown"));
                        tcArgsObj = tc.get("arguments");
                    }
                    if (tcArgsObj == null) tcArgsObj = "{}";
                    if (tcArgsObj instanceof String tcArgsStr) {
                        try {
                            tcArgsObj = ONode.ofJson(tcArgsStr).toBean();
                        } catch (Exception e) {
                            log.debug("工具调用参数 JSON 解析失败，保留原始字符串: {}", e.getMessage());
                        }
                    }
                    if (msg.responseReasoning == null && legacyResponseReasoning != null) {
                        msg.responseReasoning = legacyResponseReasoning.toString();
                    }
                    msg.toolCalls.add(new ToolCallEntry(tcId, tcName, tcArgsObj));
                }
            }
        }
        return msg;
    }

    public static ChatMessage assistant(String content, List<ToolCallEntry> toolCalls, String reasoningContent) {
        ChatMessage msg = new ChatMessage("assistant");
        msg.content = content;
        msg.reasoningContent = reasoningContent;
        msg.setToolCallsWithLegacyReasoning(toolCalls);
        msg.timestamp = System.currentTimeMillis();
        return msg;
    }

    private void setToolCallsWithLegacyReasoning(List<ToolCallEntry> entries) {
        if (entries == null) return;
        toolCalls = new ArrayList<>(entries.size());
        for (ToolCallEntry entry : entries) {
            if (responseReasoning == null && entry.responseReasoning() != null) {
                responseReasoning = entry.responseReasoning();
            }
            toolCalls.add(new ToolCallEntry(entry.id(), entry.name(), entry.arguments()));
        }
    }

    private static Long asLong(Object value) {
        if (value instanceof Number number) return number.longValue();
        try {
            return value == null ? null : Long.parseLong(value.toString());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static int asInt(Object value) {
        if (value instanceof Number number) return number.intValue();
        try {
            return value == null ? 0 : Integer.parseInt(value.toString());
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    public static ChatMessage tool(String toolCallId, String content) {
        ChatMessage msg = new ChatMessage("tool");
        msg.toolCallId = toolCallId;
        msg.content = content != null ? content : "(empty)";
        msg.timestamp = System.currentTimeMillis();
        return msg;
    }

    /** 创建带工具执行计时信息的工具结果消息。 */
    public static ChatMessage tool(String toolCallId, String content, long startedAt, long finishedAt) {
        ChatMessage msg = tool(toolCallId, content);
        msg.setToolTiming(startedAt, finishedAt);
        return msg;
    }

    public void setToolTiming(long startedAt, long finishedAt) {
        this.toolStartedAt = startedAt;
        this.toolFinishedAt = finishedAt;
        this.toolDurationMs = Math.max(0L, finishedAt - startedAt);
    }

    public static ChatMessage toolWithImage(String toolCallId, String content, String imageUrl, String imageDetail) {
        ChatMessage msg = tool(toolCallId, content);
        msg.toolImageUrl = imageUrl;
        msg.toolImageDetail = imageDetail;
        return msg;
    }

    // ==================== 便捷判断 ====================

    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("role", role);
        if (contentParts != null && !contentParts.isEmpty()) {
            List<Map<String, Object>> partsList = new ArrayList<>();
            for (ContentPart part : contentParts) {
                Map<String, Object> partMap = new LinkedHashMap<>();
                partMap.put("type", part.getType());
                if ("text".equals(part.getType())) {
                    partMap.put("text", part.getText());
                } else if ("image_url".equals(part.getType())) {
                    Map<String, Object> urlMap = new LinkedHashMap<>();
                    ContentPart.ImageUrl iu = part.getImageUrl();
                    if (iu != null) {
                        urlMap.put("url", iu.getUrl());
                        if (iu.getDetail() != null) urlMap.put("detail", iu.getDetail());
                    }
                    partMap.put("image_url", urlMap);
                }
                partsList.add(partMap);
            }
            m.put("content", partsList);
        } else if (content != null) {
            m.put("content", content);
        }
        if (toolCallId != null) m.put("tool_call_id", toolCallId);
        if (toolImageUrl != null) m.put("tool_image_url", toolImageUrl);
        if (toolImageDetail != null) m.put("tool_image_detail", toolImageDetail);
        if (reasoningContent != null) m.put("reasoning_content", reasoningContent);
        if (thinkingBlocks != null && !thinkingBlocks.isEmpty()) m.put("thinking_blocks", thinkingBlocks);
        if (responseReasoning != null) m.put("response_reasoning", responseReasoning);
        if (fileChanges != null && !fileChanges.isEmpty()) m.put("file_changes", fileChanges);
        if (snapshotId != null) m.put("snapshot_id", snapshotId);
        if (rollbackId != null) m.put("rollback_id", rollbackId);
        if (webHidden) m.put("web_hidden", true);
        if (timestamp != null) m.put("timestamp", timestamp);
        if (turnStartedAt != null) m.put("turn_started_at", turnStartedAt);
        if (turnFinishedAt != null) m.put("turn_finished_at", turnFinishedAt);
        if (elapsedMs != null) m.put("elapsed_ms", elapsedMs);
        if (toolCalls != null && !toolCalls.isEmpty()) {
            List<Map<String, Object>> tcMaps = new ArrayList<>();
            for (ToolCallEntry tc : toolCalls) {
                tcMaps.add(tc.toMap());
            }
            m.put("tool_calls", tcMaps);
        }
        return m;
    }

    public boolean isSystem() {
        return "system".equals(role);
    }

    public boolean isUser() {
        return "user".equals(role);
    }

    public boolean isAssistant() {
        return "assistant".equals(role);
    }

    public boolean isTool() {
        return "tool".equals(role);
    }

    public boolean hasContent() {
        return content != null && !content.isEmpty();
    }

    public boolean hasReasoningContent() {
        return reasoningContent != null && !reasoningContent.isEmpty();
    }

    public boolean hasToolCallId() {
        return toolCallId != null && !toolCallId.isEmpty();
    }

    public boolean hasToolImage() {
        return toolImageUrl != null && !toolImageUrl.isBlank();
    }

    public boolean hasToolCalls() {
        return toolCalls != null && !toolCalls.isEmpty();
    }

    /**
     * 创建当前消息的浅拷贝（用于 MessageHealer 的复制后修改）。
     * toolCalls 列表是独立副本，但 ToolCallEntry 本身不可变。
     * snapshotId 也一并复制，避免回滚场景下快照 ID 丢失。
     */
    public ChatMessage copy() {
        ChatMessage copy = new ChatMessage(this.role);
        copy.content = this.content;
        if (this.contentParts != null) {
            copy.contentParts = new ArrayList<>(this.contentParts);
        }
        if (this.toolCalls != null) {
            copy.toolCalls = new ArrayList<>(this.toolCalls);
        }
        copy.toolCallId = this.toolCallId;
        copy.toolImageUrl = this.toolImageUrl;
        copy.toolImageDetail = this.toolImageDetail;
        copy.reasoningContent = this.reasoningContent;
        if (this.thinkingBlocks != null) {
            copy.thinkingBlocks = new ArrayList<>(this.thinkingBlocks);
        }
        copy.responseReasoning = this.responseReasoning;
        if (this.fileChanges != null) {
            copy.fileChanges = new ArrayList<>(this.fileChanges);
        }
        copy.snapshotId = this.snapshotId;
        copy.rollbackId = this.rollbackId;
        copy.timestamp = this.timestamp;
        copy.turnStartedAt = this.turnStartedAt;
        copy.turnFinishedAt = this.turnFinishedAt;
        copy.elapsedMs = this.elapsedMs;
        copy.toolStartedAt = this.toolStartedAt;
        copy.toolFinishedAt = this.toolFinishedAt;
        copy.toolDurationMs = this.toolDurationMs;
        return copy;
    }

    // ==================== 反序列化 ====================

    // ==================== 序列化 ====================

    /**
     * OpenAI 多模态消息中的一个内容段。
     * 支持 text 和 image_url 两种类型。
     */
    @lombok.Data
    public static class ContentPart {
        /**
         * 类型: "text" 或 "image_url"
         */
        private String type;
        /**
         * text 类型时的文本内容
         */
        private String text;
        /**
         * image_url 类型时的图片信息
         */
        @ONodeAttr(name = "image_url")
        private ImageUrl imageUrl;

        public static ContentPart text(String text) {
            ContentPart part = new ContentPart();
            part.setType("text");
            part.setText(text);
            return part;
        }

        public static ContentPart imageUrl(String url) {
            return imageUrl(url, null);
        }

        public static ContentPart imageUrl(String url, String detail) {
            ContentPart part = new ContentPart();
            part.setType("image_url");
            ImageUrl iu = new ImageUrl();
            iu.setUrl(url);
            iu.setDetail(detail);
            part.setImageUrl(iu);
            return part;
        }

        @lombok.Data
        public static class ImageUrl {
            /**
             * 图片 URL，可以是：
             * - 公开的 HTTP/HTTPS 地址
              * - Base64 数据 URI：{@code data:image/jpeg;base64,...}
             */
            private String url;
            /**
             * 图片细节级别："auto" / "low" / "high"（可选）
             */
            private String detail;
        }
    }
}
