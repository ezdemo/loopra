// Electron 主进程的出站代理解析。
//
// 独立成 CommonJS 模块，既供 main.cjs 使用，也能被 web 测试直接用 Node
// 加载，不需要启动 Electron。规则必须与 Java 的 ProxySettings 保持一致。

function normalizeProxyAddress(rawAddress) {
  if (rawAddress == null || String(rawAddress).trim() === '') return ''

  let address = String(rawAddress).trim()
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(address)) address = `http://${address}`

  let parsed
  try {
    parsed = new URL(address)
  } catch {
    throw new Error('代理地址格式无效')
  }

  const protocol = parsed.protocol.toLowerCase()
  const isSocks = ['socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(protocol)
  if (protocol !== 'http:' && !isSocks) throw new Error('代理协议仅支持 http 或 socks5')
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('代理地址不应包含用户名、密码、路径或查询参数')
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('代理地址缺少主机名')
  const port = parsed.port ? Number(parsed.port) : (isSocks ? 1080 : 80)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口必须在 1-65535 之间')
  }

  const scheme = isSocks ? 'socks5' : 'http'
  const formattedHost = host.includes(':') ? `[${host}]` : host
  return `${scheme}://${formattedHost}:${port}`
}

function electronProxyRules(address) {
  const parsed = new URL(address)
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const formattedHost = host.includes(':') ? `[${host}]` : host
  const port = parsed.port || (parsed.protocol === 'socks5:' ? '1080' : '80')
  const authority = `${formattedHost}:${port}`
  return parsed.protocol === 'socks5:' ? `socks5=${authority}` : `http=${authority};https=${authority}`
}

module.exports = { normalizeProxyAddress, electronProxyRules }
