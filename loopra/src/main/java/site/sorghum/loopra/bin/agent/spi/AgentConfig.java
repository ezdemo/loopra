package site.sorghum.loopra.bin.agent.spi;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * AgentLoop 内核所需的只读配置视图（SPI）。
 * <p>
 * 内核仅依赖本接口，不感知具体配置实现；完整配置（文件读写、热更新、渠道结构等）
 * 由上层模块（loopra-harness 的 LoopraConfig）实现本接口后注入。
 * 传入 {@code null} 时内核全部使用内置默认值。
 * </p>
 *
 * @author Sorghum
 */
public interface AgentConfig {

    /** 模型请求默认最大输出 token 数（包含推理 token）。 */
    int DEFAULT_MAX_TOKENS = 32768;

    /** 上下文最大字符数（超出触发折叠）。 */
    int maxContextChars();

    /** 折叠时保留的尾部字符数。 */
    int keepTailChars();

    /** 自动折叠的模型上下文占用比例，默认 0.8。 */
    default double compactionThresholdRatio() {
        return 0.8;
    }

    /** 折叠后保留的尾部 token 比例，默认 0.16。 */
    default double compactionRetainRatio() {
        return 0.16;
    }

    /** 折叠后仍未低于阈值时的额外重试次数，默认 1。 */
    default int compactionRetries() {
        return 1;
    }

    /** 折叠前触发 tool result 裁剪的字符阈值，默认 8192。 */
    default int toolResultPruneThresholdChars() {
        return 8192;
    }

    /** 裁剪后保留的 tool result 头部字符数，默认 4096。 */
    default int toolResultPruneHeadChars() {
        return 4096;
    }

    /** 裁剪后保留的 tool result 尾部字符数，默认 1024。 */
    default int toolResultPruneTailChars() {
        return 1024;
    }

    /** 普通工具执行超时（秒）。 */
    int toolTimeoutSec();

    /** 子代理工具执行超时（秒）。 */
    int subAgentTimeoutSec();

    /** 最大自我纠正次数。 */
    int maxSelfCorrectionAttempts();

    /** 无工具调用时是否直接结束本轮对话。 */
    boolean terminateOnNoToolCall();

    /** 风暴断路器窗口大小。 */
    int stormWindowSize();

    /** 风暴断路器阈值。 */
    int stormThreshold();

    /** 工具调用校验模型名（空表示未启用校验模型）。 */
    String validationModel();

    /** 校验模型所在渠道；未配置返回 {@code null}。 */
    Channel validationModelChannel();

    /** 图片理解模型名（空表示未启用图片理解回退）。 */
    default String imageUnderstandingModel() {
        return "";
    }

    /** 图片理解模型所在渠道；未配置返回 {@code null}。 */
    default Channel imageUnderstandingModelChannel() {
        return null;
    }

    /** HITL auto 模式的白名单工具列表。 */
    List<String> autoWhitelist();

    /** 全局禁用的 Loop 插件 ID；默认全部启用。 */
    default Set<String> disabledPlugins() {
        return Set.of();
    }

    /**
     * 模型渠道视图（对应具体实现中的 ModelChannel）。
     */
    interface Channel {
        String id();

        String apiUrl();

        String apiKey();

        String apiProtocol();

        /** 渠道启用的特殊兼容插件 ID；空字符串表示不启用。 */
        default String specialCompatibility() {
            return "";
        }

        /** 渠道内按名称查找模型条目；不存在返回 {@code null}。 */
        Entry modelEntry(String modelName);
    }

    /**
     * 模型条目视图（对应具体实现中的 ModelEntry）。
     */
    interface Entry {
        String name();

        int contextTokens();

        /**
         * 模型请求最大输出 token 数（包含推理 token）；未配置时返回负数，交由内置默认值兜底。
         */
        default int maxTokens() {
            return -1;
        }

        boolean imageInput();

        Map<String, Double> price();
    }
}
