import { useState } from 'react';
import { Button, Checkbox } from '@nextui-org/react';
import { Bot, ChevronDown, LockKeyhole, Pencil, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { modelLabel } from '../composer';
import { groupGitModels, type GitModel } from '../git-models';
import { ConfirmAction, errorText, RemoteState, useRemote } from './RemoteControls';
import { Field, PageActions, SelectField, SettingDisclosure, TextField } from './SettingControls';

type ServerProfile = { id: string; name?: string; description?: string; readOnly?: boolean; systemPrompt?: string; tools?: string[]; allowedTools?: string[] | null; enable?: boolean | null; modelChannel?: string; model?: string };
type Profile = { id: string; name: string; description: string; instructions: string; readOnly: boolean; enable: boolean; allowedTools: string[] | null; tools?: string[]; model?: string; modelChannel?: string };
type RoleTool = { name: string; readOnly: boolean; enabled?: boolean };

// GET calls the prompt systemPrompt; PUT expects instructions. Preserve that boundary.
const toProfile = (profile: ServerProfile): Profile => ({
  id: profile.id, name: profile.name ?? profile.id, description: profile.description ?? '',
  instructions: profile.systemPrompt ?? '', readOnly: !!profile.readOnly, enable: profile.enable !== false,
  allowedTools: profile.allowedTools ?? null, tools: profile.tools, model: profile.model, modelChannel: profile.modelChannel,
});
function normalizeProfile(profile: Profile): Profile {
  const { model, modelChannel, ...rest } = profile;
  return modelChannel ? { ...rest, modelChannel, ...(model ? { model } : {}) } : rest;
}

export default function SubAgentManager({ api }: { api: LoopraClient }) {
  const [revision, setRevision] = useState(0);
  const state = useRemote<ServerProfile[]>(api, '/sub-agents', revision);
  const tools = useRemote<RoleTool[]>(api, '/tools');
  const denied = useRemote<string[]>(api, '/sub-agents/denied-tools');
  const models = useRemote<{ models: GitModel[] }>(api, '/models');
  const channels = groupGitModels(models.data?.models);
  const profiles = (state.data || []).map(toProfile);
  const [draft, setDraft] = useState<Profile>();
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Profile>();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState('');
  const visible = profiles.filter(profile => `${profile.name} ${profile.id} ${profile.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  async function save(next: Profile[]) {
    setBusy(true); setError('');
    try {
      await api.request('/sub-agents', 'PUT', { profiles: next.map(normalizeProfile) });
      setRevision(value => value + 1);
      return true;
    } catch (cause) { setError(errorText(cause)); return false; }
    finally { setBusy(false); }
  }
  function edit(profile?: Profile) {
    setError(''); setOriginal(profile?.id || '');
    setDraft(profile ? { ...profile, allowedTools: profile.allowedTools === null ? null : [...profile.allowedTools] }
      : { id: '', name: '', description: '', instructions: '', readOnly: true, enable: true, allowedTools: null });
  }
  function back() { if (!busy) { setDraft(undefined); setError(''); } }
  function roleModel(profile: Profile) {
    if (!profile.modelChannel) return '继承主代理模型';
    const channel = channels.find(item => item.id === profile.modelChannel);
    const model = channel?.models.find(item => item.name === profile.model);
    return model ? modelLabel(model) : profile.model || `${channel?.name || profile.modelChannel} · 默认模型`;
  }

  if (draft) {
    const importTools = (readOnly: boolean) => (tools.data || []).filter(tool => !denied.data?.includes(tool.name) && tool.enabled !== false && tool.readOnly === readOnly).map(tool => tool.name);
    const toolChoices = (tools.data || []).filter(tool => !denied.data?.includes(tool.name) && (!draft.readOnly || tool.readOnly));
    const toolsUnavailable = tools.loading || denied.loading || !tools.data || !denied.data || !!tools.error || !!denied.error;
    return <div className="settings-resource-page agent-role-page">
      <PageActions title={original ? '编辑角色' : '新增角色'} onBack={back} />
      <p className="section-note">定义角色职责、使用的模型，以及它能使用的工具。</p>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <form className="agent-role-editor" onSubmit={event => {
        event.preventDefault();
        if (busy || !state.data) return;
        if (!original && profiles.some(profile => profile.id === draft.id)) { setError('角色 ID 已存在'); return; }
        void save(original ? profiles.map(profile => profile.id === original ? draft : profile) : [...profiles, draft])
          .then(ok => { if (ok) setDraft(undefined); });
      }}>
        <section className="agent-role-editor-section"><h3>基本信息</h3><div className="agent-role-editor-fields">
          <Field label="名称" required disabled={busy} value={draft.name} onChange={name => setDraft({ ...draft, name })} placeholder="例如：代码审查" />
          <Field label="角色 ID" required disabled={busy} readOnly={!!original} pattern="[a-zA-Z0-9_\-]+" value={draft.id} onChange={id => setDraft({ ...draft, id })} placeholder="例如：code-review" />
          <Field className="agent-role-field-wide" label="描述" disabled={busy} value={draft.description} onChange={description => setDraft({ ...draft, description })} placeholder="简要说明这个角色负责什么" />
        </div></section>
        <section className="agent-role-editor-section"><h3>模型配置</h3><div className="agent-role-editor-fields">
          <SelectField label="模型渠道" disabled={busy} value={draft.modelChannel || ''} onChange={modelChannel => setDraft({ ...draft, modelChannel, model: '' })} options={[{ value: '', label: '继承主代理（默认）' }, ...channels.map(channel => ({ value: channel.id, label: channel.name }))]} />
          {draft.modelChannel ? <SelectField label="渠道模型" disabled={busy} value={draft.model || ''} onChange={model => setDraft({ ...draft, model })} options={[{ value: '', label: '渠道默认模型' }, ...(channels.find(channel => channel.id === draft.modelChannel)?.models || []).map(model => ({ value: model.name, label: modelLabel(model) }))]} />
            : <p className="agent-role-inherit-note"><Bot size={16} />跟随主代理的模型选择，无需单独配置。</p>}
        </div></section>
        <section className="agent-role-editor-section"><h3>工作方式</h3><TextField label="角色提示词" required disabled={busy} rows={7} value={draft.instructions} onChange={instructions => setDraft({ ...draft, instructions })} placeholder="描述角色目标、工作方式和交付要求…" /></section>
        <section className="agent-role-editor-section"><h3>权限与状态</h3><div className="agent-role-editor-toggles">
          <Checkbox className="settings-next-checkbox" size="sm" isDisabled={busy} isSelected={draft.readOnly} onValueChange={readOnly => setDraft({ ...draft, readOnly, ...(readOnly && draft.allowedTools && tools.data ? { allowedTools: draft.allowedTools.filter(name => tools.data!.find(tool => tool.name === name)?.readOnly) } : {}) })}>只读角色</Checkbox>
          <Checkbox className="settings-next-checkbox" size="sm" isDisabled={busy} isSelected={draft.enable} onValueChange={enable => setDraft({ ...draft, enable })}>启用角色</Checkbox>
        </div>
          <SettingDisclosure heading="工具权限" defaultExpanded={draft.allowedTools !== null}>
            <Checkbox className="settings-next-checkbox" size="sm" isDisabled={busy} isSelected={draft.allowedTools === null} onValueChange={inherit => setDraft({ ...draft, allowedTools: inherit ? null : [] })}>继承可用工具</Checkbox>
            <p className="agent-role-tool-note">{draft.allowedTools === null ? draft.readOnly ? '继承主代理可用的只读工具。' : '继承主代理可用的工具。' : `已选择 ${draft.allowedTools.length} 项工具，可单独调整白名单。`}</p>
            {draft.allowedTools !== null && <>
              <RemoteState {...tools} /><RemoteState {...denied} />
              <div className="agent-role-tool-import"><Button size="sm" variant="light" isDisabled={busy || toolsUnavailable} onPress={() => setDraft({ ...draft, allowedTools: importTools(true) })}>一键导入只读</Button><Button size="sm" variant="light" isDisabled={busy || toolsUnavailable || draft.readOnly} onPress={() => setDraft({ ...draft, allowedTools: importTools(false) })}>一键导入写入</Button></div>
              <div className="agent-role-tool-options">{toolChoices.map(tool => <Checkbox key={tool.name} className="settings-next-checkbox workbench-actions" size="sm" isDisabled={busy || toolsUnavailable || tool.enabled === false && !draft.allowedTools!.includes(tool.name)} isSelected={draft.allowedTools!.includes(tool.name)} onValueChange={selected => setDraft({ ...draft, allowedTools: selected ? [...draft.allowedTools!, tool.name] : draft.allowedTools!.filter(name => name !== tool.name) })}>{tool.name}</Checkbox>)}</div>
            </>}
          </SettingDisclosure>
        </section>
        <div className="agent-role-editor-footer"><Button size="sm" variant="light" isDisabled={busy} onPress={back}>取消</Button><Button size="sm" color="primary" type="submit" isLoading={busy} isDisabled={!state.data}>保存角色</Button></div>
      </form>
    </div>;
  }

  return <div className="settings-resource-page agent-role-page">
    <PageActions title="子代理"><Button size="sm" variant="light" isDisabled={busy || state.loading} startContent={<RefreshCw size={14} />} onPress={() => setRevision(value => value + 1)}>刷新</Button><Button size="sm" color="primary" isDisabled={busy || !state.data} startContent={<Plus size={15} />} onPress={() => edit()}>新增角色</Button></PageActions>
    <p className="section-note">让不同角色分工协作，为每项任务配置合适的职责与权限。</p>
    <div className="agent-role-toolbar"><Field className="agent-role-search" label="搜索角色" placeholder="搜索名称、ID 或职责…" value={search} onChange={setSearch} /><span>{profiles.length} 个角色 · {profiles.filter(profile => profile.enable).length} 个已启用</span></div>
    <RemoteState {...state} />{error && <p role="alert" className="settings-error">{error}</p>}
    <div className="agent-role-list">{visible.map(profile => {
      const open = expanded === profile.id;
      const toolNames = profile.tools || profile.allowedTools || [];
      return <article key={profile.id} className={`agent-role-row ${profile.enable ? '' : 'is-disabled'}`}>
        <div className="agent-role-row-main">
          <span className="agent-role-avatar" aria-hidden="true"><Bot size={20} strokeWidth={1.7} /></span>
          <div className="agent-role-row-content"><div className="agent-role-row-title"><h3>{profile.name}</h3><span className={`resource-status ${profile.enable ? 'is-on' : ''}`}>{profile.enable ? '已启用' : '已停用'}</span></div><p className="agent-role-description" title={profile.description}>{profile.description || '暂未填写角色职责'}</p>
            <div className="agent-role-row-meta"><span title="角色 ID">{profile.id}</span><span>{profile.readOnly ? <LockKeyhole size={12} /> : <Pencil size={12} />}{profile.readOnly ? '只读' : '可写'}</span><span title={profile.model || '跟随主代理的模型选择'}><Bot size={12} />{roleModel(profile)}</span><span><Wrench size={12} />{profile.tools ? `${profile.tools.length} 项工具` : profile.allowedTools !== null ? `${profile.allowedTools.length} 项工具` : '继承工具'}</span></div>
          </div>
          <div className="agent-role-row-actions"><Button size="sm" variant="light" aria-label={`编辑 ${profile.name}`} isDisabled={busy} startContent={<Pencil size={13} />} onPress={() => edit(profile)}>编辑</Button><Button size="sm" variant="light" aria-label={`${profile.enable ? '停用' : '启用'} ${profile.name}`} isDisabled={busy} onPress={() => void save(profiles.map(item => item.id === profile.id ? { ...item, enable: !item.enable } : item))}>{profile.enable ? '停用' : '启用'}</Button><Button isIconOnly size="sm" variant="light" className="agent-role-remove" aria-label={`移除 ${profile.name}`} title="移除角色" isDisabled={busy} onPress={() => setDeleting(profile)}><Trash2 size={14} /></Button></div>
        </div>
        <button type="button" className="agent-role-detail-toggle" aria-expanded={open} aria-controls={`role-detail-${profile.id}`} onClick={() => setExpanded(open ? '' : profile.id)}>提示词与工具<ChevronDown size={13} /></button>
        {open && <div className="agent-role-details" id={`role-detail-${profile.id}`}><h4>角色提示词</h4><pre>{profile.instructions || '尚未配置角色提示词'}</pre><h4>可用工具</h4>{toolNames.length ? <ul className="agent-role-tool-chips">{toolNames.map(tool => <li key={tool}>{tool}</li>)}</ul> : <p>{profile.tools || profile.allowedTools !== null ? '当前没有可用工具' : '继承主代理可用的工具'}</p>}</div>}
      </article>;
    })}</div>
    {!state.loading && !state.error && !visible.length && <div className="agent-role-empty"><Bot size={28} strokeWidth={1.5} /><h3>{profiles.length ? '没有匹配的角色' : '还没有子代理角色'}</h3><p>{profiles.length ? '试试角色名称、ID 或职责关键字。' : '点击“新增角色”，定义一位专注特定任务的助手。'}</p>{search && <button type="button" onClick={() => setSearch('')}>清除搜索</button>}</div>}
    {deleting && <ConfirmAction title="移除子代理角色" onClose={() => setDeleting(undefined)} action={async () => { if (!state.data) throw new Error('角色列表尚未加载'); await api.request('/sub-agents', 'PUT', { profiles: profiles.filter(profile => profile.id !== deleting.id).map(normalizeProfile) }); }} onDone={() => setRevision(value => value + 1)}><p>移除 {deleting.name}？</p></ConfirmAction>}
  </div>;
}
