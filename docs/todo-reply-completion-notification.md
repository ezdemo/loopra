# TODO：回复完成通知的落点

状态：**提示已删除，后续方案待定（用户暂缓讨论）**
日期：2026-10-10

## 已做的事

删除了 Web 界面里的应用内完成提示，原代码位于 `loopra-front/web/src/App.tsx`：

```tsx
// 删除前（流式请求成功后）
completed = true;
if (preferences.notifications && !activeRequest.current?.stopping) notify('回复已完成');
```

```tsx
// 删除后
completed = true;
```

删除原因：用户正在界面前盯着回复，再弹一句「✓ 回复已完成」属于多此一举；该提示不该出现在应用内 toast 里。

验证：`pnpm typecheck:web` 通过；`pnpm test:web` 34 项全绿。

## 待定问题

完成通知**应该放在哪里**（用户表示"后面再说"）。已确认的现状：

| 入口 | 实现 | 位置 | 性质 |
|---|---|---|---|
| Web 版（`pnpm dev` :3000） | 应用内 toast | `App.tsx:220`（已删） | ❌ 界面内，多此一举 |
| 桌面版（Vue/Electron） | 桌面宠物气泡 | `src/views/Chat.vue:1692` → `desktopPet.showReply` | 系统级 |
| 桌面版（宠物未显示时） | 原生系统通知 | `electron/main.cjs:999` `new Notification({title:'Loopra 收到 AI 回复'})` | 系统级，点击可唤起窗口 |

结论：桌面版已有正确做法（系统级通知 + 点击聚焦窗口），Web 版此前是退化实现。

## 候选方案

1. **改为"仅后台时"发系统通知**（曾推荐）：页面 `visibilitychange` 切到后台时才用浏览器 `Notification`，设置开关保留且真正生效。需首次授权。
2. **完全删除并清理设置项**：彻底不提醒，同时移除设置里的「系统通知」开关。
3. **保留设置开关但无效果**：不推荐，会留下拨了没反应的摆设。

## 连带影响（决定方案时必须一并处理）

`preferences.notifications` 这个偏好**全仓库只被已删除的那一行使用**，其余引用仅剩类型与设置 UI：

- `web/src/components/Settings.tsx:17` 类型定义 `notifications: boolean`
- `web/src/components/Settings.tsx:18` 默认值 `notifications: true`
- `web/src/components/Settings.tsx:81` 「系统通知」开关（描述："回答完成时显示应用内通知"，默认开启）

因此：
- 选方案 1 → 保留该偏好，接线到新的系统通知逻辑。
- 选方案 2 → 需同时删除上述三处，否则留下无效开关。

## 不受影响

错误提示走独立分支（`App.tsx:221-223`，如「请求失败：…」「本次回复已停止。」），未改动。
其他 `notify()` 调用（保存成功、复制成功、重命名等）照常，`Toast` 组件（`components/Motion.tsx:62`）继续保留。
