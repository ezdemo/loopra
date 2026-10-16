package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ChatRequest;

import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ChatRequestValidatorTest {

    @Test
    void rejectsEmptyInputButAllowsImagesAndPlanExecution() {
        assertThrows(ServiceException.class, () -> ChatRequestValidator.validate(null));
        ChatRequest request = new ChatRequest();
        request.setMessage(" ");
        request.setImages(Arrays.asList(null, " "));
        assertThrows(ServiceException.class, () -> ChatRequestValidator.validate(request));

        request.setImages(List.of("data:image/png;base64,abc"));
        assertDoesNotThrow(() -> ChatRequestValidator.validate(request));
        request.setImages(null);
        request.setAction("execute_plan");
        assertDoesNotThrow(() -> ChatRequestValidator.validate(request));
    }

    @Test
    void rejectsUnsupportedActionsAndMergeModesBeforeStartingWork() {
        ChatRequest request = new ChatRequest();
        request.setMessage("hello");
        request.setAction("unsupported");
        assertThrows(ServiceException.class, () -> ChatRequestValidator.validate(request));
        request.setAction(null);
        request.setMergeMode("unsupported");
        assertThrows(ServiceException.class, () -> ChatRequestValidator.validate(request));
        request.setMergeMode("ai-auto-approve");
        assertDoesNotThrow(() -> ChatRequestValidator.validate(request));
    }
}
