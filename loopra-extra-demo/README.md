# loopra-extra-demo — Loopra 拓展包示例

一个完整的 Solon H-SPI 拓展包示例，演示四种能力如何组合进一个 jar：

| 能力 | 实现 | 说明 |
|---|---|---|
| **桥接 SPI** | `DemoExtPackBridge` | 通过 `META-INF/services/...LoopraExtPackBridge` 声明，启动后自动注册进全部存活 AgentLoop |
| **工具** | `DemoServerTimeTool` / `DemoGreetingTool` | 服务器时间（带 format 参数）、问候（必填 name 参数），含成功/失败两种返回路径 |
| **拦截器** | `DemoExtPackBridge.interceptors()` | `BEFORE_STEP` 每步在 `LoopContext` 写变量 `demoExtApplied` |
| **路由** | `DemoExtController` | `@Controller` + `beanMake` 挂载：`GET /api/ext-demo/health`、`GET /api/ext-demo/time` |
| **Solon 插件** | `DemoExtPackPlugin` | 通过 `META-INF/solon/extpack.properties` 声明，演示 `start/preStop/stop` 生命周期 |

## 构建

```bash
# 前提：loopra 26.9.91 与 cutin 1.0-SNAPSHOT 已安装到本地仓库
#   mvn install -pl loopra -am -DskipTests   （在 loopra 仓库根目录）

mvn package        # 产出 target/loopra-extra-demo-1.0.0.jar
mvn test           # 全链路冒烟：安装 → 容器启动 → 桥接 → 停止 → 卸载
```

jar 文件名遵循 `{id}-{version}.jar` 约定：安装后 id=`loopra-extra-demo`、version=`1.0.0`。

## 安装（两种方式）

**方式一：设置页**（Loopra 启动后）
1. 打开「设置 → 拓展包」
2. 粘贴 jar 的绝对路径（或 http(s) 直链）→ 点击「安装」
3. 列表出现 `loopra-extra-demo v1.0.0` 且状态为「运行中」即成功

**方式二：REST API**

```bash
curl -X POST http://localhost:4567/api/extpacks/install \
  -H "Content-Type: application/json" \
  -d '{"source": "D:/path/to/loopra-extra-demo-1.0.0.jar"}'
```

## 验证

安装并启动后：

```bash
# 1. 路由（H-SPI 容器挂载）
curl http://localhost:4567/api/ext-demo/health
curl http://localhost:4567/api/ext-demo/time

# 2. 桥接与状态
curl http://localhost:4567/api/extpacks
```

Agent 对话中可直接使用工具 `demo-server-time`（如"现在几点？"）与 `demo-greeting`。

## 目录结构

```
loopra-extra-demo/
├── pom.xml                          # 依赖全部 provided（运行期由宿主提供）
└── src/
    ├── main/
    │   ├── java/site/sorghum/loopra/extra/demo/
    │   │   ├── DemoExtPackBridge.java    # 桥接 SPI：工具 + 拦截器
    │   │   ├── DemoServerTimeTool.java   # 示例工具 1
    │   │   ├── DemoGreetingTool.java     # 示例工具 2
    │   │   ├── DemoExtController.java    # 示例路由
    │   │   └── DemoExtPackPlugin.java    # Solon 插件生命周期
    │   └── resources/META-INF/
    │       ├── services/site.sorghum.loopra.integration.extpack.LoopraExtPackBridge   # 桥接声明
    │       └── solon/extpack.properties   # Solon 插件声明（solon.plugin=...）
    └── test/java/site/sorghum/loopra/extra/demo/
        └── DemoExtPackSmokeTest.java     # 全链路冒烟测试
```

## 开发要点

1. **桥接声明**：`META-INF/services/...LoopraExtPackBridge` 一行一个实现类（须 public 无参构造）
2. **Solon 插件声明**：`META-INF/solon/extpack.properties` 里 `solon.plugin=FQCN`
3. **路由挂载**：在插件 `start(AppContext)` 里 `context.beanMake(DemoExtController.class)`
4. **生命周期**：Solon 4.x 的 `Plugin` 接口为 `start(AppContext)` / `preStop()` / `stop()`
5. **依赖 scope**：一律 `provided`——运行期由 Loopra 宿主进程提供，jar 保持轻量
