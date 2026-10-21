import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Check, ChevronDown, CircleAlert, ExternalLink, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { ReleaseNotes } from '../release-notes';
import { RELEASES_URL } from '../update-scripts';

export function useReleaseNotes(open: boolean, loadNotes: () => Promise<ReleaseNotes>, refreshKey = '') {
  const [notes, setNotes] = useState<ReleaseNotes>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    setNotes(undefined);
    void loadNotes().then(result => { if (active) setNotes(result); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, loadNotes, refreshKey, attempt]);
  return { notes, loading, error, retry: () => setAttempt(value => value + 1) };
}

function releaseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}


export function ReleaseNotesPanel({ state, currentVersion, latestVersion }: {
  state: ReturnType<typeof useReleaseNotes>; currentVersion?: string; latestVersion?: string;
}) {
  const { notes, loading, error, retry } = state;
  const hasUpdates = !!notes?.releases.some(release => release.version !== currentVersion?.replace(/^v/i, ''));
  return (
    <section className="desktop-release-notes" aria-label="版本更新日志" aria-busy={loading}>
      <header className="desktop-release-heading">
        <div><h3><FileText size="1rem" aria-hidden="true" />更新日志{notes && notes.releases.length > 0 && <span>{notes.releases.length} 个版本</span>}</h3>
          <p>{hasUpdates ? `从 v${currentVersion} 到 v${latestVersion} 的版本变化` : '了解当前版本的新增、改进与修复'}</p></div>
        <Button isIconOnly size="sm" variant="light" aria-label="刷新更新日志" isDisabled={loading} onPress={retry}><RefreshCw size=".875rem" /></Button>
      </header>
      <div className="desktop-release-scroll" tabIndex={0} aria-label="更新日志内容">
        {loading ? <div className="desktop-release-empty" role="status"><LoaderCircle className="is-spinning" size="1.5rem" /><strong>正在加载更新日志</strong><p>正在获取官方版本发布记录…</p></div>
          : error ? <div className="desktop-release-empty"><CircleAlert size="1.5rem" /><strong>更新日志暂时无法加载</strong><p>{error}</p><Button size="sm" variant="flat" onPress={retry}>重新加载</Button><a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">前往发布页查看</a></div>
          : notes?.releases.length ? <>
            {!notes.complete && <p className="desktop-update-notice">版本跨度较大，当前展示最近的发布记录，完整历史可前往发布页查看。</p>}
            <div className="desktop-release-timeline">{notes.releases.map((release, index) => <details className="desktop-release-entry" key={release.version} open={index === 0}>
              <summary><span className="desktop-release-marker" /><span className="desktop-release-version">v{release.version}</span>
                {release.version === latestVersion?.replace(/^v/i, '') && <span className="desktop-release-badge">最新</span>}
                {release.version === currentVersion?.replace(/^v/i, '') && <span className="desktop-release-installed"><Check size=".75rem" />当前版本</span>}
                <time dateTime={release.publishedAt}>{releaseDate(release.publishedAt)}</time><ChevronDown className="desktop-release-chevron" size=".875rem" /></summary>
              <div className="desktop-release-content">
                {release.body ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}
                  components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: () => null }}>{release.body}</ReactMarkdown>
                  : <p className="desktop-release-no-notes">此版本尚未提供更新说明。</p>}
                <a className="desktop-release-original" href={release.url} target="_blank" rel="noopener noreferrer">查看此版本发布记录<ExternalLink size=".75rem" /></a>
              </div>
            </details>)}</div>
          </> : <div className="desktop-release-empty"><FileText size="1.5rem" /><strong>暂无可展示的更新日志</strong><p>该版本尚未提供发布记录，可前往发布页查看。</p><a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">前往发布页查看</a></div>}
      </div>
    </section>
  );
}
