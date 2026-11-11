import { useEffect, useState } from 'react';
import { AlertCircle, Check, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { normalizeInstanceName } from '../relay/pairing';
import type { FormEvent } from 'react';

type Props = {
  name: string;
  host: string;
  online: boolean;
  reconnecting: boolean;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onReconnect: () => void;
  onConnectAnother: () => void;
  onForget: () => Promise<void>;
};

export default function MobileConnections({ name, host, online, reconnecting, busy, onRename, onReconnect, onConnectAnother, onForget }: Props) {
  const displayName = name || host;
  const [draft, setDraft] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setDraft(displayName); }, [displayName]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const next = normalizeInstanceName(draft);
    if (!next) { setError('请输入实例名称'); return; }
    setSaving(true); setError(''); setNotice('');
    try { await onRename(next); setDraft(next); setNotice('已保存'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  async function remove() {
    setRemoving(true); setError('');
    try { await onForget(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setRemoving(false); }
  }

  return <div className="app-scroll connection-page">
    <form className="app-panel connection-card" onSubmit={save}>
      <label className="connection-field"><span>实例名称</span><input value={draft} maxLength={40} autoComplete="off" spellCheck={false} disabled={saving} onChange={event => setDraft(event.target.value)} /></label>
      <button type="submit" className="connection-save" disabled={saving || normalizeInstanceName(draft) === name}>{saving ? <LoaderCircle size={16} className="app-spin" /> : notice ? <Check size={16} /> : null}<span>{saving ? '保存中' : notice || '保存'}</span></button>
    </form>
    <section className="app-panel connection-details" aria-label="连接信息">
      <div className="connection-row"><span>状态</span><strong>{reconnecting ? <LoaderCircle size={14} className="app-spin" /> : <i className={online ? 'online' : ''} />}{reconnecting ? online ? '正在检查连接' : '正在重新连接' : online ? '已连接' : '已断开'}</strong></div>
      <div className="connection-row"><span>中继</span><strong>{host}</strong></div>
      <div className="connection-row"><span>协议</span><strong>Loopra Relay v1</strong></div>
    </section>
    <div className="connection-actions">
      <button type="button" className="connection-primary" disabled={busy} onClick={onReconnect}>{busy ? <LoaderCircle size={17} className="app-spin" /> : <RefreshCw size={17} />}<span>{busy ? online ? '检查中' : '重连中' : online ? '检查连接' : reconnecting ? '立即重试' : '重新连接'}</span></button>
      <button type="button" className="connection-secondary" disabled={busy} onClick={onConnectAnother}><Plus size={17} /><span>连接新实例</span></button>
    </div>
    {error && <p className="connection-error" role="alert"><AlertCircle size={15} /><span>{error}</span></p>}
    <div className="connection-danger">
      {confirming ? <div className="connection-confirm"><span>移除这个连接？</span><div><button type="button" disabled={removing || busy} onClick={() => setConfirming(false)}>取消</button><button type="button" className="is-danger" disabled={removing || busy} onClick={() => void remove()}>{removing ? <LoaderCircle size={15} className="app-spin" /> : <Trash2 size={15} />}<span>移除</span></button></div></div>
        : <button type="button" className="connection-remove" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={16} /><span>移除连接</span></button>}
    </div>
  </div>;
}
