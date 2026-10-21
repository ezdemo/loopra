import { useRef, useState } from 'react';
import { Button, Checkbox, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { CircleAlert, Undo2 } from 'lucide-react';
import { errorText } from './RemoteControls';

export default function RollbackMessageDialog({ hasSnapshot, onConfirm, onClose }: {
  hasSnapshot: boolean;
  onConfirm: (rollbackCode: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [rollbackCode, setRollbackCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const restoreCode = hasSnapshot && rollbackCode;

  function close() {
    if (!locked.current) onClose();
  }

  async function confirm() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await onConfirm(restoreCode);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return <Modal isOpen onClose={close} isDismissable={!busy} isKeyboardDismissDisabled={busy}
    hideCloseButton={busy} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog rollback-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
    aria-label="撤回消息">
    <ModalContent>
      <ModalHeader className="app-dialog-header rollback-dialog-header">
        <span className="rollback-dialog-icon" aria-hidden="true"><Undo2 size={20} /></span>
        <h2>撤回消息</h2>
      </ModalHeader>
      <ModalBody className="app-dialog-body rollback-dialog-body">
        <p className="rollback-dialog-description">将移除这条消息及之后的所有对话记录。</p>
        {hasSnapshot ? <Checkbox size="sm" color="primary" isSelected={rollbackCode} onValueChange={setRollbackCode}
          isDisabled={busy} aria-label="同时恢复代码"
          classNames={{ base: 'rollback-code-option', wrapper: 'rollback-code-checkbox', label: 'rollback-code-label' }}>
          <span className="rollback-code-title">同时恢复代码</span>
          <span className="rollback-code-description">将项目文件恢复到这条消息之前的快照。</span>
        </Checkbox> : <p className="rollback-dialog-note">当前代码文件会保留。</p>}
        {error && <div className="rollback-dialog-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{error}</p></div>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer rollback-dialog-footer">
        <Button autoFocus size="sm" variant="light" isDisabled={busy} onPress={close}>取消</Button>
        <Button size="sm" color="danger" isLoading={busy} isDisabled={busy} onPress={() => void confirm()}>
          {busy ? '正在撤回…' : restoreCode ? '撤回并恢复代码' : '撤回消息'}
        </Button>
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
