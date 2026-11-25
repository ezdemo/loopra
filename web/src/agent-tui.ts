export type TuiContext = {
  chatMode: boolean;
  surface: boolean;
  // 已有会话选中：会话模式在创建时固定，只在新建草稿上能创建 TUI 会话。
  session: boolean;
  busy: boolean;
};

export function isExternalAgent(agentId: string): boolean {
  return !!agentId && agentId !== 'native';
}

// TUI 入口只在项目新建草稿上对外部 Agent 开放；运行中的任务可能
// 占着 ACP 进程，此时按钮留灰而不是藏起来。
export function canUseTui(agentId: string, context: Pick<TuiContext, 'chatMode' | 'surface' | 'session'>): boolean {
  return isExternalAgent(agentId) && !context.chatMode && !context.surface && !context.session;
}

export function tuiDisabledReason(agentId: string, context: TuiContext): string | undefined {
  if (!canUseTui(agentId, context)) return undefined;
  return context.busy ? '任务运行中，结束后才能创建 TUI 会话' : undefined;
}

export function tuiSessionBody(workspaceHash: string, agentId: string, sessionName: string) {
  return { workspaceHash, agentId, sessionName };
}
