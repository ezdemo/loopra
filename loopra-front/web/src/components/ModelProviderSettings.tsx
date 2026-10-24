import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Box, ChevronDown, Copy, Download, Image, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { AgentSettings } from '../settings-data';
import { applyProviderPreset, providerPresetFor, providerPresets, validateProvider } from '../settings-data';
import type { Provider, ProviderModel } from '../lib';
import { formatTokens, getModelCatalog, modelLabel, newModel, providerModels, type ComposerOptions } from '../composer';
import { Field, ModelSelect, SelectField, SettingSwitch } from './SettingControls';
import RemoteModelsPicker from './RemoteModelsPicker';

type Props = { server: string; providers: Provider[]; onProviders: (value: Provider[]) => void | Promise<void>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void; defaultModel: string; onDefaultModel: (id: string) => void; config: AgentSettings; onConfig: (value: AgentSettings) => void; notify: (message: string) => void };
type ModelEdit = { channel: string; index: number; initial: ProviderModel };
const copyProvider = (provider: Provider): Provider => ({ ...provider, models: providerModels(provider).map(model => ({ ...model })) });

function ModelConfigDialog({ initial, adding, onClose, onApply }: { initial: ProviderModel; adding: boolean; onClose: () => void; onApply: (model: ProviderModel) => string }) {
  const [model, setModel] = useState(() => ({ ...initial }));
  const [error, setError] = useState('');
  const source = useRef(initial);
  useEffect(() => {
    // Refresh an untouched dialog, while keeping edits made by the user.
    if (JSON.stringify(model) === JSON.stringify(source.current)) setModel({ ...initial });
    source.current = initial;
  }, [initial]);
  const update = (patch: Partial<ProviderModel>) => { setModel(current => ({ ...current, ...patch })); setError(''); };
  function apply() {
    const normalized = { ...model, name: model.name.trim(), displayName: model.displayName?.trim() || '' };
    const reason = validateProvider({ id: 'model', name: '模型', type: 'responses', count: 1, models: [normalized] });
    setError(reason || onApply(normalized));
  }
  return <Modal isOpen onClose={onClose} hideCloseButton placement="center" backdrop="opaque" aria-label={adding ? '添加模型配置' : '编辑模型配置'} classNames={{ wrapper: 'model-config-wrapper', base: 'model-config-modal', backdrop: 'remote-model-backdrop' }}>
    <ModalContent><form className="model-config-form" onSubmit={event => { event.preventDefault(); apply(); }}>
      <ModalHeader className="model-config-header"><div><h2>{adding ? '添加模型' : '编辑模型配置'}</h2><p>{modelLabel(initial) || '配置模型参数'}</p></div><Button isIconOnly size="sm" variant="light" aria-label="关闭模型配置" onPress={onClose}><X size="1.125rem" /></Button></ModalHeader>
      <ModalBody className="model-config-body">
        <div className="settings-field-grid"><Field autoFocus label="模型 ID" required value={model.name} onChange={name => update({ name })} placeholder="例如 deepseek-v4.1-flash" /><Field label="展示名称" value={model.displayName || ''} onChange={displayName => update({ displayName })} placeholder="可选，例如 DeepSeek Flash" /><Field label="上下文窗口（tokens）" type="number" min={1} value={model.contextTokens} onChange={value => update({ contextTokens: Number(value) })} /><Field label="最大输出（tokens）" type="number" min={1} value={model.maxTokens} onChange={value => update({ maxTokens: Number(value) })} /></div>
        <p className="model-config-note">展示名称用于界面显示，API 请求仍使用模型 ID。</p>
        <div className="model-config-capabilities"><span><SettingSwitch label="支持图片输入" value={model.imageInput} onChange={imageInput => update({ imageInput })} />图片输入</span><span><SettingSwitch label="自定义价格" value={model.priceEnabled} onChange={priceEnabled => update({ priceEnabled })} />自定义价格</span></div>
        {model.priceEnabled && <section className="model-config-pricing"><div className="model-price-heading"><span>模型价格</span><small>元 / 百万 tokens</small></div><div className="settings-price-grid">{(['inputPrice', 'cachePrice', 'outputPrice'] as const).map((key, index) => <Field key={key} label={['输入', '缓存', '输出'][index]} type="number" min={0} step={0.001} value={model[key]} onChange={value => update({ [key]: Number(value) })} />)}</div></section>}
        {error && <p role="alert" className="settings-error">{error}</p>}
      </ModalBody>
      <ModalFooter className="model-config-footer"><small>应用后，点击“保存渠道”使更改生效。</small><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" type="submit">应用更改</Button></ModalFooter>
    </form></ModalContent>
  </Modal>;
}

export default function ModelProviderSettings(props: Props) {
  const { providers, onProviders, options, onOptions, config, onConfig } = props;
  const [selectedId, setSelectedId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Provider>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [modelEdit, setModelEdit] = useState<ModelEdit | null>(null);
  const [remoteProvider, setRemoteProvider] = useState<Provider | null>(null);
  const models = useMemo(() => getModelCatalog(providers), [providers]);
  const channels = [...providers.map(provider => ({ key: provider.id, provider: drafts[provider.id] || provider })), ...Object.entries(drafts).filter(([key]) => !providers.some(provider => provider.id === key)).map(([key, provider]) => ({ key, provider }))];
  const selected = channels.find(channel => channel.key === selectedId) || channels[0];
  const key = selected?.key || '';
  const editing = selected?.provider;
  const ownModels = editing ? providerModels(editing) : [];
  const dirty = !!drafts[key];
  const search = query.trim().toLocaleLowerCase();
  const filtered = ownModels.map((model, index) => ({ model, index })).filter(({ model }) => `${model.name} ${model.displayName || ''}`.toLocaleLowerCase().includes(search));
  function clearDraft(id: string) { setDrafts(current => { const next = { ...current }; delete next[id]; return next; }); }
  function update(patch: Partial<Provider>) {
    if (!editing) return;
    setDrafts(current => ({ ...current, [key]: { ...copyProvider(current[key] || editing), ...patch } }));
    setErrors(current => ({ ...current, [key]: '' }));
  }
  function select(id: string) { setSelectedId(id); setQuery(''); setModelEdit(null); setRemoteProvider(null); }
  function add(provider?: Provider) {
    const id = `new:${crypto.randomUUID()}`;
    setDrafts(current => ({ ...current, [id]: provider ? { ...copyProvider(provider), id: '', name: `${provider.name} 副本`, apiKey: '' } : { id: '', name: '', type: 'responses', count: 0, baseUrl: '', apiKey: '', enabled: true, models: [] } }));
    select(id);
  }
  function updateConnection(patch: Partial<Provider>) { setRemoteProvider(null); update(patch); }
  function applyModel(model: ProviderModel) {
    if (!modelEdit || modelEdit.channel !== key) return '渠道已切换，请重新编辑模型';
    if (ownModels.some((item, index) => index !== modelEdit.index && item.name.trim() === model.name)) return '同一供应商内的模型名称不能重复';
    update({ models: modelEdit.index < 0 ? [...ownModels, model] : ownModels.map((item, index) => index === modelEdit.index ? model : item) });
    if (modelEdit.index < 0) setQuery('');
    setModelEdit(null); return '';
  }
  async function save() {
    if (!editing || saving) return;
    const reason = validateProvider({ ...editing, models: ownModels });
    if (reason) { setErrors(current => ({ ...current, [key]: reason })); return; }
    const entry = { ...editing, id: editing.id || crypto.randomUUID(), name: editing.name.trim(), models: ownModels.map(model => ({ ...model, name: model.name.trim(), displayName: model.displayName?.trim() || '' })), count: ownModels.length };
    setSaving(true);
    try {
      await onProviders(providers.some(provider => provider.id === editing.id) ? providers.map(provider => provider.id === editing.id ? entry : provider) : [...providers, entry]);
      clearDraft(key);
      setSelectedId(current => current === key || current === undefined ? entry.id : current);
    } catch (error) { setErrors(current => ({ ...current, [key]: error instanceof Error ? error.message : '保存失败' })); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!editing || saving) return;
    setSaving(true);
    try {
      if (providers.some(provider => provider.id === editing.id)) await onProviders(providers.filter(provider => provider.id !== editing.id));
      clearDraft(key); setSelectedId(current => current === key || current === undefined ? channels.find(channel => channel.key !== key)?.key : current); setQuery('');
    } catch (error) { setErrors(current => ({ ...current, [key]: error instanceof Error ? error.message : '移除失败' })); }
    finally { setSaving(false); }
  }
  return <>
    <details className="provider-defaults"><summary>默认模型与用途<ChevronDown size=".875rem" /></summary><div className="settings-field-grid"><ModelSelect label="新会话默认模型" value={props.defaultModel} onChange={props.onDefaultModel} models={models} /><ModelSelect label="当前聊天模型" value={options.modelId} onChange={modelId => onOptions({ ...options, modelId })} models={models} /><ModelSelect label="命令校验模型" optional value={config.validatorModel} onChange={validatorModel => onConfig({ ...config, validatorModel })} models={models} /><ModelSelect label="图片理解模型" optional value={config.imageModel} onChange={imageModel => onConfig({ ...config, imageModel })} models={models.filter(model => model.imageInput)} /></div></details>
    <div className="provider-workspace">
      <aside className="provider-channels" aria-label="模型渠道"><div className="provider-channels-heading"><span>渠道</span><small>{channels.length}</small></div><nav className="provider-channel-list" aria-label="选择模型渠道">{channels.map(channel => <button type="button" key={channel.key} aria-current={key === channel.key ? 'true' : undefined} className={`provider-channel${key === channel.key ? ' selected' : ''}`} onClick={() => select(channel.key)} title={channel.provider.name || '新渠道'}><Box size="1rem" /><span><strong>{channel.provider.name || '新渠道'}</strong><small>{providerModels(channel.provider).length} 个模型</small></span>{drafts[channel.key] && <i title="未保存" aria-label="未保存" />}</button>)}{!channels.length && <p className="provider-channel-empty">暂无渠道</p>}</nav><Button disableAnimation variant="light" className="provider-add-channel" startContent={<Plus size="1rem" />} onPress={() => add()}>添加渠道</Button></aside>
      {editing ? <section className="provider-detail" aria-label={`渠道配置：${editing.name || '新渠道'}`}>
        <header className="provider-detail-heading"><Box size="1.25rem" /><div><h3>{editing.name || '新渠道'}</h3><p>{ownModels.length} 个模型</p></div><div className="settings-action-group"><Button isIconOnly size="sm" variant="light" aria-label="复制当前渠道" isDisabled={saving} onPress={() => add(editing)}><Copy size="1rem" /></Button>{editing.id !== 'loopra' && <Button isIconOnly size="sm" variant="light" color="danger" aria-label="删除当前渠道" isDisabled={saving} onPress={() => void remove()}><Trash2 size="1rem" /></Button>}</div></header>
        <div className="provider-detail-scroll"><fieldset disabled={saving} className="provider-connection"><div className="settings-field-grid"><Field className="provider-full-field" label="API 地址" value={editing.baseUrl || ''} onChange={baseUrl => updateConnection({ baseUrl })} placeholder="https://api.example.com/v1" /><SelectField label="API 协议" value={editing.type} onChange={type => updateConnection({ type })} options={['responses', 'chat_completions', 'anthropic']} /><Field label="API 密钥" type="password" value={editing.apiKey || ''} onChange={apiKey => updateConnection({ apiKey })} placeholder="留空保留已保存的密钥" /></div><details key={key} className="provider-advanced" open={!editing.id || undefined}><summary>渠道选项</summary><div className="settings-field-grid"><Field label="渠道名称" value={editing.name} onChange={name => update({ name })} placeholder="例如 Magpie" /><SelectField label="常用服务商" value={providerPresetFor(editing.baseUrl)} onChange={name => { const preset = providerPresets.find(item => item.name === name); if (preset) updateConnection(applyProviderPreset(editing, preset)); }} options={[{ value: '', label: '自定义地址' }, ...providerPresets.map(preset => preset.name)]} /><SelectField label="特殊兼容" value={editing.compatibility || ''} onChange={compatibility => updateConnection({ compatibility })} options={[{ value: '', label: '无' }, { value: 'opencode', label: 'OpenCode 兼容' }]} /></div></details></fieldset>
          <div className="provider-model-heading"><h3>模型列表 <small>{ownModels.length}</small></h3><div className="settings-action-group"><Button disableAnimation size="sm" variant="light" isDisabled={saving || !!remoteProvider} startContent={<Download size=".9375rem" />} onPress={() => setRemoteProvider({ ...editing })}>获取模型</Button><Button disableAnimation size="sm" variant="flat" isDisabled={saving} startContent={<Plus size=".9375rem" />} onPress={() => setModelEdit({ channel: key, index: -1, initial: newModel() })}>添加模型</Button></div></div>
          {!!ownModels.length && <label className="provider-model-search"><Search size=".9375rem" /><input type="search" aria-label="搜索当前渠道模型" placeholder="搜索模型 ID 或展示名称…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
          <ul className="provider-model-list" aria-label="当前渠道模型">{filtered.map(({ model, index }) => <li className="provider-model-row" key={index}><button type="button" className="provider-model-open" aria-label={`编辑模型：${modelLabel(model)}`} title={model.name} disabled={saving} onClick={() => setModelEdit({ channel: key, index, initial: model })}><span className="provider-model-identity"><strong>{modelLabel(model)}</strong>{model.displayName?.trim() && <small>{model.name}</small>}</span><span className="provider-model-badges"><span title={`上下文窗口 ${model.contextTokens} tokens`}>{formatTokens(model.contextTokens)}</span>{model.imageInput && <span title="支持图片输入"><Image size=".75rem" /><span>图片</span></span>}</span><Pencil size=".9375rem" className="provider-model-pencil" /></button><button type="button" className="provider-model-remove" aria-label={`移除模型：${modelLabel(model)}`} disabled={saving} onClick={() => update({ models: ownModels.filter((_, i) => i !== index) })}><Trash2 size=".9375rem" /></button></li>)}</ul>
          {!filtered.length && <div className="provider-model-empty"><Box size="1.5rem" /><p>{ownModels.length ? '没有匹配的模型' : '还没有模型，获取远程模型或手动添加。'}</p>{!!query && <button type="button" onClick={() => setQuery('')}>清空搜索</button>}</div>}
        </div>
        <footer className="provider-detail-footer"><span>{errors[key] ? <span role="alert" className="provider-save-error">{errors[key]}</span> : dirty ? '有未保存的更改' : '配置已保存'}</span>{dirty && <Button size="sm" variant="light" isDisabled={saving} onPress={() => { if (!editing.id) { clearDraft(key); setSelectedId(undefined); } else clearDraft(key); setErrors(current => ({ ...current, [key]: '' })); }}>取消更改</Button>}<Button size="sm" color="primary" isLoading={saving} isDisabled={!dirty || saving} onPress={() => void save()}>保存渠道</Button></footer>
      </section> : <div className="provider-workspace-empty"><Box size="2rem" /><h3>添加第一个模型渠道</h3><p>连接供应商后，即可获取和配置模型。</p><Button color="primary" startContent={<Plus size="1rem" />} onPress={() => add()}>添加渠道</Button></div>}
    </div>
    <RemoteModelsPicker server={props.server} provider={remoteProvider} existing={ownModels.map(model => model.name)} onClose={() => setRemoteProvider(null)} onAdd={names => { const existing = new Set(ownModels.map(model => model.name.trim())); update({ models: [...ownModels, ...[...new Set(names)].filter(name => !existing.has(name)).map(name => newModel(name))] }); setRemoteProvider(null); }} />
    {modelEdit && modelEdit.channel === key && <ModelConfigDialog initial={modelEdit.index < 0 ? modelEdit.initial : ownModels[modelEdit.index] || modelEdit.initial} adding={modelEdit.index < 0} onClose={() => setModelEdit(null)} onApply={applyModel} />}
  </>;
}
