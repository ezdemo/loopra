# 后端边界与维护约定

## 依赖方向

`cutin` 提供循环、工具与插件基础设施；`loopra/bin` 实现 Agent、项目与配置能力；`loopra/web` 负责 HTTP、SSE 和应用编排。

`bin` 不得依赖 `web`。核心需要访问项目运行时能力时，通过 `ProjectRuntimeAccess` 接口接入；用量与 token 速率通过 `AgentOutput` 和 `TokenSpeed` 输出，由 `SseAgentOutput` 转换成既有 SSE 事件。核心代码无需识别 SSE 实现类。

`UsageReporter` 和 `SessionLifecycle` 仅接收所需回调与动态依赖供应器。新增协作者时应列出实际需要的能力，避免把完整 `AgentLoop` 作为通用上下文传入。

## 聊天任务与会话

- `ChatController` 校验输入、准备消息、创建输出并调用应用服务。
- `ChatTaskService` 拥有后台执行器、请求登记、取消和完成回调。默认最多同时执行 16 个请求，额外排队 64 个；重复活动请求 ID 被拒绝，队列满时返回明确错误。
- `SessionAgentRegistry` 拥有 Agent 缓存、会话锁和活动请求集合。同一会话串行执行，不同会话使用独立锁；锁在缓存淘汰后保持身份，避免等待者与新请求使用不同锁。
- `AgentService` 继续承担 Agent 创建和业务编排，通过登记表查询会话状态和释放缓存实例。

任务先登记再入队，因此排队请求也能被查询和取消。取消未开始任务会立即清理；取消运行中任务会发送中断，等待执行逻辑及其 `finally` 退出后再注销请求和关闭 SSE。完成回调只执行一次。先到达的取消请求保留最多五分钟，标记数量最多 1024 个。

缓存优先淘汰没有活动任务、没有持锁请求、也未运行的实例。繁忙会话允许暂时超过缓存目标容量，以保持停止请求可达。淘汰、清空和服务销毁均调用 Agent 的 `dispose()`，释放插件资源。已有会话锁保留至登记表销毁，内存占用随该进程访问过的会话数增长。

## HTTP 与 SSE 错误

聊天参数校验发生在建立 SSE 和写入粘贴内容之前。空消息需附带图片；`execute_plan` 可以不带消息。未知 action 和 mergeMode 返回 400，未配置模型返回 503。

SSE 建立前，`ServiceException` 的状态码和公开说明进入普通 API 响应；未知异常记录完整服务端日志，对外仅返回通用说明。建立 SSE 后，任务提交和执行错误通过 `error` 事件传达，再结束输出。客户端需要保留处理 SSE `error` 事件的逻辑。

## 配置持久化

更新和删除配置先在副本上应用改动，写入成功后再发布内存状态。保存使用同目录临时文件和原子替换；文件系统不支持原子移动时退回普通替换，临时文件在 `finally` 清理。写入失败向调用方抛出异常，不再报告成功或提前修改当前配置。

此机制保证单进程内的更新串行化；它不提供多个 Loopra 进程同时写同一份配置时的协调。

## 验证

在仓库根目录使用 JDK 17 和 Maven 3.9+：

```bash
mvn -B -ntp -gs .workflow/maven-central-settings.xml -s .workflow/maven-central-settings.xml clean test
pwsh -File .workflow/check-agent-boundaries.ps1
git diff --check
```

`backend-checks.yml` 对 `dev`、`main`、`master` 的推送和 PR 执行 Windows / Linux 测试矩阵，并用 `jdeps` 检查编译后的 `bin → web` 依赖。`.editorconfig` 约定后续编辑格式；没有对历史文件做全仓格式化。

## 后续拆分范围

`AgentService` 仍包含较多业务编排。后续可以围绕模型选择与 Agent 工厂、会话操作、项目 MCP 刷新分别提取服务，逐步建立对应行为测试。此次先明确任务、缓存、输出和配置的边界，避免同时改动所有业务入口。
