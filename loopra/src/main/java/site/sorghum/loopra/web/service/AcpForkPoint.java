package site.sorghum.loopra.web.service;

import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Resolves a displayed reply's stored prefix to the adapters' historical fork extension. */
record AcpForkPoint(List<ChatMessage> history, Map<String, Object> meta) {
    static AcpForkPoint at(List<ChatMessage> source, int messageCount) {
        List<ChatMessage> prefix = AgentService.copyBranchMessages(source, messageCount);
        if (messageCount < source.size() && !"user".equals(source.get(messageCount).getRole())) {
            throw new ServiceException("请选择一条完整回复作为分叉位置");
        }
        int index = prefix.size() - 1;
        for (; index >= 0; index--) {
            ChatMessage message = prefix.get(index);
            if ("user".equals(message.getRole()) || "tool".equals(message.getRole())
                    || message.getToolCalls() != null && !message.getToolCalls().isEmpty()) {
                throw new ServiceException("该回复缺少可定位的最终消息，请选择其他回复");
            }
            if ("assistant".equals(message.getRole()) && message.getContent() != null && !message.getContent().isBlank()) break;
        }
        if (index < 0) throw new ServiceException("该回复缺少可定位的最终消息，请选择其他回复");
        ChatMessage selected = prefix.get(index);
        String text = selected.getContent();
        int occurrence = 0;
        for (int i = 0; i <= index; i++) {
            ChatMessage message = prefix.get(i);
            if ("assistant".equals(message.getRole()) && text.equals(message.getContent())) occurrence++;
        }
        String messageId = selected.getAcpMessageId();
        if (messageId == null || messageId.isBlank()) messageId = "loopra-history-" + (index + 1);
        // Both installed adapters resolve this extension and fail when the point is absent.
        Map<String, Object> point = Map.of("version", 1, "messageId", messageId,
                "messageFingerprint", fingerprint(text), "messageOccurrence", occurrence);
        return new AcpForkPoint(prefix, Map.of("jetbrains", Map.of("air", Map.of("fork", point))));
    }

    private static String fingerprint(String text) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
