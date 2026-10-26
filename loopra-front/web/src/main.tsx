import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { notifyDesktopWorkspaceAfterPaint } from './desktop-shell';
import { resolveInitialServer } from './runtime-config';
import { installFocusAppearance } from './focus';
import { ensureAccess, installAccessKeyProtocol, setAccessProxy } from '../../src/services/access-key.js';
import './styles.css';
import './chat-blocks.css';
import './motion.css';
import './composer.css';
import './background-tasks.css';
import './settings.css';
import './sessions.css';
import './help.css';
import './pets.css';
import './workbench.css';
import './workspace-tabs.css';
import './git-panel.css';
import './environment.css';
import './resources.css';
import './subagents.css';
import './skills.css';
import './capabilities.css';
import './requirements.css';
import './dialogs.css';
import './session-records.css';
import './project-manager.css';
import './focus.css';
import './loading.css';

document.documentElement.classList.add('workspace-theme');
const removeFocusAppearance = installFocusAppearance();
if (import.meta.hot) import.meta.hot.dispose(removeFocusAppearance);
installAccessKeyProtocol();
if (import.meta.env.DEV && ['3000', '5173'].includes(window.location.port)) setAccessProxy(window.location.origin, 'http://127.0.0.1:4567');

const root = ReactDOM.createRoot(document.getElementById('root')!);
function Workspace(props: React.ComponentProps<typeof App>) {
  React.useEffect(notifyDesktopWorkspaceAfterPaint, []);
  return <App {...props} />;
}
root.render(<React.StrictMode><Workspace startupPending /></React.StrictMode>);

async function initialize() {
  let server = import.meta.env.DEV ? 'http://127.0.0.1:4567' : window.location.origin;
  // Keep explicit browser preferences; otherwise migrate the original console's
  // address and honor config.json without pinning packaged Web pages to port 4567.
  try {
    let desktopPort: number | undefined;
    const desktopService = (window as Window & { electronAPI?: { loopraWebService?: { getCurrentPort?: () => Promise<number>; waitForReady?: () => Promise<number> } } }).electronAPI?.loopraWebService;
    if (desktopService?.waitForReady) await desktopService.waitForReady();
    try { desktopPort = await desktopService?.getCurrentPort?.(); } catch { /* Use saved/default addresses if the bridge is unavailable. */ }
    let configured: unknown;
    if (!localStorage.getItem('loopra:backend-server') && !localStorage.getItem('loopra-api-base')) {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}config.json`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) configured = (await response.json()).apiBase;
      } catch { /* Same-origin/default fallback remains available. */ }
    }
    server = resolveInitialServer({
      saved: localStorage.getItem('loopra:backend-server'),
      legacy: localStorage.getItem('loopra-api-base'), configured, desktopPort,
      origin: window.location.origin, development: import.meta.env.DEV,
    });
    // A printed launch link belongs to this service, even if a different
    // backend had previously been selected in this browser profile.
    if (!desktopPort && !import.meta.env.DEV && new URLSearchParams(window.location.search).has('rk')) server = window.location.origin;
    localStorage.setItem('loopra:backend-server', JSON.stringify(server));
  } catch { /* Storage restrictions must not prevent mounting the application. */ }
  await ensureAccess(server, true);
  root.render(
    <React.StrictMode>
      <Workspace initialServer={server} />
    </React.StrictMode>,
  );
}

void initialize();
