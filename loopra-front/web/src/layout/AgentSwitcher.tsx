import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Popup } from '../components/Motion';
import type { AgentEngine } from '../backend';
import { agentAcpInstallPrompt } from '../agent-install';
import { useMenuPlacement } from './menu-placement';

/**
 * Agent chooser shown beside the project switcher on the home screen. Switching
 * starts a new conversation, so it stays disabled while any run is active.
 */
export default function AgentSwitcher({ engines, agentId, disabled, onSelect, onRefreshEngines }: {
  engines: AgentEngine[]; agentId: string; disabled: boolean; onSelect: (id: string) => void;
  /** Re-detect the runtime when the menu opens (the backend checks on every call). */
  onRefreshEngines?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState<AgentEngine | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  // Same placement rules as the project menu: upward by default, capped to the
  // room its clipping pane leaves, and flipped below only when that is unusable.
  const placement = useMenuPlacement(open, root);
  const placementStyle = (placement.maxHeight ? { '--menu-max-height': `${placement.maxHeight}px` } : undefined) as CSSProperties | undefined;
  useEffect(() => {
    if (!open) return undefined;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
  }, [open]);
  const current = engines.find(engine => engine.id === (agentId || 'native'));
  function toggle() {
    if (open) { setOpen(false); return; }
    // Installation happens outside the app, so re-detect every time the menu opens.
    onRefreshEngines?.();
    setOpen(true);
  }
  function openInstall(engine: AgentEngine) {
    setOpen(false);
    setCopyState('idle');
    setInstalling(engine);
  }
  async function copyPrompt() {
    const text = agentAcpInstallPrompt(installing?.id || '');
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
  return <div className="agent-selector menu-anchor" data-popover ref={root} data-placement={placement.side} style={placementStyle}>
    <button type="button" aria-label="选择 Agent" aria-expanded={open} disabled={disabled}
      title={disabled ? '任务运行中，结束后才能切换 Agent' : '选择 Agent'} onClick={toggle}>
      <span className={`agent-dot ${agentId !== 'native' ? 'external' : ''}`} />
      {current?.name || (agentId === 'native' ? 'Loopra Native' : agentId)}
      <ChevronDown size="0.875rem" />
    </button>
    <Popup open={open} className="popup workspace-menu agent-menu">
      <h3>选择 Agent</h3>
      <div className="composer-tool-list">{engines.map(engine => {
        const selected = engine.id === (agentId || 'native');
        const installable = !engine.available && !!agentAcpInstallPrompt(engine.id);
        return <div key={engine.id} className="agent-option">
          <button type="button" disabled={!engine.available}
            onClick={() => { setOpen(false); onSelect(engine.id); }}>
            <span><strong>{engine.name}</strong></span>
            {selected && <Check size="1rem" />}
          </button>
          {installable && <button type="button" className="agent-install" aria-label={`安装 ${engine.name} ACP 依赖`}
            title="查看安装提示词" onClick={() => openInstall(engine)}>安装</button>}
        </div>;
      })}</div>
    </Popup>
    <Modal isOpen={!!installing} onClose={() => setInstalling(null)} placement="center" scrollBehavior="inside"
      classNames={{ base: 'app-dialog agent-install-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
      aria-label={`安装 ${installing?.name || 'Agent'} ACP`}>
      <ModalContent>
        <ModalHeader className="app-dialog-header"><h2>安装 {installing?.name} ACP</h2></ModalHeader>
        <ModalBody className="app-dialog-body">
          <p>在运行 Loopra 后端的机器上安装 {installing?.name} 的 ACP 依赖。可以把下面的提示词复制给一个 Agent，让它直接完成安装。</p>
          {installing?.detail && <p className="agent-install-reason">当前检测：{installing.detail}</p>}
          <pre className="agent-install-prompt">{agentAcpInstallPrompt(installing?.id || '')}</pre>
          {copyState === 'failed' && <p className="settings-error" role="alert">复制失败，请手动选择上面的提示词。</p>}
        </ModalBody>
        <ModalFooter className="app-dialog-footer">
          <Button size="sm" variant="light" onPress={() => setInstalling(null)}>关闭</Button>
          <Button size="sm" color="primary" onPress={() => void copyPrompt()}>{copyState === 'copied' ? '已复制' : '复制提示词'}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  </div>;
}
