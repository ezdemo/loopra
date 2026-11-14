import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { CustomAgent, CustomAgentCatalog, CustomAgentCatalogTool, LoopraClient, Workspace } from '../backend';
import { AGENT_INSTRUCTION_MAX_RUNES, AGENT_NAME_MAX_RUNES, agentNameError, agentPayload, catalogToolsFor, draftFromAgent, emptyAgentDraft, groupCatalogTools, pruneSkills, pruneTools, type AgentDraft } from '../custom-agents';
import { Field, SelectField, SettingSegments, TextField } from './SettingControls';
import { ConfirmAction } from './RemoteControls';
import { LoadingSkeleton } from './ui';

type CatalogState = { loading: boolean; error: string; data?: CustomAgentCatalog };

/** 新建/编辑自定义智能体。工具与技能都沿用「默认 = null，自定义 = 显式列表」语义。 */
export default function AgentEditor({ api, agent, workspaces, sessionCount = 0, onClose, onSaved, onDeleted }: {
  api: LoopraClient;
  agent?: CustomAgent;
  /** 可绑定的项目（只含项目，不含纯聊天与智能体）。 */
  workspaces: Workspace[];
  sessionCount?: number;
  onClose: () => void;
  onSaved: (saved: CustomAgent) => void | Promise<void>;
  onDeleted?: (agent: CustomAgent) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentDraft>(() => agent ? draftFromAgent(agent) : emptyAgentDraft);
  const [catalog, setCatalog] = useState<CatalogState>({ loading: true, error: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const request = useRef(0);
  const title = agent ? '编辑智能体' : '新建智能体';

  function loadCatalog() {
    const current = ++request.current;
    setCatalog({ loading: true, error: '' });
    void api.request<CustomAgentCatalog>('/custom-agents/catalog')
      .then(data => { if (request.current === current) setCatalog({ loading: false, error: '', data }); })
      .catch(cause => { if (request.current === current) setCatalog({ loading: false, error: cause instanceof Error ? cause.message : '加载目录失败' }); });
  }
  useEffect(() => { loadCatalog(); return () => { request.current++; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tools = catalogToolsFor(catalog.data, draft.projectHash);
  const toolGroups = groupCatalogTools(tools);
  const skills = catalog.data?.skills ?? [];

  function changeProject(projectHash: string) {
    setDraft(current => ({
      ...current,
      projectHash,
      tools: pruneTools(current.tools, catalogToolsFor(catalog.data, projectHash)),
      skills: pruneSkills(current.skills, catalog.data?.skills ?? []),
    }));
  }

  function setToolGroup(group: CustomAgentCatalogTool[], selected: string[]) {
    // CheckboxGroup 只报告本组的勾选，合并回另一组的保留值。
    setDraft(current => ({ ...current, tools: [...current.tools.filter(name => group.every(tool => tool.name !== name)), ...selected] }));
  }

  async function save() {
    const nameError = agentNameError(draft.name);
    if (nameError) { setError(nameError); return; }
    if (busy) return;
    setBusy(true); setError('');
    try {
      const payload = agentPayload(draft);
      const saved = agent
        ? await api.request<CustomAgent>(`/custom-agents/${encodeURIComponent(agent.id)}`, 'PUT', payload)
        : await api.request<CustomAgent>('/custom-agents', 'POST', payload);
      await onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存智能体失败');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Modal isOpen onClose={() => { if (!busy && !confirming) onClose(); }} isDismissable={!busy && !confirming} isKeyboardDismissDisabled={busy || confirming} hideCloseButton={busy} placement="center" scrollBehavior="inside"
      classNames={{ base: 'app-dialog agent-editor-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={title}>
      <ModalContent>
        <form className="app-dialog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <ModalHeader className="app-dialog-header"><h2>{title}</h2></ModalHeader>
          <ModalBody className="app-dialog-body">
            <Field label="名称" required maxLength={AGENT_NAME_MAX_RUNES} value={draft.name} disabled={busy} onChange={value => setDraft(current => ({ ...current, name: value }))} />
            <TextField label="角色设定" rows={4} maxLength={AGENT_INSTRUCTION_MAX_RUNES} value={draft.instruction} disabled={busy} onChange={value => setDraft(current => ({ ...current, instruction: value }))} />
            <SelectField label="项目" value={draft.projectHash} disabled={busy}
              options={[{ value: '', label: '不绑定项目' }, ...workspaces.map(item => ({ value: item.hash, label: item.displayName || item.name }))]}
              onChange={changeProject} />
            <div className="agent-editor-section">
              <SettingSegments label="工具" options={['默认', '自定义']} value={draft.toolsMode === 'custom' ? '自定义' : '默认'} onChange={value => setDraft(current => ({ ...current, toolsMode: value === '自定义' ? 'custom' : 'default' }))} />
              {draft.toolsMode === 'custom' && (catalog.loading
                ? <div className="agent-editor-loading" role="status" aria-label="正在加载工具目录"><LoadingSkeleton className="skeleton-agent-option" /><LoadingSkeleton className="skeleton-agent-option" /></div>
                : catalog.error
                  ? <div className="agent-editor-error"><p role="alert" className="settings-error">{catalog.error}</p><Button size="sm" variant="flat" onPress={loadCatalog}>重试</Button></div>
                  : <div className="agent-editor-groups">
                    {([['只读', toolGroups.readOnly], ['写入', toolGroups.write]] as const).map(([label, group]) => !!group.length && (
                      <CheckboxGroup key={label} label={label} className="agent-editor-group" size="sm" value={group.filter(tool => draft.tools.includes(tool.name)).map(tool => tool.name)} onValueChange={selected => setToolGroup(group, selected)}>
                        {group.map(tool => <Checkbox key={tool.name} value={tool.name} classNames={{ label: 'agent-editor-option-label' }} isDisabled={busy}><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</Checkbox>)}
                      </CheckboxGroup>
                    ))}
                    {!tools.length && <p className="composer-empty">暂无可用工具</p>}
                  </div>)}
            </div>
            <div className="agent-editor-section">
              <SettingSegments label="技能" options={['默认', '自定义']} value={draft.skillsMode === 'custom' ? '自定义' : '默认'} onChange={value => setDraft(current => ({ ...current, skillsMode: value === '自定义' ? 'custom' : 'default' }))} />
              {draft.skillsMode === 'custom' && (catalog.loading
                ? <div className="agent-editor-loading" role="status" aria-label="正在加载技能目录"><LoadingSkeleton className="skeleton-agent-option" /><LoadingSkeleton className="skeleton-agent-option" /></div>
                : catalog.error
                  ? <div className="agent-editor-error"><p role="alert" className="settings-error">{catalog.error}</p><Button size="sm" variant="flat" onPress={loadCatalog}>重试</Button></div>
                  : skills.length ? <CheckboxGroup label="可用技能" className="agent-editor-group" size="sm" value={draft.skills.filter(scope => skills.some(skill => skill.scope === scope))} onValueChange={selected => setDraft(current => ({ ...current, skills: selected }))}>
                    {skills.map(skill => <Checkbox key={skill.scope} value={skill.scope} classNames={{ label: 'agent-editor-option-label' }} isDisabled={busy}><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}</Checkbox>)}
                  </CheckboxGroup> : <p className="composer-empty">暂无可用技能</p>)}
            </div>
            {error && <p role="alert" className="settings-error">{error}</p>}
          </ModalBody>
          <ModalFooter className="app-dialog-footer">
            {agent && onDeleted && <Button size="sm" color="danger" variant="light" className="agent-editor-delete" isDisabled={busy} onPress={() => setConfirming(true)}>删除</Button>}
            <Button size="sm" variant="light" isDisabled={busy} onPress={onClose}>取消</Button>
            <Button size="sm" type="submit" color="primary" isLoading={busy} isDisabled={busy || !draft.name.trim()}>保存</Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
    {confirming && agent && onDeleted && <ConfirmAction title="删除智能体" onClose={() => setConfirming(false)} onDone={onClose}
      action={async () => { await api.request(`/custom-agents/${encodeURIComponent(agent.id)}`, 'DELETE'); await onDeleted(agent); }}>
      <p>删除智能体「{agent.name}」及其 {sessionCount} 个会话？此操作不可恢复。</p>
    </ConfirmAction>}
  </>;
}
