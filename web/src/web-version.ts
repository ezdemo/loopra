export function loopraWebUrl(server: string, accessKey = ''): string {
  const url = new URL(server);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  if (accessKey) url.searchParams.set('rk', accessKey);
  return url.href;
}

export function openLoopraWeb(server: string, accessKey = ''): void {
  const target = loopraWebUrl(server, accessKey);
  const bridge = (window as unknown as { electronAPI?: { openExternal?: (url: string) => unknown } }).electronAPI;
  if (bridge?.openExternal) void bridge.openExternal(target);
  else window.open(target, '_blank', 'noopener,noreferrer');
}
