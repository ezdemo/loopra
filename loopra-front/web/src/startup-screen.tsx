import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card, CardBody, Chip, Code, Divider, NextUIProvider, Progress, Select, SelectItem, Spinner } from '@nextui-org/react';
import { ArrowRight, Check, Package, Server, X, Zap } from 'lucide-react';
import '../../src/assets/styles/workspace-theme.css';
import './startup-screen.css';

type JavaRuntime = { found: boolean; path: string; version: string; major: number };
type Tone = 'ok' | 'warn' | 'off' | 'info' | '';
export type StartupState = {
  visible: boolean; theme: string; menu: string; autoStarting: boolean; startingMsg: string;
  installed: boolean; running: boolean; port: number; bundledCore: boolean; bundledVersion: string;
  installDir: string; runtimeVersion: string; desktopVersion: string; coreBusy: boolean;
  installing: boolean; starting: boolean; busy: boolean; errorMessage: string; javaChecking: boolean;
  versionStateClass: Tone; versionStateText: string; systemStateClass: Tone; systemStateText: string;
  bundledStateClass: Tone; bundledStateText: string; jreSource: string; testingMirrors: boolean;
  jreDownloading: boolean; jrePercent: number; enterPulse: boolean; jrePulse: boolean;
  java: { system: JavaRuntime; bundled: JavaRuntime; usable: boolean; hint: string };
  jreOptions: { value: string; label: string; latency?: number | null }[];
  installLogs: string[]; jreLogs: string[];
};
type Action = () => void | Promise<unknown>;
export type StartupActions = {
  cancelStart: Action; closeApp: Action; switchMenu: (menu: string) => void; enterLoopra: Action;
  refreshCore: Action; refreshJava: Action; installOrUpdate: Action; startService: Action;
  stopService: Action; restartService: Action; downloadJre: Action; runMirrorSpeedTest: Action;
  openJavaDownload: Action; setJreSource: (value: string) => void;
  setInstallLogElement: (element: HTMLDivElement | null) => void;
  setJreLogElement: (element: HTMLDivElement | null) => void;
};
const toneColor = (tone: Tone) => tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone === 'info' ? 'primary' : 'default';

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Chip size="sm" variant="flat" color={toneColor(tone)} className="sw-status-chip">{children}</Chip>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card shadow="none" className="sw-section"><CardBody className="sw-section-body"><h3>{title}</h3>{children}</CardBody></Card>;
}
function Log({ lines, elementRef }: { lines: string[]; elementRef: (element: HTMLDivElement | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines.length]);
  return <div className="sw-log" ref={element => { ref.current = element; elementRef(element); }} role="log" aria-label="安装日志">{lines.map((line, index) => <div key={index}>{line || '\u00a0'}</div>)}</div>;
}

export function StartupScreen({ state: s, actions: a, portalContainer }: { state: StartupState; actions: StartupActions; portalContainer: HTMLElement }) {
  const javaSetupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (s.visible && s.menu === 'deps' && !s.java.usable && !s.autoStarting) {
      javaSetupRef.current?.scrollIntoView({ block: 'start' });
      javaSetupRef.current?.querySelector<HTMLButtonElement>('[data-java-download]')?.focus({ preventScroll: true });
    }
  }, [s.visible, s.menu, s.java.usable, s.autoStarting]);
  if (!s.visible) return null;
  const logo = <img src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" draggable={false} />;
  const sourceOptions = [{ value: 'normal', label: 'GitHub 直连' }, ...s.jreOptions.map(item => ({ value: item.value, label: `${item.label}${item.latency != null ? ` (${item.latency}ms)` : ''}` }))];
  const inert = s.autoStarting ? { inert: '' } : {};
  return <NextUIProvider reducedMotion="user"><div className="startup-window">
    {s.autoStarting && <div className="sw-starting-overlay">
      <div className="sw-starting-brand">{logo}<span>Loopra</span></div>
      <div className="sw-loading-status" role="status" aria-live="polite" aria-atomic="true"><Spinner size="sm" color="primary" aria-label="正在准备服务" /><span>{s.startingMsg.replace(/\.{3}$/, '…')}</span></div>
      <p className="sw-loading-hint">准备就绪后即可进入工作区</p>
      <Button size="sm" variant="bordered" radius="md" className="sw-secondary-button sw-cancel-button" onPress={a.cancelStart}>取消</Button>
    </div>}
    <header className="sw-header" {...inert}>
      <div className="sw-brand">{logo}<div><strong>Loopra 桌面端管理</strong><span>核心服务 · 运行环境</span></div></div>
      <div className="sw-header-actions"><Chip size="sm" variant="flat" color={s.running ? 'success' : 'default'} startContent={<span className="sw-status-dot" />}>{s.running ? `核心服务运行中${s.port ? ` · 端口 ${s.port}` : ''}` : '核心服务未运行'}</Chip><Button isIconOnly size="sm" variant="light" aria-label="关闭程序" onPress={a.closeApp}><X size={18} /></Button></div>
    </header>
    <div className="sw-body" {...inert}>
      <aside className="sw-sidebar"><nav aria-label="桌面端管理"><Button size="sm" variant="light" className={`sw-nav-item ${s.menu === 'core' ? 'active' : ''}`} startContent={<Server size={16} />} aria-current={s.menu === 'core' ? 'page' : undefined} onPress={() => a.switchMenu('core')}>核心管理</Button><Button size="sm" variant="light" className={`sw-nav-item ${s.menu === 'deps' ? 'active' : ''}`} startContent={<Package size={16} />} aria-current={s.menu === 'deps' ? 'page' : undefined} onPress={() => a.switchMenu('deps')}>依赖管理</Button></nav><div className="sw-sidebar-foot">{s.running ? <Button size="sm" color="primary" fullWidth endContent={<ArrowRight size={14} />} onPress={a.enterLoopra}>进入 Loopra</Button> : <p>核心服务启动后可进入主界面</p>}</div></aside>
      <main className="sw-content">{s.menu === 'core' ? <section className="sw-pane" aria-label="核心管理">
        <div className="sw-pane-head"><h2>核心管理</h2><Button size="sm" variant="light" isLoading={s.coreBusy} onPress={a.refreshCore}>{s.coreBusy ? '检测中…' : '刷新状态'}</Button></div>
        <div className="sw-cards">{[
          { label: '安装状态', value: s.installed ? '已安装' : '未安装', tone: s.installed ? 'success' : 'warning' },
          { label: '运行状态', value: s.running ? '运行中' : '未运行', tone: s.running ? 'success' : '' },
          { label: '服务端口', value: s.port || '—', tone: '' },
          { label: '核心来源', value: s.bundledCore ? '安装包内置' : '在线下载', tone: '' },
        ].map(item => <Card key={item.label} shadow="none" className="sw-stat-card"><CardBody><span>{item.label}</span><strong className={item.tone}>{item.value}</strong></CardBody></Card>)}</div>
        <Section title="版本"><div className="sw-version-row"><span>桌面端</span><Code size="sm">{s.desktopVersion || '—'}</Code><span>核心服务</span><Code size="sm">{s.runtimeVersion || '—'}</Code><Status tone={s.versionStateClass}>{s.versionStateText}</Status></div></Section>
        {s.installDir && <Section title="安装目录"><Code className="sw-path">{s.installDir}</Code></Section>}
        <Section title={s.bundledCore ? "核心自动更新" : "安装核心服务"}><p className={`sw-notice ${s.bundledCore ? 'success' : 'warning'}`}>{s.bundledCore ? <>安装包已内置核心运行时{s.bundledVersion && `（版本 ${s.bundledVersion}）`}，发现新版本会自动安装并启动服务，无需手动更新</> : '当前安装包未内置核心运行时，无法在此安装/更新'}</p><div className="sw-actions">{s.bundledCore && !!s.errorMessage && <Button size="sm" color="primary" isDisabled={s.busy} isLoading={s.installing} onPress={a.installOrUpdate}>重试自动更新</Button>}<Button size="sm" variant="bordered" className="sw-secondary-button" isDisabled={s.busy || s.running || !s.installed} isLoading={s.starting} onPress={a.startService}>{s.starting ? '启动中…' : '启动服务'}</Button><Button size="sm" variant="bordered" className="sw-secondary-button" isDisabled={s.busy || !s.running} onPress={a.stopService}>停止服务</Button><Button size="sm" variant="bordered" className="sw-secondary-button" isDisabled={s.busy || !s.running} onPress={a.restartService}>重启服务</Button></div></Section>
        {s.installLogs.length > 0 && <Section title="安装日志"><Log lines={s.installLogs} elementRef={a.setInstallLogElement} /></Section>}
        {s.errorMessage && <div role="alert" className="sw-notice danger">{s.errorMessage}</div>}
      </section> : <section className="sw-pane" aria-label="依赖管理">
        <div className="sw-pane-head"><h2>依赖管理 · JRE/JDK</h2><Button size="sm" variant="light" isLoading={s.javaChecking} onPress={a.refreshJava}>{s.javaChecking ? '检测中…' : '重新检测'}</Button></div>
        {!s.java.usable && <Card ref={javaSetupRef} shadow="none" role="alert" className="sw-java-required"><CardBody><h3>请先下载 Java 运行环境</h3><p>运行 Loopra 核心服务需要 Java 17 或更高版本的 JRE 或 JDK。核心更新已检查完成。请下载安装 JRE 25，安装完成后将自动启动核心服务。</p><div><Button data-java-download size="sm" color="primary" isLoading={s.jreDownloading} startContent={!s.jreDownloading ? <Package size={14} /> : undefined} onPress={a.downloadJre}>{s.jreDownloading ? '正在下载安装 JRE…' : '下载并安装 JRE 25'}</Button></div></CardBody></Card>}
        <Card shadow="none" className={`sw-java-summary ${s.java.usable ? 'success' : 'danger'}`}><CardBody><span className="sw-java-badge">{s.java.usable ? <Check size={18} /> : <X size={18} />}</span><div><strong>{s.java.usable ? 'Java 环境可用' : '未检测到可用的 Java 17+'}</strong><p>{s.java.hint || '—'}</p></div></CardBody></Card>
        <Section title="系统 Java"><div className="sw-runtime-status"><Status tone={s.systemStateClass}>{s.systemStateText}</Status></div><div className="sw-java-row"><span>版本</span><Code size="sm">{s.java.system.version || '—'}</Code></div><div className="sw-java-row"><span>路径</span><Code size="sm" className="sw-path">{s.java.system.path || 'PATH 中未找到 java'}</Code></div>{s.java.system.found && s.java.system.major > 0 && s.java.system.major < 17 && <p className="sw-notice warning">版本过低（Java {s.java.system.major}），需要 17+</p>}</Section>
        <Section title="捆绑 JRE"><div className="sw-runtime-status"><Status tone={s.bundledStateClass}>{s.bundledStateText}</Status></div><div className="sw-java-row"><span>版本</span><Code size="sm">{s.java.bundled.version || '—'}</Code></div><div className="sw-java-tools"><Select size="sm" variant="bordered" classNames={{ trigger: 'sw-source-trigger' }} aria-label="JRE 下载源" disallowEmptySelection selectedKeys={sourceOptions.some(item => item.value === s.jreSource) ? [s.jreSource] : ['normal']} isDisabled={s.jreDownloading} onSelectionChange={keys => { const key = Array.from(keys)[0]; if (key !== undefined) a.setJreSource(String(key)); }} className="sw-source-select" popoverProps={{ portalContainer, shouldCloseOnScroll: false, classNames: { content: 'sw-source-popover' } }}>{sourceOptions.map(item => <SelectItem key={item.value} textValue={item.label}>{item.label}</SelectItem>)}</Select><Button size="sm" variant="bordered" className="sw-secondary-button" isDisabled={s.jreDownloading} isLoading={s.testingMirrors} startContent={!s.testingMirrors && <Zap size={14} />} onPress={a.runMirrorSpeedTest}>{s.testingMirrors ? '测速中' : '重新测速'}</Button><Button size="sm" color="primary" isLoading={s.jreDownloading} startContent={s.jrePulse && !s.jreDownloading ? <Package size={14} /> : undefined} onPress={a.downloadJre}>{s.jreDownloading ? '安装中…' : s.java.bundled.found ? '重新安装 JRE 25' : '安装 JRE 25'}</Button></div><Divider /><div className="sw-java-row"><span>路径</span><Code size="sm" className="sw-path">{s.java.bundled.path || '~/.loopra-gui/jre25 下未找到'}</Code></div>{s.java.bundled.found && <p className="sw-muted">捆绑 JRE 随核心服务安装到 ~/.loopra-gui/jre25</p>}{s.java.bundled.found && s.running && <p className="sw-notice warning">核心服务正在运行，重装前请先到「核心管理」停止服务，避免文件占用导致失败</p>}{(s.jreDownloading || s.jrePercent > 0) && <Progress size="sm" color="primary" label={s.jrePercent >= 100 ? '安装完成' : '正在安装 JRE'} value={s.jrePercent} showValueLabel aria-label="JRE 安装进度" />}{s.jreLogs.length > 0 && <Log lines={s.jreLogs} elementRef={a.setJreLogElement} />}</Section>
        {!s.java.usable && <Section title="手动安装 Java 17 或更高版本"><p className="sw-muted">清华大学 Adoptium 镜像：mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/</p><p className="sw-muted">injdk.cn：injdk.cn</p><div><Button size="sm" variant="bordered" className="sw-secondary-button" endContent={<ArrowRight size={14} />} onPress={a.openJavaDownload}>打开下载页面</Button></div></Section>}
      </section>}</main>
    </div>
  </div></NextUIProvider>;
}

export function mountStartupScreen(container: HTMLElement, state: StartupState, actions: StartupActions) {
  const root = createRoot(container);
  const render = (next: StartupState) => root.render(<StartupScreen state={next} actions={actions} portalContainer={container} />);
  render(state);
  return { render, unmount: () => root.unmount() };
}
