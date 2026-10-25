package site.sorghum.cutin.integrations.model;

import site.sorghum.cutin.core.context.Message;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Converts tool image metadata into visual input when building a provider request. */
final class ToolImageReplay {
    private ToolImageReplay() {
    }

    static List<Message> expand(List<Message> messages) {
        List<Message> result = new ArrayList<>();
        List<Message> pendingImages = new ArrayList<>();
        for (Message message : messages) {
            // Keep every result in a parallel tool batch next to its assistant call.
            // Inserting user images between tool results breaks Chat Completions ordering.
            if (!"tool".equals(message.role()) && !pendingImages.isEmpty()) {
                result.addAll(pendingImages);
                pendingImages.clear();
            }
            result.add(message);
            if ("tool".equals(message.role())
                    && message.metadata("tool_image_url") instanceof String url && !url.isBlank()) {
                Map<String, Object> metadata = new HashMap<>();
                metadata.put("images", List.of(url));
                Object detail = message.metadata("tool_image_detail");
                if (detail != null) {
                    metadata.put("image_detail", detail);
                }
                pendingImages.add(new Message("user",
                        "Image returned by tool call " + message.toolCallId() + ":",
                        null, List.of(), metadata));
            }
        }
        result.addAll(pendingImages);
        return result;
    }
}
