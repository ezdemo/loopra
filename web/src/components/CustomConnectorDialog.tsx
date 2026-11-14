import { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import {
  customDraftError, customDraftFromServer, customDraftPayload, suggestConnectorName,
  type CustomDraft,
} from '../connectors';
import { OAuthWaiting, useOAuthFlow } from './OAuthFlow';
import { errorText } from './RemoteControls';
import { Field, SelectField, SettingDisclosure, SettingSegments, TextField } from './SettingControls';

// 自定义连接器添加 / 编辑对话框，取代连接器页内嵌的 MCP 管理表单。
// 保存前先探测：可匿名访问直接保存；需要 OAuth 时保存后走与内置
// 连接器相同的浏览器授权等待态；探测失败允许「仍然保存」。
export function CustomConnectorDialog({ api, name, takenNames, notify, onClose, onDone }: {
  api: LoopraClient;
  // 编辑时传入原服务名；添加时为空。
  name?: string;
  takenNames: string[];
  notify: (message: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<CustomDraft>(() => customDraftFromServer(undefined));
  const [existing, setExisting] = useState<Record<string, any> | undefined>();
  const [loaded, setLoaded] = useState(!name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forceSave, setForceSave] = useState(false);
  const [savedName, setSavedName] = useState('');
  const { phase, setPhase, authURL, blocked, preopen, start, fail, cancel } =
    useOAuthFlow(api, () => { notify(`${savedName} 已连接`); onDone(); });
  const editing = !!name;

  // 编辑时从 /mcp/servers 取完整配置（含表单未展示字段），
  // 保存时以它为底仅覆盖表单字段，保留 disallowedTools 与未知键。
  useEffect(() => {
    if (!name) return;
    let stale = false;
    void api.request<Record<string, any>[]>('/mcp/servers', 'GET')
      .then(list => {
        if (stale) return;
        const server = list.find(item => item?.name === name);
        if (!server) { setError(`找不到服务 ${name}`); return; }
        setExisting(server);
        setDraft(customDraftFromServer(server));
        setLoaded(true);
      })
      .catch(cause => { if (!stale) setError(errorText(cause)); });
    return () => { stale = true; };
  }, [name, api]);

  function payload(): Record<string, any> {
    return customDraftPayload(draft, existing);
  }

  async function save(): Promise<boolean> {
    const server = payload();
    if (editing) {
      await api.request('/mcp/servers/update', 'POST', { originalName: name, server });
    } else {
      await api.request('/mcp/servers/add', 'POST', server);
    }
    return true;
  }

  async function authorize(serverName: string) {
    const result = await api.request<{ flowId: string; authorizationUrl: string }>(
      `/connectors/custom/${encodeURIComponent(serverName)}/authorize`, 'POST');
    start(result.flowId, result.authorizationUrl);
  }

  async function submit(skipProbe: boolean) {
    const invalid = customDraftError(draft, takenNames, name);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError('');
    const serverName = (payload().name as string) || '';
    try {
      if (skipProbe) {
        await save();
        notify(editing ? `${serverName} 已保存` : `${serverName} 已添加`);
        onDone();
        return;
      }
      preopen();
      const probe = await api.request<{ ok?: boolean; toolCount?: number; authRequired?: boolean; error?: string }>(
        '/connectors/custom/probe', 'POST', { server: payload() });
      if (probe.ok) {
        await save();
        fail();
        notify(editing ? `${serverName} 已保存` : `${serverName} 已添加`);
        onDone();
        return;
      }
      if (probe.authRequired) {
        await save();
        setSavedName(serverName);
        await authorize(serverName);
        return;
      }
      fail();
      setError(probe.error ? `探测失败：${probe.error}` : '探测失败，可以仍然保存。');
      setForceSave(true);
    } catch (cause) {
      fail();
      setError(errorText(cause));
      setForceSave(true);
    } finally { setBusy(false); }
  }

  function close() {
    if (phase === 'waiting') void cancel();
    onClose();
  }

  const suggested = suggestConnectorName({ url: draft.url, command: draft.command, args: draft.argsText.split('\n').map(line => line.trim()).filter(Boolean) });
  return <Modal isOpen onClose={close} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog connector-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}
    aria-label={editing ? `编辑 ${name}` : '添加自定义连接器'}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>{editing ? `编辑 ${name}` : '添加自定义连接器'}</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        {phase === 'waiting' && <OAuthWaiting name={savedName} authURL={authURL} blocked={blocked} />}
        {phase === 'failed' && <p role="alert" className="settings-error">授权失败，请重试。</p>}
        {phase !== 'waiting' && phase !== 'failed' && <>
          <SettingSegments label="连接方式" options={['远程地址', '本地命令']}
            value={draft.mode === 'remote' ? '远程地址' : '本地命令'}
            onChange={value => setDraft(current => ({ ...current, mode: value === '远程地址' ? 'remote' : 'stdio' }))} />
          {draft.mode === 'remote'
            ? <Field label="地址" required placeholder="https://mcp.example.com/mcp" value={draft.url}
                onChange={value => setDraft(current => ({ ...current, url: value }))} />
            : <>
              <Field label="命令" required placeholder="npx" value={draft.command}
                onChange={value => setDraft(current => ({ ...current, command: value }))} />
              <TextField label="参数" placeholder={'-y\n@modelcontextprotocol/server-everything'} rows={3} spellCheck="false"
                value={draft.argsText} onChange={value => setDraft(current => ({ ...current, argsText: value }))} />
            </>}
          <Field label="名称" placeholder={suggested || '服务名称'} value={draft.name}
            onChange={value => setDraft(current => ({ ...current, name: value }))} />
          <SettingDisclosure heading="高级">
            {draft.mode === 'remote' && <>
              <SelectField label="传输" value={draft.transport} options={[{ value: 'streamable', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE' }]}
                onChange={value => setDraft(current => ({ ...current, transport: value as CustomDraft['transport'] }))} />
              <TextField label="请求头" placeholder={'Authorization: Bearer …'} rows={2} spellCheck="false"
                value={draft.headersText} onChange={value => setDraft(current => ({ ...current, headersText: value }))} />
            </>}
            {draft.mode === 'stdio' && <TextField label="环境变量" placeholder={'KEY=VALUE'} rows={2} spellCheck="false"
              value={draft.envText} onChange={value => setDraft(current => ({ ...current, envText: value }))} />}
            <Field label="超时" placeholder="30s" value={draft.timeout}
              onChange={value => setDraft(current => ({ ...current, timeout: value }))} />
          </SettingDisclosure>
          {!!error && <p role="alert" className="settings-error">{error}</p>}
        </>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        {phase === 'waiting' && <Button size="sm" variant="light" onPress={() => void cancel()}>取消</Button>}
        {phase === 'failed' && <Button size="sm" variant="light" onPress={() => setPhase('form')}>返回</Button>}
        {phase === 'form' && <>
          <Button size="sm" variant="light" onPress={onClose}>取消</Button>
          {forceSave && <Button size="sm" variant="flat" isLoading={busy} onPress={() => void submit(true)}>仍然保存</Button>}
          <Button size="sm" color="primary" isLoading={busy || !loaded}
            onPress={() => void submit(false)}>{editing ? '保存' : '添加'}</Button>
        </>}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
