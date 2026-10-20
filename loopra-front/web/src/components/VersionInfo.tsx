import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowUpRight, Download, RefreshCw, Server } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';
import { PageActions, SelectField, SettingRow } from './SettingControls';
import { MIRROR_SOURCES, RELEASE_LATEST_URL, UPDATE_SOURCE_NORMAL, buildUpdateCommand } from '../update-scripts';
import type { VersionCheck } from '../version';
import { CoreServiceUpdateDialog, useCoreServiceUpdate, type CoreServiceUpdateController } from './CoreServiceUpdate';
import type { DesktopUpdateController } from './DesktopUpdate';

type SystemVersion = { version: string; name?: string; buildTime?: string };

// 设置 → 关于：核心服务版本、检查更新与更新命令（旧 VersionInfoPanel.vue）。
type VersionInfoProps = { api: LoopraClient; notify: (text: string) => void; initialCheck?: VersionCheck; desktopUpdate?: DesktopUpdateController };

export default function VersionInfo(props: VersionInfoProps) {
  const coreUpdate = useCoreServiceUpdate(props.api, props.notify);
  return <><VersionInfoPanel {...props} coreUpdate={coreUpdate} /><CoreServiceUpdateDialog controller={coreUpdate} notify={props.notify} /></>;
}

export function VersionInfoPanel({ api, notify, initialCheck, coreUpdate, desktopUpdate }: VersionInfoProps & { coreUpdate: CoreServiceUpdateController }) {
  const { update, startingUpdate, stoppingUpdate, source, setSource } = coreUpdate;
  const [current, setCurrent] = useState<SystemVersion>();
  const [check, setCheck] = useState<VersionCheck | undefined>(initialCheck);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setCheck(initialCheck); }, [initialCheck]);
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
    catch { notify('复制失败，请手动选择内容'); }
  }

  const version = check?.currentVersion || current?.version || '-';
  const latest = check?.latestVersion;
  const hasNew = !!check?.hasNewVersion;
  const releaseUrl = check?.releaseUrl || RELEASE_LATEST_URL;
  const commands = buildUpdateCommand(source);
  const options = [{ value: UPDATE_SOURCE_NORMAL, label: '直连（GitHub）' }, ...MIRROR_SOURCES.map(mirror => ({ value: mirror.value, label: `镜像 · ${mirror.label}` }))];
  const updateRunning = !!update?.running;
  const updateBusy = startingUpdate || stoppingUpdate;

  return <>
    <PageActions title="版本与更新" />
    {desktopUpdate && <div className="settings-card">
      <SettingRow title="桌面客户端" description={desktopUpdate.state?.supported ? '自动检查并下载新版，退出时安装' : '从发布页下载桌面端更新'}>
        <span className="version-value">{desktopUpdate.state ? `v${desktopUpdate.state.currentVersion}` : '读取中…'}</span>
      </SettingRow>
      <div className="version-actions"><Button size="sm" color="primary" variant="flat" onPress={desktopUpdate.show} startContent={<Download size=".875rem" />}>桌面端更新</Button></div>
    </div>}
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
        {updateRunning
          ? <Button size="sm" color="primary" variant="flat" onPress={coreUpdate.show} startContent={<Server size="0.875rem" />}>查看更新进度</Button>
          : <Button size="sm" color={hasNew ? 'primary' : 'default'} variant={hasNew ? 'solid' : 'flat'}
            isDisabled={checking || updateBusy} isLoading={startingUpdate} onPress={() => coreUpdate.prepare(version, check)}
            startContent={<Server size="0.875rem" />}>{startingUpdate ? '启动中…' : '更新核心服务'}</Button>}
        {!desktopUpdate && <Button size="sm" variant="light" onPress={() => window.open(RELEASE_LATEST_URL, '_blank', 'noreferrer')} startContent={<Download size="0.875rem" />}>下载桌面端（推荐）</Button>}
      </div>
    </div>
  </>;
}
