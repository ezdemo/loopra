import { useMemo } from 'react';
import { Button } from '@nextui-org/react';
import { getModelCatalog, type ComposerOptions } from '../composer';
import type { Provider } from '../lib';
import type { AgentSettings } from '../settings-data';
import { ModelSelect, PageActions } from './SettingControls';

type Props = {
  providers: Provider[];
  defaultModel: string; onDefaultModel: (id: string) => void;
  options: ComposerOptions; onOptions: (value: ComposerOptions) => void;
  config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>;
  onManageModels: () => void;
};

export default function ModelUsageSettings({ providers, defaultModel, onDefaultModel, options, onOptions, config, onConfig, onManageModels }: Props) {
  const models = useMemo(() => getModelCatalog(providers), [providers]);
  return <>
    <PageActions title="模型用途"><Button size="sm" variant="light" onPress={onManageModels}>管理模型供应商</Button></PageActions>
    <h3 className="settings-section-title">聊天模型</h3>
    <div className="settings-card model-usage-card settings-field-grid">
      <div className="settings-field"><ModelSelect label="新会话默认模型" value={defaultModel} onChange={onDefaultModel} models={models} /><p className="model-usage-hint">新建会话时默认使用的模型。</p></div>
      <div className="settings-field"><ModelSelect label="当前聊天模型" value={options.modelId} onChange={modelId => onOptions({ ...options, modelId })} models={models} /><p className="model-usage-hint">切换当前聊天使用的模型。</p></div>
    </div>
    <h3 className="settings-section-title">辅助功能</h3>
    <div className="settings-card model-usage-card settings-field-grid">
      <div className="settings-field model-usage-wide"><ModelSelect label="工具模型" optional value={config.toolModel} onChange={toolModel => onConfig({ ...config, toolModel })} models={models} /><p className="model-usage-hint">用于会话标题生成，未配置时使用消息截取标题。“做梦”记忆整理尚未实现。</p></div>
      <div className="settings-field"><ModelSelect label="命令校验模型" optional value={config.validatorModel} onChange={validatorModel => onConfig({ ...config, validatorModel })} models={models} /><p className="model-usage-hint">用于工具调用前的命令校验，可指定独立模型。</p></div>
      <div className="settings-field"><ModelSelect label="图片理解模型" optional value={config.imageModel} onChange={imageModel => onConfig({ ...config, imageModel })} models={models.filter(model => model.imageInput)} /><p className="model-usage-hint">用于理解图片，仅列出支持图片输入的模型。</p></div>
    </div>
    {!models.length && <p className="section-note">暂无可用模型，请先在“模型供应商”中添加并启用模型。</p>}
  </>;
}
