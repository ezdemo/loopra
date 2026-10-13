package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.bin.browser.AiBrowserBridgeService;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.BrowserBridgeRequest;
import site.sorghum.loopra.web.model.SystemHealthDTO;
import site.sorghum.loopra.web.model.SystemVersionDTO;

/**
 * 系统管理端点 —— 健康检查、版本查询。
 *
 * @author Sorghum
 */
@Api(tags = "系统")
@Controller
@Mapping("/api/system")
public class SystemController {

    @Inject
    private AiBrowserBridgeService browserBridgeService;

    /**
     * 健康检查 — 不需要版本注入，直接返回固定状态。
     */
    @ApiOperation(value = "健康检查", notes = "返回服务是否正常运行，无需 Agent 初始化即可访问")
    @Get
    @Mapping("/health")
    public ApiResponse<SystemHealthDTO> health() {
        String version = readVersion();
        return ApiResponse.ok(new SystemHealthDTO("ok", version, ""));
    }

    /**
     * 获取版本信息 — 从 Solon 配置读取 Maven 注入的版本号。
     */
    @ApiOperation(value = "获取版本信息", notes = "返回当前 Loopra 的运行版本和名称")
    @Get
    @Mapping("/version")
    public ApiResponse<SystemVersionDTO> version() {
        String version = readVersion();
        String name = org.noear.solon.Solon.cfg().get("solon.app.name");
        return ApiResponse.ok(new SystemVersionDTO(version, "", name));
    }

    @ApiOperation(value = "登记本机 AI 浏览器桥接地址", notes = "仅 Electron 桌面端在启动服务后调用；地址仅保存在当前服务进程中")
    @Post
    @Mapping("/browser-bridge")
    public ApiResponse<String> registerBrowserBridge(@Body BrowserBridgeRequest request) {
        try {
            String address = browserBridgeService.setAddress(request == null ? null : request.getAddress());
            return ApiResponse.ok(address);
        } catch (IllegalArgumentException e) {
            return ApiResponse.fail(e.getMessage());
        }
    }

    /**
     * 读取本机 AI 浏览器桥接状态 —— 桌面端未登记时 {@code address} 为空。
     */
    @ApiOperation(value = "读取本机 AI 浏览器桥接状态", notes = "返回 Electron 桌面端登记的本机浏览器桥接地址；未登记时 address 为空字符串")
    @Get
    @Mapping("/browser-bridge")
    public ApiResponse<java.util.Map<String, Object>> browserBridgeStatus() {
        String address = browserBridgeService.getAddress();
        boolean registered = address != null && !address.isBlank();
        java.util.Map<String, Object> status = new java.util.LinkedHashMap<>();
        status.put("registered", registered);
        status.put("address", registered ? address : "");
        return ApiResponse.ok(status);
    }

    /**
     * 从 Solon 配置读取版本号（由 Maven 资源过滤从 pom.xml 注入）。
     */
    private String readVersion() {
        String v = org.noear.solon.Solon.cfg().get("solon.app.version");
        return (v != null && !v.isEmpty()) ? v : "unknown";
    }
}
