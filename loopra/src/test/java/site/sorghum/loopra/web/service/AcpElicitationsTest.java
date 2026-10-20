package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpSchema.CreateElicitationResponse;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(10)
class AcpElicitationsTest {
    private static final Map<String, Object> SCHEMA = Map.of("type", "object", "required", List.of("food"), "properties", Map.of(
            "food", Map.of("type", "string", "oneOf", List.of(Map.of("const", "chicken", "title", "黄焖鸡"), Map.of("const", "kfc", "title", "肯德基"))),
            "note", Map.of("type", "string", "_meta", Map.of("codex", Map.of("isSecret", true))),
            "count", Map.of("type", "integer", "minimum", 1, "maximum", 10),
            "delivery", Map.of("type", "boolean"),
            "sides", Map.of("type", "array", "items", Map.of("type", "string", "enum", List.of("rice", "tea")), "uniqueItems", true)));

    private static Map<String, Object> request(String session) { return Map.of("sessionId", session, "mode", "form", "message", "午餐", "requestedSchema", SCHEMA); }

    @Test void selectedValuesAndNotesResumeTheRpcAndAreNotEchoedToTheStream() throws Exception {
        List<String> events = new CopyOnWriteArrayList<>();
        var ready = new CountDownLatch(1);
        var inputs = new AcpElicitations("root"::equals, (type, data) -> { events.add(type + ":" + data); if (type.equals("elicitation")) ready.countDown(); });
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<CreateElicitationResponse> answer = worker.submit(() -> inputs.request(request("root")));
            assertTrue(ready.await(3, TimeUnit.SECONDS));
            assertFalse(answer.isDone());
            String id = (String) inputs.pending().get(0).get("elicitationRequestId");
            for (Map<String, Object> invalid : List.of(Map.<String, Object>of(), Map.<String, Object>of("food", "invalid"),
                    Map.<String, Object>of("food", "kfc", "unexpected", "value"), Map.<String, Object>of("food", "kfc", "count", 1.5),
                    Map.<String, Object>of("food", "kfc", "sides", List.of("rice", "rice")))) {
                assertThrows(ServiceException.class, () -> inputs.resolve(id, "accept", invalid));
            }
            Map<String, Object> content = Map.of("food", "chicken", "note", "private-note", "count", 2, "delivery", false, "sides", List.of("rice"));
            inputs.resolve(id, "accept", content);
            assertEquals(content, answer.get(3, TimeUnit.SECONDS).content());
            assertTrue(inputs.pending().isEmpty());
            assertTrue(events.stream().anyMatch(event -> event.startsWith("elicitation_resolved:")));
            assertTrue(events.stream().noneMatch(event -> event.contains("private-note")));
            assertThrows(ServiceException.class, () -> inputs.resolve(id, "accept", content));
        } finally { inputs.cancel(); worker.shutdownNow(); }
    }

    @ParameterizedTest @ValueSource(strings = {"decline", "cancel", "stop"})
    void skippingAndStoppingReleasePendingRequests(String action) throws Exception {
        var ready = new CountDownLatch(1);
        var inputs = new AcpElicitations("root"::equals, (type, data) -> { if (type.equals("elicitation")) ready.countDown(); });
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<CreateElicitationResponse> answer = worker.submit(() -> inputs.request(request("root")));
            assertTrue(ready.await(3, TimeUnit.SECONDS));
            if (action.equals("stop")) inputs.cancel();
            else inputs.resolve((String) inputs.pending().get(0).get("elicitationRequestId"), action, null);
            assertEquals(action.equals("decline") ? "DECLINE" : "CANCEL", answer.get(3, TimeUnit.SECONDS).action().name());
            assertTrue(inputs.pending().isEmpty());
        } finally { inputs.cancel(); worker.shutdownNow(); }
    }

    @Test void foreignSessionsAndUnadvertisedUrlRequestsAreCancelled() {
        var inputs = new AcpElicitations("root"::equals, (type, data) -> fail("Unsupported requests must not appear"));
        assertEquals("CANCEL", inputs.request(request("other")).action().name());
        assertEquals("CANCEL", inputs.request(Map.of("sessionId", "root", "mode", "url", "url", "https://example.test")).action().name());
    }
}
