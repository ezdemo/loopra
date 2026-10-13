import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { resolveInitialServer } from './runtime-config';
import './styles.css';
import './chat-blocks.css';
import './motion.css';
import './composer.css';
import './settings.css';
import './sessions.css';
import './help.css';
import './pets.css';
import './workbench.css';
import './capabilities.css';
import './requirements.css';

async function initialize() {
  // Keep explicit browser preferences; otherwise migrate the original console's
  // address and honor config.json without pinning packaged Web pages to port 4567.
  try {
    let configured: unknown;
    if (!localStorage.getItem('loopra:backend-server') && !localStorage.getItem('loopra-api-base')) {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}config.json`, { signal: AbortSignal.timeout(3000) });
        if (response.ok) configured = (await response.json()).apiBase;
      } catch { /* Same-origin/default fallback remains available. */ }
    }
    const server = resolveInitialServer({
      saved: localStorage.getItem('loopra:backend-server'),
      legacy: localStorage.getItem('loopra-api-base'), configured,
      origin: window.location.origin, development: import.meta.env.DEV,
    });
    localStorage.setItem('loopra:backend-server', JSON.stringify(server));
  } catch { /* Storage restrictions must not prevent mounting the application. */ }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void initialize();
