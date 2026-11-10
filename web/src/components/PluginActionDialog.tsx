import { useRef, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Progress, Spinner, Tab, Tabs } from '@nextui-org/react';
import { ArrowRight, Check, CircleAlert, Folder, Github, Package, Plus, RefreshCw } from 'lucide-react';
import { usePresence } from './Motion';

export type PluginOperation = {
  kind: 'install' | 'update';
  phase: 'running' | 'success' | 'error';
  pack?: { id: string; displayName?: string; version?: string; source?: string; sourceUrl?: string };
  source?: string;
  error?: string;
  result?: { id?: string; displayName?: string; version?: string };
};

const sourceTypes = [
  { id: 'github', name: 'GitHub', icon: Github, placeholder: 'https://github.com/owner/plugin' },
  { id: 'npm', name: 'npm', icon: Package, placeholder: '@scope/plugin-name' },
  { id: 'local', name: '本地', icon: Folder, placeholder: '插件文件夹的完整路径' },
] as const;

export default function PluginActionDialog({ open, operation: currentOperation, source, onSourceChange, onClose, onInstall, onRetry, onEdit, updatedVersion }: {
  open: boolean; operation?: PluginOperation; source: string; onSourceChange: (source: string) => void;
  onClose: () => void; onInstall: () => void; onRetry: () => void; onEdit: () => void; updatedVersion?: string;
}) {
  // Bound the portal's exit lifetime: nested NextUI layout animations can keep
  // AnimatePresence mounted after the dialog has already faded out.
  const mounted = usePresence(open);
  // Keep the finished surface intact until the modal's exit animation completes.
  const lastOperation = useRef(currentOperation);
  if (open) lastOperation.current = currentOperation;
  const operation = open ? currentOperation : lastOperation.current;
  const [sourceType, setSourceType] = useState('github');
  const selected = sourceTypes.find(type => type.id === sourceType)!;
  const running = operation?.phase === 'running';
  const success = operation?.phase === 'success';
  const failed = operation?.phase === 'error';
  const updating = operation?.kind === 'update';
  const action = updating ? '更新' : '安装';
  const title = operation ? running ? `正在${action}插件` : success ? `插件已${action}` : `${action}未完成` : '添加插件';
  const name = operation?.pack?.displayName || operation?.result?.displayName || operation?.pack?.id || operation?.result?.id;
  const address = operation?.pack?.source || operation?.pack?.sourceUrl || operation?.source;
  const targetVersion = operation?.result?.version || updatedVersion;
  if (!mounted) return null;
  return <Modal isOpen={open} onClose={onClose} isDismissable={!running} isKeyboardDismissDisabled={running} hideCloseButton={running} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog plugin-action-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop plugin-action-backdrop', closeButton: 'app-dialog-close' }}
    motionProps={{ onUpdate: () => undefined, variants: { initial: { opacity: 0, y: 12, scale: .98 }, enter: { opacity: 1, y: 0, scale: 1, transition: { duration: .24, ease: [.22, 1, .36, 1] } }, exit: { opacity: 0, y: 6, scale: .99, transition: { duration: .16 } } } }} aria-label={title}>
    <ModalContent onKeyDownCapture={event => { if (event.key === 'Escape' && !running) { event.stopPropagation(); onClose(); } }}><form className="app-dialog-form" onSubmit={event => { event.preventDefault(); if (!operation && source.trim()) onInstall(); }}>
      <ModalHeader className="app-dialog-header plugin-action-header"><span className="plugin-action-mark" data-phase={operation?.phase || 'idle'}>{success ? <Check size={21} /> : failed ? <CircleAlert size={21} /> : updating ? <RefreshCw size={21} /> : <Plus size={21} />}</span><h2>{title}</h2></ModalHeader>
      <ModalBody className="app-dialog-body plugin-action-body">
        {!operation ? <>
          <Tabs aria-label="插件来源" selectedKey={sourceType} onSelectionChange={key => { setSourceType(String(key)); onSourceChange(''); }} disableCursorAnimation={!open} fullWidth size="md" classNames={{ base: 'plugin-source-tabs', tabList: 'plugin-source-tab-list', tab: 'plugin-source-tab', tabContent: 'plugin-source-tab-content' }}>{sourceTypes.map(type => <Tab key={type.id} title={<><type.icon size={16} />{type.name}</>} />)}</Tabs>
          <Input autoFocus label={sourceType === 'local' ? '文件夹路径' : sourceType === 'npm' ? '包名' : '仓库地址'} labelPlacement="outside" aria-label="插件地址" value={source} onValueChange={onSourceChange} placeholder={selected.placeholder} autoComplete="off" spellCheck="false" isRequired validationBehavior="native" variant="bordered" classNames={{ base: 'plugin-source-field', inputWrapper: 'plugin-source-input-wrapper' }} />
          <p className="plugin-action-note">{sourceType === 'github' ? '支持仓库地址，也可通过 ?path= 指定插件子目录。' : sourceType === 'npm' ? '可在包名后添加 @版本号，安装指定版本。' : '从本机已有的插件目录安装。'}</p>
        </> : <div className="plugin-operation" key={operation.phase}>
          <div className="plugin-operation-identity"><span className="plugin-operation-icon"><Package size={20} /></span><div><strong>{name || '新插件'}</strong>{address && <span title={address}>{address}</span>}</div></div>
          {updating && operation.pack?.version && <div className="plugin-version-change"><span>v{operation.pack.version}</span><ArrowRight size={14} /><span>{success ? targetVersion ? `v${targetVersion}` : '已更新' : '最新版本'}</span></div>}
          {running && <div className="plugin-operation-progress" role="status"><div><Spinner size="sm" /><span>正在{action}，请稍候…</span></div><Progress isIndeterminate size="sm" aria-label={`正在${action}插件`} className="plugin-progress" /></div>}
          {success && <p className="plugin-operation-result" role="status"><Check size={16} />{updating ? '更新完成，已保留原有启用状态。' : '安装完成，插件已加入我的内容。'}</p>}
          {failed && <div className="plugin-operation-error" role="alert"><CircleAlert size={16} /><p>{operation.error}</p></div>}
        </div>}
      </ModalBody>
      {!running && <ModalFooter className="app-dialog-footer plugin-action-footer">
        {!operation ? <><Button size="sm" variant="bordered" type="button" className="capability-secondary" onPress={onClose}>取消</Button><Button size="sm" color="primary" type="submit" className="capability-primary" isDisabled={!source.trim()}><Plus size={15} />安装插件</Button></> : <><Button size="sm" color={success ? 'primary' : 'default'} variant={success ? 'solid' : 'bordered'} type="button" className={success ? 'capability-primary' : 'capability-secondary'} onPress={failed && !updating ? onEdit : onClose}>{success ? '完成' : updating ? '关闭' : '修改地址'}</Button>{failed && <Button size="sm" color="primary" type="button" className="capability-primary" onPress={onRetry}><RefreshCw size={15} />重试</Button>}</>}
      </ModalFooter>}
    </form></ModalContent>
  </Modal>;
}
