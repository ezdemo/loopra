package site.sorghum.loopra.web.service;

import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ChatRequest;

import java.util.Set;

/** 在创建输出流或写入会话设置之前验证聊天请求。 */
public final class ChatRequestValidator {

    private static final Set<String> MERGE_MODES = Set.of("manual", "ai-auto", "ai-auto-approve");

    private ChatRequestValidator() {
    }

    public static void validate(ChatRequest request) {
        if (request == null) throw new ServiceException(WebErrorMessages.MESSAGE_REQUIRED);
        String action = request.getAction();
        if (action != null && !action.isBlank() && !"execute_plan".equals(action)) {
            throw new ServiceException("不支持的聊天操作");
        }
        boolean hasText = request.getMessage() != null && !request.getMessage().isBlank();
        boolean hasImages = request.getImages() != null
                && request.getImages().stream().anyMatch(image -> image != null && !image.isBlank());
        if (!"execute_plan".equals(action) && !hasText && !hasImages) {
            throw new ServiceException(WebErrorMessages.MESSAGE_REQUIRED);
        }
        String mergeMode = request.getMergeMode();
        if (mergeMode != null && !mergeMode.isBlank() && !MERGE_MODES.contains(mergeMode)) {
            throw new ServiceException("不支持的隔离分支合并模式");
        }
    }
}
