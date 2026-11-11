type FetchTransport = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

// Only this device's virtual origin is routed through E2E. Tauri IPC, packaged
// assets and external URLs keep their original fetch implementation.
export function relayFetch(transport: FetchTransport, origin: string, fallback: typeof fetch): typeof fetch {
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== origin) return fallback(input, init);
    const source = new Request(url, input instanceof Request ? input : undefined);
    const current = new Request(source, init);
    const options: RequestInit = { method: current.method, headers: current.headers, signal: current.signal };
    if (!['GET', 'HEAD'].includes(current.method)) options.body = await current.arrayBuffer();
    let path = url.pathname + url.search;
    for (let redirects = 0; ; redirects++) {
      const response = await transport.fetch(path, options);
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location || current.redirect === 'manual') return response;
      if (redirects >= 5 || current.redirect === 'error') { await response.body?.cancel(); throw new Error('桌面 API 重定向失败'); }
      const next = new URL(location, origin + path);
      await response.body?.cancel();
      if (next.origin !== origin || !next.pathname.startsWith('/api/')) throw new Error('桌面 API 返回了无效的重定向地址');
      if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) { options.method = 'GET'; delete options.body; }
      path = next.pathname + next.search;
    }
  };
  return request;
}

export function installRelayFetch(transport: FetchTransport, origin: string): () => void {
  const original = window.fetch;
  const routed = relayFetch(transport, origin, original.bind(window));
  window.fetch = routed;
  return () => { if (window.fetch === routed) window.fetch = original; };
}
