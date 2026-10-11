package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.web.common.UsageCostCalculator;
import site.sorghum.loopra.web.model.DashboardDTO;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * 数据面板服务 —— 读取每日用量日志并聚合为 Dashboard 数据。
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class DashboardService {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private final Path usageFile;
    private final Clock clock;
    private final Supplier<Map<String, Map<String, Double>>> prices;
    private final Supplier<ModelPriceProvider> priceProvider;

    public DashboardService() {
        this(Paths.get(System.getProperty("user.home"), ".loopra", "usage_daily.jsonl"),
                Clock.systemDefaultZone(), UsageCostCalculator::loadPrices, ModelMetaPriceProvider::getInstance);
    }

    DashboardService(Path usageFile, Clock clock, Supplier<Map<String, Map<String, Double>>> prices,
                     Supplier<ModelPriceProvider> priceProvider) {
        this.usageFile = usageFile;
        this.clock = clock;
        this.prices = prices;
        this.priceProvider = priceProvider;
    }

    /**
     * 获取数据面板统计。
     *
     * @param days 统计天数（1-365）
     * @return 面板 DTO
     */
    public DashboardDTO getDashboard(int days) {
        int n = (days > 0) ? Math.min(days, 365) : 30;
        LocalDate today = LocalDate.now(clock);
        LocalDate startDate = today.minusDays(n - 1);

        // 1. 读取日志
        List<String> lines = readLogFile();
        if (lines.isEmpty()) {
            return emptyDashboard(n, today);
        }

        // 2. 解析并聚合：date -> model -> [prompt, completion, cacheHit, cacheMiss, requests]
        Map<String, Map<String, long[]>> dailyAgg = new LinkedHashMap<>();
        // modelTotal：模型 -> [输入 token, 输出 token, 缓存命中 token, 请求数]
        Map<String, long[]> modelTotal = new LinkedHashMap<>();
        long totalRequests = 0;

        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty()) continue;
            try {
                ONode node = ONode.ofJson(line);
                long ts = node.get("ts").getLong();
                String model = node.get("model").getString();
                if (model == null || model.isEmpty()) model = "unknown";
                long prompt = node.get("prompt").getLong();
                long completion = node.get("completion").getLong();
                long cacheHit = node.get("cacheHit").getLong();
                long cacheMiss = node.get("cacheMiss").getLong();

                LocalDate date = Instant.ofEpochMilli(ts)
                        .atZone(clock.getZone()).toLocalDate();
                if (date.isBefore(startDate) || date.isAfter(today)) continue;

                String dateStr = date.format(DATE_FMT);
                long[] dmu = dailyAgg
                        .computeIfAbsent(dateStr, k -> new LinkedHashMap<>())
                        .computeIfAbsent(model, k -> new long[5]);
                dmu[0] += prompt;
                dmu[1] += completion;
                dmu[2] += cacheHit;
                dmu[3] += cacheMiss;
                dmu[4]++;

                long[] mt = modelTotal.computeIfAbsent(model, k -> new long[4]);
                mt[0] += prompt;
                mt[1] += completion;
                mt[2] += cacheHit;
                mt[3]++;

                totalRequests++;
            } catch (Exception ignored) {
                // 单条用量记录解析失败不阻断统计
            }
        }

        // 3. 价格配置：优先用户配置，其次 ModelMetaPriceProvider
        Map<String, Map<String, Double>> configPrices = prices.get();
        ModelPriceProvider provider = priceProvider.get();

        // 合并价格：config 优先，provider 补充
        Map<String, Map<String, Double>> allPrices = new LinkedHashMap<>();
        if (configPrices != null) allPrices.putAll(configPrices);
        for (String model : modelTotal.keySet()) {
            Map<String, Double> resolved = UsageCostCalculator.resolvePrice(configPrices, model, provider);
            if (resolved != null && !resolved.isEmpty()) allPrices.put(model, resolved);
        }

        // 4. 构建每日统计
        List<DashboardDTO.DailyStat> dailyStats = new ArrayList<>();
        long globalPrompt = 0, globalCompletion = 0, globalCacheHit = 0, globalCacheMiss = 0;
        double globalCost = 0;
        Set<String> activeDates = new HashSet<>();

        for (int i = 0; i < n; i++) {
            LocalDate d = startDate.plusDays(i);
            String dateStr = d.format(DATE_FMT);
            Map<String, long[]> dayModels = dailyAgg.getOrDefault(dateStr, Collections.emptyMap());

            long dayPrompt = 0, dayCompletion = 0, dayCacheHit = 0, dayCacheMiss = 0, dayRequests = 0;
            double dayCost = 0;
            Map<String, DashboardDTO.ModelUsage> breakdown = new LinkedHashMap<>();

            for (Map.Entry<String, long[]> entry : dayModels.entrySet()) {
                String mName = entry.getKey();
                long[] v = entry.getValue();
                dayPrompt += v[0];
                dayCompletion += v[1];
                dayCacheHit += v[2];
                dayCacheMiss += v[3];
                dayRequests += v[4];

                dayCost += UsageCostCalculator.calculate(allPrices.get(mName), v[0], v[1], v[2]).totalCost();

                breakdown.put(mName, new DashboardDTO.ModelUsage(
                        v[0], v[1], v[2], v[3], v[0] + v[1]));
            }

            if (!dayModels.isEmpty()) activeDates.add(dateStr);

            dailyStats.add(new DashboardDTO.DailyStat(
                    dateStr, dayPrompt, dayCompletion, dayCacheHit, dayCacheMiss,
                    dayPrompt + dayCompletion, round4(dayCost), dayRequests, breakdown));

            globalPrompt += dayPrompt;
            globalCompletion += dayCompletion;
            globalCacheHit += dayCacheHit;
            globalCacheMiss += dayCacheMiss;
            globalCost += dayCost;
        }

        // 5. 构建模型汇总统计（按 token 总量降序）
        List<DashboardDTO.ModelStat> modelStats = new ArrayList<>();
        for (Map.Entry<String, long[]> entry : modelTotal.entrySet()) {
            String mName = entry.getKey();
            long[] v = entry.getValue();
            double mCost = round4(UsageCostCalculator.calculate(allPrices.get(mName), v[0], v[1], v[2]).totalCost());
            modelStats.add(new DashboardDTO.ModelStat(
                    mName, v[0], v[1], v[2], v[0] + v[1], mCost, v[3]));
        }
        modelStats.sort((a, b) -> Long.compare(b.totalTokens(), a.totalTokens()));

        return new DashboardDTO(
                globalPrompt, globalCompletion, globalCacheHit, globalCacheMiss,
                round4(globalCost), activeDates.size(), totalRequests, dailyStats, modelStats, allPrices);
    }

    // ---- 内部方法 ----

    private List<String> readLogFile() {
        try {
            if (!Files.exists(usageFile)) return Collections.emptyList();
            return Files.readAllLines(usageFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.warn("[dashboard] 读取每日用量日志失败: {}", e.getMessage());
            return Collections.emptyList();
        }
    }

    private static DashboardDTO emptyDashboard(int n, LocalDate today) {
        List<DashboardDTO.DailyStat> dailyStats = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            dailyStats.add(new DashboardDTO.DailyStat(
                    today.minusDays(n - 1 - i).format(DATE_FMT),
                    0, 0, 0, 0, 0, 0, 0, Collections.emptyMap()));
        }
        return new DashboardDTO(0, 0, 0, 0, 0, 0, 0, dailyStats, Collections.emptyList(), Collections.emptyMap());
    }

    private static double round4(double v) {
        return UsageCostCalculator.round4(v);
    }
}
