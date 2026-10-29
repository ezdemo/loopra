import { LockKeyhole, RefreshCw } from 'lucide-react';

type Props = {
  busy: boolean;
  forking: boolean;
  disabled: boolean;
  onRetry: () => void;
  onFork: () => void;
};

export default function SessionOccupiedNotice({ busy, forking, disabled, onRetry, onFork }: Props) {
  return <section className="session-occupied" role="status" aria-live="polite" aria-busy={busy || forking}>
    <LockKeyhole className="session-occupied-icon" size="1.125rem" aria-hidden="true" />
    <div className="session-occupied-copy">
      <strong>已在另一个应用中打开</strong>
      <p>关闭那边的会话后重试，或保留历史创建分叉继续。</p>
    </div>
    <div className="session-occupied-actions">
      <button type="button" disabled={busy || forking || disabled} onClick={onRetry}>
        {busy && <RefreshCw size="0.875rem" className="session-occupied-checking" aria-hidden="true" />}
        {busy ? '检查中…' : '重试'}
      </button>
      <button type="button" disabled={busy || forking || disabled} onClick={onFork}>{forking ? '创建中…' : '创建分叉'}</button>
    </div>
  </section>;
}
