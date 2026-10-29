import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner } from '@nextui-org/react';
import { AlertCircle, Boxes, Check, ChevronRight, Download, RefreshCw, Search, X } from 'lucide-react';
import { LoopraClient } from '../backend';
import type { Provider } from '../lib';

type Props = { server: string; provider: Provider | null; existing: string[]; onAdd: (names: string[]) => void; onClose: () => void };

export default function RemoteModelsPicker({ server, provider, existing, onAdd, onClose }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [addedOpen, setAddedOpen] = useState(false);
  const lastProvider = useRef(provider);
  if (provider) lastProvider.current = provider;
  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setModels([]); setSelected([]); setQuery(''); setAddedOpen(false);
    void new LoopraClient(server).remoteModels(provider, controller.signal)
      .then(result => { if (!controller.signal.aborted) setModels(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '获取模型失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [server, provider, attempt]);
  const existingSet = new Set(existing.map(name => name.trim()));
  const filtered = models.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()));
  const available = filtered.filter(name => !existingSet.has(name));
  const added = filtered.filter(name => existingSet.has(name));
  const additions = selected.filter(name => !existingSet.has(name));
  const allSelected = available.length > 0 && available.every(name => selected.includes(name));
  function toggle(name: string) {
    setSelected(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  }
  return <Modal isOpen={!!provider} onClose={onClose} hideCloseButton placement="center" backdrop="opaque" aria-label="获取远程模型" classNames={{ wrapper: 'remote-model-modal-wrapper', base: 'remote-model-modal', backdrop: 'remote-model-backdrop' }}>
    <ModalContent>
      <ModalHeader className="remote-model-header"><span className="remote-model-icon"><Boxes size="1.375rem" /></span><div><h2>获取模型</h2><p>{lastProvider.current?.name || '当前供应商'}<span>·</span>{loading ? '正在连接' : `${models.length} 个可用模型`}</p></div><Button isIconOnly size="sm" variant="light" aria-label="关闭远程模型列表" onPress={onClose}><X size="1.125rem" /></Button></ModalHeader>
      <ModalBody className="remote-model-body">
        <Input autoFocus isClearable size="md" variant="bordered" aria-label="搜索远程模型" placeholder="搜索模型名称…" value={query} onValueChange={setQuery} onClear={() => setQuery('')} isDisabled={loading || !!error} startContent={<Search size="1.0625rem" />} className="remote-model-search" />
        {!loading && !error && <div className="remote-model-toolbar"><span>{query ? `${available.length} 个可添加` : available.length ? '选择要添加的模型' : '没有可添加的新模型'}</span><div><Button size="sm" variant="light" isDisabled={!available.length} onPress={() => setSelected(current => allSelected ? current.filter(name => !available.includes(name)) : [...new Set([...current, ...available])])}>{allSelected ? '取消当前全选' : '全选当前结果'}</Button><Button isIconOnly size="sm" variant="light" aria-label="重新获取模型" onPress={() => setAttempt(value => value + 1)}><RefreshCw size="0.9375rem" /></Button></div></div>}
        {loading ? <div className="remote-model-message" role="status"><Spinner size="lg" /><strong>正在获取模型</strong><p>连接供应商，读取可用模型列表…</p></div> : error ? <div className="remote-model-message remote-model-failure" role="alert"><AlertCircle size="2rem" /><strong>暂时无法获取模型</strong><p>{error}</p><Button size="sm" variant="flat" onPress={() => setAttempt(value => value + 1)} startContent={<RefreshCw size="0.875rem" />}>重新获取</Button></div> : <div className="remote-model-list">{available.map(name => {
          const checked = selected.includes(name);
          return <button type="button" key={name} className={`remote-model-option${checked ? ' is-selected' : ''}`} aria-pressed={checked} onClick={() => toggle(name)}><span className={`remote-model-check${checked ? ' is-on' : ''}`} aria-hidden="true">{checked && <Check size="0.75rem" />}</span><span className="remote-model-label"><span>{name}</span></span></button>;
        })}{!!added.length && <div className="remote-model-added"><button type="button" className="remote-model-added-toggle" aria-expanded={addedOpen} onClick={() => setAddedOpen(open => !open)}><ChevronRight size="0.875rem" /><span>已添加 {added.length} 个</span></button>{addedOpen && <ul>{added.map(name => <li key={name}>{name}</li>)}</ul>}</div>}{!filtered.length && <div className="remote-model-message"><Search size="2rem" /><strong>{models.length ? '没有匹配的模型' : '未发现可用模型'}</strong><p>{models.length ? '试试其他名称，或清空搜索条件。' : '检查 API 地址后重试，也可以手动添加模型。'}</p>{!!query && <Button size="sm" variant="light" onPress={() => setQuery('')}>清空搜索</Button>}</div>}</div>}
      </ModalBody>
      <ModalFooter className="remote-model-footer"><div><span>已选 <strong>{additions.length}</strong> 个新模型</span><small>已有模型配置将保留</small></div><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" isDisabled={loading || !!error || !additions.length} startContent={<Download size="1rem" />} onPress={() => { if (additions.length) onAdd(additions); }}>添加所选模型{additions.length ? `（${additions.length}）` : ''}</Button></ModalFooter>
    </ModalContent>
  </Modal>;
}
