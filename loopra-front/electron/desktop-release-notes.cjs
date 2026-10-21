const { compareVersions } = require('./version.cjs')

const RELEASES_API = 'https://api.github.com/repos/ezdemo/loopra-release/releases'
const RELEASES_URL = 'https://github.com/ezdemo/loopra-release/releases/tag/'
const stableVersion = (tag) => typeof tag === 'string' && /^v?\d+\.\d+\.\d+$/i.test(tag)

function releaseNotesBody(body) {
  if (typeof body !== 'string') return ''
  // Published notes append package links and build metadata after the changes.
  return body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^## Loopra v[^\r\n]+\r?\n/i, '')
    .split(/^### 下载\s*$/m)[0].trim()
}

function createDesktopReleaseNotes({ request, currentVersion, getLatestVersion = () => '', now = Date.now }) {
  let cached
  let pending

  async function load() {
    const releases = new Map()
    let complete = false
    const signal = AbortSignal.timeout(20000)
    for (let page = 1; page <= 10; page++) {
      const response = await request(`${RELEASES_API}?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Loopra/Desktop' }, signal,
      })
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429
        ? '发布服务请求过于频繁，请稍后重试。' : `获取更新日志失败（HTTP ${response.status}）`)
      const entries = await response.json()
      if (!Array.isArray(entries)) throw new Error('发布服务返回了无效的更新日志。')
      for (const entry of entries) {
        if (!entry || entry.draft || entry.prerelease || !stableVersion(entry.tag_name)) continue
        const version = entry.tag_name.replace(/^v/i, '')
        releases.set(version, { version, name: typeof entry.name === 'string' ? entry.name : '',
          body: releaseNotesBody(entry.body), publishedAt: typeof entry.published_at === 'string' ? entry.published_at : '',
          url: RELEASES_URL + encodeURIComponent(entry.tag_name) })
      }
      if (entries.length < 100) { complete = true; break }
    }
    return { releases: [...releases.values()].sort((a, b) => compareVersions(b.version, a.version)), complete }
  }

  async function getReleaseNotes() {
    const target = getLatestVersion()
    const missingTarget = cached && target && (!cached.releases.length || compareVersions(target, cached.releases[0].version) > 0)
    if (!cached || missingTarget || now() - cached.at >= 5 * 60 * 1000) {
      if (!pending) pending = load().then(value => { cached = { ...value, at: now() } })
        .finally(() => { pending = null })
      await pending
    }
    // The updater's target takes precedence, so notes never advertise an
    // unrelated version that this platform is not about to install.
    const latestVersion = getLatestVersion() || cached.releases[0]?.version || ''
    const hasUpdates = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0
    const releases = cached.releases.filter(release => hasUpdates
      ? compareVersions(release.version, currentVersion) > 0 && compareVersions(release.version, latestVersion) <= 0
      : compareVersions(release.version, currentVersion) === 0)
    return { currentVersion, latestVersion, releases, complete: cached.complete }
  }

  return { getReleaseNotes }
}

module.exports = { createDesktopReleaseNotes }
