import { useEffect, useState } from 'react';
import { AlertCircle, BookOpen, ChevronRight, Folder, Plug, Puzzle, RefreshCw, Search, Wrench, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText, useRemote } from './RemoteControls';
import { filterProjectCapabilities, mcpEmptyText, mcpServersOf, mcpStatusLabel, mcpToolCount, mcpTypeLabel, projectCapabilitiesPath, projectSkillEmptyText, projectSkillsOf, type ProjectCapabilitiesData } from '../capabilities';

export default function ProjectCapabilities({ api, workspaceHash, workspaceName, revision = 0, notify }: {
  api: LoopraClient; workspaceHash: string; workspaceName?: string; revision?: number; notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'skills' | 'mcp'>('all');
  useEffect(() => setRefreshError(''), [revision]);
  const state = useRemote<ProjectCapabilitiesData>(api, workspaceHash ? projectCapabilitiesPath(workspaceHash) : null, revision);
  const skills = projectSkillsOf(state.data);
  const servers = mcpServersOf(state.data);
  const visible = filterProjectCapabilities(state.data, search);
  const title = workspaceName?.trim() || state.data?.workspacePath?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '当前项目';
  const showSkills = filter !== 'mcp';
  const showMcp = filter !== 'skills';
  const noMatches = !!search.trim() && !(showSkills && visible.skills.length) && !(showMcp && visible.servers.length);
  const error = refreshError || (!state.data && state.error);

  async function refresh() {
    if (!workspaceHash || busy || state.loading) return;
    setBusy(true); setRefreshError('');
    try {
      const data = await api.request<ProjectCapabilitiesData>(projectCapabilitiesPath(workspaceHash, true), 'POST', undefined);
      state.setData(data);
      notify('项目能力已刷新');
    } catch (cause) {
      setRefreshError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceHash) return <div className="capabilities-empty"><Folder size={24} /><strong>请先选择项目</strong><p>选择项目后，查看它的 Skill 和 MCP 连接。</p></div>;
  return <div className="project-capabilities" aria-label="项目能力" aria-busy={state.loading || busy}>
    <header className="capabilities-header">
      <span className="capabilities-mark" aria-hidden="true"><Puzzle size={19} strokeWidth={1.7} /></span>
      <div className="capabilities-heading"><h2>项目能力</h2><span title={state.data?.workspacePath || title}><Folder size={12} aria-hidden="true" />{title}</span></div>
      <button type="button" className="capabilities-refresh" aria-label="刷新项目能力" title="重新读取项目 Skill 和 MCP 配置" disabled={busy || state.loading} onClick={() => void refresh()}>
        <RefreshCw size={14} className={busy || state.loading ? 'spin' : ''} /><span>{busy ? '刷新中' : '刷新'}</span>
      </button>
    </header>
    {error && <div className="capabilities-error" role="alert"><AlertCircle size={15} /><div><strong>{state.data ? '刷新失败，保留上次结果' : '暂时无法读取项目能力'}</strong><p>{error}</p><button type="button" disabled={busy || state.loading} onClick={() => void refresh()}>重新加载</button></div></div>}
    {state.loading && !state.data && <div className="capabilities-loading" role="status" aria-label="正在读取项目能力"><span /><span /><span /><span /></div>}
    {state.data && <>
      <div className="capabilities-controls">
        <div className="capabilities-filters" role="group" aria-label="能力类型">
          {([['all', '全部', skills.length + servers.length], ['skills', 'Skill', skills.length], ['mcp', 'MCP', servers.length]] as const).map(([value, label, count]) =>
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}
        </div>
        <label className="capabilities-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索项目能力" placeholder="搜索技能、服务或工具…" value={search} onChange={event => setSearch(event.target.value)} />
          {search && <button type="button" aria-label="清空能力搜索" onClick={() => setSearch('')}><X size={13} /></button>}
        </label>
      </div>
      {noMatches ? <div className="capabilities-empty" role="status"><Search size={23} /><strong>没有匹配的能力</strong><p>试试其他技能、服务器或工具名称。</p><button type="button" onClick={() => setSearch('')}>清空搜索</button></div> : <>
        {showSkills && (!search.trim() || visible.skills.length > 0) && <section className="capabilities-section" aria-label="项目 Skill">
          <header className="capabilities-section-heading"><BookOpen size={14} /><h3>项目 Skill</h3><span>{visible.skills.length}</span></header>
          {skills.length === 0 ? <div className="capabilities-section-empty"><p>还没有项目 Skill</p><small>{projectSkillEmptyText(state.data)}</small></div> : <ul className="capability-list">{visible.skills.map((skill, index) => <li key={skill.path || `${skill.mountAlias}:${skill.name}:${index}`}>
            <details className="capability-entry skill-entry">
              <summary><span className="capability-icon" aria-hidden="true"><BookOpen size={16} strokeWidth={1.7} /></span><span className="capability-main"><strong title={skill.name}>{skill.name || '未命名 Skill'}</strong><small>{skill.description || '暂无技能描述'}</small></span><ChevronRight size={14} className="capability-chevron" aria-hidden="true" /></summary>
              <div className="capability-detail"><p className="capability-description">{skill.description || '暂无技能描述'}</p>{skill.path && <div className="capability-source"><span>文件位置</span><code>{skill.path}</code></div>}</div>
            </details>
          </li>)}</ul>}
        </section>}
        {showMcp && (!search.trim() || visible.servers.length > 0) && <section className="capabilities-section" aria-label="项目 MCP">
          <header className="capabilities-section-heading"><Plug size={14} /><h3>项目 MCP</h3><span>{visible.servers.length}</span><small>{mcpToolCount(visible.servers)} 个工具</small></header>
          {servers.length === 0 ? <div className="capabilities-section-empty"><p>还没有项目 MCP 服务</p><small>{mcpEmptyText(state.data)}</small></div> : <ul className="capability-list">{visible.servers.map((server, index) => {
            const status = server.enabled === false ? 'disabled' : server.loaded ? 'connected' : server.error ? 'failed' : 'idle';
            return <li key={server.name || index}><details className="capability-entry mcp-entry">
              <summary>
                <span className="capability-icon" aria-hidden="true"><Plug size={16} strokeWidth={1.7} /></span>
                <span className="capability-main"><strong title={server.name}>{server.name || '未命名 MCP'}</strong><small>{mcpTypeLabel(server.type)} · {server.toolCount || 0} 个工具</small></span>
                <span className={`mcp-status ${status}`}><i aria-hidden="true" />{mcpStatusLabel(server)}</span><ChevronRight size={14} className="capability-chevron" aria-hidden="true" />
              </summary>
              <div className="capability-detail">
                {status !== 'connected' ? <p className={`mcp-notice ${status}`}>{status === 'disabled' ? '此服务已停用，不会加载它的工具。' : status === 'failed' ? '连接失败，请检查项目 MCP 配置后刷新。' : '服务尚未加载，可刷新后查看连接状态。'}</p>
                  : server.toolNames?.length ? <><div className="mcp-tools-heading">可用工具<span>{server.toolNames.length}</span></div><ul className="mcp-tools">{server.toolNames.map((tool, index) => <li key={`${tool}:${index}`}><Wrench size={12} aria-hidden="true" /><code>{tool}</code></li>)}</ul></>
                    : <p className="mcp-notice">此服务暂未提供工具。</p>}
              </div>
            </details></li>;
          })}</ul>}
        </section>}
      </>}
      <footer className="capabilities-footer"><Folder size={12} aria-hidden="true" /><span>仅展示当前项目的能力，全局配置请前往设置。</span></footer>
    </>}
    {!state.data && !state.loading && !error && <div className="capabilities-empty"><Puzzle size={24} /><strong>尚未读取到项目能力</strong><p>点击上方刷新，重新读取当前项目的配置。</p></div>}
  </div>;
}
