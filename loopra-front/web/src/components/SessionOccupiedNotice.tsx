import { LockKeyhole, RefreshCw } from 'lucide-react';

type Props = {
  busy: boolean;
  disabled: boolean;
  error?: string;
  onRetry: () => void;
  onNew: () => void;
};

export default function SessionOccupiedNotice({ busy, disabled, error, onRetry, onNew }: Props) {
  return <section className="session-occupied" role="status" aria-live="polite" aria-busy={busy}>
    <LockKeyhole className="session-occupied-icon" size="1.125rem" aria-hidden="true" />
    <div className="session-occupied-copy">
      <strong>已在另一个应用中打开</strong>
      <p>请先在那边关闭会话，再重试以继续。</p>
      {error && <p className="session-occupied-error">检查失败：{error}</p>}
    </div>
    <div className="session-occupied-actions">
      <button type="button" disabled={busy || disabled} onClick={onRetry}>
        {busy && <RefreshCw size="0.875rem" className="session-occupied-checking" aria-hidden="true" />}
        {busy ? '检查中…' : '重试'}
      </button>
      <button type="button" disabled={busy || disabled} onClick={onNew}>新建聊天</button>
    </div>
  </section>;
}
