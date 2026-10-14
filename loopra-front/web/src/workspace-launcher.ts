import type { LoopraClient } from './backend';

export const workspaceApplications = [
  { name: 'File Explorer', label: '文件资源管理器', application: 'folder' },
  { name: 'PowerShell', label: 'PowerShell', application: 'powershell' },
  { name: 'Git Bash', label: 'Git Bash', application: 'git-bash' },
  { name: 'Bash', label: 'Bash', application: 'bash' },
];

export async function launchWorkspace(api: LoopraClient, workspaceHash: string, name: string) {
  if (!workspaceHash) throw new Error('请先选择项目');
  const application = name === 'Terminal' ? 'terminal' : workspaceApplications.find(item => item.name === name)?.application;
  if (!application) throw new Error('不支持的打开方式');
  return api.request<string>('/system/open-workspace', 'POST', { workspaceHash, application });
}
