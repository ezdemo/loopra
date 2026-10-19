package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.json.AcpJsonMapper;
import com.agentclientprotocol.sdk.json.TypeRef;
import com.agentclientprotocol.sdk.spec.*;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

/** A private, JSON-serialized ACP connection. No ports, subprocesses or shared request objects. */
public final class JsonRpcLoopback implements AutoCloseable {
    private final AcpJsonMapper mapper = AcpJsonMapper.createDefault();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Sinks.One<Void> termination = Sinks.one();
    private final Endpoint client = new Endpoint();
    private final Endpoint agent = new Endpoint();

    public JsonRpcLoopback() { client.peer = agent; agent.peer = client; }
    public AcpClientTransport client() { return client; }
    public AcpAgentTransport agent() { return agent; }
    @Override public void close() { closed.set(true); termination.tryEmitEmpty(); }

    private final class Endpoint implements AcpClientTransport, AcpAgentTransport {
        private Endpoint peer;
        private volatile Function<Mono<AcpSchema.JSONRPCMessage>, Mono<AcpSchema.JSONRPCMessage>> handler;
        @Override public void setExceptionHandler(java.util.function.Consumer<Throwable> handler) {}
        @Override public Mono<Void> connect(Function<Mono<AcpSchema.JSONRPCMessage>, Mono<AcpSchema.JSONRPCMessage>> handler) {
            return start(handler);
        }
        @Override public Mono<Void> start(Function<Mono<AcpSchema.JSONRPCMessage>, Mono<AcpSchema.JSONRPCMessage>> handler) {
            return Mono.fromRunnable(() -> this.handler = handler);
        }
        @Override public Mono<Void> sendMessage(AcpSchema.JSONRPCMessage message) {
            return Mono.fromRunnable(() -> {
                if (closed.get() || peer.handler == null) throw new IllegalStateException("ACP connection is closed");
                try {
                    var copy = AcpSchema.deserializeJsonRpcMessage(mapper, mapper.writeValueAsString(message));
                    peer.handler.apply(Mono.just(copy)).flatMap(peer::sendMessage).subscribe();
                } catch (java.io.IOException exception) { throw new IllegalArgumentException("Invalid ACP message", exception); }
            });
        }
        @Override public <T> T unmarshalFrom(Object data, TypeRef<T> type) { return mapper.convertValue(data, type); }
        @Override public Mono<Void> closeGracefully() { return Mono.fromRunnable(JsonRpcLoopback.this::close); }
        @Override public Mono<Void> awaitTermination() { return termination.asMono(); }
    }
}
