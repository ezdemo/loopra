import { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress } from '@nextui-org/react';
import { Download, RefreshCw } from 'lucide-react';
import { electronApi } from '../desktop-shell';
import { desktopUpdateLabel, type DesktopUpdateState } from '../desktop-update';
import { RELEASE_LATEST_URL } from '../update-scripts';

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

export function DesktopUpdateDialog({ controller: c }: { controller: DesktopUpdateController }) {
  const s = c.state;
  const busy = !!s && ['checking', 'available', 'downloading', 'installing'].includes(s.status);
  const ready = s?.status === 'downloaded';
  return <Modal isOpen={c.open} onClose={c.close} size="md" hideCloseButton={s?.status === 'installing'}
    isDismissable={s?.status !== 'installing'}
    classNames={{ base: 'app-dialog version-update-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>桌面端更新</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        <p>当前桌面端：{s?.currentVersion ? `v${s.currentVersion}` : '读取中…'}</p>
        {s?.latestVersion && <p>最新版本：v{s.latestVersion}</p>}
        <p role="status">{s ? desktopUpdateLabel(s) : '正在读取更新状态…'}</p>
        {s?.status === 'downloading' && <Progress aria-label="桌面端下载进度" value={s.percent} size="sm" />}
        {s?.supported && <p className="settings-hint">新版会在后台自动下载，退出应用时自动安装；也可以下载完成后点击重启并安装。</p>}
        {ready && c.blockedReason && <p role="status">{c.blockedReason}</p>}
        {(c.error || s?.error) && <p className="settings-error" role="alert">{c.error || s?.error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        <Button variant="light" size="sm" onPress={() => window.open(RELEASE_LATEST_URL, '_blank', 'noreferrer')}>查看发布页</Button>
        {ready ? <Button color="primary" size="sm" isDisabled={!!c.blockedReason} onPress={() => void c.install()} startContent={<RefreshCw size=".875rem" />}>重启并安装</Button>
          : (!s || s.supported) && <Button color="primary" size="sm" isLoading={busy} onPress={() => void c.check()} startContent={<Download size=".875rem" />}>{s?.status === 'error' ? '重试更新' : s?.status === 'downloading' ? '下载中…' : s?.status === 'installing' ? '正在安装…' : '检查更新'}</Button>}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
