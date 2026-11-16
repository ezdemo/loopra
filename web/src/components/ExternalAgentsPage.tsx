import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import AgentIcon from './AgentIcon';
import AgentInstallDialog from './AgentInstallDialog';
import { agentAcpInstallPrompt } from '../agent-install';
import type { AgentEngine, LoopraClient } from '../backend';
import { errorText, RemoteState, useRemote } from './RemoteControls';
import { PageActions, SettingSwitch } from './SettingControls';

/**
 * 三方 ACP Agent 管理页：展示各 Agent 的本机检测结果，提供安装说明，
 * 并用开关控制已安装的 Agent 是否出现在输入框旁的 Agent 选择器。
 */
export default function ExternalAgentsPage({ api, notify, onChanged, onNestedDialog }: { api: LoopraClient; notify: (message: string) => void; onChanged?: () => void; onNestedDialog?: (open: boolean) => void }) {
  const [revision, setRevision] = useState(0);
  const state = useRemote<AgentEngine[]>(api, '/agent-engines', revision, true);
  const [busy, setBusy] = useState('');
  const [installing, setInstalling] = useState<AgentEngine | null>(null);
  useEffect(() => {
    if (!installing || !onNestedDialog) return;
    onNestedDialog(true);
    return () => onNestedDialog(false);
  }, [installing, onNestedDialog]);
  const engines = (state.data || []).filter(engine => engine.id !== 'native');
  async function setVisible(engine: AgentEngine, visible: boolean) {
    if (busy) return;
    setBusy(engine.id);
    try {
      const hiddenAgents = engines.filter(item => (item.id === engine.id ? !visible : !!item.hidden)).map(item => item.id);
      await api.request('/agent-engines/preferences', 'PUT', { hiddenAgents });
      setRevision(value => value + 1);
      onChanged?.();
    } catch (cause) {
      notify(errorText(cause));
    } finally {
      setBusy('');
    }
  }
  return <div className="settings-resource-page">
    <PageActions title="外部 Agent"><Button className="settings-outlined-action" size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>重新检测</Button></PageActions>
    <RemoteState {...state} loading={state.loading && !state.data} />
    {!!engines.length && <div className="settings-card">{engines.map(engine => <div className="setting-row" data-setting-title={engine.name} key={engine.id}>
      <div className="external-agent-info">
        <AgentIcon agentId={engine.id} />
        <div><div className="setting-label">{engine.name}</div><p>{engine.available ? engine.detail || '已安装' : `未安装${engine.detail ? ` · ${engine.detail}` : ''}`}</p></div>
      </div>
      <div className="setting-control external-agent-controls">
        {!engine.available && !!agentAcpInstallPrompt(engine.id) && <Button size="sm" variant="light" isDisabled={!!busy} onPress={() => setInstalling(engine)}>安装说明</Button>}
        <SettingSwitch label={`${engine.name} 显示在 Agent 选择器`} value={!engine.hidden} onChange={visible => void setVisible(engine, visible)} />
      </div>
    </div>)}</div>}
    <AgentInstallDialog engine={installing} onClose={() => setInstalling(null)} />
  </div>;
}
