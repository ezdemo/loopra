import { compareVersions } from './update-scripts';

export type ReleaseNotes = {
  currentVersion: string;
  latestVersion: string;
  releases: { version: string; name: string; body: string; publishedAt: string; url: string }[];
  complete: boolean;
};

type PublishedRelease = { tag_name?: string; name?: string; body?: string; published_at?: string; draft?: boolean; prerelease?: boolean };
type ReleaseHistory = Pick<ReleaseNotes, 'releases' | 'complete'>;
const stableVersion = (version: string) => /^v?\d+\.\d+\.\d+$/i.test(version);

export function selectReleaseNotes(history: ReleaseHistory, currentVersion: string, latestVersion: string): ReleaseNotes {
  const hasUpdates = compareVersions(latestVersion, currentVersion) > 0;
  return { currentVersion, latestVersion, complete: history.complete, releases: history.releases.filter(release => hasUpdates
    ? compareVersions(release.version, currentVersion) > 0 && compareVersions(release.version, latestVersion) <= 0
    : compareVersions(release.version, currentVersion) === 0) };
}

export function createWebReleaseNotesReader(request: typeof fetch = (...args) => fetch(...args), now = Date.now) {
  let cached: (ReleaseHistory & { at: number }) | undefined;
  let pending: Promise<void> | undefined;

  async function load() {
    const releases = new Map<string, ReleaseNotes['releases'][number]>();
    const signal = AbortSignal.timeout(20000);
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const response = await request(`https://api.github.com/repos/ezdemo/loopra-release/releases?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' }, signal, credentials: 'omit',
      });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429
        ? '发布服务请求过于频繁，请稍后重试。' : `获取更新日志失败（HTTP ${response.status}）`);
      const entries: PublishedRelease[] = await response.json();
      if (!Array.isArray(entries)) throw new Error('发布服务返回了无效的更新日志。');
      for (const entry of entries) {
        if (!entry || entry.draft || entry.prerelease || typeof entry.tag_name !== 'string' || !stableVersion(entry.tag_name)) continue;
        const version = entry.tag_name.replace(/^v/i, '');
        releases.set(version, { version, name: typeof entry.name === 'string' ? entry.name : '',
          body: typeof entry.body === 'string' ? entry.body.replace(/<!--[\s\S]*?-->/g, '')
            .replace(/^## Loopra v[^\r\n]+\r?\n/i, '').split(/^### 下载\s*$/m)[0].trim() : '',
          publishedAt: typeof entry.published_at === 'string' ? entry.published_at : '',
          url: `https://github.com/ezdemo/loopra-release/releases/tag/${encodeURIComponent(entry.tag_name)}` });
      }
      if (entries.length < 100) { complete = true; break; }
    }
    cached = { releases: [...releases.values()].sort((a, b) => compareVersions(b.version, a.version)), complete, at: now() };
  }

  return async (currentVersion: string, latestVersion: string) => {
    if (!stableVersion(currentVersion) || !stableVersion(latestVersion)) throw new Error('版本信息尚未就绪，请先重新检查版本。');
    const missingTarget = cached && (!cached.releases.length || compareVersions(latestVersion, cached.releases[0].version) > 0);
    if (!cached || missingTarget || now() - cached.at >= 5 * 60 * 1000) {
      if (!pending) pending = load().finally(() => { pending = undefined; });
      try { await pending; }
      catch (cause) {
        if (cause instanceof Error && cause.name === 'TimeoutError') throw new Error('获取更新日志超时，请检查网络后重试。');
        throw cause;
      }
    }
    return selectReleaseNotes(cached!, currentVersion, latestVersion);
  };
}

export const loadWebReleaseNotes = createWebReleaseNotesReader();
