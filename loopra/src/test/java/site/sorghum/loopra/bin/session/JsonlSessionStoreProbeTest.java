package site.sorghum.loopra.bin.session;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;

class JsonlSessionStoreProbeTest {
    @TempDir Path home;
    @Test void messageProbeMatchesLoadAndStopsBeforeMalformedTrailingData() throws Exception {
        var store=new JsonlSessionStore(home);
        try {
            assertFalse(store.hasMessages("missing"));
            Files.writeString(home.resolve("chat.jsonl"),"// comment\n\n{broken\n");
            assertFalse(store.hasMessages("chat"));
            store.bindTo("chat");store.append(ChatMessage.ofUser("real message"));
            assertTrue(store.hasMessages("chat"));
            assertEquals(!store.load("chat").isEmpty(),store.hasMessages("chat"));
            // A UTF-8 decoding error after a buffered page must not require loading the entire transcript.
            Files.writeString(home.resolve("chat.jsonl"),"\n".repeat(20000),StandardOpenOption.APPEND);
            Files.write(home.resolve("chat.jsonl"),new byte[]{(byte)0xff},StandardOpenOption.APPEND);
            assertTrue(store.hasMessages("chat"));
        } finally {store.shutdown();}
    }

    @Test void internalNoticesAloneAreNotAResumableTranscript() throws Exception {
        var store=new JsonlSessionStore(home);
        try {
            String notice=site.sorghum.loopra.bin.agent.context.ConversationContext.NO_TOOL_CALL_NOTICE;
            Files.writeString(home.resolve("chat.jsonl"),JsonlSessionStore.serializeMessage(ChatMessage.ofUser(notice))+"\n");
            assertFalse(store.hasMessages("chat"));assertTrue(store.load("chat").isEmpty());
            Files.writeString(home.resolve("chat.jsonl"),JsonlSessionStore.serializeMessage(ChatMessage.assistant("real reply",java.util.List.of(),null))+"\n",StandardOpenOption.APPEND);
            assertTrue(store.hasMessages("chat"));assertEquals(1,store.load("chat").size());
        } finally {store.shutdown();}
    }
}
