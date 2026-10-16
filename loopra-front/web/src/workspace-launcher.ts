import type { LoopraClient } from './backend';

export const workspaceApplications = [
  { name: 'File Explorer', label: '文件资源管理器', application: 'folder' },
  { name: 'PowerShell', label: 'PowerShell', application: 'powershell' },
  { name: 'Git Bash', label: 'Git Bash', application: 'git-bash' },
  { name: 'Bash', label: 'Bash', application: 'bash' },
];

/** Entry id for a configured name; 'Terminal' is the alias older preferences stored. */
export function applicationIdOf(name: string): string | undefined {
  if (name === 'Terminal') return 'terminal';
  return workspaceApplications.find(item => item.name === name)?.application;
}

/** What the service host can really open. Null means "unknown" (older service) — don't filter. */
export async function fetchAvailableApplications(api: LoopraClient, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const ids = await api.request<string[]>('/system/open-applications', 'GET', undefined, signal);
    return Array.isArray(ids) && ids.length ? ids : null;
  } catch {
    return null;
  }
}

/** The host's real entries, so the menu never offers Git Bash or PowerShell where they cannot run. */
export function visibleApplications(available: string[] | null | undefined) {
  if (!available) return workspaceApplications;
  return workspaceApplications.filter(item => available.includes(item.application));
}

export async function launchWorkspace(api: LoopraClient, workspaceHash: string, name: string) {
  if (!workspaceHash) throw new Error('请先选择项目');
  const application = applicationIdOf(name);
  if (!application) throw new Error('不支持的打开方式');
  return api.request<string>('/system/open-workspace', 'POST', { workspaceHash, application });
}
