import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { reduceFlow, type ConnectorFlowView, type FlowPhase } from '../connectors';

const FLOW_POLL_MS = 1500;

type ElectronBridge = { openExternal?: (url: string) => unknown };
function electronBridge(): ElectronBridge | undefined {
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
}

// 内置连接器与自定义 MCP 服务共用的浏览器授权流程：
// 预开空白窗 → 轮询 flow 状态 → 完成后回调。弹窗必须在用户手势里
// 同步打开；被拦截时等待态的「打开授权页面」链接兜底。
export function useOAuthFlow(api: LoopraClient, onConnected: () => void) {
  const [phase, setPhase] = useState<FlowPhase>('form');
  const [authURL, setAuthURL] = useState('');
  const [blocked, setBlocked] = useState(false);
  const flow = useRef<{ id: string } | null>(null);
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    if (phase !== 'waiting' || !flow.current) return;
    const active = flow.current;
    const timer = setInterval(() => {
      void api.request<ConnectorFlowView>(`/connectors/flows/${encodeURIComponent(active.id)}`, 'GET')
        .then(view => setPhase(current => reduceFlow(current, view)))
        .catch(() => {});
    }, FLOW_POLL_MS);
    return () => clearInterval(timer);
  }, [phase, api]);
  useEffect(() => () => { popup.current?.close(); }, []);
  useEffect(() => {
    if (phase === 'connected') {
      popup.current?.close();
      onConnected();
    } else if (phase === 'failed' || phase === 'cancelled') {
      popup.current?.close();
      flow.current = null;
    }
  }, [phase, onConnected]);

  function openAuthPage(url: string) {
    const bridge = electronBridge();
    if (bridge?.openExternal) { void bridge.openExternal(url); return; }
    if (popup.current && !popup.current.closed) {
      popup.current.opener = null;
      popup.current.location.href = url;
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  // 在用户手势里同步预开空白窗；返回授权地址后 start() 写入地址。
  function preopen() {
    if (electronBridge()?.openExternal) return;
    popup.current = window.open('', '_blank');
    if (!popup.current) setBlocked(true);
  }

  function start(flowId: string, authorizationUrl: string) {
    flow.current = { id: flowId };
    setAuthURL(authorizationUrl);
    setPhase('waiting');
    openAuthPage(authorizationUrl);
  }

  function fail() {
    popup.current?.close();
    popup.current = null;
  }

  async function cancel() {
    const active = flow.current;
    popup.current?.close();
    popup.current = null;
    if (active) {
      flow.current = null;
      try { await api.request(`/connectors/flows/${encodeURIComponent(active.id)}/cancel`, 'POST'); } catch { /* 流程可能已结束 */ }
    }
    setPhase('form');
  }

  return { phase, setPhase, authURL, blocked, preopen, start, fail, cancel };
}

export function OAuthWaiting({ name, authURL, blocked }: { name: string; authURL: string; blocked: boolean }) {
  return <div className="connector-waiting" role="status">
    <Spinner size="md" />
    <p>请在浏览器中完成 {name} 授权。</p>
    {(blocked || authURL) && <a href={authURL} target="_blank" rel="noreferrer">打开授权页面</a>}
  </div>;
}
