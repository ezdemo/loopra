package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.web.common.ServiceException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ChatModeWorkspaceTest {

    @Test
    void pureChatNeverExternalizesOrSavesPastedTextIntoAWorkspace() {
        PasteContentService service = new PasteContentService();
        String large = "x".repeat(PasteContentService.EXTERNALIZE_THRESHOLD_CHARS + 1);

        assertEquals(large, service.externalizeIfNeeded(ChatMode.root().toString(), large));
        assertThrows(ServiceException.class,
                () -> service.saveAtWorkspace(ChatMode.root().toString(), "small"));
    }
}
