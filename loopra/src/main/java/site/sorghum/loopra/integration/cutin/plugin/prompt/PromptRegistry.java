package site.sorghum.loopra.integration.cutin.plugin.prompt;

import site.sorghum.cutin.core.context.LoopContext;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
        return slices(context).stream()
                .map(PromptSlice::content)
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.joining("\n\n---\n\n"));
    }

    /**
     * 同一次模型调用内复用装配结果。
     * <p>
     * 折叠插件（order -200）与 prompt 插件（order 900）在一次模型调用中各需要一次
     * system 文本，两次装配会重复触发 project-doc / skill-contract 的读盘与目录扫描。
     * 缓存键取 {@code context.id() + loopraStep}：step 变量在请求模型前置入，
     * 两个插件看到的是同一个值，而进入下一步后键自然失效，切片内容照常重新计算。
     * </p>
     */
    public String assembleOnce(LoopContext context) {
        if (context == null) {
            return assemble(null);
        }
        Object step = context.variables() == null ? null : context.variables().get("loopraStep");
        AssemblyKey key = new AssemblyKey(context.id(), step);
        AssemblyCache cache = assemblyCache;
        if (cache != null && cache.key().equals(key)) {
            return cache.assembled();
        }
        String assembled = assemble(context);
        assemblyCache = new AssemblyCache(key, assembled);
        return assembled;
    }

    public int size() {
        return providers.size();
    }

    private volatile AssemblyCache assemblyCache;

    private record AssemblyKey(String contextId, Object step) {
        @Override
        public boolean equals(Object o) {
            return o instanceof AssemblyKey other
                    && Objects.equals(contextId, other.contextId)
                    && Objects.equals(step, other.step);
        }

        @Override
        public int hashCode() {
            return Objects.hash(contextId, step);
        }
    }

    private record AssemblyCache(AssemblyKey key, String assembled) {
    }
}
