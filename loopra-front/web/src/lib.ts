import { useEffect, useState } from 'react';
import { demoMessages } from './chat';
import type { Message } from './chat';
export type { Message } from './chat';

export function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { const saved = localStorage.getItem(`loopra:${key}`); return saved ? migrateSavedState(key, JSON.parse(saved)) as T : initial; }
    catch { return initial; }
  });
  useEffect(() => { localStorage.setItem(`loopra:${key}`, JSON.stringify(value)); }, [key, value]);
  return [value, setValue] as const;
}

export type Session = { id: string; title: string; workspace: string; kind: 'api' | 'repair' | 'demo' | 'mock' | 'remote'; messages: Message[]; archived?: boolean; name?: string; workspaceHash?: string; mtime?: number };

export function getSessionMessages(session: Session): Message[] {
  return [...(session.kind === 'mock' || session.kind === 'remote' ? [] : demoMessages[session.kind]), ...session.messages];
}

// Upgrade the original demo defaults without removing saved conversations or settings.
function migrateSavedState(key: string, value: unknown): unknown {
  if (key === 'sessions' && Array.isArray(value)) {
    const sessions = (value as Session[]).map(session => session.id === 'repair' && session.kind === 'repair'
      ? { ...session, title: session.title.replace(/^kimicode有个会话坏了/, 'Loopra 有个会话坏了') }
      : session);
    return sessions.some(session => session.id === 'agent-blocks') ? sessions : [...sessions, initialSessions.find(session => session.id === 'agent-blocks')!];
  }
  if (key === 'providers' && Array.isArray(value)) {
    return (value as Provider[]).map(provider => ({
      ...provider,
      ...(provider.id === 'kimi' ? { id: 'loopra', name: provider.name === 'Kimi 订阅' ? 'Loopra 订阅' : provider.name, color: '#2083ff' } : {}),
      ...(provider.type === 'kimi' ? { type: 'openai_responses' } : {}),
    }));
  }
  if (key === 'preferences' && value && typeof value === 'object' && 'theme' in value) {
    const saved = { ...value } as Record<string, unknown>;
    const legacyScale: Record<string, number> = { S: 93, M: 100, L: 114, XL: 129 };
    const scale = typeof saved.fontScale === 'number' && Number.isFinite(saved.fontScale) ? saved.fontScale : legacyScale[String(saved.fontSize)] || 100;
    delete saved.fontSize;
    return { ...saved, fontScale: Math.min(150, Math.max(80, scale)), theme: value.theme === '月之亮面' ? '浅色' : value.theme === '月之暗面' ? '深色' : value.theme };
  }
  return value;
}

export const initialSessions: Session[] = [
  { id: 'repair', title: 'Loopra 有个会话坏了 帮我修复下400 [code=upstream_error] The request failed before completion', workspace: 'comfyui', kind: 'repair', messages: [] },
  { id: 'api', title: 'comfui支持传出api嘛?', workspace: 'comfyui', kind: 'api', messages: [] },
  { id: 'agent-blocks', title: 'Agent 聊天内容块演示', workspace: 'runtime', kind: 'demo', messages: [] },
];
export const workspaces = [
  { name: 'runtime', path: '~\\AppData\\Roaming\\Loopra\\runtime' },
  { name: 'comfyui', path: '~\\Documents\\ChatGPT\\comfyui' },
];
export const models = ['DeepSeek V4.1 Flash', 'Mimo V2.6 Flash', 'Mimo V2.6 pro'];
export type ProviderModel = { name: string; contextTokens: number; maxTokens: number; imageInput: boolean; priceEnabled: boolean; inputPrice: number; cachePrice: number; outputPrice: number };
export type Provider = { id: string; name: string; type: string; count: number; color?: string; baseUrl?: string; apiKey?: string; compatibility?: string; enabled?: boolean; models?: ProviderModel[] };
export const initialProviders: Provider[] = [
  { id: 'loopra', name: 'Loopra 订阅', type: 'OAuth', count: 4, color: '#2083ff' },
  { id: 'cpa', name: 'CPA', type: 'openai_responses', count: 4 },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai_responses', count: 3, color: '#5962ff' },
  { id: 'magpie', name: 'magpie', type: 'openai_responses', count: 17 },
];

export function mockReply(prompt: string) {
  if (/你好|hello|hi\b/i.test(prompt)) return '你好！我是你的编程助手。你可以让我分析代码、修复问题，或者帮你实现一个新功能。\n\n当前工作区已经准备好了，我们从哪里开始？';
  if (/api|接口/i.test(prompt)) return '可以的，ComfyUI 提供了 HTTP API 和 WebSocket 接口。\n\n### 常用接口\n\n- `POST /prompt`：提交工作流并创建任务\n- `GET /history`：查询任务历史和输出结果\n- `POST /upload/image`：上传输入图片\n- `GET /view`：获取生成的图片\n\n实时进度可以通过 `ws://127.0.0.1:8188/ws` 订阅。你可以描述一下调用场景，我会帮你整理接入方案。\n\n> 以上为本地演示回复，尚未连接模型或 ComfyUI。';
  if (/修复|报错|bug|错误/i.test(prompt)) return '我来帮你排查这个问题。\n\n1. 先确认错误触发的位置和完整报错信息。\n2. 检查相关依赖、请求参数和运行环境。\n3. 定位原因后，给出最小范围的修改方案。\n\n把相关代码或错误日志发给我，我们就可以继续。';
  return `收到，我会围绕「${prompt.length > 70 ? prompt.slice(0, 70) + '…' : prompt}」来处理。\n\n我会先梳理需求和现有代码结构，再拆分实现步骤，并检查最终结果。\n\n这是本地 mock 演示回复；接入真实 Agent 后，这里可以展示模型思考、工具调用和流式输出。`;
}
