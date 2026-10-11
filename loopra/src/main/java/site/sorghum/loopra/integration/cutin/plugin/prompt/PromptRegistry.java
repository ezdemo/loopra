package site.sorghum.loopra.integration.cutin.plugin.prompt;

import site.sorghum.cutin.core.context.LoopContext;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;

/**
 * 提示词切片注册表 —— 聚合所有 {@link PromptSliceProvider} 并按 order 拼装。
 * <p>
 * 作为普通 bean 注入到 {@code LoopraPromptPlugin}，外部插件只需拿到此 bean
 * 并调用 {@link #register} 即可热插拔自己的提示词。重置时保留内置切片。
 * </p>
 */
public final class PromptRegistry {

    private final CopyOnWriteArrayList<PromptSliceProvider> providers = new CopyOnWriteArrayList<>();

    public void register(PromptSliceProvider provider) {
        // 同一实例重复注册（如插件 stop/start 重启）不产生重复切片
        if (provider != null && !providers.contains(provider)) {
            providers.add(provider);
        }
    }

    public void unregister(PromptSliceProvider provider) {
        providers.remove(provider);
    }

    /**
     * 按 order 升序返回切片；同 id 只保留最后一次注册的结果（后者覆盖前者），
     * 避免外部插件重复注册或多次热插拔导致同一段提示词出现多次。
     */
    public List<PromptSlice> slices(LoopContext context) {
        Map<String, PromptSlice> byId = new LinkedHashMap<>();
        for (PromptSliceProvider p : providers) {
            try {
                PromptSlice slice = p.slice(context);
                if (slice == null || slice.isEmpty()) continue;
                byId.put(slice.id(), slice);
            } catch (Exception ignored) {
                // 单个 provider 生成失败不影响其他 provider
            }
        }
        return byId.values().stream()
                .sorted(Comparator.comparingInt(PromptSlice::order))
                .toList();
    }

    /** 拼装成最终 system prompt，空切片已过滤。 */
    public String assemble(LoopContext context) {
        List<PromptSlice> list = slices(context);
        return list.stream()
                .map(PromptSlice::content)
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.joining("\n\n---\n\n"));
    }

    public int size() {
        return providers.size();
    }
}
