import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ModalContent } from '@nextui-org/react';
import { HelpCircle, Search as SearchIcon, X } from 'lucide-react';
import { IconButton } from './ui';
import {
  helpChangelog, helpCommands, helpConfigOptions, helpConfigSample, helpEndpoints, helpIssues,
  helpSections, helpShortcuts, helpSteps, helpTools, searchHelp,
} from '../help';

// Ported from legacy `src/views/Help.vue`: the same sections, search box and
// sidebar table of contents, presented as a modal instead of a routed page.
export default function Help({ open, onClose, server }: { open: boolean; onClose: () => void; server: string }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(helpSections[0].id);
  const main = useRef<HTMLDivElement>(null);
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const hits = useMemo(() => searchHelp(query), [query]);

  useEffect(() => { if (open) { setQuery(''); setActive(helpSections[0].id); } }, [open]);

  function goTo(id: string) {
    setActive(id);
    sections.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function onScroll() {
    const container = main.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    let current = helpSections[0].id;
    for (const section of helpSections) {
      const element = sections.current[section.id];
      if (element && element.getBoundingClientRect().top - top <= 24) current = section.id;
    }
    setActive(current);
  }

  const sectionProps = (id: string) => ({ ref: (element: HTMLElement | null) => { sections.current[id] = element; } });

  return <Modal isOpen={open} onClose={onClose} hideCloseButton backdrop="opaque" placement="center" classNames={{ wrapper: 'settings-wrapper', base: 'settings-modal help-modal', backdrop: 'modal-backdrop' }} aria-label="帮助中心">
    <ModalContent>
      <div className="help-layout">
        <header className="help-header">
          <div className="help-heading"><HelpCircle size="1.25rem" /><h1>帮助中心</h1></div>
          <label className="help-search">
            <SearchIcon size="0.9375rem" />
            <input aria-label="搜索帮助文档" placeholder="搜索帮助文档…" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <IconButton label="关闭帮助" onClick={onClose} className="settings-close"><X size="1.25rem" /></IconButton>
        </header>

        <div className="help-body">
          <nav className="help-nav" aria-label="帮助目录">
            <h2>目录</h2>
            <ul>{helpSections.map(section => <li key={section.id}>
              <button type="button" className={active === section.id && !query.trim() ? 'active' : ''} aria-current={active === section.id ? 'true' : undefined} onClick={() => { setQuery(''); goTo(section.id); }}>
                <span aria-hidden="true">{section.icon}</span>{section.title}
              </button>
            </li>)}</ul>
            <h2>快捷键</h2>
            <dl className="help-shortcuts">{helpShortcuts.map(shortcut => <div key={shortcut.keys}><dt><kbd>{shortcut.keys}</kbd></dt><dd>{shortcut.desc}</dd></div>)}</dl>
          </nav>

          <div className="help-main rich-settings-content" ref={main} onScroll={onScroll}>
            {query.trim() ? <>
              <h2>搜索结果</h2>
              <p className="section-note" role="status">找到 {hits.length} 个结果</p>
              <div className="help-results">{hits.map(hit => <button key={hit.section.id} type="button" onClick={() => { setQuery(''); goTo(hit.section.id); }}>
                <span aria-hidden="true">{hit.section.icon}</span>
                <span><strong>{hit.section.title}</strong><small>{hit.matches[0] || hit.section.preview}</small></span>
              </button>)}</div>
              {!hits.length && <p className="section-note">试试“命令”“工具”“配置”或“会话”。</p>}
            </> : <>
              <section className="help-section" {...sectionProps('quickstart')}>
                <h2>🚀 快速入门</h2>
                <p className="section-note">开始使用 Loopra 的基本步骤</p>
                <div className="help-steps">{helpSteps.map((step, index) => <article key={step.title}>
                  <span className="help-step-number">{index + 1}</span>
                  <h3>{step.title}</h3><p>{step.body}</p><code>{step.sample}</code>
                </article>)}</div>
              </section>

              <section className="help-section" {...sectionProps('commands')}>
                <h2>⌨️ 命令参考</h2>
                <p className="section-note">可用的斜杠命令和操作</p>
                <div className="help-table" role="table">
                  <div className="help-table-head" role="row"><span role="columnheader">命令</span><span role="columnheader">描述</span><span role="columnheader">示例</span></div>
                  {helpCommands.map(command => <div className="help-table-row" role="row" key={command.name}>
                    <code role="cell">{command.name}</code><span role="cell">{command.desc}</span><code role="cell">{command.example}</code>
                  </div>)}
                </div>
              </section>

              <section className="help-section" {...sectionProps('tools')}>
                <h2>🔧 工具列表</h2>
                <p className="section-note">可用的 AI 工具和功能</p>
                <div className="help-tools">{helpTools.map(tool => <article key={tool.name}>
                  <header><strong>{tool.name}</strong>{tool.readonly && <span className="help-badge">只读</span>}</header>
                  <p>{tool.desc}</p>
                  <small>参数：{tool.params}</small>
                </article>)}</div>
              </section>

              <section className="help-section" {...sectionProps('config')}>
                <h2>⚙️ 配置说明</h2>
                <p className="section-note">配置文件和选项说明</p>
                <h3>配置文件位置</h3><code>~/.loopra/config.json</code>
                <h3>配置文件示例</h3><pre className="help-code"><code>{helpConfigSample}</code></pre>
                <h3>配置选项</h3>
                <dl className="help-options">{helpConfigOptions.map(option => <div key={option.name}><dt>{option.name}</dt><dd>{option.desc}</dd></div>)}</dl>
              </section>

              <section className="help-section" {...sectionProps('troubleshooting')}>
                <h2>🔍 故障排除</h2>
                <p className="section-note">常见问题和解决方案</p>
                <div className="help-issues">{helpIssues.map(issue => <article key={issue.title}>
                  <h3>{issue.title}</h3>
                  <p><strong>症状：</strong>{issue.symptom}</p>
                  <p><strong>解决方案：</strong>{issue.solution}</p>
                </article>)}</div>
              </section>

              <section className="help-section" {...sectionProps('api')}>
                <h2>📡 API 文档</h2>
                <p className="section-note">Loopra 提供 RESTful API 接口，用于与外部系统集成。当前服务地址：<code>{server}</code></p>
                <div className="help-endpoints">{helpEndpoints.map(endpoint => <div key={`${endpoint.method} ${endpoint.path}`}>
                  <span className={`help-method help-method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
                  <code>{endpoint.path}</code><span>{endpoint.desc}</span>
                </div>)}</div>
              </section>

              <section className="help-section" {...sectionProps('changelog')}>
                <h2>📝 更新日志</h2>
                <p className="section-note">版本更新记录</p>
                {helpChangelog.map(release => <article className="help-release" key={release.version}>
                  <header><strong>{release.version}</strong><time>{release.date}</time></header>
                  <ul>{release.changes.map(change => <li key={change.desc}><span className={`help-change help-change-${change.type}`}>{change.type}</span>{change.desc}</li>)}</ul>
                </article>)}
              </section>
            </>}
          </div>
        </div>
      </div>
    </ModalContent>
  </Modal>;
}
