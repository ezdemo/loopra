import { LockKeyhole, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Props = {
  busy: boolean;
  forking: boolean;
  disabled: boolean;
  onRetry: () => void;
  onFork: () => void;
};

export default function SessionOccupiedNotice({ busy, forking, disabled, onRetry, onFork }: Props) {
  const { t } = useTranslation();
  return <section className="session-occupied" role="status" aria-live="polite" aria-busy={busy || forking}>
    <LockKeyhole className="session-occupied-icon" size="1.125rem" aria-hidden="true" />
    <div className="session-occupied-copy">
      <strong>{t('chat.occupiedTitle')}</strong>
      <p>{t('chat.occupiedBody')}</p>
    </div>
    <div className="session-occupied-actions">
      <button type="button" disabled={busy || forking || disabled} onClick={onRetry}>
        {busy && <RefreshCw size="0.875rem" className="session-occupied-checking" aria-hidden="true" />}
        {busy ? t('chat.checking') : t('common.retry')}
      </button>
      <button type="button" disabled={busy || forking || disabled} onClick={onFork}>{forking ? t('chat.creating') : t('chat.forkSession')}</button>
    </div>
  </section>;
}
