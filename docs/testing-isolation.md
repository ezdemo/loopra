# 测试数据隔离

后端 JUnit 测试通过 `src/test/resources/META-INF/services/org.junit.platform.launcher.LauncherSessionListener`
自动加载 `IsolatedTestHome`。监听器在测试发现和业务类初始化之前创建独立的临时用户目录。
项目注册表、默认会话、用量、配置等所有依赖 `user.home` 的存储都写入该目录，
测试结束后清理。Maven 和支持 JUnit Platform 的 IDE 运行器都使用这个入口。

不要再靠项目名包含 `junit` 来过滤测试项目：这不能隔离会话或配置，也不能覆盖任意名称的测试项目。
新增存储测试优先通过 `@TempDir` 注入路径；需要验证默认路径时使用进程的隔离目录，
不要设置 `user.home` 为开发者真实目录。`ProjectRegistryTest` 验证默认项目和默认会话都位于
`loopra.test.home`，并检查同名项目的会话目录互不混用。

运行后端测试：

```sh
mvn -pl loopra -am test
```

前端协议测试使用模拟 `fetch`，不连接正在使用的后端：

```sh
cd loopra-front
pnpm test:web
pnpm typecheck:web
pnpm build
```

需要真实模型或浏览器端到端测试时，另起后端进程，通过 JVM 参数 `-Duser.home=<独立临时目录>`
指定测试数据根目录，并使用独立端口。不要复用日常运行的后端来创建测试工作区或测试会话。
测试配置只包含测试所需内容，不复制日常工作区和会话文件。测试后关闭进程再清理该临时目录。
