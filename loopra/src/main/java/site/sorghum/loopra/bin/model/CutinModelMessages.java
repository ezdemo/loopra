package site.sorghum.loopra.bin.model;

import site.sorghum.cutin.core.context.Message;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;

import java.util.List;

/** Use the same multimodal conversion for background requests and the agent loop. */
final class CutinModelMessages {

    private CutinModelMessages() {
    }

    static List<Message> toCutin(List<ChatMessage> messages) {
        return CutinMessageBridge.toCutin(messages);
    }

    static Message toCutin(ChatMessage message) {
        return CutinMessageBridge.toCutin(message);
    }

}
