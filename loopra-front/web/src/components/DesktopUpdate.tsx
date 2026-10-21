import { useCallback, useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress } from '@nextui-org/react';
import { ArrowRight, CircleAlert, CircleCheck, Download, ExternalLink, LoaderCircle, Monitor, RefreshCw } from 'lucide-react';
import { electronApi } from '../desktop-shell';
import { desktopUpdateLabel, type DesktopUpdateState } from '../desktop-update';
import { RELEASE_LATEST_URL } from '../update-scripts';
import { ReleaseNotesPanel, useReleaseNotes } from './ReleaseNotes';

export function useDesktopUpdate(blockedReason = '', onOpen?: () => void) {
  const bridge = electronApi()?.desktopUpdate;
  const [state, setState] = useState<DesktopUpdateState>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const accept = (next: DesktopUpdateState) => {
      if (active) setState(previous => !previous || next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = bridge.onState(accept);
    void bridge.getState().then(accept).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  async function check() {
    setError('');
    try { await bridge?.check(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function install() {
    if (blockedReason) return;
    setError('');
    try { await bridge?.install(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function show() { onOpen?.(); setOpen(true); }
  return { available: !!bridge, state, open, show, close: () => setOpen(false), check, install, error, blockedReason };
}

export type DesktopUpdateController = ReturnType<typeof useDesktopUpdate>;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit > 0 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function DesktopUpdateDialog({ controller: c }: { controller: DesktopUpdateController }) {
  const s = c.state;
  const bridge = electronApi()?.desktopUpdate;
  const loadNotes = useCallback(async () => {
    if (!bridge?.getReleaseNotes) throw new Error('当前桌面端暂不支持读取更新日志，请前往发布页查看。');
    return bridge.getReleaseNotes();
  }, [bridge]);
  const releaseNotes = useReleaseNotes(c.open, loadNotes, [s?.currentVersion, s?.latestVersion, s?.checkedAt].join(':'));
  const { notes, loading } = releaseNotes;
  const busy = !!s && ['checking', 'available', 'downloading', 'verifying', 'installing'].includes(s.status);
  const ready = s?.status === 'downloaded';
  const latestVersion = s?.latestVersion || notes?.latestVersion;
  const currentVersion = s?.currentVersion || notes?.currentVersion;
  const upToDate = s?.status === 'idle' && !!s.checkedAt;
  const StatusIcon = s?.status === 'error' || s?.status === 'unsupported' ? CircleAlert
    : ready || upToDate ? CircleCheck : busy ? LoaderCircle : Monitor;
  const statusTone = s?.status === 'error' ? 'error' : ready || upToDate ? 'success' : busy ? 'active' : 'neutral';
  return <Modal isOpen={c.open} onClose={c.close} placement="center" scrollBehavior="inside" hideCloseButton={s?.status === 'installing'}
    isDismissable={s?.status !== 'installing'}
    isKeyboardDismissDisabled={s?.status === 'installing'} aria-label="桌面端更新"
    classNames={{ base: 'app-dialog version-update-modal desktop-update-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}>
    <ModalContent>
      <ModalHeader className="app-dialog-header">
        <span className="version-update-header-icon desktop-update-header-icon"><Monitor size="1.25rem" aria-hidden="true" /></span>
        <div className="version-update-heading"><h2>桌面端更新</h2><p>查看版本变化，让 Loopra 保持最新</p></div>
      </ModalHeader>
      <ModalBody className="app-dialog-body">
        <section className="desktop-update-overview" data-tone={statusTone} aria-label="更新概览">
          <div className="desktop-update-status" role="status">
            <span className={`desktop-update-status-icon${busy ? ' is-spinning' : ''}`}><StatusIcon size="1.25rem" aria-hidden="true" /></span>
            <div><strong>{s ? desktopUpdateLabel(s) : '正在读取更新状态…'}</strong>
              <p>{ready ? '新版已准备就绪，可在方便时重启完成更新。'
                : s?.supported ? '自动检查 · 后台下载 · 退出时安装' : '从官方发布页获取适合当前系统的安装包'}</p></div>
          </div>
          <div className="desktop-update-version-path" aria-label="版本对比">
            <dl><dt>当前版本<span>已安装</span></dt><dd>{currentVersion ? `v${currentVersion}` : '读取中…'}</dd></dl>
            <ArrowRight size="1.125rem" aria-hidden="true" />
            <dl className="desktop-update-target"><dt>最新版本{ready && <span>已下载</span>}</dt><dd>{latestVersion ? `v${latestVersion}` : upToDate ? `v${currentVersion}` : busy || loading ? '检查中…' : '待检查'}</dd></dl>
          </div>
          {s?.status === 'downloading' && <div className="desktop-update-download">
            <Progress aria-label="桌面端下载进度" value={s.percent} size="sm" />
            <div><span>{formatBytes(s.transferred)} / {s.total > 0 ? formatBytes(s.total) : '计算大小中…'}</span><span>{s.bytesPerSecond > 0 ? `${formatBytes(s.bytesPerSecond)}/s` : '正在连接…'}</span></div>
          </div>}
        </section>
        {s?.installHint && <p className="desktop-update-notice">{s.installHint}</p>}
        {ready && c.blockedReason && <p role="status">{c.blockedReason}</p>}
        {(c.error || s?.error) && <p className="settings-error" role="alert">{c.error || s?.error}</p>}
        <ReleaseNotesPanel state={releaseNotes} currentVersion={currentVersion} latestVersion={latestVersion} />
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        <span className="version-update-footer-note">{s?.checkedAt ? `上次检查 ${new Date(s.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '更新下载期间可继续使用 Loopra'}</span>
        <Button variant="light" size="sm" onPress={() => window.open(RELEASE_LATEST_URL, '_blank', 'noreferrer')} startContent={<ExternalLink size=".875rem" />}>查看发布页</Button>
        {ready ? <Button color="primary" size="sm" isDisabled={!!c.blockedReason} onPress={() => void c.install()} startContent={<RefreshCw size=".875rem" />}>重启并安装</Button>
          : (!s || s.supported) && <Button color="primary" size="sm" isLoading={busy} onPress={() => void c.check()} startContent={busy ? undefined : <Download size=".875rem" />}>{s?.status === 'error' ? '重试更新' : s?.status === 'downloading' ? '下载中…' : s?.status === 'verifying' ? '正在验证…' : s?.status === 'installing' ? '正在安装…' : '检查更新'}</Button>}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
