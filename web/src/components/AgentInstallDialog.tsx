import { useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { agentAcpInstallPrompt } from '../agent-install';
import type { AgentEngine } from '../backend';

/** ACP 依赖安装说明弹窗：把提示词复制给任一 Agent 即可完成安装。 */
export default function AgentInstallDialog({ engine, onClose }: { engine: AgentEngine | null; onClose: () => void }) {
  return <Modal isOpen={!!engine} onClose={onClose} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog agent-install-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
    aria-label={`${engine?.name || 'Agent'} ACP 安装说明`}>
    <ModalContent>{engine && <InstallBody key={engine.id} engine={engine} onClose={onClose} />}</ModalContent>
  </Modal>;
}

function InstallBody({ engine, onClose }: { engine: AgentEngine; onClose: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyPrompt() {
    const text = agentAcpInstallPrompt(engine.id);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      return;
    } catch {
      // Electron denies the async clipboard API to an unfocused document; fall
      // back to the selection-based copy so the button still works.
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      setCopyState(copied ? 'copied' : 'failed');
    } catch {
      setCopyState('failed');
    }
  }
  return <>
    <ModalHeader className="app-dialog-header"><h2>{engine.name} ACP 安装说明</h2></ModalHeader>
    <ModalBody className="app-dialog-body">
      <p>在运行 Loopra 后端的机器上安装 {engine.name} 的 ACP 依赖。可以把下面的提示词复制给一个 Agent，让它直接完成安装。</p>
      {engine.detail && <p className="agent-install-reason">当前检测：{engine.detail}</p>}
      <pre className="agent-install-prompt">{agentAcpInstallPrompt(engine.id)}</pre>
      {copyState === 'failed' && <p className="settings-error" role="alert">复制失败，请手动选择上面的提示词。</p>}
    </ModalBody>
    <ModalFooter className="app-dialog-footer">
      <Button size="sm" variant="light" onPress={onClose}>关闭</Button>
      <Button size="sm" color="primary" onPress={() => void copyPrompt()}>{copyState === 'copied' ? '已复制' : '复制提示词'}</Button>
    </ModalFooter>
  </>;
}
