import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowUpRight, ChevronDown, Copy, Download, Monitor, RefreshCw, Server, Terminal } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';
import { SelectField } from './SettingControls';
import { MIRROR_SOURCES, RELEASE_LATEST_URL, UPDATE_SOURCE_NORMAL, buildUpdateCommand } from '../update-scripts';
import type { VersionCheck } from '../version';
import { CoreServiceUpdateDialog, useCoreServiceUpdate, type CoreServiceUpdateController } from './CoreServiceUpdate';
import type { DesktopUpdateController } from './DesktopUpdate';
import { isDesktopWindow } from '../desktop-shell';

type SystemVersion = { version: string; name?: string; buildTime?: string };

type VersionInfoProps = { api: LoopraClient; notify: (text: string) => void; initialCheck?: VersionCheck; desktopUpdate?: DesktopUpdateController };

export default function VersionInfo(props: VersionInfoProps) {
  const coreReadOnly = !!props.desktopUpdate || isDesktopWindow();
  const coreUpdate = useCoreServiceUpdate(props.api, props.notify, undefined, !coreReadOnly);
  return <><VersionInfoPanel {...props} coreUpdate={coreUpdate} />{!coreReadOnly && <CoreServiceUpdateDialog controller={coreUpdate} notify={props.notify} />}</>;
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

  const coreReadOnly = !!desktopUpdate || isDesktopWindow();
  const version = current?.version || check?.currentVersion || '-';
  const latest = check?.latestVersion;
  const hasNew = !!check?.hasNewVersion;
  const releaseUrl = (!coreReadOnly && check?.releaseUrl) || RELEASE_LATEST_URL;
  const commands = buildUpdateCommand(source);
  const options = [{ value: UPDATE_SOURCE_NORMAL, label: '直连（GitHub）' }, ...MIRROR_SOURCES.map(mirror => ({ value: mirror.value, label: `镜像 · ${mirror.label}` }))];
  const updateRunning = !!update?.running;
  const updateBusy = startingUpdate || stoppingUpdate;
  const desktop = desktopUpdate?.state;
  const desktopStatus = desktop ? {
    unsupported: '手动更新', idle: desktop.checkedAt ? '已是最新' : '未检查', checking: '检查中',
    available: '发现新版', downloading: `下载中 ${Math.floor(desktop.percent)}%`, verifying: '校验中',
    downloaded: '待重启安装', installing: '安装中', error: '更新失败',
  }[desktop.status] : '读取中';
  const desktopTone = desktop?.status === 'error' ? 'error'
    : desktop?.status === 'downloaded' || (desktop?.status === 'idle' && desktop.checkedAt) ? 'success'
      : desktop && ['checking', 'available', 'downloading', 'verifying', 'installing'].includes(desktop.status) ? 'active' : 'neutral';

  return <section className="version-panel" aria-label="版本与更新">
    <div className="about-section-heading"><h3>版本与更新</h3><a className="version-link" href={releaseUrl} target="_blank" rel="noreferrer">查看发布页<ArrowUpRight size=".875rem" aria-hidden="true" /></a></div>
    <div className={`version-cards${desktopUpdate ? '' : ' version-cards-single'}`}>
      {desktopUpdate && <article className="version-card" aria-label="桌面客户端">
        <div className="version-card-heading"><span className="version-card-icon"><Monitor size="1.125rem" aria-hidden="true" /></span><h4>桌面客户端</h4><span className="version-status" data-tone={desktopTone} role="status">{desktopStatus}</span></div>
        <div className="version-card-number">{desktop?.currentVersion ? `v${desktop.currentVersion}` : '读取中…'}</div>
        <p className="version-card-latest">{desktop?.latestVersion ? <>最新版本 <strong>v{desktop.latestVersion}</strong></> : '安装包包含桌面端与核心服务'}</p>
        <p className="version-card-description">{desktop?.status === 'error' ? '更新遇到问题，打开详情后可重试'
          : desktop?.supported ? '后台下载新版，退出时安装' : '从发布页下载桌面端安装包'}</p>
        <div className="version-card-actions"><Button size="sm" variant="flat" onPress={desktopUpdate.show} startContent={<Download size=".875rem" />}>{desktop?.status === 'downloaded' ? '查看并安装' : '桌面端更新'}</Button></div>
      </article>}
      <article className="version-card" aria-label="核心服务">
        <div className="version-card-heading"><span className="version-card-icon"><Server size="1.125rem" aria-hidden="true" /></span><h4>核心服务</h4><span className="version-status" data-tone={(!coreReadOnly && updateRunning) || checking || hasNew ? 'active' : check ? 'success' : 'neutral'} role="status">{!coreReadOnly && updateRunning ? '更新中' : checking ? '检查中' : check ? (hasNew ? '发现新版' : '已是最新') : '未检查'}</span></div>
        <div className="version-card-number">{version === '-' ? '读取中…' : `v${version}`}</div>
        <p className="version-card-latest">{latest ? <>最新版本 <strong>v{latest}</strong></> : '检查更新以获取最新版本'}</p>
        <p className="version-card-description">{check?.checkTime ? `上次检查：${check.checkTime}` : '提供会话、工作区与 Agent 服务'}{coreReadOnly && <><br />核心服务随桌面安装包更新</>}</p>
        <div className="version-card-actions">
          {!coreReadOnly && (updateRunning
            ? <Button size="sm" color="primary" variant="flat" onPress={coreUpdate.show}>查看更新进度</Button>
            : <Button size="sm" color={hasNew ? 'primary' : 'default'} variant={hasNew ? 'solid' : 'flat'}
              isDisabled={checking || updateBusy} isLoading={startingUpdate} onPress={() => coreUpdate.prepare(version, check)}
              startContent={<Download size=".875rem" />}>{startingUpdate ? '启动中…' : '更新核心服务'}</Button>)}
          <Button size="sm" variant="light" isLoading={checking} isDisabled={updateRunning || updateBusy} onPress={() => void checkLatest()} startContent={<RefreshCw size=".875rem" />}>检查更新</Button>
        </div>
      </article>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!coreReadOnly && <div className="version-tools">
      <div className="version-source"><div><h4>核心服务更新源</h4><p>用于服务更新与手动更新命令</p></div><SelectField compact label="更新源" value={source} onChange={setSource} options={options} disabled={updateRunning || updateBusy} /></div>
      <details className="version-manual">
        <summary><Terminal size="1rem" aria-hidden="true" /><span>手动更新核心服务</span><ChevronDown size=".875rem" aria-hidden="true" /></summary>
        <div className="version-manual-content"><p>选择对应系统，点击复制后在服务所在设备的终端中运行。</p>
          <button type="button" className="version-command" title={commands.windows} aria-label="复制 Windows PowerShell 更新命令" onClick={() => void copy(commands.windows)}><span className="uc-badge win">PS</span><code>{commands.windowsLabel}</code><Copy size=".875rem" aria-hidden="true" /></button>
          <button type="button" className="version-command" title={commands.unix} aria-label="复制 macOS / Linux 更新命令" onClick={() => void copy(commands.unix)}><span className="uc-badge unix">sh</span><code>{commands.unixLabel}</code><Copy size=".875rem" aria-hidden="true" /></button>
        </div>
      </details>
    </div>}
    {!coreReadOnly && <a className="version-desktop-download" href={RELEASE_LATEST_URL} target="_blank" rel="noreferrer"><Monitor size=".875rem" aria-hidden="true" />下载桌面端<ArrowUpRight size=".875rem" aria-hidden="true" /></a>}
  </section>;
}
