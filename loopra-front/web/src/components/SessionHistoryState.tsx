import { Button } from '@nextui-org/react';

export default function SessionHistoryState({ loading, error, hasMessages, onRetry }: { loading: boolean; error?: string; hasMessages: boolean; onRetry: () => void }) {
  if (error) return <div className={`session-history-state${hasMessages ? '' : ' session-history-empty'}`} role="alert"><span>历史消息加载失败：{error}</span><Button size="sm" variant="light" onPress={onRetry}>重新加载</Button></div>;
  if (!loading || hasMessages) return null;
  return <div className="session-history-state session-history-empty" role="status"><span className="session-history-loader" aria-hidden="true"><i /><i /><i /></span><span>正在加载历史消息…</span></div>;
}
