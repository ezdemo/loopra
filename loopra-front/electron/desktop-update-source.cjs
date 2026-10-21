const fs = require('fs')
const path = require('path')

// Keep this allowlist aligned with the core updater's MIRROR_SOURCES.
const MIRROR_SOURCES = [
  'https://gh-proxy.org/',
  'https://github.boki.moe/',
  'https://wget.la/',
  'https://gh.monlor.com/',
  'https://fastgit.cc/',
  'https://ghproxy.net/',
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://down.npee.cn/',
  'https://ghproxy.vip/',
]
const RELEASE_DOWNLOADS = 'https://github.com/ezdemo/loopra-release/releases/latest/download/'

function normalizeUpdateSource(source) {
  if (source === 'normal') return source
  if (source === 'mirror') return MIRROR_SOURCES[0]
  if (typeof source === 'string') {
    const normalized = source.replace(/\/+$/, '') + '/'
    if (MIRROR_SOURCES.includes(normalized)) return normalized
  }
  throw new Error('请选择列表中的 GitHub 直连或镜像源')
}

function desktopUpdateFeed(source, packageType) {
  const normalized = normalizeUpdateSource(source)
  // Squirrel clients must never consume an ad-hoc ZIP. The custom installer
  // uses its own manifest, including when downloading directly from GitHub.
  if (packageType === 'mac-unsigned') return {
    provider: 'generic', channel: 'latest-unsigned',
    url: (normalized === 'normal' ? '' : normalized) + RELEASE_DOWNLOADS,
    useMultipleRangeRequest: false,
  }
  return normalized === 'normal'
    ? { provider: 'github', owner: 'ezdemo', repo: 'loopra-release' }
    : { provider: 'generic', url: normalized + RELEASE_DOWNLOADS, useMultipleRangeRequest: false }
}

function readDesktopUpdateSource(file) {
  try { return normalizeUpdateSource(JSON.parse(fs.readFileSync(file, 'utf8')).source) }
  catch { return 'normal' }
}

function saveDesktopUpdateSource(file, source) {
  const normalized = normalizeUpdateSource(source)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ source: normalized }) + '\n', 'utf8')
}

module.exports = { MIRROR_SOURCES, normalizeUpdateSource, desktopUpdateFeed, readDesktopUpdateSource, saveDesktopUpdateSource }
