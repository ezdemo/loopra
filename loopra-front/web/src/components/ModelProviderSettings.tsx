import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowLeft, ChevronRight, Copy, Download, Plus, Trash2 } from 'lucide-react';
import type { AgentSettings } from '../settings-data';
import { applyProviderPreset, providerPresetFor, providerPresets, validateProvider } from '../settings-data';
import type { Provider } from '../lib';
import { getModelCatalog, newModel, providerModels, type ComposerOptions } from '../composer';
import { Enter } from './Motion';
import { LoopraMark } from './ui';
import { Field, ModelSelect, PageHeader, SelectField, SettingSwitch, SettingDisclosure } from './SettingControls';
import RemoteModelsPicker from './RemoteModelsPicker';

type Props = { server: string; providers: Provider[]; onProviders: (value: Provider[]) => void | Promise<void>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void; defaultModel: string; onDefaultModel: (id: string) => void; config: AgentSettings; onConfig: (value: AgentSettings) => void; notify: (message: string) => void };
export default function ModelProviderSettings(props: Props) {
  const { providers, onProviders, options, onOptions, config, onConfig } = props;
  const [editing, setEditing] = useState<Provider | null>(null);
  const [error, setError] = useState('');
  const [remoteProvider, setRemoteProvider] = useState<Provider | null>(null);
  const models = getModelCatalog(providers);
  function edit(provider?: Provider) {
    setError(''); setRemoteProvider(null);
    setEditing(provider ? { ...provider, models: providerModels(provider).map(model => ({ ...model })) } : { id: '', name: '', type: 'responses', count: 0, baseUrl: '', apiKey: '', enabled: true, models: [] });
  }
  async function save() {
    if (!editing) return;
    const reason = validateProvider(editing);
    if (reason) { setError(reason); return; }
    const entry = { ...editing, id: editing.id || crypto.randomUUID(), name: editing.name.trim(), models: editing.models?.map(model => ({ ...model, name: model.name.trim() })), count: editing.models?.length || 0 };
    try { await onProviders(editing.id ? providers.map(provider => provider.id === editing.id ? entry : provider) : [...providers, entry]); setEditing(null); } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
  }
  function copyProvider(provider: Provider) {
    edit({ ...provider, id: '', name: `${provider.name} 副本`, apiKey: '', models: providerModels(provider) });
  }
  function updateConnection(patch: Partial<Provider>) {
    setRemoteProvider(null);
    setEditing(current => current ? { ...current, ...patch } : null);
  }
  if (editing) return <Enter key={editing.id || 'new'}>
    <PageHeader title={editing.id ? '编辑模型供应商' : '添加模型供应商'} description="配置保存到 Loopra 后端，密钥保留在后端配置文件中。"><Button isIconOnly variant="light" aria-label="返回模型列表" onPress={() => setEditing(null)}><ArrowLeft size="1.125rem" /></Button></PageHeader>
    <form className="rich-settings-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="settings-field-grid"><SelectField label="常用服务商（自动填入地址）" value={providerPresetFor(editing.baseUrl)} onChange={name => { const preset = providerPresets.find(item => item.name === name); if (preset) setEditing(applyProviderPreset(editing, preset)); }} options={[{ value: '', label: '自定义地址' }, ...providerPresets.map(preset => preset.name)]} /><Field label="供应商名称" value={editing.name} onChange={name => setEditing({ ...editing, name })} placeholder="例如：我的模型渠道" /><Field label="API 地址" value={editing.baseUrl || ''} onChange={baseUrl => updateConnection({ baseUrl })} placeholder="https://api.example.com/v1" />
        <SelectField label="API 协议" value={editing.type} onChange={type => updateConnection({ type })} options={['responses', 'chat_completions', 'anthropic']} /><SelectField label="特殊兼容" value={editing.compatibility || ''} onChange={compatibility => updateConnection({ compatibility })} options={[{ value: '', label: '无' }, { value: 'opencode', label: 'OpenCode 兼容' }]} />
        <Field label="API 密钥" type="password" value={editing.apiKey || ''} onChange={apiKey => updateConnection({ apiKey })} placeholder="已保存的密钥会脱敏显示；留空保留原密钥" />
      </div>

      <div className="settings-inline-heading model-list-heading"><h3>模型列表 <small>{editing.models?.length || 0}</small></h3><div className="settings-action-group"><Button size="sm" variant="bordered" startContent={<Download size="0.9375rem" />} isDisabled={!!remoteProvider} onPress={() => setRemoteProvider({ ...editing })}>获取模型</Button><Button size="sm" variant="flat" startContent={<Plus size="0.9375rem" />} onPress={() => setEditing({ ...editing, models: [...(editing.models || []), newModel()] })}>添加模型</Button></div></div>
      <RemoteModelsPicker server={props.server} provider={remoteProvider} existing={(editing.models || []).map(model => model.name)} onClose={() => setRemoteProvider(null)} onAdd={names => { setEditing(current => { if (!current) return null; const existing = new Set((current.models || []).map(model => model.name.trim())); return { ...current, models: [...(current.models || []), ...names.filter(name => !existing.has(name)).map(name => newModel(name))] }; }); setRemoteProvider(null); props.notify(`已添加 ${names.length} 个模型到草稿，请保存配置`); }} />
      {!editing.models?.length && <p className="rich-settings-empty">添加模型后，可在输入栏中选择使用。</p>}
      {(editing.models || []).map((model, index) => {
        const updateModel = (patch: Partial<typeof model>) => setEditing({ ...editing, models: editing.models!.map((item, i) => i === index ? { ...item, ...patch } : item) });
        return <div className="settings-model-editor" key={index}><div className="settings-inline-heading"><strong>{model.name || `新模型 ${index + 1}`}</strong><Button isIconOnly size="sm" variant="light" aria-label={`移除模型：${model.name || index + 1}`} onPress={() => setEditing({ ...editing, models: editing.models!.filter((_, i) => i !== index) })}><Trash2 size="0.9375rem" /></Button></div>
          <div className="settings-field-grid"><Field label={`模型名称 ${index + 1}`} value={model.name} onChange={name => updateModel({ name })} /><Field label={`上下文 tokens ${index + 1}`} type="number" min={1} value={model.contextTokens} onChange={value => updateModel({ contextTokens: Number(value) })} /><Field label={`最大输出 tokens ${index + 1}`} type="number" min={1} value={model.maxTokens} onChange={value => updateModel({ maxTokens: Number(value) })} /></div>
          <div className="model-editor-switches"><span>支持图片输入<SettingSwitch label={`支持图片输入 ${index + 1}`} value={model.imageInput} onChange={imageInput => updateModel({ imageInput })} /></span><span>配置价格<SettingSwitch label={`配置价格 ${index + 1}`} value={model.priceEnabled} onChange={priceEnabled => updateModel({ priceEnabled })} /></span></div>
          {model.priceEnabled && <div className="settings-price-grid">{(['inputPrice', 'cachePrice', 'outputPrice'] as const).map((key, priceIndex) => <Field key={key} label={`${['输入', '缓存', '输出'][priceIndex]}价格 ${index + 1}（元/百万 tokens）`} type="number" min={0} step={0.001} value={model[key]} onChange={value => updateModel({ [key]: Number(value) })} />)}</div>}
        </div>;
      })}
      <p className="form-hint">保存时写入 Loopra 模型渠道配置；脱敏密钥保持原值。</p>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="settings-save-row"><Button variant="light" onPress={() => setEditing(null)}>取消</Button><Button color="primary" type="submit">保存配置</Button></div>
    </form>
  </Enter>;
  return <>
    <PageHeader title="模型供应商" description="按渠道管理模型，并与聊天输入栏共享配置。"><Button size="sm" variant="bordered" startContent={<Plus size="1rem" />} onPress={() => edit()}>添加供应商</Button></PageHeader>
    <div className="settings-card rich-settings-card"><div className="settings-field-grid model-defaults"><ModelSelect label="新会话默认模型" value={props.defaultModel} onChange={props.onDefaultModel} models={models} /><ModelSelect label="当前聊天模型" value={options.modelId} onChange={modelId => onOptions({ ...options, modelId })} models={models} /><ModelSelect label="命令校验模型" optional value={config.validatorModel} onChange={validatorModel => onConfig({ ...config, validatorModel })} models={models} /><ModelSelect label="图片理解模型" optional value={config.imageModel} onChange={imageModel => onConfig({ ...config, imageModel })} models={models.filter(model => model.imageInput)} /></div></div>
    <div className="settings-card provider-card">{providers.map(provider => <div className="settings-provider-list-row" key={provider.id}><Button variant="light" className="provider-row" onPress={() => edit(provider)}><span className={`provider-icon ${provider.id === 'loopra' ? 'loopra' : ''}`} style={{ background: provider.color || 'var(--line)', color: provider.color ? 'white' : 'var(--secondary)' }}>{provider.id === 'loopra' ? <LoopraMark small /> : provider.name[0]?.toUpperCase()}</span><span className="provider-name">{provider.name}<small>{provider.type}</small></span><span className="provider-count">{providerModels(provider).length} 个模型</span><ChevronRight size="1rem" /></Button></div>)}</div>
    {providers.length === 0 && <p className="rich-settings-empty">还没有模型供应商，添加一个开始配置。</p>}
    <SettingDisclosure className="settings-advanced" heading="更多渠道操作">{providers.map(provider => <div key={provider.id} className="settings-inline-heading"><span>{provider.name}</span><div className="settings-action-group"><Button size="sm" variant="light" onPress={() => copyProvider(provider)}><Copy size="0.875rem" />复制配置</Button>{provider.id !== 'loopra' && <Button size="sm" variant="light" color="danger" onPress={() => { void Promise.resolve(onProviders(providers.filter(item => item.id !== provider.id))).catch(() => {}); }}>移除</Button>}</div></div>)}</SettingDisclosure>
  </>;
}
