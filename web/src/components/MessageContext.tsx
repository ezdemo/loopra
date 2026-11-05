import { useMemo, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from '@nextui-org/react';
import { Clipboard, Layers, Sparkles } from 'lucide-react';
import type { MessageDocument } from '../chat';
import { messageContextItems } from '../message-context';
import type { MessageContextItem } from '../message-context';
import FileGlyph from './FileGlyph';
import { useImagePreview } from './ImagePreview';

function ContextIcon({ item }: { item: MessageContextItem }) {
  if (item.kind === 'skill') return <Sparkles size="1rem" aria-hidden="true" />;
  if (item.kind === 'paste') return <Clipboard size="1rem" aria-hidden="true" />;
  if (item.kind === 'context') return <Layers size="1rem" aria-hidden="true" />;
  return <FileGlyph name={item.name} size="1rem" mono />;
}

const labels = { document: '附件', skill: '技能', file: '引用文件', paste: '粘贴内容', context: '上下文' };

export default function MessageContext({ context, documents, images = [] }: { context: string; documents: MessageDocument[]; images?: string[] }) {
  const items = useMemo(() => messageContextItems(context, documents), [context, documents]);
  const [selected, setSelected] = useState<MessageContextItem | null>(null);
  const previewImage = useImagePreview();
  if (!items.length && !images.length) return null;
  return <>
    <div className="message-context-items">{images.map((src, index) => <Button key={`image-${index}`} size="sm" variant="light" className="message-context-chip message-context-image" aria-label={`预览图片 ${index + 1}`} aria-haspopup="dialog" onPress={() => previewImage?.(src)}>
      <img className="message-context-thumbnail" src={src} alt="" /><span className="message-context-name">图片 {index + 1}</span>
    </Button>)}{items.map((item, index) => <Button key={index} size="sm" variant="light" className={`message-context-chip message-context-${item.kind}`} aria-label={`查看${labels[item.kind]}：${item.name}`} aria-haspopup="dialog" title={item.name} onPress={() => setSelected(item)}>
      <span className="message-context-icon"><ContextIcon item={item} /></span><span className="message-context-name">{item.name}</span>
    </Button>)}</div>
    <Modal isOpen={!!selected} onClose={() => setSelected(null)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog message-context-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={selected ? `${labels[selected.kind]}：${selected.name}` : '上下文'}>
      <ModalContent>{selected && <>
        <ModalHeader className="app-dialog-header message-context-header"><span className={`message-context-icon message-context-${selected.kind}`}><ContextIcon item={selected} /></span><h2>{selected.name}</h2></ModalHeader>
        <ModalBody className="app-dialog-body message-context-body"><pre>{selected.content}</pre></ModalBody>
      </>}</ModalContent>
    </Modal>
  </>;
}
