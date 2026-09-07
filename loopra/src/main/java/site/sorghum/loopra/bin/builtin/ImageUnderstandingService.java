package site.sorghum.loopra.bin.builtin;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;

import java.util.List;
import java.util.Map;

/**
 * 使用配置的图片理解模型把图片转换为文字，供不支持图片输入的主模型继续处理。
 * <p>
 * 该服务只执行一次独立的同步模型调用，不修改当前 Agent 的 Provider 或会话模型，
 * 避免在并发会话中产生模型串用。
 * </p>
 */
@Slf4j
@Component
public class ImageUnderstandingService {

    private static final String SYSTEM_PROMPT = """
            你是图片理解助手。请客观、准确地理解用户提供的图片，并用简洁但完整的文字描述图片内容。
            如果图片包含文字，请尽可能准确地转录；如果包含界面、图表、代码或错误信息，请说明关键内容和结构。
            只输出图片分析结果，不要提及系统提示词、模型、图片输入协议或无法看到图片等元信息。
            """;

    /**
     * 调用配置的图片理解模型。
     *
     * @param config  当前 Agent 的只读配置
     * @param dataUri 已校验的图片 data URI
     * @param detail  图片分析精度
     * @return 面向主模型的纯文本工具结果
     */
    public String understand(AgentConfig config, String dataUri, String detail) {
        return understand(config, dataUri, detail, null);
    }

    /**
     * 调用配置的图片理解模型，并将本次调用的识别要求传给它。
     *
     * @param config  当前 Agent 的只读配置
     * @param dataUri 已校验的图片 data URI
     * @param detail  图片分析精度
     * @param prompt  本次图片识别的任务描述
     * @return 面向主模型的纯文本工具结果
     */
    public String understand(AgentConfig config, String dataUri, String detail, String prompt) {
        Target target = resolveTarget(config);
        if (target.error() != null) {
            log.warn("[image-understanding] 图片理解未调用: {}", target.error());
            return target.error();
        }
        try {
            String normalizedDetail = detail == null || detail.isBlank() ? "auto" : detail.trim();
            String normalizedPrompt = prompt == null ? "" : prompt.trim();
            log.info("[image-understanding] 开始调用: channel={}, model={}, protocol={}, detail={}, "
                            + "endpoint={}, imageChars={}, promptChars={}",
                    target.channel().id(), target.model(), target.channel().apiProtocol(), normalizedDetail,
                    safeApiUrl(target.channel().apiUrl()), dataUri == null ? 0 : dataUri.length(),
                    normalizedPrompt.length());
            LoopraModelProvider provider = new LoopraModelProvider(
                    target.channel().apiUrl(),
                    target.channel().apiKey(),
                    target.model(),
                    "none",
                    target.channel().id(),
                    target.channel().apiProtocol(),
                    target.channel().specialCompatibility(),
                    target.maxTokens());
            Message message = new Message(
                    "user",
                    (prompt == null || prompt.isBlank() ? "请分析这张图片。" : prompt.trim())
                            + "\n分析精度要求：" + (detail == null || detail.isBlank() ? "auto" : detail),
                    null,
                    List.of(),
                    Map.of("images", List.of(dataUri)));
            ModelResponse response = provider.call(new ModelCallRequest(
                    provider.effectiveModel(),
                    List.of(new Message("system", SYSTEM_PROMPT), message),
                    List.of(),
                    Map.of()));
            String content = response == null || response.message() == null
                    ? ""
                    : response.message().content();
            if (content == null || content.isBlank()) {
                log.warn("[image-understanding] 图片理解模型未返回有效结果: channel={}, model={}",
                        target.channel().id(), target.model());
                return "IMAGE_UNDERSTANDING_FAILED: 图片理解模型未返回有效的文字结果";
            }
            log.info("[image-understanding] 调用成功: channel={}, model={}, resultChars={}",
                    target.channel().id(), target.model(), content.trim().length());
            return "图片已由图片理解模型分析：\n" + content.trim();
        } catch (Exception e) {
            // 不返回 data URI 或请求体，避免图片内容进入错误信息和日志。
            log.error("[image-understanding] 调用失败: channel={}, model={}, protocol={}, endpoint={}, error={}",
                    target.channel().id(), target.model(), target.channel().apiProtocol(),
                    safeApiUrl(target.channel().apiUrl()), e.getMessage(), e);
            String message = e.getMessage();
            return "IMAGE_UNDERSTANDING_FAILED: "
                    + (message == null || message.isBlank() ? "图片理解模型调用失败" : message);
        }
    }

    private static Target resolveTarget(AgentConfig config) {
        if (config == null) {
            return Target.error("MODEL_NOT_SUPPORTED: 当前模型不支持图片输入，且未配置图片理解模型");
        }
        String model = trim(config.imageUnderstandingModel());
        if (model.isEmpty()) {
            return Target.error("MODEL_NOT_SUPPORTED: 当前模型不支持图片输入，请先配置图片理解模型");
        }
        AgentConfig.Channel channel = config.imageUnderstandingModelChannel();
        if (channel == null) {
            return Target.error("IMAGE_UNDERSTANDING_NOT_CONFIGURED: 图片理解模型所属渠道不存在");
        }
        AgentConfig.Entry entry = channel.modelEntry(model);
        if (entry == null) {
            return Target.error("IMAGE_UNDERSTANDING_NOT_CONFIGURED: 图片理解模型不在所选渠道中");
        }
        if (!entry.imageInput()) {
            return Target.error("IMAGE_UNDERSTANDING_NOT_SUPPORTED: 所选图片理解模型不支持图片输入");
        }
        if (channel.apiUrl() == null || channel.apiUrl().isBlank() || channel.apiKey() == null || channel.apiKey().isBlank()) {
            return Target.error("IMAGE_UNDERSTANDING_NOT_CONFIGURED: 图片理解模型渠道的 API 地址或密钥未配置");
        }
        return new Target(model, channel,
                entry.maxTokens() > 0 ? entry.maxTokens() : AgentConfig.DEFAULT_MAX_TOKENS, null);
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    /** 日志只记录接口地址，不记录可能包含密钥的查询参数。 */
    private static String safeApiUrl(String value) {
        if (value == null) {
            return "";
        }
        int query = value.indexOf('?');
        int fragment = value.indexOf('#');
        int end = value.length();
        if (query >= 0) end = Math.min(end, query);
        if (fragment >= 0) end = Math.min(end, fragment);
        return value.substring(0, end);
    }

    private record Target(String model, AgentConfig.Channel channel, int maxTokens, String error) {
        private static Target error(String error) {
            return new Target("", null, -1, error);
        }
    }
}
