package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AcpToolOutputTest {
    @Test void terminalChunksSurviveStatusOnlyCompletionAndRetainWhitespace() {
        var output = new AcpToolOutput();
        output.update(null, null, Map.of("terminal_output_delta", Map.of("data", "first\n")));
        output.update(null, null, Map.of("terminal_output_delta", Map.of("data", "  second\n")));
        output.update(Map.of("exit_code", 0), null, null);
        assertEquals("first\n  second\n\nExit code: 0", output.text());
        assertFalse(output.failed());
    }

    @Test void textContentIsRetainedAndNotReplacedByExitMetadata() {
        var output = new AcpToolOutput();
        output.update(null, text("file contents"), null);
        output.update(Map.of("exit_code", 0), null, null);
        assertEquals("file contents\n\nExit code: 0", output.text());
        var empty = new AcpToolOutput();
        empty.update("", text("fallback"), null);
        assertEquals("fallback", empty.text());
        empty.update(Map.of(), null, null);
        assertEquals("fallback", empty.text());
    }

    @Test void terminalAliasesAreAppendedOnlyOnceAndNonzeroExitsFail() {
        var output = new AcpToolOutput();
        output.update(null, null, Map.of("terminal_output", Map.of("data", "old\n")));
        output.update(null, null, Map.of("terminal_output", Map.of("data", "new\n"),
                "terminal_output_delta", Map.of("data", "new\n")));
        output.update(null, null, Map.of("terminal_exit", Map.of("exit_code", 7)));
        assertEquals("old\nnew\n\nExit code: 7", output.text());
        assertTrue(output.failed());
        var signalled = new AcpToolOutput();
        signalled.update(null, null, Map.of("terminal_exit", Map.of("signal", "SIGTERM")));
        assertEquals("Signal: SIGTERM", signalled.text());
        assertTrue(signalled.failed());
    }

    @Test void structuredAndPlainResultsRemainCompatibleWithOtherAgents() {
        var output = new AcpToolOutput();
        output.update(null, null, Map.of("mcp_output_delta", Map.of("data", "working")));
        assertEquals("working", output.text());
        output.update("final result", text("display copy"), null);
        assertEquals("final result", output.text());
        output.update(Map.of("items", List.of("one", "two")), null, null);
        assertTrue(output.text().contains("\"items\""));
        assertFalse(output.text().contains("working"));
    }

    @Test void contentUpdatesReplaceTheirPreviousSnapshotAndMalformedMetadataIsIgnored() {
        var output = new AcpToolOutput();
        output.update(null, text("preview"), null);
        output.update(null, text("final"), Map.of("terminal_output_delta", Map.of("data", 42),
                "terminal_exit", "invalid"));
        assertEquals("final", output.text());
        output.update(null, List.of(), null);
        assertEquals("", output.text());
    }

    private static List<ToolCallContent> text(String value) {
        return List.of(new ToolCallContentBlock("content", new TextContent(value)));
    }
}
