import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Provider, Session } from './lib';
import { LoopraClient, configProviders, remoteSession, type RemoteConfig, type RemoteSession, type Workspace } from './backend';
import type { SkillConfig, ToolConfig } from './settings-data';
import type { VersionCheck } from './version';

export const VERSION_CHECK_INTERVAL_MS = 5 * 60_000;

export default function useLoopra(server: string) {
  const api = useMemo(() => new LoopraClient(server), [server]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [config, setConfig] = useState<RemoteConfig>();
  const [tools, setTools] = useState<ToolConfig[]>([]);
  const [skills, setSkills] = useState<SkillConfig[]>([]);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  const [updateCheck, setUpdateCheck] = useState<VersionCheck>();
  const [ready, setReady] = useState(false);
  const refreshSessions = useCallback(async (projects: Workspace[], signal?: AbortSignal) => {
    const lists = await Promise.all(projects.map(async project => (await api.request<RemoteSession[]>(`/sessions?workspaceHash=${encodeURIComponent(project.hash)}`, 'GET', undefined, signal)).map(item => remoteSession(item, project))));
    if (signal?.aborted) return;
    setSessions(current => lists.flat().map(item => ({ ...item, messages: current.find(old => old.id === item.id)?.messages || [] })));
  }, [api]);
  const refreshWorkspaces = useCallback(async () => {
    const projects = await api.request<Workspace[]>('/workspaces');
    setWorkspaces(projects);
    await refreshSessions(projects);
    return projects;
  }, [api, refreshSessions]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setStatus('connecting'); setError('');
    try {
      const [health, agent, nextConfig, projects] = await Promise.all([
        api.request<{ version: string }>('/system/health', 'GET', undefined, signal),
        api.request<{ ready: boolean }>('/agent/status', 'GET', undefined, signal),
        api.request<RemoteConfig>('/config', 'GET', undefined, signal),
        api.request<Workspace[]>('/workspaces', 'GET', undefined, signal),
      ]);
      if (signal?.aborted) return;
      setVersion(health.version); setReady(agent.ready); setConfig(nextConfig); setProviders(configProviders(nextConfig)); setWorkspaces(projects);
      if (agent.ready) {
        await refreshSessions(projects, signal);
        const resources = await Promise.allSettled([
          api.request<Omit<ToolConfig, 'category'>[]>('/tools', 'GET', undefined, signal),
          api.request<{ name: string; description: string }[]>('/agent/skills', 'GET', undefined, signal),
          api.request<string>('/loopra-md', 'GET', undefined, signal),
        ]);
        if (signal?.aborted) return;
        if (resources[0].status === 'fulfilled') setTools(resources[0].value.map(tool => ({ ...tool, category: tool.readOnly ? '只读工具' : '写入工具' })));
        if (resources[1].status === 'fulfilled') setSkills(resources[1].value.map(skill => ({ ...skill, id: skill.name, enabled: true })));
        if (resources[2].status === 'fulfilled') setPrompt(resources[2].value);
      } else { setSessions([]); setTools([]); setSkills([]); }
      setStatus('connected');
    } catch (cause) { if (signal?.aborted) return; setStatus('error'); setReady(false); setError(cause instanceof Error ? cause.message : '连接失败'); }
  }, [api, refreshSessions]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  useEffect(() => {
    if (status !== 'connected' || !version) { setUpdateCheck(undefined); return undefined; }
    // Keep the startup path responsive when the release host is unreachable:
    // version checking runs after the local service is already marked online.
    const controller = new AbortController();
    const check = () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      void api.request<VersionCheck>('/version/check', 'GET', undefined, signal)
        .then(result => { if (!controller.signal.aborted) setUpdateCheck(result); })
        // A temporary network failure must not hide an update we already know about.
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, VERSION_CHECK_INTERVAL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [api, status, version]);
  return { api, sessions, setSessions, workspaces, providers, setProviders, config, tools, skills, prompt, status, ready, error, version, updateCheck, refresh, refreshSessions, refreshWorkspaces };
}
