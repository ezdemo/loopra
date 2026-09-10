package site.sorghum.loopra.bin.builtin;

import okhttp3.*;
import org.noear.snack4.ONode;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.bin.browser.AiBrowserBridgeService;
import site.sorghum.loopra.tool.*;

import java.io.IOException;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 调用 Electron AI 浏览器的本地桥接服务。
 * Electron 未运行时，工具会明确返回不可用状态，不会退化为后台网络请求。
 */
@Component
public class AiBrowserTool extends AbsToolProvider implements SolonToTools {
    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.MINUTES)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build();

    @Inject
    private AiBrowserBridgeService browserBridgeService;

    @ToolMapping(name = "browser_new_tab", description = """
            在 Loopra Electron AI 浏览器中创建并激活一个新标签页。url 可省略以创建空白页；传入网址后会等待基础页面加载完成。
            只能浏览 HTTP 或 HTTPS 地址。超过 16 个标签页仍允许创建，但结果会要求清理不再需要的非活动标签；达到 20 个硬上限时，先调用 browser_tabs 和 browser_close_tab 清理后再重试一次。
            工具会返回 sessionId 和 tabId；后续调用应复用它们，避免多个 Agent 或 MCP 客户端互相干扰。能在当前标签页完成的导航应使用 browser_navigate，不要无意义创建新标签。后续操作请先调用 browser_screenshot 获取页面的清洗结构和元素 ID。
            """)
    public String newTab(@Param(name = "url", description = "要打开的 HTTP(S) 地址；为空时创建空白标签页", required = false) String url,
                         @Param(name = "browserSessionId", description = "浏览器会话 ID；首次创建可留空，结果中的 sessionId 应用于后续调用", required = false) String browserSessionId,
                         @Param(name = "ctx", required = false) ToolContext ctx) {
        return call("new-tab", withSession(new ONode().set("url", safe(url)), browserSessionId, ctx));
    }

    @ToolMapping(name = "browser_tabs", description = "返回当前浏览器会话中的所有标签页、激活标签页 ID、地址、标题及前进后退状态。")
    public String tabs(@Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                       @Param(name = "ctx", required = false) ToolContext ctx) {
        // 空 ONode 的 Snack4 JSON 表示是 null；bridge 端需要一个 JSON 对象。
        return call("tabs", withSession(ONode.ofJson("{}"), browserSessionId, ctx));
    }

    @ToolMapping(name = "browser_navigate", description = "让当前浏览器会话中的指定标签页跳转到新的 HTTP(S) 地址。tabId 从 browser_tabs 或 browser_new_tab 的结果中取得。")
    public String navigate(@Param(name = "tabId", description = "目标浏览器标签页 ID") String tabId,
                           @Param(name = "url", description = "要打开的 HTTP(S) 地址") String url,
                           @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                           @Param(name = "ctx", required = false) ToolContext ctx) {
        return call("navigate", withSession(new ONode().set("tabId", safe(tabId)).set("url", safe(url)), browserSessionId, ctx));
    }

    @ToolMapping(name = "browser_screenshot", description = """
            等待指定标签页成功加载后，返回清洗后的结构化 HTML 页面快照及当前可见视口的图片；页面加载失败或超过 30 秒会返回明确错误。
            视口截图仅在当前模型支持图片输入时附带；否则只返回结构化快照，不会附带图片。
            结果中的 elements 是优先使用的可操作元素列表，会识别原生控件、ARIA 控件、可聚焦元素、开放 Shadow DOM 和 cursor:pointer 的自定义控件；每项含可访问名称、表单状态、坐标、是否可见/被遮挡及所在上下文。
            overlays 和 notices 分别表示当前弹层/下拉框与提示错误，优先处理；viewport 表示页面滚动状态。visibleText 是当前页面及 iframe 已渲染的可见正文（兼容 SPA、SAP/UI5 和深层组件树），renderedHtml.documents 是按主文档/iframe 返回的运行时 DOM HTML（Electron 会逐 frame 读取，已清理工具内部标记、敏感输入值并设置大小上限），frames 表示 iframe 的可访问性，html 是经过自适应语义深度、节点数和无效节点过滤的辅助 DOM 树：透明布局 wrapper 会折叠，空节点和装饰图片会过滤，语义/交互节点会保留。密码、验证码、OTP 和令牌输入值不会返回，也不能通过 browser_act 自动填写。
            每次快照返回 snapshotId。调用 browser_act 时必须同时传入该 snapshotId；任何页面导航或操作后都必须重新调用本工具。
            """)
    public String screenshot(@Param(name = "tabId", description = "目标标签页 ID；为空时使用当前激活标签页", required = false) String tabId,
                             @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                             @Param(name = "ctx", required = false) ToolContext ctx) {
        return postProcessScreenshot(call("screenshot", withSession(new ONode().set("tabId", safe(tabId)), browserSessionId, ctx)), ctx);
    }

    /**
     * 根据当前模型的图片输入能力处理截图结果：
     * 支持或无法判断时附带截图图片；明确不支持时去除图片，仅回传结构化快照。
     */
    static String postProcessScreenshot(String result, ToolContext ctx) {
        if (result == null || isBrowserFailure(result)) return result;
        try {
            ONode data = ONode.ofJson(result).get("data");
            String imageUrl = data.get("imageUrl").getString();
            if (imageUrl == null || imageUrl.isBlank()) return result;
            String detail = data.get("imageDetail").getString();
            data.remove("imageUrl");
            data.remove("imageDetail");
            if (!ImageReadTool.supportsImageInput(ctx)) {
                data.set("imageOmitted", "当前模型不支持图片输入，未附带视口截图，请依据 elements 和 html 理解页面");
                return data.toJson();
            }
            return ImageReadTool.imageResult(data.toJson(), imageUrl, detail);
        } catch (Exception e) {
            return result;
        }
    }

    @ToolMapping(name = "browser_act", description = """
            操作 browser_screenshot 返回的元素 ID。action 可为 click、click_at、fill、select、press、scroll。
            fill 的 value 是输入文本；select 的 value 是 option value；press 的 value 是按键名，默认为 Enter。
            click_at 会使用 Electron 的浏览器级鼠标事件，适合需要真实用户手势的控件。snapshotId 必须传入对应 browser_screenshot 的 snapshotId，过期快照会被拒绝。不接受 CSS Selector、XPath 或任意 JavaScript。元素 ID 失效时重新调用 browser_screenshot。
            """)
    public String act(@Param(name = "tabId", description = "目标标签页 ID；为空时使用当前激活标签页", required = false) String tabId,
                      @Param(name = "targetId", description = "browser_screenshot 返回的元素 ID，例如 e3") String targetId,
                      @Param(name = "action", description = "click、click_at、fill、select、press 或 scroll") String action,
                      @Param(name = "value", description = "fill/select/press 使用的值；click 和 scroll 可为空", required = false) String value,
                      @Param(name = "snapshotId", description = "browser_screenshot 返回的 snapshotId；必须传入以防止操作过期页面", required = true) String snapshotId,
                      @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                      @Param(name = "ctx", required = false) ToolContext ctx) {
        return call("act", withSession(new ONode()
                .set("tabId", safe(tabId))
                .set("targetId", safe(targetId))
                .set("action", safe(action))
                .set("value", safe(value))
                .set("snapshotId", safe(snapshotId)), browserSessionId, ctx));
    }

    @ToolMapping(name = "browser_scroll", description = """
            在当前浏览器会话的指定标签页中滚动页面，触发懒加载并等待页面稳定。direction 可为 up、down、top 或 bottom；默认 down。
            滚动后之前的 browser_screenshot 快照会失效，继续操作前必须重新获取快照。
            """)
    public String scroll(@Param(name = "tabId", description = "目标浏览器标签页 ID；为空时使用当前激活标签页", required = false) String tabId,
                         @Param(name = "direction", description = "滚动方向：up、down、top 或 bottom；默认 down", required = false) String direction,
                         @Param(name = "amount", description = "up/down 的滚动像素，默认 800", required = false) Integer amount,
                         @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                         @Param(name = "ctx", required = false) ToolContext ctx) {
        return call("scroll", withSession(new ONode()
                .set("tabId", safe(tabId))
                .set("direction", safe(direction))
                .set("amount", amount == null ? 800 : amount), browserSessionId, ctx));
    }

    @ToolMapping(name = "browser_request_user_action", description = """
            浏览器遇到必须由用户完成的登录、验证码、人机验证、二维码扫描、短信或邮箱确认、安全验证时调用。
            此工具会聚焦目标浏览器标签页，并在聊天中向用户显示“我已完成 / 取消”的接管提示，然后暂停当前 AI 操作。
            不得尝试绕过认证或验证，不得索要、填写或读取密码、验证码、Cookie、令牌等敏感凭据。用户确认完成后，再调用 browser_screenshot 获取最新页面状态。
            """)
    public String requestUserAction(
            @Param(name = "tabId", description = "需要用户操作的标签页 ID；为空时使用当前激活标签页", required = false) String tabId,
            @Param(name = "message", description = "说明用户需要在网页中完成什么操作，例如“请登录后点击我已完成”") String message,
            @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
            @Param(name = "ctx", required = false) ToolContext ctx) {
        String focused = call("request-user-action", withSession(new ONode()
                .set("tabId", safe(tabId))
                .set("message", safe(message)), browserSessionId, ctx));
        if (isBrowserFailure(focused)) return focused;

        AgentLoopController controller = ctx == null ? null : ctx.getLoopController();
        // 外部 MCP 没有 Loopra 的 AgentLoopController。Electron 已经聚焦浏览器并进入
        // waiting 状态，此时把结构化结果交给 MCP 客户端，由下一次截图继续，而不是伪造
        // 一个不可恢复的 NO_CONTROLLER 错误。
        if (controller == null) return focused;
        AgentOutput output = controller.getOutput();
        if (output == null) return ErrorCodes.NO_OUTPUT + ": 没有可用的输出通道，无法请求用户接管浏览器";

        String result = output.ask(safe(message), List.of(
                Map.of("title", "我已完成，可以继续", "value", "completed"),
                Map.of("title", "取消这次浏览器操作", "value", "cancelled")
        ), false);
        controller.requestStop();
        return result;
    }

    @ToolMapping(name = "browser_close_tab", description = "关闭指定 AI 浏览器标签页；tabId 为空时关闭当前激活标签页。")
    public String closeTab(@Param(name = "tabId", description = "要关闭的标签页 ID；为空时关闭当前标签页", required = false) String tabId,
                           @Param(name = "browserSessionId", description = "浏览器会话 ID；为空时使用当前工具会话或桌面默认会话", required = false) String browserSessionId,
                           @Param(name = "ctx", required = false) ToolContext ctx) {
        return call("close-tab", withSession(new ONode().set("tabId", safe(tabId)), browserSessionId, ctx));
    }

    private String call(String method, ONode payload) {
        String baseUrl = browserBridgeService == null ? "" : browserBridgeService.getAddress();
        if (baseUrl == null || baseUrl.isBlank()) {
            return failure("BRIDGE_UNAVAILABLE", "Loopra Desktop has not registered its browser bridge yet");
        }
        Request request = new Request.Builder()
                .url(baseUrl + "/browser/" + method)
                .post(RequestBody.create(payload.toJson(), JSON))
                .build();
        try (Response response = client.newCall(request).execute()) {
            String body = response.body() == null ? "" : response.body().string();
            if (response.isSuccessful()) return body;
            return body.isBlank()
                    ? failure("BRIDGE_ERROR", "Electron AI browser rejected the request")
                    : body;
        } catch (IOException e) {
            return failure("BRIDGE_UNAVAILABLE", "Start Loopra Desktop before using browser tools: " + e.getMessage());
        }
    }

    private ONode withSession(ONode payload, String requestedSessionId, ToolContext ctx) {
        String sessionId = safe(requestedSessionId).trim();
        if (sessionId.isBlank() && ctx != null) {
            String contextSessionId = safe(ctx.getSessionId()).trim();
            if (!"mcp".equalsIgnoreCase(contextSessionId)) sessionId = contextSessionId;
        }
        // 外部 MCP 当前没有可靠的 transport session 注入；留空让 Electron 使用默认会话，
        // 同时允许 MCP 客户端复用 browser_new_tab 返回的 sessionId 做显式隔离。
        if (!sessionId.isBlank()) payload.set("sessionId", sessionId);
        return payload;
    }

    static boolean isBrowserFailure(String result) {
        if (result == null) return false;
        if (result.startsWith("BROWSER_UNAVAILABLE:") || result.startsWith("BROWSER_ERROR:")) return true;
        try {
            ONode success = ONode.ofJson(result).get("success");
            return success != null && !success.isNull() && success.isValue() && !success.getBoolean();
        } catch (Exception ignored) {
            return false;
        }
    }

    private String failure(String code, String message) {
        return new ONode()
                .set("success", false)
                .set("error", new ONode().set("code", code).set("message", safe(message)))
                .toJson();
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return this.getTools();
    }
}
