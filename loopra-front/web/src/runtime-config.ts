type ServerSources = { saved?: string | null; legacy?: string | null; configured?: unknown; desktopPort?: number; origin: string; development: boolean };

function address(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value.trim());
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href.replace(/\/+$/, '');
  } catch { /* Ignore invalid saved/configured addresses. */ }
}

export function resolveInitialServer({ saved, legacy, configured, desktopPort, origin, development }: ServerSources): string {
  // Electron owns the local core's port, which may change between launches.
  if (typeof desktopPort === 'number' && Number.isInteger(desktopPort) && desktopPort > 0 && desktopPort <= 65535) return `http://127.0.0.1:${desktopPort}`;
  let parsed: unknown;
  try { parsed = saved ? JSON.parse(saved) : undefined; } catch { /* Invalid preference. */ }
  const preferred = address(parsed) || address(legacy);
  if (preferred) return preferred;
  const config = address(configured);
  const bundledDefault = config === 'http://localhost:4567' || config === 'http://127.0.0.1:4567';
  if (config && (development || !bundledDefault)) return config;
  return (!development && address(origin)) || config || 'http://127.0.0.1:4567';
}
