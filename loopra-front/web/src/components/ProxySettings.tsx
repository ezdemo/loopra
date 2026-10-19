import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { electronProxyApi } from '../desktop-shell';
import { normalizeProxyAddress, proxyAddressError } from '../proxy';
import { Field, PageActions, SettingRow } from './SettingControls';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * 出站代理设置。地址写入后端 `config.json` 的 `proxy` 字段，由 Java 侧
 * `ProxySettings` 应用到 JVM；桌面端再通过 preload 的 `proxy.set` 同步到
 * Electron 的 defaultSession，两者共用同一个地址。
 */
export default function ProxySettings({ api, notify }: { api: LoopraClient; notify: (message: string) => void }) {
  const [address, setAddress] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.request<{ proxy?: string }>('/config')
      .then(config => {
        if (!live) return;
        setAddress(config.proxy || '');
        setSaved(config.proxy || '');
      })
      .catch(cause => { if (live) setError(`读取代理配置失败：${errorText(cause)}`); });
    return () => { live = false; };
  }, [api]);

  async function apply(nextAddress: string) {
    const invalid = proxyAddressError(nextAddress);
    if (invalid) { setError(invalid); return; }

    setBusy(true);
    setError('');
    try {
      const normalized = normalizeProxyAddress(nextAddress);
      await api.request('/config', 'PUT', { proxy: normalized });
      setAddress(normalized);
      setSaved(normalized);

      let warning = '';
      const bridge = electronProxyApi();
      if (bridge?.set) {
        try {
          const result = await bridge.set(normalized);
          if (result?.success === false) warning = `代理已保存，但桌面端应用失败：${result.error || '请重启桌面端'}`;
        } catch (cause) {
          warning = `代理已保存，但桌面端应用失败：${errorText(cause)}`;
        }
      }
      notify(warning || (normalized ? `代理已保存：${normalized}` : '代理已关闭'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <PageActions title="网络代理" />
    <form className="settings-card rich-settings-card rich-settings-form" onSubmit={event => { event.preventDefault(); void apply(address); }}>
      <SettingRow title="出站代理" description="Java 后端与 Electron 桌面端共用；留空表示直连">
        <span className="form-hint" role="status">{saved ? `已保存：${saved}` : '当前为直连'}</span>
      </SettingRow>
      <Field label="代理地址" value={address} onChange={value => { setAddress(value); setError(''); }} placeholder="http://127.0.0.1:7890" />
      <p className="section-note">支持 HTTP 或 SOCKS5；可省略协议（默认 HTTP），例如 <code>127.0.0.1:7890</code>、<code>socks5://127.0.0.1:1080</code>。本机地址始终直连。</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-save-row">
        <Button variant="light" isDisabled={busy || (!saved && !address.trim())} onPress={() => void apply('')}>关闭代理</Button>
        <Button type="submit" color="primary" isLoading={busy}>保存代理</Button>
      </div>
    </form>
    <p className="section-note">保存后后端会重新初始化 Agent，桌面端会立即切换 Chromium 网络会话。</p>
  </>;
}
