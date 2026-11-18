import { useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { GitBranch } from 'lucide-react';
import type { AgentEngine } from '../backend';
import { errorText } from './RemoteControls';
import { SelectField } from './SettingControls';

// 「从此回复继续到新会话」的目标引擎选择：默认沿用源会话绑定，候选项只列
// 当前可用且未隐藏的引擎；源引擎即使已不可用也保留为默认项，维持既有行为。
export default function SessionBranchDialog({ sourceAgentId, engines, busy, onConfirm, onClose }: {
  sourceAgentId: string;
  engines: AgentEngine[];
  busy: boolean;
  onConfirm: (agentId: string) => Promise<void>;
  onClose: () => void;
}) {
  const sourceId = sourceAgentId || 'native';
  const options: { value: string; label: string }[] = [{ value: sourceId, label: engines.find(item => item.id === sourceId)?.name || sourceId }];
  for (const engine of engines) {
    if (engine.id === sourceId || !engine.available || engine.hidden) continue;
    options.push({ value: engine.id, label: engine.name || engine.id });
  }
  const [agentId, setAgentId] = useState(sourceId);
  const [error, setError] = useState('');
  const locked = useRef(false);

  function close() {
    if (!locked.current) onClose();
  }

  async function confirm() {
    if (locked.current) return;
    locked.current = true;
    setError('');
    try {
      await onConfirm(agentId);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      locked.current = false;
    }
  }

  return <Modal isOpen onClose={close} isDismissable={!busy} isKeyboardDismissDisabled={busy}
    hideCloseButton={busy} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog branch-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
    aria-label="继续到新会话">
    <ModalContent>
      <ModalHeader className="app-dialog-header branch-dialog-header">
        <span className="branch-dialog-icon" aria-hidden="true"><GitBranch size={20} /></span>
        <h2>继续到新会话</h2>
      </ModalHeader>
      <ModalBody className="app-dialog-body branch-dialog-body">
        <SelectField label="Agent" value={agentId} onChange={setAgentId} options={options} disabled={busy} />
        {error && <div className="branch-dialog-error" role="alert"><p>{error}</p></div>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer branch-dialog-footer">
        <Button autoFocus size="sm" variant="light" isDisabled={busy} onPress={close}>取消</Button>
        <Button size="sm" color="primary" isLoading={busy} isDisabled={busy} onPress={() => void confirm()}>
          {busy ? '正在创建…' : '创建分支'}
        </Button>
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
