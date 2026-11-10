// Development-only synthetic data. This entry is not part of the application build.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppMotion } from '@web/components/Motion';
import MobileWorkspace from '../src/MobileWorkspace';
import { paintPreferences, readPreferences, savePreferences } from '../src/preferences';
import '@web/chat-blocks.css';
import '@web/motion.css';
import '@web/dialogs.css';
import '../src/mobile.css';

const origin = 'https://loopra-ui-fixture.invalid';
const original = window.fetch.bind(window);
const histories: Record<string, unknown[]> = {
  welcome: [
    { role: 'user', content: '帮我检查一下移动端的会话布局，正文要舒服好读。', timestamp: Date.now() - 120000 },
    { role: 'assistant', reasoning_content: '先确认手机宽度和输入区域，再检查思考、工具详情是否保留。', tool_calls: [{ id: 'read1', function: { name: 'read', arguments: { path: 'mobile/src/MobileWorkspace.tsx' } } }] },
    { role: 'tool', tool_call_id: 'read1', content: '布局使用单列，会话正文复用 Conversation。', tool_status: 'completed', tool_duration_ms: 120 },
    { role: 'assistant', content: '手机端的布局已经调整好了。\n\n### 阅读与操作\n\n- **正文优先**，保留 Loopra 原来的消息渲染。\n- 思考、工具和子代理可以展开查看。\n- 输入框固定在底部，返回后继续浏览其他会话。\n\n```tsx\n<Messages\n  session={session}\n  loading={running}\n/>\n```\n\n| 内容 | 呈现 |\n| --- | --- |\n| 正文 | 默认展开 |\n| 思考与工具 | 默认折叠 |\n\n> 模型仍在桌面执行，手机只通过接口操作。', timestamp: Date.now() - 60000, turn_started_at: Date.now() - 120000, turn_finished_at: Date.now() - 60000 },
  ],
  approval: [{ role: 'user', content: '检查项目并申请工具权限。' }, { role: 'assistant', reasoning_content: '需要等待用户确认。' }],
  question: [{ role: 'user', content: '请帮我创建界面，需要什么信息可以问我。' }, { role: 'assistant', content: '需要先确认你的偏好。' }],
};
let active: { name: string; requestId: string; timer?: ReturnType<typeof setInterval>; finish: () => void } | undefined;
let approved = false;
let inputAnswered = false;
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== origin) return original(request);
  const path = url.pathname.replace('/api', '');
  const ok = (data: unknown) => Response.json({ success: true, data });
  if (path === '/workspaces') return ok([{ hash: 'project', name: 'Loopra', path: '/fixture/loopra' }]);
  if (path === '/config') return ok({ model: 'DeepSeek V4.1', modelChannels: [{ id: 'fixture', name: 'Fixture', models: [{ name: 'DeepSeek V4.1' }, { name: 'Claude Sonnet' }] }] });
  if (path === '/agent-engines') return ok([{ id: 'native', name: 'Loopra Native', available: true }]);
  if (path === '/sessions') return ok(url.searchParams.get('workspaceHash') === 'project' ? [
    { name: 'welcome', title: '让手机上的对话更舒服', mtime: Date.now() - 120000, messageCount: 4 },
    { name: 'approval', title: '工具审批', mtime: Date.now() - 3600000, messageCount: 2 },
    { name: 'question', title: 'Agent 提问', mtime: Date.now() - 7200000, messageCount: 2 },
    ...Array.from({ length: 16 }, (_, index) => ({ name: `layout-${index}`, title: ['移动端消息排版', '检查输入与滚动', '保持会话同步', '整理项目里的修改'][index % 4], mtime: Date.now() - (index + 3) * 3600000, messageCount: 2 })),
  ] : []);
  if (path === '/agent-engines/prepare') { histories.created = []; return ok({ sessionName: 'created', agentId: 'native' }); }
  const name = url.searchParams.get('sessionName') || '';
  if (path === '/agent/session-status') return ok({ running: active?.name === name || name === 'approval' && !approved || name === 'question' && !inputAnswered, requestId: active?.name === name ? active.requestId : `${name}-request` });
  if (path === '/agent/history') return ok(histories[name] || []);
  if (path === '/chat/permissions') return ok(name === 'approval' && !approved ? [{ type: 'choice', permissionRequestId: 'fixture-permission', title: '允许读取项目文件吗？', description: 'read mobile/src/MobileWorkspace.tsx', options: [{ title: '允许本次', value: 'approve' }, { title: '拒绝', value: 'deny' }] }] : []);
  if (path === '/chat/elicitations') return ok(name === 'question' && !inputAnswered ? [{ elicitationRequestId: 'fixture-input', message: '选择你的阅读偏好', schema: { required: ['style'], properties: { style: { type: 'string', title: '阅读风格', enum: ['简洁', '详细'] } } } }] : []);
  if (path === '/chat/permission') { approved = true; return ok({}); }
  if (path === '/chat/elicitation') { inputAnswered = true; return ok({}); }
  if (path === '/chat/abort') { active?.finish(); return ok({}); }
  if (path === '/chat/stream') {
    const body = await request.json();
    histories[body.sessionName] ||= [];
    histories[body.sessionName].push({ role: 'user', content: body.message });
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    const chunks = ['这是手机端的流式回复。\n\n', ...Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 段内容会逐步到达。阅读历史时不会强制滚到底部。\n\n`), '**完成了。**'];
    const stream = new ReadableStream({ start(controller) {
      let index = 0;
      let ended = false;
      const emit = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const finish = () => {
        if (ended) return; ended = true; clearInterval(timer);
        histories[body.sessionName].push({ role: 'assistant', reasoning_content: '流式回复的思考', content: chunks.slice(0, index).join('') });
        emit({ type: 'complete' }); emit({ type: 'done' }); controller.close(); active = undefined;
      };
      active = { name: body.sessionName, requestId: body.requestId, finish };
      emit({ type: 'reasoning', content: '检查输入和手机布局。' });
      timer = setInterval(() => { if (index < chunks.length) emit({ type: 'content', content: chunks[index++] }); else finish(); }, 220);
      request.signal.addEventListener('abort', finish, { once: true });
    }, cancel() { clearInterval(timer); active = undefined; } });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return Response.json({ success: false, error: `Fixture route missing: ${path}` }, { status: 404 });
};
function Fixture() {
  const [preferences, setPreferences] = useState(readPreferences);
  paintPreferences(preferences);
  return <AppMotion enabled><MobileWorkspace origin={origin} hostname="Loopra@Desktop" online error="" onReconnect={() => {}} onDisconnect={() => {}} preferences={preferences} onPreferences={value => { savePreferences(value); setPreferences(value); }} /></AppMotion>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
