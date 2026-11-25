import { useEffect, useState } from 'react';
import { Button, Spinner } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { useShellTerminal, type ShellSession } from '../shell-terminal';
import { tuiSessionBody } from '../agent-tui';

type Props = {
  api: LoopraClient; workspaceHash: string; agentId: string; sessionName: string;
};

// 全尺寸的外部 Agent TUI：后端在项目目录里起真实 CLI，这里只挂屏幕。
export default function AgentTui({ api, workspaceHash, agentId, sessionName }: Props) {
  const [session, setSession] = useState<ShellSession | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const host = useShellTerminal(api.base, workspaceHash, session?.id || '', !!session);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setError('');
    void api.request<ShellSession>('/shell-terminal/sessions', 'POST', tuiSessionBody(workspaceHash, agentId, sessionName))
      .then(created => { if (!cancelled) setSession(created); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '启动 TUI 失败'); });
    return () => { cancelled = true; };
  }, [api, workspaceHash, agentId, sessionName, revision]);

  return <div className="agent-tui">
    {error
      ? <div className="agent-tui-error"><p role="alert" className="settings-error">{error}</p><Button size="sm" variant="flat" onPress={() => setRevision(value => value + 1)}>重试</Button></div>
      : session
        ? <div className="agent-tui-screen" ref={host} />
        : <div className="agent-tui-loading"><Spinner size="sm" /></div>}
  </div>;
}
