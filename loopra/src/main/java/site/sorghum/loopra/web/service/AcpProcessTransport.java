package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.json.AcpJsonMapper;
import com.agentclientprotocol.sdk.json.TypeRef;
import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import reactor.core.publisher.Mono;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

/** Owns a stdio Agent and its descendants. EOF fails requests immediately. */
final class AcpProcessTransport implements AcpClientTransport {
    private final AcpJsonMapper mapper = AcpJsonMapper.createDefault();
    private final List<String> command;
    private final Map<String, String> env;
    private final Path cwd;
    private final Set<Object> pending = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ExecutorService readers = Executors.newFixedThreadPool(2, task -> {
        Thread thread = new Thread(task, "loopra-acp-stdio"); thread.setDaemon(true); return thread;
    });
    private volatile Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler;
    private volatile Process process;
    private BufferedWriter writer;

    AcpProcessTransport(List<String> command, Map<String, String> env, Path cwd) {
        this.command = List.copyOf(command); this.env = Map.copyOf(env); this.cwd = cwd;
    }

    @Override public Mono<Void> connect(Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler) {
        return Mono.fromRunnable(() -> {
            this.handler = handler;
            try {
                ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile());
                builder.environment().putAll(env);
                process = builder.start();
                writer = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
                readers.submit(() -> read(process.getInputStream(), true));
                readers.submit(() -> read(process.getErrorStream(), false));
            } catch (IOException e) { close(); throw new UncheckedIOException("启动 ACP Agent 失败", e); }
        });
    }

    private void read(InputStream stream, boolean protocol) {
        try (BufferedReader input = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                if (!protocol || line.isBlank()) continue;
                JSONRPCMessage message = AcpSchema.deserializeJsonRpcMessage(mapper, line);
                if (message instanceof JSONRPCResponse response) pending.remove(response.id());
                deliver(message);
            }
        } catch (Exception e) {
            if (protocol && !closed.get()) failRequests("ACP Agent 通信中断，请检查 Claude 登录状态和配置");
        } finally {
            if (protocol) {
                failRequests("ACP Agent 已退出，请检查 Claude 登录状态和配置后重试");
                close();
            }
        }
    }

    private void deliver(JSONRPCMessage message) {
        if (handler != null) handler.apply(Mono.just(message)).flatMap(this::sendMessage).subscribe(ignored -> {}, error -> {});
    }

    private void failRequests(String reason) {
        for (Object id : List.copyOf(pending)) if (pending.remove(id)) {
            deliver(new JSONRPCResponse("2.0", id, null, new JSONRPCError(-32603, reason, null)));
        }
    }

    @Override public Mono<Void> sendMessage(JSONRPCMessage message) {
        return Mono.fromRunnable(() -> {
            synchronized (this) {
                if (closed.get() || process == null || !process.isAlive()) throw new IllegalStateException("ACP Agent 已退出");
                if (message instanceof JSONRPCRequest request) pending.add(request.id());
                try { writer.write(mapper.writeValueAsString(message)); writer.newLine(); writer.flush(); }
                catch (IOException e) { failRequests("ACP Agent 写入失败"); throw new UncheckedIOException(e); }
            }
        });
    }

    @Override public <T> T unmarshalFrom(Object data, TypeRef<T> type) { return mapper.convertValue(data, type); }
    @Override public Mono<Void> closeGracefully() { return Mono.fromRunnable(this::close); }
    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        failRequests("ACP 连接已关闭");
        Process owned = process;
        if (owned != null) {
            var children = owned.descendants().toList();
            children.forEach(ProcessHandle::destroy);
            owned.destroy();
            children.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            if (owned.isAlive()) owned.destroyForcibly();
            // Windows 下子进程工作目录/日志句柄要等进程真正退出才释放；不等的话
            // 紧随其后的目录清理会报“文件正被另一个进程使用”。
            try {
                owned.waitFor(3, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        readers.shutdownNow();
    }
}
