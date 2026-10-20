import { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { ArrowUpRight, Download, RefreshCw, Server, Square } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';
import { PageActions, SelectField, SettingRow } from './SettingControls';
import { MIRROR_SOURCES, RELEASE_LATEST_URL, UPDATE_SOURCE_NORMAL, buildUpdateCommand, loadUpdateSource, saveUpdateSource } from '../update-scripts';
import type { VersionCheck } from '../version';

type SystemVersion = { version: string; name?: string; buildTime?: string };

// 设置 → 关于：核心服务版本、检查更新与更新命令（旧 VersionInfoPanel.vue）。
type VersionUpdate = {
  running: boolean;
  state: 'idle' | 'starting' | 'running' | 'success' | 'failed' | 'stopped';
  platform: string;
  target: string;
  logFile: string;
  log: string;
  message: string;
};

const UPDATE_STATE_LABEL: Record<VersionUpdate['state'], string> = {
  idle: '无任务',
  starting: '启动中',
  running: '更新中',
  success: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export default function VersionInfo({ api, notify, initialCheck }: { api: LoopraClient; notify: (text: string) => void; initialCheck?: VersionCheck }) {
  const [current, setCurrent] = useState<SystemVersion>();
  const [check, setCheck] = useState<VersionCheck | undefined>(initialCheck);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<VersionUpdate>();
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [stoppingUpdate, setStoppingUpdate] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState(loadUpdateSource);

  useEffect(() => { saveUpdateSource(source); }, [source]);
  useEffect(() => { setCheck(initialCheck); }, [initialCheck]);
  useEffect(() => {
    const controller = new AbortController();
    void api.request<SystemVersion>('/version/', 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setCurrent(data); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refreshUpdate = async () => {
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      try {
        const result = await api.request<VersionUpdate>('/version/update', 'GET', undefined, nextController.signal);
        if (active && !nextController.signal.aborted) setUpdate(result);
      } catch {
        // Keep the last known task state when a polling request is interrupted.
      }
    };
    void refreshUpdate();
    const timer = window.setInterval(() => void refreshUpdate(), 1500);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
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

  async function updateCore() {
    setUpdateDialogOpen(true);
    setStartingUpdate(true);
    setError('');
    try {
      const result = await api.request<VersionUpdate>('/version/update', 'POST', { source });
      setUpdate(result);
      notify(result.message || '更新已启动');
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      notify(`更新启动失败：${message}`);
    } finally {
      setStartingUpdate(false);
    }
  }

  async function stopUpdate() {
    setStoppingUpdate(true);
    setError('');
    try {
      const result = await api.request<VersionUpdate>('/version/update/stop', 'POST', {});
      setUpdate(result);
      notify('更新已停止');
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      notify(`停止更新失败：${message}`);
    } finally {
      setStoppingUpdate(false);
    }
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
          ? <Button size="sm" color="primary" variant="flat" onPress={() => setUpdateDialogOpen(true)} startContent={<Server size="0.875rem" />}>查看更新进度</Button>
          : <Button size="sm" color={hasNew ? 'primary' : 'default'} variant={hasNew ? 'solid' : 'flat'}
            isDisabled={checking || updateBusy} isLoading={startingUpdate} onPress={() => void updateCore()}
            startContent={<Server size="0.875rem" />}>{startingUpdate ? '启动中…' : '更新核心服务'}</Button>}
        <Button size="sm" variant="light" onPress={() => window.open(RELEASE_LATEST_URL, '_blank', 'noreferrer')} startContent={<Download size="0.875rem" />}>下载桌面端（推荐）</Button>
      </div>
    </div>
    <Modal isOpen={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} placement="center" scrollBehavior="inside"
      classNames={{ base: 'app-dialog background-task-log-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
      aria-label="核心服务更新日志">
      <ModalContent>
        <ModalHeader className="app-dialog-header"><h2>更新日志</h2></ModalHeader>
        <ModalBody className="app-dialog-body">
          <div className="background-task-log-info">
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minWidth: 0 }}>
              <span className={`tag ${update?.state === 'failed' ? '' : 'is-ok'}`}>{update ? UPDATE_STATE_LABEL[update.state] : '启动中'}</span>
              {update?.target && <strong>{update.target}</strong>}
            </div>
            <small>{update?.message || (startingUpdate ? '正在启动核心服务更新…' : '等待更新任务')}</small>
            {update?.logFile && <code>{update.logFile}</code>}
          </div>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <pre className="background-task-log-output" role="log" aria-label="更新日志">{update?.log || (startingUpdate ? '正在启动更新…' : '等待更新输出…')}</pre>
        </ModalBody>
        <ModalFooter className="app-dialog-footer">
          {updateRunning && <Button size="sm" color="danger" variant="light" isLoading={stoppingUpdate}
            onPress={() => void stopUpdate()} startContent={<Square size="0.75rem" fill="currentColor" />}>停止更新</Button>}
          <Button size="sm" onPress={() => setUpdateDialogOpen(false)}>关闭</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  </>;
}
