import { useEffect, useRef, useState } from 'react';
import { Button, Switch } from '@nextui-org/react';
import { RefreshCw } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText, query, RemoteState, useRemote } from './RemoteControls';

type McpServerChoice = { name: string; type?: string; source: 'global' | 'project'; configuredEnabled: boolean; enabled: boolean };

export default function AgentMcpControls({ api, agentId, workspaceHash, connected }: {
  api: LoopraClient; agentId: string; workspaceHash: string; connected: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const state = useRemote<McpServerChoice[]>(api, connected && workspaceHash ? `/agent-engines/mcp?${query({ agentId, workspaceHash })}` : null, revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => {
    setSaving(false); setError(''); setNotice('');
    return () => request.current?.abort();
  }, [api, agentId, workspaceHash]);

  async function toggle(name: string, enabled: boolean) {
    if (saving) return;
    const controller = new AbortController(); request.current = controller;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api.request<McpServerChoice[]>('/agent-engines/mcp', 'PUT', { agentId, workspaceHash, name, enabled }, controller.signal);
      if (!controller.signal.aborted) { state.setData(result); setNotice('下一轮生效'); }
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setSaving(false); }
  }

  return <div className="composer-mcp-controls">
    {agentId === 'pi' && <p className="composer-note">Pi 暂不支持 MCP 透传。</p>}
    <RemoteState loading={state.loading} error={state.error} />
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!connected ? <p className="composer-empty">连接服务后管理 MCP</p> : !workspaceHash ? <p className="composer-empty">请先选择项目</p> : <>
      <div className="composer-mcp-list">
        {state.data?.map(server => <div className="composer-mcp-row" key={server.name}>
          <strong title={server.name}>{server.name}</strong>
          <Switch size="sm" aria-label={`透传 MCP：${server.name}`} isSelected={server.enabled} isDisabled={saving || state.loading} onValueChange={enabled => void toggle(server.name, enabled)} />
        </div>)}
      </div>
      {!state.loading && !state.error && state.data?.length === 0 && <p className="composer-empty">暂无 MCP</p>}
      <div className="popover-footer"><span role="status">{saving ? '保存中…' : notice}</span><Button size="sm" variant="light" isDisabled={saving || state.loading} onPress={() => { setError(''); setNotice(''); setRevision(value => value + 1); }}><RefreshCw size=".875rem" />刷新</Button></div>
    </>}
  </div>;
}
