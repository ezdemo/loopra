package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.Context;
import site.sorghum.loopra.bin.agent.model.FileChange;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * SSE (Server-Sent Events) 流式输出工具类。
 *
 * @author Sorghum
 */
@Slf4j
public class SseEmitter {

    /** 可打印字符的最小边界（ASCII 控制字符截止于 0x1F） */
    private static final char MIN_PRINTABLE_CHAR = 0x20;

    private final OutputStream out;
    private final AtomicBoolean completed = new AtomicBoolean(false);
    private final CompletableFuture<Void> completionFuture = new CompletableFuture<>();

    /**
     * 从 Solon Context 创建 SSE emitter。
     */
    public SseEmitter(Context ctx) throws IOException {
        ctx.contentType("text/event-stream; charset=utf-8");
        ctx.headerSet("Cache-Control", "no-cache");
        ctx.headerSet("Connection", "keep-alive");
        ctx.headerSet("X-Accel-Buffering", "no");
        this.out = ctx.outputStream();
    }

    static String escapeJson(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < MIN_PRINTABLE_CHAR) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append("\"");
        return sb.toString();
    }

    /**
     * 发送一个 SSE 事件。
     * <p>
     * 当OutputStream已关闭（如页面刷新断开SSE连接）时，会抛出IOException或RuntimeException。
     * 此处捕获所有异常，设置completed标志，后续调用直接返回，让Agent继续执行完成。
     * </p>
     */
    public synchronized void send(String eventType, String data) {
        if (completed.get()) return;
        try {
            String frame = "event: " + eventType + "\n" +
                    "data: " + data + "\n\n";
            out.write(frame.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Exception e) {
            // IOException 或 RuntimeException（如 OutputStream 已关闭时抛出的 IllegalStateException）
            // 设置completed标志，后续调用直接返回，让Agent继续执行完成
            log.warn("[sse] 写入事件失败，SSE 连接已断开: event={}, 原因: {}", eventType, e.toString());
            completed.set(true);
            completionFuture.complete(null);
        }
    }

    public void sendContent(String token) {
        send("content", escapeJson(token));
    }

    public void sendReasoning(String token) {
        send("reasoning", escapeJson(token));
    }

    public void sendReasoningStarted() {
        send("reasoning_started", "{}");
    }

    public void sendToolCall(String name, String args) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("name", name);
        if (args != null && !args.isEmpty()) {
            node.set("args", ONode.ofJson(args));
        }
        send("tool_call", node.toJson());
    }

    public void sendChoice(List<?> options) {
        sendChoice(null, null, options);
    }

    /**
     * 发送 choice 事件（带标题和描述）。
     */
    public void sendChoice(String title, String description, List<?> options) {
        ONode root = ONode.ofJson("{}").asObject();
        if (title != null && !title.isEmpty()) {
            root.set("title", title);
        }
        if (description != null && !description.isEmpty()) {
            root.set("description", description);
        }
        ONode arr = root.getOrNew("options").asArray();
        for (Object opt : options) {
            ONode item = arr.addNew();
            if (opt instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<Object, Object> m = (Map<Object, Object>) opt;
                item.set("value", String.valueOf(m.getOrDefault("value", "")));
                item.set("title", String.valueOf(m.getOrDefault("title", "")));
            } else {
                try {
                    java.lang.reflect.Method vm = opt.getClass().getMethod("value");
                    java.lang.reflect.Method tm = opt.getClass().getMethod("title");
                    item.set("value", String.valueOf(vm.invoke(opt)));
                    item.set("title", String.valueOf(tm.invoke(opt)));
                } catch (Exception e) {
                    item.set("value", "");
                    item.set("title", "");
                }
            }
        }
        send("choice", root.toJson());
    }

    public void sendToolResult(String name, String result) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("name", name);
        node.set("result", result != null ? result : "");
        send("tool_result", node.toJson());
    }

     /** 在 AI 回合结束后发送最终的写入/编辑摘要。 */
    public void sendFileChanges(List<FileChange> changes) {
        if (changes == null || changes.isEmpty()) return;
        ONode root = ONode.ofJson("{}").asObject();
        ONode items = root.getOrNew("changes").asArray();
        for (FileChange change : changes) {
            ONode item = items.addNew().asObject();
            item.set("path", change.path());
            item.set("additions", change.additions());
            item.set("deletions", change.deletions());
            item.set("created", change.created());
            item.set("diff", change.diff());
        }
        send("file_changes", root.toJson());
    }

    public void sendUsage(int promptTokens, int completionTokens, int totalTokens,
                          int cacheHit, int cacheMiss) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("promptTokens", promptTokens);
        node.set("completionTokens", completionTokens);
        node.set("totalTokens", totalTokens);
        node.set("cacheHit", cacheHit);
        node.set("cacheMiss", cacheMiss);
        node.set("lastPromptTokens", promptTokens);
        send("usage", node.toJson());
    }

    public void sendTokenSpeed(long completionTokens, double tokensPerSecond, double avgTokensPerSecond, boolean done) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("completionTokens", completionTokens);
        node.set("tokensPerSecond", tokensPerSecond);
        node.set("avgTokensPerSecond", avgTokensPerSecond);
        node.set("done", done);
        send("token_speed", node.toJson());
    }

    public void sendTokenSpeed(long completionTokens, double tokensPerSecond, boolean done) {
        sendTokenSpeed(completionTokens, tokensPerSecond, tokensPerSecond, done);
    }

    /**
     * 发送消息撤回点事件，并标记是否同时创建了代码快照。
     */
    public void sendSnapshot(String msgId, boolean hasCodeSnapshot) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("msgId", msgId);
        node.set("hasCodeSnapshot", hasCodeSnapshot);
        send("snapshot", node.toJson());
    }

    public synchronized void complete() {
        if (!completed.get()) {
            // 与 send 共用同一把锁，先发送结束事件，再阻止后续写入。
            send("done", "{}");
            completed.set(true);
            try {
                out.flush();
                out.close();
            } catch (Exception e) {
                log.debug("[sse] 关闭输出流失败: {}", e.toString());
            }
            completionFuture.complete(null);
        }
    }

    /**
     * 发送完整回复事件（event: complete），用于在增量流结束后告知前端最终完整文本。
     */
    public void sendComplete(String reply) {
        send("complete", escapeJson(reply));
    }

    public void sendError(String message) {
        ONode node = ONode.ofJson("{}").asObject();
        node.set("error", message != null ? message : "unknown error");
        send("error", node.toJson());
        complete();
    }

    public boolean isCompleted() {
        return completed.get();
    }

    /**
     * 阻塞当前线程直到 SSE 流结束（用于保持 handler 线程存活）。
     */
    public void awaitCompletion() {
        try {
            completionFuture.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException ignored) {
            // 正常完成路径，忽略
        }
    }

    /**
     * 阻塞当前线程直到 SSE 流结束，或超时。
     */
    public void awaitCompletion(long timeoutMs) {
        try {
            completionFuture.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException | TimeoutException ignored) {
            // 超时或正常完成路径，忽略
        }
    }
}
