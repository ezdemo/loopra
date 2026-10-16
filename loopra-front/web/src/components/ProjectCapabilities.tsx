import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { IconButton } from './ui';
import { RemoteState, errorText, useRemote } from './RemoteControls';
import { mcpEmptyText, mcpServersOf, mcpStatusLabel, mcpToolCount, mcpTypeLabel, projectCapabilitiesPath, projectSkillEmptyText, projectSkillsOf, type ProjectCapabilitiesData } from '../capabilities';

// The legacy desktop tool panel showed what a session can actually use: project
// skills from `.loopra/skills` plus the project MCP servers and their tools.
export default function ProjectCapabilities({ api, workspaceHash, workspaceName, notify }: {
  api: LoopraClient; workspaceHash: string; workspaceName?: string; notify: (message: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const state = useRemote<ProjectCapabilitiesData>(api, workspaceHash ? projectCapabilitiesPath(workspaceHash) : null, revision);
  const skills = projectSkillsOf(state.data);
  const servers = mcpServersOf(state.data);
  const title = workspaceName?.trim() || state.data?.workspacePath || '当前项目';

  async function refresh() {
    if (!workspaceHash || busy) return;
    setBusy(true);
    try {
      // Reloads `.loopra` skill/MCP config on the server; running sessions keep going.
      await api.request<ProjectCapabilitiesData>(projectCapabilitiesPath(workspaceHash, true), 'POST', undefined);
      setRevision(value => value + 1);
      notify('项目能力已刷新');
    } catch (cause) {
      notify(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceHash) return <p className="panel-empty">请先选择项目</p>;
  return <div className="project-capabilities">
    <header className="workbench-card-head"><strong>项目能力</strong><span className="section-note" title={state.data?.workspacePath || ''}>{title}</span><IconButton label="刷新项目能力" onClick={() => void refresh()}><RefreshCw size="0.875rem" className={busy ? 'spin' : ''} /></IconButton></header>
    <RemoteState loading={state.loading} error={state.error} />
    {state.data && <>
      <div className="capabilities-summary">
        <span><strong>{skills.length}</strong> Skill</span>
        <span><strong>{servers.length}</strong> MCP</span>
        <span><strong>{mcpToolCount(servers)}</strong> 工具</span>
      </div>
      <section className="workbench-card">
        <header className="workbench-card-head"><strong>项目 Skill</strong><span className="section-note">{skills.length}</span></header>
        {skills.length === 0 ? <p className="panel-empty">{projectSkillEmptyText(state.data)}</p> : <ul className="capability-list">{skills.map(skill => <li key={`${skill.mountAlias || ''}:${skill.name || ''}`} className="capability-row" title={skill.path || ''}>
          <span className="capability-dot project" aria-hidden="true" />
          <span className="capability-main"><strong>{skill.name}</strong><small>{skill.description || skill.path || '项目技能'}</small></span>
        </li>)}</ul>}
      </section>
      <section className="workbench-card">
        <header className="workbench-card-head"><strong>项目 MCP</strong><span className="section-note">{servers.length}</span></header>
        {servers.length === 0 ? <p className="panel-empty">{mcpEmptyText(state.data)}</p> : <ul className="capability-list">{servers.map(server => <li key={server.name} className="capability-row mcp-row">
          <details>
            <summary>
              <span className={`capability-dot ${server.loaded ? 'loaded' : 'offline'}`} aria-hidden="true" />
              <span className="capability-main"><strong>{server.name}</strong><small>{mcpTypeLabel(server.type)} · {server.toolCount || 0} 个工具</small></span>
              <span className={`mcp-status ${server.loaded ? 'loaded' : 'offline'}`}>{mcpStatusLabel(server)}</span>
            </summary>
            <div className="capability-detail">
              {server.toolNames?.length ? <p className="mcp-tools">{server.toolNames.map(tool => <code key={tool}>{tool}</code>)}</p>
                : server.error ? <p className="mcp-failed">加载失败</p> : <p className="mcp-failed">暂无工具</p>}
            </div>
          </details>
        </li>)}</ul>}
      </section>
    </>}
    {!state.data && !state.loading && !state.error && <p className="panel-empty">未读取到项目能力，可尝试刷新。</p>}
  </div>;
}
