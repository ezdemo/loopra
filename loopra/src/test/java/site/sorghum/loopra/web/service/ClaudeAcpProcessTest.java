package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class ClaudeAcpProcessTest {
    @TempDir Path home;
    @Test void windowsPathKeyIsCaseInsensitiveAndSupportsNvm() throws Exception {
        Path bin = Files.createDirectories(home.resolve("node with spaces"));
        Files.createFile(bin.resolve("node.exe"));
        Path claude = home.resolve(".local/bin/claude.exe");
        Files.createDirectories(claude.getParent()); Files.createFile(claude);
        Path adapter = bin.resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        Files.createDirectories(adapter.getParent()); Files.createFile(adapter);
        assertTrue(ClaudeAcpProcess.detect(Map.of("Path", "\"" + bin + "\""), home, true, null).available());
        assertTrue(ClaudeAcpProcess.detect(Map.of("nvm_symlink", bin.toString()), home, true, null).available());
        assertFalse(ClaudeAcpProcess.detect(Map.of(), home, true, null).available());
        assertTrue(ClaudeAcpProcess.detect(Map.of(), home, true, null).reason().contains("Node.js"));
    }
}
