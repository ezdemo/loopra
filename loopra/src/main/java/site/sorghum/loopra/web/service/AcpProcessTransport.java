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
    private final CompletableFuture<Void> closeFinished = new CompletableFuture<>();
    private volatile Thread closingThread;
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
        if (!closed.compareAndSet(false, true)) {
            // EOF and the session owner may close concurrently. Do not return to
            // the owner while the reader is still releasing the process and cwd.
            if (closingThread != Thread.currentThread()) awaitClosed(closeFinished);
            return;
        }
        closingThread = Thread.currentThread();
        boolean interrupted = Thread.interrupted();
        try {
            closeProcess();
            closeFinished.complete(null);
        } catch (RuntimeException | Error error) {
            closeFinished.completeExceptionally(error);
            throw error;
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private void closeProcess() {
        failRequests("ACP 连接已关闭");
        Process owned = process;
        try {
            if (owned != null) {
                var children = owned.descendants().toList();
                var childExits = children.stream().map(ProcessHandle::onExit).toArray(CompletableFuture<?>[]::new);
                try {
                    children.forEach(ProcessHandle::destroyForcibly);
                    // Reap descendants while their parent can still collect them. Killing
                    // a process does not mean its Windows cwd/handles have been released.
                    awaitClosed(CompletableFuture.allOf(childExits));
                } finally {
                    CompletableFuture<ProcessHandle> exit = owned.toHandle().onExit();
                    owned.destroyForcibly();
                    awaitClosed(exit);
                }
            }
        } finally {
            if (owned != null) {
                closeStream(owned.getOutputStream());
                closeStream(owned.getInputStream());
                closeStream(owned.getErrorStream());
            }
            readers.shutdownNow();
        }
    }

    /** Cancellation must not let the owner release a workspace before its Agent exits. */
    private static void awaitClosed(CompletableFuture<?> finished) {
        boolean interrupted = Thread.interrupted();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        try {
            while (true) {
                try {
                    finished.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                    return;
                } catch (InterruptedException e) {
                    interrupted = true;
                } catch (ExecutionException | TimeoutException e) {
                    throw new IllegalStateException("ACP Agent 进程未能完成清理", e);
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static void closeStream(Closeable stream) {
        try { stream.close(); }
        catch (IOException ignored) { /* The process may already have closed its pipes on exit. */ }
    }
}
