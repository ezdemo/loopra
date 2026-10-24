package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.json.AcpJsonMapper;
import com.agentclientprotocol.sdk.json.TypeRef;
import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import reactor.core.publisher.Mono;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(10)
class SharedAcpProcessesTest {
    @TempDir Path home;

    static class Peer implements AcpClientTransport {
        final AcpJsonMapper mapper = AcpJsonMapper.createDefault();
        final List<JSONRPCRequest> requests = new CopyOnWriteArrayList<>();
        final List<String> closedSessions = new CopyOnWriteArrayList<>();
        final List<JSONRPCResponse> responses = new CopyOnWriteArrayList<>();
        final List<JSONRPCNotification> notifications = new CopyOnWriteArrayList<>();
        final Map<String,String> models = new ConcurrentHashMap<>();
        Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler;
        boolean closeSupported = true, closed, rejectClose;
        public Mono<Void> connect(Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler) { return Mono.fromRunnable(() -> this.handler=handler); }
        void emit(JSONRPCMessage message) { handler.apply(Mono.just(message)).flatMap(this::sendMessage).subscribe(); }
        public Mono<Void> sendMessage(JSONRPCMessage raw) {
            return Mono.fromRunnable(() -> {
                if (closed) throw new IllegalStateException("exited");
                if (raw instanceof JSONRPCResponse response) { responses.add(response); return; }
                if (raw instanceof JSONRPCNotification notification) { notifications.add(notification); return; }
                if (!(raw instanceof JSONRPCRequest request)) return;
                requests.add(request);
                Map<String,Object> params=unmarshalFrom(request.params(),new TypeRef<Map<String,Object>>() {});
                Object result=Map.of();
                switch (request.method()) {
                    case "initialize" -> result=Map.of("protocolVersion",1,"agentCapabilities",Map.of("loadSession",true,
                            "sessionCapabilities",closeSupported?Map.of("resume",Map.of(),"close",Map.of()):Map.of("resume",Map.of()),
                            "mcpCapabilities",Map.of("http",true,"sse",true)));
                    case "session/resume", "session/load" -> result=config((String)params.get("sessionId"));
                    case "session/set_config_option" -> { models.put((String)params.get("sessionId"),(String)params.get("value"));result=config((String)params.get("sessionId")); }
                    case "session/prompt" -> {
                        String session=(String)params.get("sessionId");
                        emit(new JSONRPCNotification("2.0","session/update",Map.of("sessionId",session,"update",Map.of("sessionUpdate","agent_message_chunk","content",Map.of("type","text","text",session)))));
                        result=Map.of("stopReason","end_turn");
                    }
                    case "session/close" -> {
                        if(rejectClose){emit(new JSONRPCResponse("2.0",request.id(),null,new JSONRPCError(-32603,"close failed",null)));return;}
                        closedSessions.add((String)params.get("sessionId"));
                    }
                    case "hang" -> { return; }
                    case "explode" -> throw new IllegalStateException("exited");
                    default -> result=Map.of("session",params.getOrDefault("sessionId","none"));
                }
                emit(new JSONRPCResponse("2.0",request.id(),result,null));
            });
        }
        Map<String,Object> config(String session) {return Map.of("configOptions",List.of(Map.of("id","model","name","Model","type","select","currentValue",models.getOrDefault(session,"alpha"),"options",List.of(Map.of("value","alpha","name","Alpha"),Map.of("value","beta","name","Beta")))));}
        public <T> T unmarshalFrom(Object data,TypeRef<T> type) { return mapper.convertValue(data,type); }
        public Mono<Void> closeGracefully() { return Mono.fromRunnable(() -> closed=true); }
    }

    @Test void sharesHandshakeButKeepsConcurrentSessionOutputAndCancellationIsolated() throws Exception {
        List<Peer> peers=new ArrayList<>();
        try (var pool=new SharedAcpProcesses((id,cwd)->{var peer=new Peer();peers.add(peer);return peer;})) {
            List<String> first=new CopyOnWriteArrayList<>(),second=new CopyOnWriteArrayList<>();
            AgentOutput aOutput=new SseAgentOutput(new SseEmitter(new org.noear.solon.core.handle.ContextEmpty())) {
                @Override public void onContentDelta(String text) { first.add(text); }
            };
            AgentOutput bOutput=new SseAgentOutput(new SseEmitter(new org.noear.solon.core.handle.ContextEmpty())) {
                @Override public void onContentDelta(String text) { second.add(text); }
            };
            var a=new AcpWorkbenchClient(pool.borrow("codex",home,List.of(),List.of(),"a"),aOutput);
            a.open(home.toString(),"a",List.of(),List.of(),null,false);
            var b=new AcpWorkbenchClient(pool.borrow("codex",home,List.of(),List.of(),"b"),bOutput);
            b.open(home.toString(),"b",List.of(),List.of(),null,false);
            assertEquals(1,peers.size());
            Peer peer=peers.get(0);
            assertEquals(1,peer.requests.stream().filter(request->request.method().equals("initialize")).count());
            a.setConfigOption("model","beta");
            assertEquals("beta",a.configOptions().get(0).currentValue());
            assertEquals("alpha",b.configOptions().get(0).currentValue());
            var workers=Executors.newFixedThreadPool(2);
            try {
                var one=workers.submit(()->a.prompt(UserMessage.of("first",List.of()),Map.of()));
                var two=workers.submit(()->b.prompt(UserMessage.of("second",List.of()),Map.of()));
                one.get(5,TimeUnit.SECONDS);two.get(5,TimeUnit.SECONDS);
            } finally { workers.shutdownNow(); }
            assertEquals(List.of("a"),first);
            assertEquals(List.of("b"),second);
            a.cancel();
            var cancel=peer.notifications.stream().filter(notification->notification.method().equals("session/cancel")).findFirst().orElseThrow();
            assertEquals("a",peer.unmarshalFrom(cancel.params(),new TypeRef<Map<String,Object>>() {}).get("sessionId"));
            a.close();
            assertEquals(List.of("a"),peer.closedSessions);
            assertFalse(peer.closed,"Closing one client must leave the other Agent session alive");
            b.prompt(UserMessage.of("still running",List.of()),Map.of());
            assertEquals(List.of("b","b"),second);
            b.close();
            assertEquals(List.of("a","b"),peer.closedSessions);
            assertTrue(peer.closed,"The last conversation must release the process and its workspace handles");
        }
        assertTrue(peers.get(0).closed);
    }

    AcpClientTransport endpoint(SharedAcpProcesses pool,String session,List<JSONRPCMessage> messages) {
        var endpoint=pool.borrow("codex",home,List.of(),List.of(),session);
        endpoint.connect(message->message.doOnNext(messages::add).then(Mono.empty())).block();
        endpoint.sendMessage(new JSONRPCRequest("2.0","same-id","initialize",Map.of())).block();
        return endpoint;
    }

    @Test void rewritesCollidingRequestIdsAndRoutesChildNotificationsAndAgentRequestsOnlyToTheirOwner() {
        Peer peer=new Peer();
        try(var pool=new SharedAcpProcesses((id,cwd)->peer)) {
            List<JSONRPCMessage> aMessages=new CopyOnWriteArrayList<>(),bMessages=new CopyOnWriteArrayList<>();
            var a=endpoint(pool,"a",aMessages);var b=endpoint(pool,"b",bMessages);
            a.sendMessage(new JSONRPCRequest("2.0","same-id","test",Map.of("sessionId","a"))).block();
            b.sendMessage(new JSONRPCRequest("2.0","same-id","test",Map.of("sessionId","b"))).block();
            assertEquals("a",((Map<?,?>)((JSONRPCResponse)aMessages.get(1)).result()).get("session"));
            assertEquals("b",((Map<?,?>)((JSONRPCResponse)bMessages.get(1)).result()).get("session"));
            assertEquals(2,peer.requests.stream().filter(request->request.method().equals("test")).map(JSONRPCRequest::id).distinct().count());
            peer.emit(new JSONRPCNotification("2.0","session/update",Map.of("sessionId","a","update",Map.of("sessionUpdate","subagent_spawned","subagentSessionId","child"))));
            peer.emit(new JSONRPCNotification("2.0","session/update",Map.of("sessionId","child","update",Map.of("sessionUpdate","agent_message_chunk"))));
            peer.emit(new JSONRPCRequest("2.0","permission","session/request_permission",Map.of("sessionId","b")));
            assertEquals(4,aMessages.size());
            assertEquals(3,bMessages.size());
            assertInstanceOf(JSONRPCRequest.class,bMessages.get(2));
            peer.emit(new JSONRPCNotification("2.0","session/update",Map.of("sessionId","unknown")));
            assertEquals(4,aMessages.size());assertEquals(3,bMessages.size());
            a.closeGracefully().block();b.closeGracefully().block();
        }
    }

    @Test void doesNotShareAcrossWorkspacesMcpDirectoriesOrPeersWithoutIndependentClose() {
        List<Peer> peers=new ArrayList<>();
        try(var pool=new SharedAcpProcesses((id,cwd)->{var peer=new Peer();peers.add(peer);return peer;})) {
            var a=endpoint(pool,"a",new ArrayList<>());
            var other=pool.borrow("codex",home.resolve("different"),List.of(),List.of(),"b");
            var linked=pool.borrow("codex",home,List.of("linked"),List.of(),"c");
            var mcp=pool.borrow("codex",home,List.of(),List.of(new McpServerHttp("one","https://example.test",List.of())),"d");
            var claude=pool.borrow("claude-code",home,List.of(),List.of(),"e");
            assertEquals(5,peers.size());
            a.closeGracefully().block();other.closeGracefully().block();linked.closeGracefully().block();mcp.closeGracefully().block();claude.closeGracefully().block();
        }
        assertTrue(peers.stream().allMatch(peer->peer.closed));
        List<Peer> old=new ArrayList<>();
        try(var pool=new SharedAcpProcesses((id,cwd)->{var peer=new Peer();peer.closeSupported=false;old.add(peer);return peer;})) {
            var a=endpoint(pool,"a",new ArrayList<>());
            var b=endpoint(pool,"b",new ArrayList<>());
            assertEquals(2,old.size());
            a.closeGracefully().block();assertTrue(old.get(0).closed);assertFalse(old.get(1).closed);
            b.closeGracefully().block();
        }
    }

    @Test void routesPermissionAndFormRepliesToTheRequestingSession() {
        Peer peer=new Peer();
        try(var pool=new SharedAcpProcesses((id,cwd)->peer)) {
            List<JSONRPCMessage> first=new ArrayList<>();var a=endpoint(pool,"a",first);
            var b=pool.borrow("codex",home,List.of(),List.of(),"b");
            b.connect(message->message.flatMap(raw->raw instanceof JSONRPCRequest request
                    ?Mono.just(new JSONRPCResponse("2.0",request.id(),Map.of("owner","b"),null)):Mono.empty())).block();
            b.sendMessage(new JSONRPCRequest("2.0","init","initialize",Map.of())).block();
            peer.emit(new JSONRPCRequest("2.0","approval","session/request_permission",Map.of("sessionId","b")));
            peer.emit(new JSONRPCRequest("2.0","form","elicitation/create",Map.of("sessionId","b")));
            assertEquals(1,first.size());
            assertEquals(List.of("approval","form"),peer.responses.stream().map(JSONRPCResponse::id).toList());
            assertTrue(peer.responses.stream().allMatch(response->"b".equals(((Map<?,?>)response.result()).get("owner"))));
            a.closeGracefully().block();b.closeGracefully().block();
        }
    }

    @Test void retiresAnAdapterWithFailedSessionCloseWithoutKillingItsOtherConversations() {
        List<Peer> peers=new ArrayList<>();
        try(var pool=new SharedAcpProcesses((id,cwd)->{var peer=new Peer();peers.add(peer);return peer;})) {
            var a=endpoint(pool,"a",new ArrayList<>());var b=endpoint(pool,"b",new ArrayList<>());
            peers.get(0).rejectClose=true;
            a.closeGracefully().block();assertFalse(peers.get(0).closed);
            var c=endpoint(pool,"c",new ArrayList<>());assertEquals(2,peers.size());
            b.sendMessage(new JSONRPCRequest("2.0","ping","test",Map.of("sessionId","b"))).block();
            b.closeGracefully().block();assertTrue(peers.get(0).closed);
            c.closeGracefully().block();assertTrue(peers.get(1).closed);
        }
    }

    @Test void transportFailureCompletesOtherPendingRequestsAndNextBorrowCreatesANewProcess() {
        List<Peer> peers=new ArrayList<>();
        try(var pool=new SharedAcpProcesses((id,cwd)->{var peer=new Peer();peers.add(peer);return peer;})) {
            List<JSONRPCMessage> first=new ArrayList<>();var a=endpoint(pool,"a",first);var b=endpoint(pool,"b",new ArrayList<>());
            a.sendMessage(new JSONRPCRequest("2.0","pending","hang",Map.of())).block();
            assertThrows(RuntimeException.class,()->b.sendMessage(new JSONRPCRequest("2.0","failed","explode",Map.of())).block());
            assertEquals("pending",((JSONRPCResponse)first.get(1)).id());assertNotNull(((JSONRPCResponse)first.get(1)).error());
            var c=endpoint(pool,"c",new ArrayList<>());assertEquals(2,peers.size());
            a.closeGracefully().block();b.closeGracefully().block();c.closeGracefully().block();
        }
    }

    @Test void externalRuntimeReusesAdaptersAndRefreshesMcpWithoutStoppingOtherSessions() throws Exception {
        List<Peer> peers=new ArrayList<>();
        var mcp=new java.util.concurrent.atomic.AtomicReference<List<McpServer>>(List.of());
        var first=new site.sorghum.loopra.bin.session.JsonlSessionStore(home.resolve("sessions"));
        var second=new site.sorghum.loopra.bin.session.JsonlSessionStore(home.resolve("sessions"));
        first.bindTo("a");first.append(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("first"));
        second.bindTo("b");second.append(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("second"));
        first.setAcpBinding("a",new site.sorghum.loopra.bin.session.SessionStore.AcpBinding("codex","a",home.toString()));
        second.setAcpBinding("b",new site.sorghum.loopra.bin.session.SessionStore.AcpBinding("codex","b",home.toString()));
        try(var runtime=new ExternalAcpSessions((id,cwd)->{var peer=new Peer();peers.add(peer);return peer;},(key,cwd)->mcp.get(),true)) {
            runtime.configuration("one",home,"a",first,null,null);
            runtime.configuration("two",home,"b",second,null,null);
            assertEquals(1,peers.size());
            mcp.set(List.of(new McpServerHttp("changed","https://example.test",List.of())));
            runtime.configuration("one",home,"a",first,null,null);
            assertEquals(2,peers.size());assertFalse(peers.get(0).closed);
            runtime.configuration("two",home,"b",second,null,null);
            assertEquals(2,peers.size());assertTrue(peers.get(0).closed);
        } finally {first.shutdown();second.shutdown();}
        assertTrue(peers.stream().allMatch(peer->peer.closed));
    }

    @Test void concurrentCloseWaitsUntilTheProcessActuallyReleasesItsHandles() throws Exception {
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        Peer peer=new Peer(){
            @Override public Mono<Void> closeGracefully(){return Mono.fromRunnable(()->{
                entered.countDown();
                try{if(!release.await(5,TimeUnit.SECONDS))throw new IllegalStateException("cleanup did not resume");}
                catch(InterruptedException failure){Thread.currentThread().interrupt();throw new IllegalStateException(failure);}
                closed=true;
            });}
        };
        var pool=new SharedAcpProcesses((id,cwd)->peer);
        var endpoint=endpoint(pool,"a",new ArrayList<>());
        var workers=Executors.newFixedThreadPool(2);
        try {
            var processClose=workers.submit(pool::close);
            assertTrue(entered.await(5,TimeUnit.SECONDS));
            var clientClose=workers.submit(()->endpoint.closeGracefully().block());
            assertThrows(TimeoutException.class,()->clientClose.get(100,TimeUnit.MILLISECONDS));
            release.countDown();
            processClose.get(5,TimeUnit.SECONDS);clientClose.get(5,TimeUnit.SECONDS);
            assertTrue(peer.closed);
        } finally {release.countDown();workers.shutdownNow();pool.close();}
    }

    @Test void shutdownAttemptsEveryProcessEvenWhenOneCleanupReportsFailure() {
        List<Peer> peers=new ArrayList<>();
        var pool=new SharedAcpProcesses((id,cwd)->{
            Peer peer=peers.isEmpty()?new Peer(){
                @Override public Mono<Void> closeGracefully(){return Mono.fromRunnable(()->{closed=true;throw new IllegalStateException("cleanup failed");});}
            }:new Peer();peers.add(peer);return peer;
        });
        endpoint(pool,"a",new ArrayList<>());
        pool.borrow("codex",home.resolve("other"),List.of(),List.of(),"b");
        assertThrows(RuntimeException.class,pool::close);
        assertTrue(peers.stream().allMatch(peer->peer.closed));
    }
}
