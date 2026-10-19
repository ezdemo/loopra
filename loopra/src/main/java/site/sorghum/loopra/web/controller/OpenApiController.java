package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Post;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.OpenApiSourceDTO;
import site.sorghum.loopra.web.service.OpenApiManageService;

import java.util.List;
import java.util.Map;

/**
 * OpenAPI 管理控制器 —— 提供 OpenAPI 源的注册、查询、移除和接口搜索。
 *
 * @author Sorghum
 */
@Api(tags = "OpenAPI 管理")
@Controller
@Mapping("/api/openapi")
public class OpenApiController {

    @Inject
    private OpenApiManageService openApiManageService;

    @ApiOperation(value = "获取所有 OpenAPI 源", notes = "返回所有已注册的 OpenAPI 接口源列表")
    @Get
    @Mapping("/sources")
    public ApiResponse<List<OpenApiSourceDTO>> listSources() {
        return ApiResponse.ok(openApiManageService.getSources());
    }

    @ApiOperation(value = "关键词搜索接口文档",
            notes = "通过关键词在已注册的 OpenAPI 文档中搜索匹配的接口。支持多关键词空格分隔（如 '订单 查询'），按 AND 逻辑匹配")
    @Get
    @Mapping("/search")
    public ApiResponse<Object> searchApis(
            @ApiParam(value = "搜索关键词，多关键词用空格分隔", required = true)
            @Param(value = "keyword", required = true) String keyword) {
        if (keyword == null || keyword.isBlank()) {
            throw new ServiceException("keyword 不能为空");
        }
        return ApiResponse.ok(openApiManageService.searchApis(keyword));
    }

    @ApiOperation(value = "注册 OpenAPI 源",
            notes = "注册一个新的 OpenAPI (Swagger) 接口源，支持 Bearer Token / API Key / Basic 三种认证")
    @Post
    @Mapping("/sources")
    public ApiResponse<OpenApiSourceDTO> addSource(@ApiParam(value = "注册请求体") @Body OpenApiAddRequest request) {
        if (request.docUrl == null || request.docUrl.isBlank()) {
            throw new ServiceException("docUrl 不能为空");
        }
        String authType = request.authType != null ? request.authType : "none";
        OpenApiSourceDTO result = openApiManageService.addSource(
                request.docUrl, request.headers,
                authType, request.authConfig);
        if ("error".equals(result.getStatus())) {
            return ApiResponse.fail("OpenAPI 源注册失败: " + result.getErrorMessage());
        }
        return ApiResponse.ok(result);
    }

    @ApiOperation(value = "移除 OpenAPI 源", notes = "根据 docUrl 移除一个已注册的 OpenAPI 接口源")
    @Delete
    @Mapping("/sources")
    public ApiResponse<Void> removeSource(
            @ApiParam(value = "{\"docUrl\":\"...\"}") @Body OpenApiRemoveRequest request) {
        if (request.docUrl == null || request.docUrl.isBlank()) {
            throw new ServiceException("docUrl 不能为空");
        }
        boolean removed = openApiManageService.removeSource(request.docUrl);
        if (!removed) {
            return ApiResponse.fail("移除失败，请检查 docUrl 是否正确");
        }
        return ApiResponse.ok(null);
    }

    @ApiOperation(value = "刷新 OpenAPI 源", notes = "重新加载指定 OpenAPI 接口源的定义")
    @Put
    @Mapping("/sources/refresh")
    public ApiResponse<OpenApiSourceDTO> refreshSource(@ApiParam(value = "刷新请求体") @Body OpenApiAddRequest request) {
        if (request.docUrl == null || request.docUrl.isBlank()) {
            throw new ServiceException("docUrl 不能为空");
        }
        String authType = request.authType != null ? request.authType : "none";
        OpenApiSourceDTO result = openApiManageService.refreshSource(
                request.docUrl, request.headers,
                authType, request.authConfig);
        if ("error".equals(result.getStatus())) {
            return ApiResponse.fail("OpenAPI 源刷新失败: " + result.getErrorMessage());
        }
        return ApiResponse.ok(result);
    }

    // ==================== 请求体 ====================

    public static class OpenApiAddRequest {
        public String docUrl;
        public Map<String, String> headers;
        public String authType;
        public Map<String, String> authConfig;
    }

    public static class OpenApiRemoveRequest {
        public String docUrl;
    }
}
