package site.sorghum.loopra.bin.app;

import org.noear.solon.annotation.Bean;
import org.noear.solon.annotation.Configuration;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;

import java.io.IOException;

/**
 * Solon IoC 配置 —— 将核心组件注册为 Solon 管理的 Bean。
 * <p>
 * 内核交互工具（interact）由 @Component 扫描自动发现；
 * loopra-harness 等上层模块的内置工具同样自动发现。
 * </p>
 *
 * @author Sorghum
 */
@Configuration
public class AppConfig {

    @Bean
    public LoopraModelProvider modelProvider() throws IOException {
        LoopraConfig config = LoopraConfig.load();
        return new LoopraModelProvider(
                config.apiUrl(),
                config.apiKey(),
                config.model(),
                config.reasoningEffort(),
                config.modelChannelId(),
                config.apiProtocol(),
                config.specialCompatibility(),
                config.activeModelMaxTokens()
        );
    }

    @Bean
    public LoopraConfig loopraConfig() throws IOException {
        return LoopraConfig.load();
    }
}
