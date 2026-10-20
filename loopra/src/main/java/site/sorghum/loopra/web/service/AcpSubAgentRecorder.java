package site.sorghum.loopra.web.service;

import site.sorghum.loopra.bin.session.SubAgentSessionStore;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 把外部 ACP Agent 的子代理事件，按子会话落盘到 {@link SubAgentSessionStore}，
 * 供右侧「子代理」面板回放。
 * <p>
 * 文本增量（{@code sub_content} / {@code sub_reasoning}）按段聚合后再写，
 * 避免每个 token 打开一次文件；工具调用、结束等事件先刷出未落盘的文本，保持事件顺序。
 * </p>
 */
final class AcpSubAgentRecorder {

    private final SubAgentSessionStore store;
    private final String parentSessionName;
    /** subSessionId → 尚未落盘的文本 */
    private final Map<String, StringBuilder> buffers = new HashMap<>();
    /** subSessionId → 当前缓冲区的事件类型 */
    private final Map<String, String> bufferTypes = new HashMap<>();
    /** subSessionId → 事件公共字段（subId / subSessionId），用于补全聚合后的事件 */
    private final Map<String, Map<String, Object>> stamps = new HashMap<>();
    private boolean idle;

    AcpSubAgentRecorder(SubAgentSessionStore store, String parentSessionName) {
        this.store = store;
        this.parentSessionName = parentSessionName;
    }

    /** {@link AcpWorkbenchClient#setSubAgentListener} 的写入端。 */
    synchronized void record(String type, Map<String, Object> event) {
        if (!(event.get("subSessionId") instanceof String subSessionId)) return;
        Map<String, Object> stamp = new LinkedHashMap<>();
        stamp.put("subId", event.get("subId"));
        stamp.put("subSessionId", subSessionId);
        stamps.put(subSessionId, stamp);

        if ("sub_content".equals(type) || "sub_reasoning".equals(type)) {
            Object token = event.get("token");
            if (!(token instanceof String text) || text.isEmpty()) return;
            String current = bufferTypes.get(subSessionId);
            if (current != null && !current.equals(type)) flush(subSessionId);
            bufferTypes.put(subSessionId, type);
            buffers.computeIfAbsent(subSessionId, ignored -> new StringBuilder()).append(text);
            // The root SSE turn may be over while a native child keeps producing text.
            if (idle) flush(subSessionId);
            return;
        }

        // 任何非文本事件都先落盘此前的文本段，保证回放顺序与实时事件一致。
        flush(subSessionId);
        if ("sub_start".equals(type)) {
            // session/load 会重放历史更新；子代理以开始事件为界重写，避免回放叠加成重复记录。
            store.delete(parentSessionName, subSessionId);
        }
        store.record(parentSessionName, subSessionId, type, event);
    }

    /**
     * 一轮结束时刷出所有未落盘的文本段。
     * 未收到 sub_end 的运行保留 running 状态（进程异常中断时用户仍能看到已有输出）。
     */
    synchronized void finish() {
        idle = true;
        for (String subSessionId : new java.util.ArrayList<>(buffers.keySet())) flush(subSessionId);
    }

    /** 刷出某个子会话尚未落盘的文本段（没有文本时无操作）。 */
    private void flush(String subSessionId) {
        String type = bufferTypes.remove(subSessionId);
        StringBuilder buffer = buffers.remove(subSessionId);
        if (type == null || buffer == null || buffer.isEmpty()) return;
        Map<String, Object> payload = new LinkedHashMap<>(stamps.getOrDefault(subSessionId, Map.of()));
        payload.put("token", buffer.toString());
        store.record(parentSessionName, subSessionId, type, payload);
    }
}
