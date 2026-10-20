import { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { ArrowRight, Check, CircleAlert, CircleCheck, CirclePause, Copy, Download, FileText, LoaderCircle, RefreshCw, Server, Square, Terminal } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';
import { SelectField } from './SettingControls';
import type { VersionCheck } from '../version';
import { MIRROR_SOURCES, UPDATE_SOURCE_NORMAL, loadUpdateSource, saveUpdateSource } from '../update-scripts';

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

type UpdatePreparation = { currentVersion: string; latestVersion?: string; hasNewVersion?: boolean };
const UPDATE_SOURCE_OPTIONS = [
  { value: UPDATE_SOURCE_NORMAL, label: '直连（GitHub）' },
  ...MIRROR_SOURCES.map(mirror => ({ value: mirror.value, label: `镜像 · ${mirror.label}` })),
];

export function useCoreServiceUpdate(api: LoopraClient, notify: (text: string) => void, onOpen?: () => void, enabled = true) {
  const [update, setUpdate] = useState<VersionUpdate>();
  const [startingUpdate, setStartingUpdate] = useState(false);
  const [stoppingUpdate, setStoppingUpdate] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [view, setView] = useState<'confirm' | 'log'>('confirm');
  const [preparation, setPreparation] = useState<UpdatePreparation>();
  const [checkingVersions, setCheckingVersions] = useState(false);
  const [versionError, setVersionError] = useState('');
  const [checkRevision, setCheckRevision] = useState(0);
  const [error, setError] = useState('');
  const [source, setSource] = useState(loadUpdateSource);

  useEffect(() => { saveUpdateSource(source); }, [source]);

  useEffect(() => {
    if (!updateDialogOpen || view !== 'confirm') return;
    const controller = new AbortController();
    setCheckingVersions(true);
    setVersionError('');
    void api.request<VersionCheck>('/version/check', 'GET', undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setPreparation(previous => previous && ({
          ...previous, currentVersion: result.currentVersion || previous.currentVersion,
          latestVersion: result.latestVersion, hasNewVersion: result.hasNewVersion,
        }));
      })
      .catch(cause => { if (!controller.signal.aborted) setVersionError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setCheckingVersions(false); });
    return () => controller.abort();
  }, [api, updateDialogOpen, view, checkRevision]);

  useEffect(() => {
    if (!enabled && !updateDialogOpen && !update?.running) return;
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
  }, [api, enabled, updateDialogOpen, update?.running]);

  function show() {
    setView('log');
    onOpen?.();
    setUpdateDialogOpen(true);
  }

  function prepare(currentVersion: string, check?: VersionCheck) {
    setPreparation({ currentVersion, latestVersion: check?.latestVersion, hasNewVersion: check?.hasNewVersion });
    setView('confirm');
    setCheckingVersions(true);
    setVersionError('');
    setError('');
    onOpen?.();
    setUpdateDialogOpen(true);
    setCheckRevision(previous => previous + 1);
  }

  async function updateCore() {
    if (startingUpdate || checkingVersions || !preparation?.latestVersion) return;
    if (update?.running) { show(); return; }
    show();
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

  return {
    update, startingUpdate, stoppingUpdate, updateDialogOpen, error, view, preparation, checkingVersions, versionError, source, setSource,
    prepare, show, updateCore, stopUpdate, checkVersions: () => { setCheckingVersions(true); setCheckRevision(previous => previous + 1); },
    close: () => setUpdateDialogOpen(false),
  };
}

export type CoreServiceUpdateController = ReturnType<typeof useCoreServiceUpdate>;

export function CoreServiceUpdateDialog({ controller, notify }: { controller: CoreServiceUpdateController; notify: (text: string) => void }) {
  const { update, startingUpdate, stoppingUpdate, updateDialogOpen, error, stopUpdate, close } = controller;
  const { view, preparation, checkingVersions, versionError } = controller;
  const confirming = view === 'confirm';
  const updateRunning = !!update?.running;
  const updateState = startingUpdate ? 'starting' : error && !updateRunning ? 'failed' : update?.state || 'idle';
  const UpdateStatusIcon = updateState === 'success' ? CircleCheck
    : updateState === 'failed' ? CircleAlert
    : updateState === 'stopped' ? CirclePause
    : updateState === 'starting' || updateState === 'running' ? LoaderCircle : Server;
  const updateMessage = startingUpdate ? '正在启动核心服务更新…' : update?.message || '等待更新任务';
  const logLineCount = update?.log ? update.log.trimEnd().split(/\r\n|\r|\n/).length : 0;

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板'); }
    catch { notify('复制失败，请手动选择内容'); }
  }

  return (
    <Modal isOpen={updateDialogOpen} onClose={close} placement="center" scrollBehavior="inside"
      classNames={{ base: `app-dialog background-task-log-modal version-update-modal${confirming ? ' version-update-confirmation' : ''}`, wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
      aria-label={confirming ? '核心服务更新' : '核心服务更新日志'}>
      <ModalContent>
        <ModalHeader className="app-dialog-header">
          <span className="version-update-header-icon"><Download size="1.125rem" aria-hidden="true" /></span>
          <div className="version-update-heading"><h2>{confirming ? '更新核心服务' : '更新日志'}</h2><p>{confirming ? '查看版本信息，确认后开始更新' : '核心服务的更新状态与执行记录'}</p></div>
        </ModalHeader>
        <ModalBody className="app-dialog-body">
          {confirming ? <>
            <div className="version-update-versions" aria-label="版本对比">
              <dl><dt>当前版本</dt><dd>{preparation?.currentVersion && preparation.currentVersion !== '-' ? `v${preparation.currentVersion}` : '未知'}</dd></dl>
              <ArrowRight size="1.125rem" aria-hidden="true" />
              <dl className="version-update-latest"><dt>最新版本</dt><dd>{preparation?.latestVersion ? `v${preparation.latestVersion}` : checkingVersions ? '检查中…' : '获取失败'}</dd></dl>
            </div>
            <div className="version-update-check-row">
              <span role="status">{checkingVersions ? '正在获取最新版本信息…'
                : versionError ? '版本检查未完成'
                : preparation?.hasNewVersion ? '发现新版本，可以开始更新' : '当前已是最新版本，可手动重新安装'}</span>
              <Button size="sm" variant="light" isLoading={checkingVersions} onPress={controller.checkVersions}
                startContent={<RefreshCw size="0.8125rem" aria-hidden="true" />}>重新检查</Button>
            </div>
            {versionError && <p className="settings-error" role="alert">{versionError}</p>}
            <div className="version-update-source"><span>更新源</span>
              <SelectField compact label="更新源" value={controller.source} onChange={controller.setSource}
                options={UPDATE_SOURCE_OPTIONS} disabled={startingUpdate || updateRunning} />
            </div>
          </> : <>
          <div className="version-update-summary" data-state={updateState} role="status">
            <span className="version-update-status-icon">
              <UpdateStatusIcon size="1.375rem" aria-hidden="true" />
            </span>
            <div className="version-update-summary-copy">
              <div className="version-update-summary-title">
                <strong>{update?.target || '核心服务'}</strong>
                <span className="version-update-state">{UPDATE_STATE_LABEL[updateState]}</span>
              </div>
              <p>{updateMessage}</p>
            </div>
          </div>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <div className="version-update-console">
            <div className="version-update-console-toolbar">
              <span className="version-update-console-title"><Terminal size="0.9375rem" aria-hidden="true" />执行输出</span>
              <span className="version-update-line-count">{logLineCount} 行</span>
              <Button size="sm" variant="light" className="version-update-copy" isDisabled={!update?.log}
                onPress={() => void copy(update?.log || '')} startContent={<Copy size="0.875rem" aria-hidden="true" />}>复制日志</Button>
            </div>
            <pre className="background-task-log-output version-update-output" role="log" aria-label="更新日志" tabIndex={0}>{update?.log || (startingUpdate ? '正在启动更新…' : '等待更新输出…')}</pre>
            {update?.logFile && <div className="version-update-log-file">
              <FileText size="0.875rem" aria-hidden="true" />
              <span>日志文件</span>
              <code title={update.logFile}>{update.logFile}</code>
              <Button isIconOnly size="sm" variant="light" className="version-update-copy-path" aria-label="复制日志路径"
                onPress={() => void copy(update.logFile)}><Copy size="0.8125rem" aria-hidden="true" /></Button>
            </div>}
          </div>
          </>}
        </ModalBody>
        <ModalFooter className="app-dialog-footer">
          <span className="version-update-footer-note">{confirming ? '点击「开始更新」后才会下载并安装'
            : updateRunning || startingUpdate
            ? '日志自动刷新，关闭窗口后仍会继续更新'
            : updateState === 'success' ? <><Check size="0.875rem" aria-hidden="true" />更新记录已保留</>
            : '可复制日志用于排查问题'}</span>
          {!confirming && updateRunning && <Button size="sm" color="danger" variant="light" isLoading={stoppingUpdate}
            onPress={() => void stopUpdate()} startContent={<Square size="0.75rem" fill="currentColor" />}>停止更新</Button>}
          <Button size="sm" color={confirming ? 'default' : 'primary'} variant={confirming ? 'light' : 'flat'} onPress={close}>关闭</Button>
          {confirming && <Button size="sm" color="primary" isLoading={startingUpdate}
            isDisabled={stoppingUpdate || (!updateRunning && (checkingVersions || !preparation?.latestVersion))}
            onPress={() => { if (updateRunning) controller.show(); else void controller.updateCore(); }}
            startContent={<Download size="0.875rem" aria-hidden="true" />}>{updateRunning ? '查看更新进度' : '开始更新'}</Button>}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
