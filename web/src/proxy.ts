// 出站代理地址的校验与规范化。
//
// 与后端 `ProxySettings`、Electron 主进程 `electron/proxy.cjs` 保持同一套规则：
// 只接受 http / socks5（含 socks/socks4/socks5h 别名），允许省略协议（按 http），
// 归一化为 `scheme://host:port`，空字符串表示关闭代理。

const HTTP_SCHEMES = new Set(['http']);
const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks5', 'socks5h']);

/** 校验并规范化代理地址；空值返回空字符串。非法时抛出带中文说明的错误。 */
export function normalizeProxyAddress(rawAddress: string | null | undefined): string {
  const value = (rawAddress || '').trim();
  if (!value) return '';

  const address = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error('代理地址格式无效');
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const isSocks = SOCKS_SCHEMES.has(scheme);
  if (!HTTP_SCHEMES.has(scheme) && !isSocks) {
    throw new Error('代理协议仅支持 http 或 socks5');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('代理地址不应包含用户名、密码、路径或查询参数');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('代理地址缺少主机名');

  const port = parsed.port ? Number(parsed.port) : (isSocks ? 1080 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口必须在 1-65535 之间');
  }

  const formattedHost = host.includes(':') ? `[${host}]` : host;
  return `${isSocks ? 'socks5' : 'http'}://${formattedHost}:${port}`;
}

/** 返回校验错误；地址合法时返回空字符串。 */
export function proxyAddressError(rawAddress: string | null | undefined): string {
  try {
    normalizeProxyAddress(rawAddress);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
