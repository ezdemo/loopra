package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpSchema.CreateElicitationResponse;
import org.noear.snack4.ONode;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Predicate;

/** Pending ACP form inputs; answers resume the original RPC, without another model turn. */
final class AcpElicitations {
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Predicate<String> acceptsSession;
    private final BiConsumer<String, String> emit;

    AcpElicitations(Predicate<String> acceptsSession, BiConsumer<String, String> emit) {
        this.acceptsSession = acceptsSession;
        this.emit = emit;
    }

    CreateElicitationResponse request(Map<String, Object> request) {
        if (!(request.get("sessionId") instanceof String session) || !acceptsSession.test(session)
                || !(request.get("requestedSchema") instanceof Map<?, ?> schema)
                || !(schema.get("properties") instanceof Map<?, ?>)
                || (request.get("mode") != null && !"form".equals(request.get("mode")))) return CreateElicitationResponse.cancel();
        String id = UUID.randomUUID().toString();
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("elicitationRequestId", id);
        event.put("sessionId", session);
        event.put("message", request.getOrDefault("message", "请回答以下问题"));
        event.put("schema", schema);
        Pending input = new Pending(schema, event, new CompletableFuture<>());
        pending.put(id, input);
        try {
            // A turn can be stopped just before a request handler enters its waiting state.
            if (!acceptsSession.test(session)) return CreateElicitationResponse.cancel();
            emit.accept("elicitation", ONode.serialize(event));
            if (request.get("_meta") instanceof Map<?, ?> meta && meta.get("codex") instanceof Map<?, ?> codex
                    && codex.get("autoResolutionMs") instanceof Number delay) {
                CompletableFuture.delayedExecutor(Math.max(0L, delay.longValue()), TimeUnit.MILLISECONDS)
                        .execute(() -> input.answer().complete(CreateElicitationResponse.cancel()));
            }
            return input.answer().join();
        } finally {
            pending.remove(id);
            CreateElicitationResponse response = input.answer().getNow(CreateElicitationResponse.cancel());
            // Never echo user answers (which may include secrets) to the stream or local history.
            emit.accept("elicitation_resolved", ONode.serialize(Map.of("elicitationRequestId", id,
                    "action", response.action().name().toLowerCase(Locale.ROOT))));
        }
    }

    List<Map<String, Object>> pending() {
        return pending.values().stream().filter(input -> !input.answer().isDone()).map(Pending::event).toList();
    }

    void resolve(String id, String action, Map<String, Object> content) {
        Pending input = pending.get(id);
        if (input == null || input.answer().isDone()) throw new ServiceException(409, "提问已结束或不属于当前会话");
        CreateElicitationResponse response = switch (action == null ? "" : action) {
            case "accept" -> {
                Map<String, Object> values = content == null ? Map.of() : new LinkedHashMap<>(content);
                validate(input.schema(), values);
                yield CreateElicitationResponse.accept(values);
            }
            case "decline" -> CreateElicitationResponse.decline();
            case "cancel" -> CreateElicitationResponse.cancel();
            default -> throw new ServiceException("无效的提问操作");
        };
        if (!input.answer().complete(response)) throw new ServiceException(409, "提问已处理");
    }

    void cancel() { pending.values().forEach(input -> input.answer().complete(CreateElicitationResponse.cancel())); }

    private static void validate(Map<?, ?> schema, Map<String, Object> values) {
        Map<?, ?> fields = (Map<?, ?>) schema.get("properties");
        if (schema.get("required") instanceof List<?> required) for (Object key : required) {
            if (!values.containsKey(key) || values.get(key) == null) throw new ServiceException("请填写所有必答项");
        }
        for (var entry : values.entrySet()) {
            if (!(fields.get(entry.getKey()) instanceof Map<?, ?> field) || !validValue(field, entry.getValue())) {
                throw new ServiceException("提问答案不符合字段要求: " + entry.getKey());
            }
        }
    }

    private static boolean validValue(Map<?, ?> field, Object value) {
        String type = field.get("type") instanceof String declared ? declared : "string";
        boolean valid = switch (type) {
            case "string" -> value instanceof String text
                    && bound(field, "minLength", text.length(), true) && bound(field, "maxLength", text.length(), false);
            case "boolean" -> value instanceof Boolean;
            case "number", "integer" -> value instanceof Number number && Double.isFinite(number.doubleValue())
                    && (!"integer".equals(type) || number.doubleValue() == Math.rint(number.doubleValue()))
                    && bound(field, "minimum", number.doubleValue(), true) && bound(field, "maximum", number.doubleValue(), false);
            case "array" -> value instanceof List<?> list && field.get("items") instanceof Map<?, ?> items
                    && bound(field, "minItems", list.size(), true) && bound(field, "maxItems", list.size(), false)
                    && (!Boolean.TRUE.equals(field.get("uniqueItems")) || new HashSet<>(list).size() == list.size())
                    && list.stream().allMatch(item -> validValue(items, item));
            default -> false;
        };
        if (!valid) return false;
        if (field.get("enum") instanceof List<?> choices && choices.stream().noneMatch(choice -> equalValue(choice, value))) return false;
        if (field.get("oneOf") instanceof List<?> choices && choices.stream().noneMatch(option ->
                option instanceof Map<?, ?> choice && equalValue(choice.get("const"), value))) return false;
        if (field.get("anyOf") instanceof List<?> choices && choices.stream().noneMatch(option ->
                option instanceof Map<?, ?> choice && equalValue(choice.get("const"), value))) return false;
        return true;
    }

    private static boolean equalValue(Object left, Object right) {
        if (left instanceof Number a && right instanceof Number b) {
            return new java.math.BigDecimal(a.toString()).compareTo(new java.math.BigDecimal(b.toString())) == 0;
        }
        return Objects.equals(left, right);
    }

    private static boolean bound(Map<?, ?> field, String key, double value, boolean minimum) {
        return !(field.get(key) instanceof Number bound) || (minimum ? value >= bound.doubleValue() : value <= bound.doubleValue());
    }

    private record Pending(Map<?, ?> schema, Map<String, Object> event, CompletableFuture<CreateElicitationResponse> answer) {}
}
