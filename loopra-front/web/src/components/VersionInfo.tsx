import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowUpRight, Download, RefreshCw, Server, Sparkles } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';
import { PageActions, SelectField, SettingRow } from './SettingControls';
import { MIRROR_SOURCES, RELEASE_LATEST_URL, UPDATE_SOURCE_NORMAL, buildUpdateCommand, loadUpdateSource, saveUpdateSource } from '../update-scripts';

type SystemVersion = { version: string; name?: string; buildTime?: string };
type VersionCheck = { currentVersion: string; latestVersion: string; hasNewVersion: boolean; releaseUrl?: string | null; releaseNotes?: string | null; checkTime?: string | null };

// 设置 → 关于：核心服务版本、检查更新与更新命令（旧 VersionInfoPanel.vue）。
export default function VersionInfo({ api, notify, onAutoUpdate }: { api: LoopraClient; notify: (text: string) => void; onAutoUpdate: () => void }) {
  const [current, setCurrent] = useState<SystemVersion>();
  const [check, setCheck] = useState<VersionCheck>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState(loadUpdateSource);

  useEffect(() => { saveUpdateSource(source); }, [source]);
  useEffect(() => {
    const controller = new AbortController();
    void api.request<SystemVersion>('/version/', 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setCurrent(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [api]);

  async function checkLatest() {
    setChecking(true); setError('');
    try {
      const result = await api.request<VersionCheck>('/version/check', 'GET');
      setCheck(result);
      notify(result.hasNewVersion ? `发现新版本 v${result.latestVersion}` : '当前已是最新版本');
    } catch (cause) { setError(errorText(cause)); }
    finally { setChecking(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板'); }
    catch { notify('复制失败，请手动选择命令'); }
  }

  const version = check?.currentVersion || current?.version || '-';
  const latest = check?.latestVersion;
  const hasNew = !!check?.hasNewVersion;
  const releaseUrl = check?.releaseUrl || RELEASE_LATEST_URL;
  const commands = buildUpdateCommand(source);
  const options = [{ value: UPDATE_SOURCE_NORMAL, label: '直连（GitHub）' }, ...MIRROR_SOURCES.map(mirror => ({ value: mirror.value, label: `镜像 · ${mirror.label}` }))];

  return <>
    <PageActions title="版本与更新" />
    <div className="settings-card">
      <SettingRow title="核心服务" description={`Loopra Web 服务 · ${api.base}`}>
        <span className="version-value">v{version}<i className={`tag ${hasNew && check ? '' : 'is-ok'}`}>{check ? (hasNew ? '新版' : '已是最新') : '未检查'}</i></span>
      </SettingRow>
      <SettingRow title="最新发布" description={check?.checkTime ? `上次检查：${check.checkTime}` : '点击「检查更新」获取远程最新版本'}>
        <span className="version-value">{latest ? `v${latest}` : '—'}<a className="version-link" href={releaseUrl} target="_blank" rel="noreferrer">查看发布页<ArrowUpRight size=".875rem" aria-hidden="true" /></a></span>
      </SettingRow>
      <SettingRow title="更新源" description="更新命令与自动更新使用的下载源">
        <SelectField compact label="更新源" value={source} onChange={setSource} options={options} />
      </SettingRow>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-card">
      <SettingRow title="更新命令" description="在对应系统的终端中运行，将 Loopra 更新到最新版本">
        <span />
      </SettingRow>
      <button type="button" className="version-command" title="点击复制" onClick={() => void copy(commands.windows)}><span className="uc-badge win">PS</span><code>{commands.windowsLabel}</code></button>
      <button type="button" className="version-command" title="点击复制" onClick={() => void copy(commands.unix)}><span className="uc-badge unix">sh</span><code>{commands.unixLabel}</code></button>
      <div className="version-actions">
        <Button size="sm" variant="flat" isLoading={checking} onPress={() => void checkLatest()} startContent={<RefreshCw size="0.875rem" />}>检查更新</Button>
        <Button size="sm" color={hasNew ? 'primary' : 'default'} variant={hasNew ? 'solid' : 'flat'} onPress={onAutoUpdate} startContent={<Server size="0.875rem" />}>更新核心服务</Button>
        <Button size="sm" variant="light" onPress={() => window.open(RELEASE_LATEST_URL, '_blank', 'noreferrer')} startContent={<Download size="0.875rem" />}>下载桌面端（推荐）</Button>
      </div>
      <p className="section-note"><Sparkles size="0.75rem" /> 「更新核心服务」会新建一个会话并发送更新指令，由 Agent 执行脚本。</p>
    </div>
  </>;
}
