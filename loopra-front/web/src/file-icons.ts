// Ported from legacy src/utils/fileIcons.js: the file explorer / search list used a
// per-extension codicon + brand color. The React app renders lucide glyphs, so the
// kind is the stable contract while `icon`/`color` keep the legacy values intact.
export type FileIcon = { kind: string; color: string; icon: string };

const FILE_ICONS: Record<string, [string, string]> = {
  default: ['codicon-file', '#6d8086'],
  vue: ['codicon-symbol-color', '#8dc149'],
  javascript: ['codicon-file-code', '#cbcb41'],
  react: ['codicon-symbol-class', '#519aba'],
  typescript: ['codicon-file-code', '#519aba'],
  java: ['codicon-coffee', '#cc3e44'],
  kotlin: ['codicon-file-code', '#e37933'],
  json: ['codicon-json', '#cbcb41'],
  markdown: ['codicon-markdown', '#519aba'],
  css: ['codicon-symbol-color', '#519aba'],
  sass: ['codicon-symbol-color', '#f55385'],
  html: ['codicon-code', '#e37933'],
  xml: ['codicon-code', '#e37933'],
  yaml: ['codicon-list-tree', '#a074c4'],
  python: ['codicon-file-code', '#519aba'],
  go: ['codicon-file-code', '#519aba'],
  rust: ['codicon-settings-gear', '#6d8086'],
  php: ['codicon-file-code', '#a074c4'],
  shell: ['codicon-terminal', '#4d5a5e'],
  powershell: ['codicon-terminal-powershell', '#519aba'],
  database: ['codicon-database', '#f55385'],
  image: ['codicon-file-media', '#a074c4'],
  svg: ['codicon-symbol-color', '#a074c4'],
  pdf: ['codicon-file-pdf', '#cc3e44'],
  archive: ['codicon-file-zip', '#cc3e44'],
  config: ['codicon-settings-gear', '#6d8086'],
  git: ['codicon-source-control', '#41535b'],
  npm: ['codicon-package', '#41535b'],
  docker: ['codicon-package', '#519aba'],
  maven: ['codicon-package', '#cc3e44'],
  gradle: ['codicon-package', '#519aba'],
};

const EXTENSION_ICONS: Record<string, string> = {
  vue: 'vue', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react', java: 'java',
  kt: 'kotlin', kts: 'kotlin', json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'sass', sass: 'sass', less: 'css', html: 'html', htm: 'html',
  xml: 'xml', yml: 'yaml', yaml: 'yaml', py: 'python', pyw: 'python', go: 'go', rs: 'rust',
  php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', sql: 'database',
  db: 'database', sqlite: 'database', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', ico: 'image', svg: 'svg', pdf: 'pdf', zip: 'archive', rar: 'archive',
  '7z': 'archive', tar: 'archive', gz: 'archive', toml: 'config', ini: 'config', conf: 'config',
};

export function iconKind(name?: string): string {
  const lower = String(name || '').toLowerCase();
  if (/^(package(-lock)?|pnpm-lock|npm-shrinkwrap)\.json$/.test(lower)) return 'npm';
  if (lower === 'pom.xml') return 'maven';
  if (/^(build|settings)\.gradle(\.kts)?$/.test(lower)) return 'gradle';
  if (lower === 'dockerfile' || lower.startsWith('docker-compose.')) return 'docker';
  if (/^\.git(ignore|attributes|modules)?$/.test(lower)) return 'git';
  if (lower === '.env' || lower.startsWith('.env.')) return 'config';
  const dot = lower.lastIndexOf('.');
  return EXTENSION_ICONS[dot >= 0 ? lower.slice(dot + 1) : ''] || 'default';
}

export function fileIconFor(name?: string): FileIcon {
  const kind = iconKind(name);
  const [icon, color] = FILE_ICONS[kind];
  return { kind, color, icon };
}
