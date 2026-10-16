// Maps the backend /usage DTO onto the composer's context-usage view model.
// The local estimate stays as a fallback for fresh sessions or offline backends.

export type ContextEstimate = {
  systemTokens: number; toolDefinitionTokens: number; userTokens: number; assistantTokens: number; toolResultTokens: number;
  totalTokens: number; exactTokenizer: boolean; estimator: string;
};

export type UsageDTO = {
  promptTokens: number; completionTokens: number; cacheHit: number; cacheMiss: number;
  lastPromptTokens: number; maxContextTokens: number; totalTokens: number; model: string;
  hasPrice: boolean; totalCost: number; currency: string; contextEstimate?: ContextEstimate | null;
  inputCost?: number; cacheCost?: number; outputCost?: number;
};

export type ContextPart = { name: string; tokens: number; color: string };
export type ContextUsage = { parts: ContextPart[]; total: number; limit: number; percent: number; exact?: boolean; metrics?: UsageMetrics };
export type UsageMetrics = { promptTokens: number; completionTokens: number; totalCost: number; hasPrice: boolean; currency: string; cacheHitRate: number | null; inputCost: number; cacheCost: number; outputCost: number };

const colors = { system: '#566274', tools: '#8b6048', user: '#42b7a0', assistant: '#e4b467', result: '#d9695f' };

// Legacy UsagePanel folds history once the prompt reaches 80% of the window.
export const FOLD_THRESHOLD_RATIO = 0.8;

/** Context-window token count at which Loopra folds history (legacy 80% mark). */
export function foldThreshold(limit: number) {
  return Math.floor((Number.isFinite(limit) && limit > 0 ? limit : 0) * FOLD_THRESHOLD_RATIO);
}

export function usagePath(workspaceHash: string, sessionName?: string) {
  const params = new URLSearchParams({ workspaceHash });
  if (sessionName) params.set('sessionName', sessionName);
  return `/usage?${params.toString()}`;
}

function cacheHitRate(usage: UsageDTO) {
  const total = (usage.cacheHit || 0) + (usage.cacheMiss || 0);
  return total > 0 ? (usage.cacheHit / total) * 100 : null;
}

/**
 * Builds the context-usage view from server data, or returns the caller's
 * estimate when the backend has no real numbers to report.
 */
export function contextFromUsage(usage: UsageDTO | null | undefined, fallback: ContextUsage): ContextUsage {
  const estimate = usage?.contextEstimate;
  const total = estimate?.totalTokens || usage?.lastPromptTokens || 0;
  if (!usage || total <= 0) return fallback;
  const parts: ContextPart[] = estimate
    ? [
        { name: '系统指令', tokens: estimate.systemTokens, color: colors.system },
        { name: '工具定义', tokens: estimate.toolDefinitionTokens, color: colors.tools },
        { name: '用户消息', tokens: estimate.userTokens, color: colors.user },
        { name: '助手消息', tokens: estimate.assistantTokens, color: colors.assistant },
        { name: '工具结果', tokens: estimate.toolResultTokens, color: colors.result },
      ].filter(part => part.tokens > 0)
    : [{ name: '会话上下文', tokens: total, color: colors.system }];
  const limit = usage.maxContextTokens > 0 ? usage.maxContextTokens : fallback.limit;
  return {
    parts,
    total,
    limit,
    percent: Math.min(100, total / limit * 100),
    exact: !!estimate?.exactTokenizer,
    metrics: {
      promptTokens: usage.promptTokens || 0,
      completionTokens: usage.completionTokens || 0,
      totalCost: usage.totalCost || 0,
      hasPrice: !!usage.hasPrice,
      currency: usage.currency || 'CNY',
      cacheHitRate: cacheHitRate(usage),
      // Legacy UsagePanel 费用估算的三项明细。
      inputCost: usage.inputCost || 0,
      cacheCost: usage.cacheCost || 0,
      outputCost: usage.outputCost || 0,
    },
  };
}
