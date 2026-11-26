import { Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';

export default function SessionHistoryState({ loading, error, hasMessages, onRetry }: { loading: boolean; error?: string; hasMessages: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  if (error) return <div className={`session-history-state${hasMessages ? '' : ' session-history-empty'}`} role="alert"><span>{t('chat.historyFailed', { error })}</span><Button size="sm" variant="light" onPress={onRetry}>{t('chat.reload')}</Button></div>;
  if (!loading || hasMessages) return null;
  return <div className="session-history-state session-history-empty" role="status"><span className="session-history-loader" aria-hidden="true"><i /><i /><i /></span><span>{t('chat.loadingHistory')}</span></div>;
}
