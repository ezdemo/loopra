import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { PageHeader, SettingRow } from './SettingControls';
import { RemoteState, useRemote } from './RemoteControls';

type BridgeStatus = { registered: boolean; address: string };
type ToolInfo = { name: string; description?: string; readOnly: boolean; enabled: boolean };

/**
 * 浏览器工具与桌面桥接状态。AI 浏览器（打开标签页 / 点击 / 截图）由 Loopra
 * 桌面端在启动后通过 `POST /system/browser-bridge` 登记本机地址；Web 端只读展示，
 * 不再跳转到旧版控制台。
 */
export default function BrowserSettings({ api }: { api: LoopraClient }) {
  const [revision, setRevision] = useState(0);
  const bridge = useRemote<BridgeStatus>(api, '/system/browser-bridge', revision);
  const tools = useRemote<ToolInfo[]>(api, '/tools', revision);
  const browserTools = (tools.data || []).filter(tool => tool.name.startsWith('browser_'));
  return <>
    <PageHeader title="浏览器" description="AI 浏览器工具由 Loopra 桌面端提供本机桥接；Web 端展示实时状态。">
      <Button size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button>
    </PageHeader>
    <RemoteState loading={bridge.loading} error={bridge.error} />
    <div className="settings-card">
      <SettingRow title="桌面浏览器桥接" description="Electron 桌面端启动后自动登记本机地址">
        <span className="form-hint" role="status">{bridge.loading ? '读取中…' : bridge.data?.registered ? `已连接 · ${bridge.data.address}` : '未连接（AI 浏览器仅在桌面端可用）'}</span>
      </SettingRow>
      <SettingRow title="浏览器工具" description="由后端工具注册表提供，随桥接可用性生效">
        <span className="form-hint" role="status">{tools.loading ? '读取中…' : tools.error ? '读取失败' : `${browserTools.length} 个`}</span>
      </SettingRow>
    </div>
    {browserTools.length > 0 && <div className="settings-card">{browserTools.map(tool => <SettingRow key={tool.name} title={tool.name} description={tool.description || ''}><span className="form-hint">{tool.readOnly ? '只读' : '写入'}{tool.enabled ? '' : ' · 已停用'}</span></SettingRow>)}</div>}
    <p className="section-note">未连接时，Agent 调用浏览器工具会返回 <code>BRIDGE_UNAVAILABLE</code>；启动 Loopra 桌面端后自动恢复。浏览器工具的启用与只读属性可在「工具」分类中调整。</p>
  </>;
}
