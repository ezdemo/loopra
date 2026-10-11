package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.bin.lsp.LspManageService;
import site.sorghum.loopra.bin.lsp.LspServerConfig;
import site.sorghum.loopra.bin.lsp.LspServerDTO;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ApiResponse;

import java.util.List;
import java.util.stream.Collectors;

/**
 * LSP 服务器管理控制器 —— 提供 LSP 服务器的增删改查、启停及安装状态检测。
 * <p>
 * 接口设计参考 {@code McpController}，适配 loopra REST API 风格。
 * </p>
 *
 * @author Sorghum
 */
@Api(tags = "LSP 服务器管理")
@Controller
@Mapping("/api/lsp")
public class LspController {

    @Inject
    private LspManageService lspManageService;

    // ==================== 服务器列表 ====================

    @ApiOperation(value = "获取所有 LSP 服务器", notes = "返回所有已注册的 LSP 服务器配置列表")
    @Get
    @Mapping("/servers")
    public ApiResponse<List<LspServerDTO>> listServers() {
        List<LspServerDTO> dtos = lspManageService.listServers().stream()
                .map(LspServerDTO::fromConfig)
                .collect(Collectors.toList());
        return ApiResponse.ok(dtos);
    }

    // ==================== 新增服务器 ====================

    @ApiOperation(value = "新增 LSP 服务器", notes = "新增一个 LSP 服务器配置")
    @Post
    @Mapping("/servers/add")
    public ApiResponse<LspServerDTO> addServer(
            @ApiParam(value = "LSP 服务器配置") @Body LspServerDTO server) {
        // 校验必填字段
        validateServer(server);
        LspServerConfig config = server.toConfig();
        LspServerConfig result = lspManageService.addServer(config);
        return ApiResponse.ok(LspServerDTO.fromConfig(result));
    }

    // ==================== 更新服务器 ====================

    @ApiOperation(value = "更新 LSP 服务器", notes = "更新已有 LSP 服务器配置，可通过 originalName 指定原名称以便重命名")
    @Post
    @Mapping("/servers/update")
    public ApiResponse<LspServerDTO> updateServer(
            @ApiParam(value = "更新请求体") @Body LspUpdateRequest request) {
        if (request.server == null) {
            throw new ServiceException("server 不能为空");
        }
        validateServer(request.server);
        LspServerConfig config = request.server.toConfig();
        LspServerConfig result = lspManageService.updateServer(request.originalName, config);
        return ApiResponse.ok(LspServerDTO.fromConfig(result));
    }

    // ==================== 删除服务器 ====================

    @ApiOperation(value = "删除 LSP 服务器", notes = "根据名称删除一个 LSP 服务器配置（系统内置不可删除）")
    @Post
    @Mapping("/servers/remove")
    public ApiResponse<String> removeServer(
            @ApiParam(value = "{\"name\":\"...\"}") @Body LspNameRequest request) {
        if (request.name == null || request.name.isBlank()) {
            throw new ServiceException("名称不能为空");
        }
        if (lspManageService.isSystemServer(request.name)) {
            throw new ServiceException("系统内置服务器不可删除");
        }
        lspManageService.removeServer(request.name);
        return ApiResponse.ok("服务器已删除");
    }

    // ==================== 启停控制 ====================

    @ApiOperation(value = "启用/禁用 LSP 服务器", notes = "切换 LSP 服务器的启用状态")
    @Post
    @Mapping("/servers/toggle")
    public ApiResponse<LspServerDTO> toggleServer(
            @ApiParam @Body LspToggleRequest request) {
        if (request.name == null || request.name.isBlank()) {
            throw new ServiceException("名称不能为空");
        }
        LspServerConfig result = lspManageService.toggleServer(request.name, request.enabled);
        if (result == null) {
            throw new ServiceException("未找到指定服务器: " + request.name);
        }
        return ApiResponse.ok(LspServerDTO.fromConfig(result));
    }

    // ==================== 安装检测 ====================

    @ApiOperation(value = "检测 LSP 服务器安装状态", notes = "检测指定服务器命令是否在系统 PATH 中可用")
    @Post
    @Mapping("/servers/check")
    public ApiResponse<String> checkInstallation(
            @ApiParam(value = "{\"name\":\"...\"}") @Body LspNameRequest request) {
        if (request.name == null || request.name.isBlank()) {
            throw new ServiceException("名称不能为空");
        }
        LspServerConfig server = lspManageService.listServers().stream()
                .filter(s -> s.getName().equals(request.name))
                .findFirst()
                .orElse(null);
        if (server == null) {
            throw new ServiceException("未找到指定服务器: " + request.name);
        }
        boolean ok = lspManageService.checkInstallation(server);
        if (ok) {
            return ApiResponse.ok("命令可用");
        } else {
            return ApiResponse.fail("命令不可用，请确认已安装对应的 LSP 服务器");
        }
    }

    // ==================== 内部校验 ====================

    /**
     * 校验 LSP 服务器配置的必填字段。
     */
    private void validateServer(LspServerDTO server) {
        if (server.getName() == null || server.getName().isBlank()) {
            throw new ServiceException("名称为必填项");
        }
        if (!server.getName().matches("^[a-zA-Z0-9_-]+$")) {
            throw new ServiceException("名称仅允许字母、数字、下划线和连字符");
        }
        if (server.getCommand() == null || server.getCommand().isBlank()) {
            throw new ServiceException("命令为必填项");
        }
    }

    // ==================== 请求体内部类 ====================

    /**
     * 更新请求体：包含原名称和目标配置。
     */
    public static class LspUpdateRequest {
        /** 原名称（编辑时用于查找，为空时按新增处理） */
        public String originalName;
        /** 新的服务器配置 */
        public LspServerDTO server;
    }

    /**
     * 名称请求体。
     */
    public static class LspNameRequest {
        public String name;
    }

    /**
     * 启停请求体。
     */
    public static class LspToggleRequest {
        public String name;
        public boolean enabled;
    }
}
