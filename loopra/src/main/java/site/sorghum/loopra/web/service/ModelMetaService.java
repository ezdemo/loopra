package site.sorghum.loopra.web.service;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Init;
import site.sorghum.loopra.web.model.meta.Cost;
import site.sorghum.loopra.web.model.meta.CostTier;
import site.sorghum.loopra.web.model.meta.Limit;
import site.sorghum.loopra.web.model.meta.Modalities;
import site.sorghum.loopra.web.model.meta.Model;
import site.sorghum.loopra.web.model.meta.ModelMeta;
import site.sorghum.loopra.web.model.meta.Provider;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

/**
 * 模型元数据服务 —— 管理本地模型元数据文件的初始化、更新与解析。
 * <p>
 * 功能：
 * 1. 检查 ~/.loopra/model_meta.json 文件是否存在且不为空。
 * 2. 如果文件为空或不存在，则从远程 API (https://models.dev/api.json) 下载模型元数据并保存到本地。
 * 3. 解析本地 JSON 文件为 ModelMeta 对象，提供便捷的查询方法。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class ModelMetaService {

    /**
     * 远程模型元数据 API 地址
     */
    private static final String MODEL_META_API_URL = "https://models.dev/api.json";

    /**
     * 本地模型元数据文件路径: ~/.loopra/model_meta.json
     */
    private static final Path MODEL_META_FILE = Paths.get(
            System.getProperty("user.home"), ".loopra", "model_meta.json");

    /**
     * HTTP 连接超时时间（秒）
     */
    private static final int CONNECT_TIMEOUT_SEC = 15;

    /**
     * HTTP 读取超时时间（秒）
     */
    private static final int READ_TIMEOUT_SEC = 60;

    /**
     * 缓存的模型元数据对象
     */
    @Getter
    private volatile ModelMeta modelMeta;

    /**
     * 初始化方法，在 Solon 容器启动后自动执行。
     * 检查本地模型元数据文件是否存在且不为空，如果为空则从远程下载。
     */
    @Init
    public void init() {
        log.info("[model-meta] 开始检查模型元数据文件: {}", MODEL_META_FILE);

        try {
            // 确保目录存在
            Path parentDir = MODEL_META_FILE.getParent();
            if (!Files.exists(parentDir)) {
                Files.createDirectories(parentDir);
                log.info("[model-meta] 创建目录: {}", parentDir);
            }

            // 检查文件是否存在且不为空
            if (Files.exists(MODEL_META_FILE) && Files.size(MODEL_META_FILE) > 0) {
                log.info("[model-meta] 本地模型元数据文件已存在且不为空，跳过下载。");
            } else {
                // 文件为空或不存在，开始下载
                log.info("[model-meta] 本地模型元数据文件为空或不存在，开始从远程下载: {}", MODEL_META_API_URL);
                String jsonContent = downloadModelMeta();

                if (jsonContent != null && !jsonContent.isEmpty()) {
                    // 保存到本地文件
                    Files.write(MODEL_META_FILE, jsonContent.getBytes(StandardCharsets.UTF_8));
                    log.info("[model-meta] 模型元数据已成功下载并保存到: {}", MODEL_META_FILE);
                } else {
                    log.error("[model-meta] 下载模型元数据失败：返回内容为空。");
                    return;
                }
            }

            // 解析本地文件
            parseModelMetaFile();

        } catch (IOException e) {
            log.error("[model-meta] 处理模型元数据文件时发生 I/O 错误: {}", e.getMessage(), e);
        } catch (Exception e) {
            log.error("[model-meta] 初始化模型元数据服务时发生未知错误: {}", e.getMessage(), e);
        }
    }

    /**
     * 从远程 API 下载模型元数据 JSON 内容。
     *
     * @return JSON 字符串内容，如果下载失败则返回 null
     */
    private String downloadModelMeta() {
        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
                .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
                .build();

        Request request = new Request.Builder()
                .url(MODEL_META_API_URL)
                .header("Accept", "application/json")
                .header("User-Agent", "opencode/1.14.21 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13")
                .get()
                .build();

        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                log.error("[model-meta] 下载模型元数据失败，HTTP 状态码: {}", response.code());
                return null;
            }

            String body = response.body() != null ? response.body().string() : null;
            if (body == null || body.isEmpty()) {
                log.error("[model-meta] 下载模型元数据失败：响应体为空。");
                return null;
            }

            log.info("[model-meta] 成功下载模型元数据，大小: {} 字节", body.length());
            return body;

        } catch (IOException e) {
            log.error("[model-meta] 下载模型元数据时发生网络错误: {}", e.getMessage(), e);
            return null;
        }
    }

    /**
     * 解析本地模型元数据 JSON 文件为 ModelMeta 对象。
     */
    private void parseModelMetaFile() {
        try {
            String jsonContent = Files.readString(MODEL_META_FILE, StandardCharsets.UTF_8);
            if (jsonContent == null || jsonContent.isEmpty()) {
                log.warn("[model-meta] 模型元数据文件内容为空，无法解析。");
                return;
            }

            ONode root = ONode.ofJson(jsonContent);
            if (root == null || !root.isObject()) {
                log.error("[model-meta] 模型元数据文件格式错误：根节点不是对象。");
                return;
            }

            Map<String, Provider> providers = new LinkedHashMap<>();
            int totalModels = 0;

            // 遍历所有提供商
            for (Map.Entry<String, ONode> entry : root.getObject().entrySet()) {
                String providerId = entry.getKey();
                if (!Objects.equals(providerId,"openrouter")){
                    continue;
                }
                ONode providerNode = entry.getValue();

                try {
                    Provider provider = parseProvider(providerId, providerNode);
                    if (provider != null) {
                        providers.put(providerId, provider);
                        totalModels += provider.getModelCount();
                    }
                } catch (Exception e) {
                    log.warn("[model-meta] 解析提供商 '{}' 失败: {}", providerId, e.getMessage());
                }
            }

            this.modelMeta = new ModelMeta(providers);
            log.info("[model-meta] 模型元数据解析完成：{} 个提供商，{} 个模型", providers.size(), totalModels);

        } catch (IOException e) {
            log.error("[model-meta] 读取模型元数据文件失败: {}", e.getMessage(), e);
        } catch (Exception e) {
            log.error("[model-meta] 解析模型元数据文件失败: {}", e.getMessage(), e);
        }
    }

    /**
     * 解析提供商节点为 Provider 对象。
     */
    private Provider parseProvider(String providerId, ONode providerNode) {
        if (providerNode == null || !providerNode.isObject()) {
            return null;
        }

        String npm = getStringValue(providerNode, "npm");
        String api = getStringValue(providerNode, "api");
        String name = getStringValue(providerNode, "name");
        String doc = getStringValue(providerNode, "doc");
        List<String> env = getStringListValue(providerNode, "env");

        // 解析模型
        Map<String, Model> models = new LinkedHashMap<>();
        ONode modelsNode = providerNode.get("models");
        if (modelsNode != null && modelsNode.isObject()) {
            for (Map.Entry<String, ONode> modelEntry : modelsNode.getObject().entrySet()) {
                String modelId = modelEntry.getKey();
                ONode modelNode = modelEntry.getValue();

                try {
                    Model model = parseModel(modelId, modelNode);
                    if (model != null) {
                        models.put(modelId, model);
                        // 如果模型存在/ 存单纯模型名称也存一份
                        if (modelId.contains("/")){
                            modelId = modelId.substring(modelId.lastIndexOf("/") + 1);
                            models.put(modelId, model);
                        }
                    }
                } catch (Exception e) {
                    log.warn("[model-meta] 解析模型 '{}' 失败: {}", modelId, e.getMessage());
                }
            }
        }

        return new Provider(providerId, env, npm, api, name, doc, models);
    }

    /**
     * 解析模型节点为 Model 对象。
     */
    private Model parseModel(String modelId, ONode modelNode) {
        if (modelNode == null || !modelNode.isObject()) {
            return null;
        }

        String name = getStringValue(modelNode, "name");
        String family = getStringValue(modelNode, "family");
        boolean attachment = getBooleanValue(modelNode, "attachment");
        boolean reasoning = getBooleanValue(modelNode, "reasoning");
        boolean toolCall = getBooleanValue(modelNode, "tool_call");
        boolean temperature = getBooleanValue(modelNode, "temperature");
        String knowledge = getStringValue(modelNode, "knowledge");
        String releaseDate = getStringValue(modelNode, "release_date");
        String lastUpdated = getStringValue(modelNode, "last_updated");
        boolean openWeights = getBooleanValue(modelNode, "open_weights");

        // 解析模态
        Modalities modalities = parseModalities(modelNode.get("modalities"));

        // 解析限制
        Limit limit = parseLimit(modelNode.get("limit"));

        // 解析成本
        Cost cost = parseCost(modelNode.get("cost"));

        return new Model(modelId, name, family, attachment, reasoning, toolCall,
                temperature, knowledge, releaseDate, lastUpdated,
                modalities, openWeights, limit, cost);
    }

    /**
     * 解析模态节点为 Modalities 对象。
     */
    private Modalities parseModalities(ONode modalitiesNode) {
        if (modalitiesNode == null || !modalitiesNode.isObject()) {
            return null;
        }

        List<String> input = getStringListValue(modalitiesNode, "input");
        List<String> output = getStringListValue(modalitiesNode, "output");

        return new Modalities(input, output);
    }

    /**
     * 解析限制节点为 Limit 对象。
     */
    private Limit parseLimit(ONode limitNode) {
        if (limitNode == null || !limitNode.isObject()) {
            return null;
        }

        long context = getLongValue(limitNode, "context");
        long output = getLongValue(limitNode, "output");

        return new Limit(context, output);
    }

    /**
     * 解析成本节点为 Cost 对象。
     */
    private Cost parseCost(ONode costNode) {
        if (costNode == null || !costNode.isObject()) {
            return null;
        }

        double input = getDoubleValue(costNode, "input");
        double output = getDoubleValue(costNode, "output");
        double cacheRead = getDoubleValue(costNode, "cache_read");
        double cacheWrite = getDoubleValue(costNode, "cache_write");

        // 解析分层定价
        List<CostTier> tiers = null;
        ONode tiersNode = costNode.get("tiers");
        if (tiersNode != null && tiersNode.isArray()) {
            tiers = new ArrayList<>();
            for (ONode tierNode : tiersNode.getArray()) {
                try {
                    CostTier tier = parseCostTier(tierNode);
                    if (tier != null) {
                        tiers.add(tier);
                    }
                } catch (Exception e) {
                    log.warn("[model-meta] 解析分层定价失败: {}", e.getMessage());
                }
            }
        }

        // 解析上下文超过 200k 的定价
        Cost.ContextOver200k contextOver200k = null;
        ONode contextOver200kNode = costNode.get("context_over_200k");
        if (contextOver200kNode != null && contextOver200kNode.isObject()) {
            double coInput = getDoubleValue(contextOver200kNode, "input");
            double coOutput = getDoubleValue(contextOver200kNode, "output");
            double coCacheRead = getDoubleValue(contextOver200kNode, "cache_read");
            contextOver200k = new Cost.ContextOver200k(coInput, coOutput, coCacheRead);
        }

        return new Cost(input, output, cacheRead, cacheWrite, tiers, contextOver200k);
    }

    /**
     * 解析分层定价节点为 CostTier 对象。
     */
    private CostTier parseCostTier(ONode tierNode) {
        if (tierNode == null || !tierNode.isObject()) {
            return null;
        }

        double input = getDoubleValue(tierNode, "input");
        double output = getDoubleValue(tierNode, "output");
        double cacheRead = getDoubleValue(tierNode, "cache_read");
        double cacheWrite = getDoubleValue(tierNode, "cache_write");

        // 解析分层条件
        CostTier.TierCondition tierCondition = null;
        ONode conditionNode = tierNode.get("tier");
        if (conditionNode != null && conditionNode.isObject()) {
            String type = getStringValue(conditionNode, "type");
            long size = getLongValue(conditionNode, "size");
            tierCondition = new CostTier.TierCondition(type, size);
        }

        return new CostTier(input, output, cacheRead, cacheWrite, tierCondition);
    }

    // ==================== 工具方法 ====================

    private String getStringValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && child.isValue()) ? child.getString() : null;
    }

    private List<String> getStringListValue(ONode node, String key) {
        ONode child = node.get(key);
        if (child == null || !child.isArray()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (ONode item : child.getArray()) {
            if (item.isValue()) {
                result.add(item.getString());
            }
        }
        return result;
    }

    private boolean getBooleanValue(ONode node, String key) {
        ONode child = node.get(key);
        return child != null && child.isValue() && child.getBoolean();
    }

    private long getLongValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && child.isValue()) ? child.getLong() : 0;
    }

    private double getDoubleValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && child.isValue()) ? child.getDouble() : 0.0;
    }

    // ==================== 公共方法 ====================

    /**
     * 获取本地模型元数据文件的路径。
     *
     * @return 模型元数据文件的 Path 对象
     */
    public Path getModelMetaFilePath() {
        return MODEL_META_FILE;
    }

    /**
     * 检查本地模型元数据文件是否存在且不为空。
     *
     * @return true 表示文件存在且不为空，false 表示文件不存在或为空
     */
    public boolean isModelMetaAvailable() {
        try {
            return Files.exists(MODEL_META_FILE) && Files.size(MODEL_META_FILE) > 0;
        } catch (IOException e) {
            log.warn("[model-meta] 检查模型元数据文件状态时发生错误: {}", e.getMessage());
            return false;
        }
    }

    /**
     * 检查模型元数据是否已成功解析。
     *
     * @return true 表示已解析，false 表示未解析或解析失败
     */
    public boolean isModelMetaParsed() {
        return modelMeta != null;
    }

    /**
     * 强制刷新本地模型元数据文件（重新下载并解析）。
     *
     * @return true 表示刷新成功，false 表示刷新失败
     */
    public boolean refreshModelMeta() {
        log.info("[model-meta] 强制刷新模型元数据文件...");
        try {
            String jsonContent = downloadModelMeta();
            if (jsonContent != null && !jsonContent.isEmpty()) {
                Files.write(MODEL_META_FILE, jsonContent.getBytes(StandardCharsets.UTF_8));
                log.info("[model-meta] 模型元数据已成功刷新，开始重新解析...");
                parseModelMetaFile();
                return modelMeta != null;
            } else {
                log.error("[model-meta] 刷新模型元数据失败：下载内容为空。");
                return false;
            }
        } catch (IOException e) {
            log.error("[model-meta] 刷新模型元数据时发生 I/O 错误: {}", e.getMessage(), e);
            return false;
        }
    }

    /**
     * 重新解析本地模型元数据文件（不重新下载）。
     *
     * @return true 表示解析成功，false 表示解析失败
     */
    public boolean reparseModelMeta() {
        log.info("[model-meta] 重新解析模型元数据文件...");
        parseModelMetaFile();
        return modelMeta != null;
    }

    /**
     * 获取所有提供商列表。
     *
     * @return 提供商列表，如果未解析则返回空列表
     */
    public List<Provider> getAllProviders() {
        return modelMeta != null ? modelMeta.getAllProviders() : List.of();
    }

    /**
     * 获取所有模型列表。
     *
     * @return 模型列表，如果未解析则返回空列表
     */
    public List<Model> getAllModels() {
        return modelMeta != null ? modelMeta.getAllModels() : List.of();
    }

    /**
     * 根据模型 ID 查找模型。
     *
     * @param modelId 模型 ID（如 "openai/gpt-5"）
     * @return 模型对象，如果未找到则返回 null
     */
    public Model findModelById(String modelId) {
        return modelMeta != null ? modelMeta.findModelById(modelId) : null;
    }

    /**
     * 搜索模型名称或 ID 中包含指定关键词的模型。
     *
     * @param keyword 关键词
     * @return 匹配的模型列表
     */
    public List<Model> searchModels(String keyword) {
        return modelMeta != null ? modelMeta.searchModels(keyword) : List.of();
    }

    /**
     * 获取指定提供商下的所有模型。
     *
     * @param providerId 提供商 ID
     * @return 模型列表，如果提供商不存在则返回空列表
     */
    public List<Model> getModelsByProvider(String providerId) {
        return modelMeta != null ? modelMeta.getModelsByProvider(providerId) : List.of();
    }

    /**
     * 获取提供商数量。
     *
     * @return 提供商数量
     */
    public int getProviderCount() {
        return modelMeta != null ? modelMeta.providers().size() : 0;
    }

    /**
     * 获取模型总数。
     *
     * @return 模型总数
     */
    public int getModelCount() {
        return modelMeta != null ? modelMeta.getAllModels().size() : 0;
    }
}