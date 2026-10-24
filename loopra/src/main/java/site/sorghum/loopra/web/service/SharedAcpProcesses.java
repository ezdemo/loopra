package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.json.TypeRef;
import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import reactor.core.publisher.Mono;

import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiFunction;
import java.util.function.Function;

/** Reuses initialized adapters, while each workbench conversation keeps its own SDK client. */
final class SharedAcpProcesses implements AutoCloseable {
    private static final int MAX_PROCESSES = 8;
    private final BiFunction<String, Path, AcpClientTransport> factory;
    private final List<Group> groups = new ArrayList<>();
    private boolean closed;

    SharedAcpProcesses(BiFunction<String, Path, AcpClientTransport> factory) { this.factory = factory; }

    static boolean reusesHandshake(AcpClientTransport transport) {
        return transport instanceof Endpoint endpoint && endpoint.group.initialized != null;
    }

    // Roots and MCP definitions affect native discovery. Never share across different environments.
    record Environment(String agent, Path cwd, List<String> directories, List<McpServer> mcp) {
        Environment {
            cwd = cwd.toAbsolutePath().normalize();
            directories = List.copyOf(directories);
            mcp = List.copyOf(mcp);
        }
    }

    synchronized AcpClientTransport borrow(String agent, Path cwd, List<String> directories,
                                           List<McpServer> mcp, String sessionId) {
        if (closed) throw new IllegalStateException("ACP process pool is closed");
        Environment environment = new Environment(agent, cwd, directories, mcp);
        groups.removeIf(group -> { if (group.dead()) { group.close(); return true; } return false; });
        for (Group group : groups) {
            if (group.environment.equals(environment)) {
                Endpoint endpoint = group.reuse(sessionId);
                if (endpoint != null) return endpoint;
            }
        }
        if (groups.size() >= MAX_PROCESSES) {
            Group idle = groups.stream().filter(Group::idle).min(Comparator.comparingLong(group -> group.lastUsed))
                    .orElseThrow(() -> new IllegalStateException("ACP process pool is full"));
            groups.remove(idle);
            idle.close();
        }
        Group group = new Group(environment, factory.apply(agent, cwd));
        groups.add(group);
        return group.endpoint(sessionId);
    }

    @Override public synchronized void close() {
        closed = true;
        RuntimeException failure = null;
        for (Group group : groups) {
            try { group.close(); }
            catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        }
        groups.clear();
        if (failure != null) throw failure;
    }

    private static final class Pending {
        final Endpoint endpoint;
        final Object originalId;
        final String method;
        final CompletableFuture<JSONRPCResponse> internal;

        Pending(Endpoint endpoint, Object originalId, String method, CompletableFuture<JSONRPCResponse> internal) {
            this.endpoint = endpoint; this.originalId = originalId; this.method = method; this.internal = internal;
        }
    }

    private static final class Group implements AutoCloseable {
        final Environment environment;
        final AcpClientTransport transport;
        final AtomicLong ids = new AtomicLong();
        final Map<Object, Pending> pending = new ConcurrentHashMap<>();
        final Map<String, Endpoint> routes = new ConcurrentHashMap<>();
        final Set<Endpoint> endpoints = ConcurrentHashMap.newKeySet();
        final CompletableFuture<Void> closeFinished = new CompletableFuture<>();
        volatile Object initialized;
        volatile boolean supportsClose;
        volatile boolean closed;
        volatile boolean retiring;
        volatile Thread closingThread;
        volatile long lastUsed = System.nanoTime();

        Group(Environment environment, AcpClientTransport transport) {
            this.environment = environment; this.transport = transport;
            transport.connect(message -> message.doOnNext(this::receive).then(Mono.empty())).block();
        }

        boolean dead() {
            return closed || retiring || transport instanceof AcpProcessTransport process && !process.isAlive();
        }

        boolean idle() { return endpoints.isEmpty(); }

        synchronized Endpoint reuse(String sessionId) {
            // A peer without session/close cannot release one writer independently.
            // While initialize is in flight, keep the old private-start behavior.
            return !dead() && initialized != null && supportsClose && !routes.containsKey(sessionId) ? endpoint(sessionId) : null;
        }

        Endpoint endpoint(String sessionId) {
            Endpoint endpoint = new Endpoint(this, sessionId);
            endpoints.add(endpoint);
            routes.put(sessionId, endpoint);
            lastUsed = System.nanoTime();
            return endpoint;
        }

        void receive(JSONRPCMessage raw) {
            if (raw instanceof JSONRPCResponse response) {
                Pending request = pending.remove(response.id());
                if (request == null) return;
                if ("initialize".equals(request.method) && response.error() == null) {
                    initialized = response.result();
                    if (initialized instanceof Map<?, ?> result && result.get("agentCapabilities") instanceof Map<?, ?> caps
                            && caps.get("sessionCapabilities") instanceof Map<?, ?> sessions) supportsClose = sessions.get("close") != null;
                }
                if (request.internal != null) request.internal.complete(response);
                else request.endpoint.deliver(new JSONRPCResponse(response.jsonrpc(), request.originalId, response.result(), response.error()));
                return;
            }
            Object params = raw instanceof JSONRPCNotification notification ? notification.params()
                    : raw instanceof JSONRPCRequest request ? request.params() : null;
            Map<String, Object> map = params == null ? Map.of() : transport.unmarshalFrom(params, new TypeRef<Map<String, Object>>() {});
            String session = map.get("sessionId") instanceof String id ? id : null;
            Endpoint endpoint = session == null ? null : routes.get(session);
            if (endpoint != null) {
                if (map.get("update") instanceof Map<?, ?> update && "subagent_spawned".equals(update.get("sessionUpdate"))
                        && update.get("subagentSessionId") instanceof String child) routes.putIfAbsent(child, endpoint);
                endpoint.deliver(raw);
            } else if (session == null && raw instanceof JSONRPCNotification) {
                // Connection-level auth status is informational and contains no conversation output.
                for (Endpoint current : List.copyOf(endpoints)) current.deliver(raw);
            } else if (raw instanceof JSONRPCRequest request) {
                transport.sendMessage(new JSONRPCResponse("2.0", request.id(), null,
                        new JSONRPCError(-32602, "Unknown ACP conversation", null))).subscribe();
            }
        }

        Mono<Void> send(Endpoint endpoint, JSONRPCMessage message) {
            if (closed || endpoint.closed && !(message instanceof JSONRPCResponse)) throw new IllegalStateException("ACP conversation is closed");
            if (message instanceof JSONRPCRequest request) {
                if ("initialize".equals(request.method()) && initialized != null) {
                    endpoint.deliver(new JSONRPCResponse("2.0", request.id(), initialized, null));
                    return Mono.empty();
                }
                // This transport is only borrowed for an existing remote session.
                // Fresh sessions and forks retain their own private process until bound.
                if (Set.of("session/new", "session/fork").contains(request.method())) {
                    throw new IllegalStateException("An unbound session needs a private ACP process");
                }
                Object id = "loopra-shared-" + ids.incrementAndGet();
                pending.put(id, new Pending(endpoint, request.id(), request.method(), null));
                message = new JSONRPCRequest(request.jsonrpc(), id, request.method(), request.params());
            }
            return transport.sendMessage(message).doOnError(failure -> close());
        }

        void release(Endpoint endpoint) {
            if (!endpoints.contains(endpoint)) return;
            try {
                if (!closed && supportsClose && initialized != null) {
                    // Release this session's native writer/CLI without terminating other conversations.
                    Object id = "loopra-close-" + ids.incrementAndGet();
                    CompletableFuture<JSONRPCResponse> finished = new CompletableFuture<>();
                    pending.put(id, new Pending(null, null, "session/close", finished));
                    try {
                        transport.sendMessage(new JSONRPCRequest("2.0", id, "session/close", Map.of("sessionId", endpoint.sessionId))).block();
                        JSONRPCResponse response = finished.get(10, TimeUnit.SECONDS);
                        if (response.error() != null) throw new IllegalStateException("Agent did not close the conversation");
                    } finally { pending.remove(id); }
                }
            } catch (Exception failure) {
                // A peer that cannot close reliably is retired. Its remaining sessions
                // keep running; the last release reaps the process.
                supportsClose = false;
                if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            } finally {
                boolean last;
                synchronized (this) {
                    routes.entrySet().removeIf(entry -> entry.getValue() == endpoint);
                    endpoints.remove(endpoint);
                    last = endpoints.isEmpty();
                    if (last) retiring = true;
                }
                pending.forEach((id, request) -> {
                    if (request.endpoint == endpoint && pending.remove(id, request)) endpoint.deliver(new JSONRPCResponse("2.0", request.originalId,
                            null, new JSONRPCError(-32603, "ACP conversation closed", null)));
                });
                lastUsed = System.nanoTime();
                // Do not keep an unowned process holding a deleted workspace/worktree open.
                if (last) close();
            }
        }

        @Override public void close() {
            boolean owner;
            synchronized (this) {
                owner = !closed;
                if (owner) { closed = true; retiring = true; closingThread = Thread.currentThread(); }
            }
            if (!owner) {
                if (closingThread != Thread.currentThread()) closeFinished.join();
                return;
            }
            try {
                pending.forEach((id, request) -> {
                    if (!pending.remove(id, request)) return;
                    JSONRPCResponse failure = new JSONRPCResponse("2.0", request.originalId, null, new JSONRPCError(-32603, "ACP Agent exited", null));
                    if (request.internal != null) request.internal.complete(failure);
                    else request.endpoint.deliver(failure);
                });
                transport.closeGracefully().block(Duration.ofSeconds(15));
                closeFinished.complete(null);
            } catch (RuntimeException | Error failure) {
                closeFinished.completeExceptionally(failure);
                throw failure;
            }
        }
    }

    private static final class Endpoint implements AcpClientTransport {
        final Group group;
        final String sessionId;
        volatile Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler;
        volatile boolean closed;
        final CompletableFuture<Void> closeFinished = new CompletableFuture<>();
        volatile Thread closingThread;

        Endpoint(Group group, String sessionId) { this.group = group; this.sessionId = sessionId; }

        public Mono<Void> connect(Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler) {
            return Mono.fromRunnable(() -> this.handler = handler);
        }
        void deliver(JSONRPCMessage message) {
            Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> current = handler;
            if (current != null) current.apply(Mono.just(message)).flatMap(this::sendMessage).subscribe(ignored -> {}, ignored -> {});
        }
        public Mono<Void> sendMessage(JSONRPCMessage message) { return Mono.defer(() -> group.send(this, message)); }
        public <T> T unmarshalFrom(Object data, TypeRef<T> type) { return group.transport.unmarshalFrom(data, type); }
        public Mono<Void> closeGracefully() { return Mono.fromRunnable(this::closeEndpoint); }
        private void closeEndpoint() {
            boolean owner;
            synchronized (this) {
                owner = !closed;
                if (owner) { closed = true; closingThread = Thread.currentThread(); }
            }
            if (!owner) { if (closingThread != Thread.currentThread()) closeFinished.join(); return; }
            try { group.release(this); closeFinished.complete(null); }
            catch (RuntimeException | Error failure) { closeFinished.completeExceptionally(failure); throw failure; }
        }
    }
}
