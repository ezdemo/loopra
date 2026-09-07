package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.PasteContentDTO;

import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class PasteContentServiceTest {

    @TempDir
    Path workspace;

    @Test
    void savesUtf8TextToAProjectRelativePastePath() throws Exception {
        PasteContentService service = service();

        String content = "中文粘贴内容\nline 2";
        PasteContentDTO saved = service.save("workspace-1", content);

        assertTrue(saved.path().startsWith(".loopra/paste/"));
        assertFalse(Path.of(saved.path()).isAbsolute());
        assertEquals(content.length(), saved.chars());
        assertEquals(content.getBytes(java.nio.charset.StandardCharsets.UTF_8).length, saved.bytes());
        assertEquals(content, Files.readString(workspace.resolve(saved.path())));
        assertTrue(saved.name().endsWith(".txt"));
    }

    @Test
    void createsUniqueFilesForRepeatedPastes() {
        PasteContentService service = service();

        PasteContentDTO first = service.save("workspace-1", "first");
        PasteContentDTO second = service.save("workspace-1", "second");

        assertNotEquals(first.path(), second.path());
        assertEquals(2, assertFileCount(workspace.resolve(".loopra/paste")));
    }

    @Test
    void rejectsContentOverTheByteLimit() {
        PasteContentService service = service();
        String content = "x".repeat((int) PasteContentService.MAX_PASTE_BYTES + 1);

        ServiceException error = assertThrows(ServiceException.class,
                () -> service.save("workspace-1", content));
        assertTrue(error.getMessage().contains("4 MiB"));
    }

    @Test
    void rejectsPasteDirectorySymlinkOutsideTheProject() throws Exception {
        Path outside = Files.createTempDirectory("loopra-paste-outside");
        Path loopraDirectory = workspace.resolve(".loopra");
        try {
            try {
                Files.createSymbolicLink(loopraDirectory, outside);
            } catch (UnsupportedOperationException | FileSystemException e) {
                return;
            }

            assertThrows(ServiceException.class, () -> service().save("workspace-1", "secret"));
            assertFalse(Files.exists(outside.resolve("paste")));
        } finally {
            Files.deleteIfExists(loopraDirectory);
            Files.deleteIfExists(outside);
        }
    }

    @Test
    void wrapsLargeContentAsAReadReferenceForBackendFallback() {
        PasteContentService service = service();
        String content = "x".repeat(PasteContentService.EXTERNALIZE_THRESHOLD_CHARS + 1);

        String reference = service.externalizeIfNeeded(workspace.toString(), content);

        assertTrue(reference.startsWith("```折叠块"));
        assertTrue(reference.contains(".loopra/paste/"));
        assertTrue(reference.contains("请使用 read 工具"));
        assertEquals(1, assertFileCount(workspace.resolve(".loopra/paste")));
    }

    private PasteContentService service() {
        return new PasteContentService(new StubAgentService(workspace));
    }

    private static long assertFileCount(Path directory) {
        try (var files = Files.list(directory)) {
            return files.filter(Files::isRegularFile).count();
        } catch (Exception e) {
            fail("无法读取 paste 目录: " + e.getMessage());
            return -1;
        }
    }

    private static final class StubAgentService extends AgentService {
        private final Path workspace;

        private StubAgentService(Path workspace) {
            this.workspace = workspace;
        }

        @Override
        public String resolveProjectHashOrThrow(String projectHash) {
            assertEquals("workspace-1", projectHash);
            return workspace.toString();
        }
    }
}
