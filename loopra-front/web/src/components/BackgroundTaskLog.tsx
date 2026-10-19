import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { BashSessionsState } from '../useBashSessions';
import { bashSessionState } from '../bash-sessions';

export default function BackgroundTaskLog({ state, open, onClose, notify }: { state: BashSessionsState; open: boolean; onClose: () => void; notify: (message: string) => void }) {
  const current = state.sessions.find(item => item.sessionId === state.selected);
  async function copy() {
    try { await navigator.clipboard.writeText(state.output || ''); notify('输出已复制'); }
    catch { notify('复制失败'); }
  }
  async function terminate() {
    if (!current) return;
    try { await state.terminate(current.sessionId); }
    catch (cause) { notify(cause instanceof Error ? cause.message : '终止失败'); }
  }
  return <Modal isOpen={open} onClose={onClose} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog background-task-log-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="后台任务输出">
    <ModalContent><ModalHeader className="app-dialog-header"><h2>任务输出</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        {current && <div className="background-task-log-info"><code>{current.command}</code><small>{bashSessionState(current)}{current.workdir && ` · ${current.workdir}`}</small></div>}
        {state.error && <p className="settings-error" role="alert">{state.error}</p>}
        <pre className="background-task-log-output" role="log" aria-label="任务输出日志">{state.output || (state.loading ? '正在读取输出…' : current ? '暂时没有输出，后台会自动刷新。' : '该任务已结束或已清理。')}</pre>
      </ModalBody>
      <ModalFooter className="app-dialog-footer">{current?.status === 'running' && <Button size="sm" color="danger" variant="light" isLoading={state.terminating.includes(current.sessionId)} onPress={() => void terminate()}>终止任务</Button>}<Button size="sm" variant="light" onPress={state.refresh}>刷新</Button><Button size="sm" variant="light" isDisabled={!state.output} onPress={() => void copy()}>复制输出</Button><Button size="sm" onPress={onClose}>关闭</Button></ModalFooter>
    </ModalContent>
  </Modal>;
}
