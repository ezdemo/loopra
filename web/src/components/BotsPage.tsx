import { useEffect, useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner, Switch } from '@nextui-org/react';
import { Bot as BotIcon, ExternalLink, FolderOpen, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import type { LoopraClient, Workspace } from '../backend';
import { botAccessIDs, botStateLabel, type Bot, type BotRegistration } from '../bots';
import { ConfirmAction, errorText, RemoteState, useRemote } from './RemoteControls';
import { Field, PageActions, SettingDisclosure, TextField } from './SettingControls';
import { IconButton } from './ui';

type Props = {
  api: LoopraClient; workspaces: Workspace[]; english?: boolean;
  onChanged: () => Promise<unknown>;
  onManageProject: (workspace: Workspace) => void;
  onOpenSession: (hash: string, name: string) => void;
};

export default function BotsPage({ api, workspaces, english = false, onChanged, onManageProject, onOpenSession }: Props) {
  const [revision, setRevision] = useState(0);
  const state = useRemote<Bot[]>(api, '/bots', revision, true);
  const [registration, setRegistration] = useState<Bot | 'new'>();
  const [editing, setEditing] = useState<Bot>();
  const [deleting, setDeleting] = useState<Bot>();
  const [notice, setNotice] = useState('');
  const t = (zh: string, en: string) => english ? en : zh;
  useEffect(() => {
    const timer = window.setInterval(() => setRevision(value => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, [api]);
  return <section className="skills-hub bots-hub" aria-label="Bot">
    <div className="skills-hub-inner bots-inner">
      <PageActions title="Bot">
        <IconButton label={t('刷新 Bot', 'Refresh bots')} onClick={() => setRevision(value => value + 1)}><RefreshCw size="1rem" /></IconButton>
        <Button color="primary" size="sm" startContent={<Plus size="1rem" />} onPress={() => setRegistration('new')}>{t('添加 Bot', 'Add bot')}</Button>
      </PageActions>
      <RemoteState loading={state.loading && !state.data} error={state.error || notice} />
      {state.error && <Button size="sm" variant="flat" onPress={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</Button>}
      {state.data?.length === 0 && <div className="bots-empty"><BotIcon size="2rem" strokeWidth={1.5} /><h3>{t('添加你的第一个 Bot', 'Add your first bot')}</h3><p>{t('扫码连接飞书，在聊天中使用 Agent。', 'Connect Feishu by scanning a QR code and chat with your agent.')}</p></div>}
      <div className="bots-list">
        {state.data?.map(item => {
          const project = workspaces.find(workspace => workspace.hash === item.workspaceHash);
          return <article className="bot-row" key={item.id}>
            <div className="bot-identity"><span className="bot-icon"><BotIcon size="1.25rem" /></span><div><h3>{item.name}</h3><span>{t('飞书', 'Feishu')} · <span className={`bot-status bot-status-${item.state}`}>{botStateLabel(item.state, english)}</span></span></div></div>
            <div className="bot-project"><FolderOpen size="1rem" /><span>{project?.name || t('项目已移除', 'Project removed')}</span></div>
            <div className="bot-actions">
              <Button size="sm" variant="light" onPress={() => setEditing(item)} startContent={<Settings2 size="1rem" />}>{t('管理', 'Manage')}</Button>
              <IconButton label={`${t('删除', 'Delete')} ${item.name}`} onClick={() => setDeleting(item)}><Trash2 size="1rem" /></IconButton>
            </div>
            {item.error && <p className="bot-error" role="status">{item.error}</p>}
          </article>;
        })}
      </div>
      {registration && <RegistrationDialog key={`${api.base}:${registration === 'new' ? 'new' : registration.id}`} api={api} target={registration === 'new' ? undefined : registration} english={english}
        onClose={() => setRegistration(undefined)} onCompleted={() => {
          setRegistration(undefined); setRevision(value => value + 1);
          void onChanged().catch(cause => setNotice(errorText(cause)));
        }} />}
      {editing && <BotDialog key={editing.id} api={api} bot={state.data?.find(item => item.id === editing.id) || editing} english={english}
        project={workspaces.find(item => item.hash === editing.workspaceHash)}
        onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setRevision(value => value + 1); }}
        onRegister={() => { setRegistration(editing); setEditing(undefined); }}
        onManageProject={onManageProject} onOpenSession={onOpenSession} />}
      {deleting && <ConfirmAction title={t('删除 Bot', 'Delete bot')} onClose={() => setDeleting(undefined)}
        action={() => api.request(`/bots/${encodeURIComponent(deleting.id)}`, 'DELETE')} onDone={() => { setRevision(value => value + 1); setEditing(undefined); }}>
        <p>{t(`删除 ${deleting.name}？项目和历史会话会保留。`, `Delete ${deleting.name}? Its project and conversation history will be kept.`)}</p>
      </ConfirmAction>}
    </div>
  </section>;
}

function RegistrationDialog({ api, target, english, onClose, onCompleted }: {
  api: LoopraClient; target?: Bot; english: boolean; onClose: () => void; onCompleted: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [registration, setRegistration] = useState<BotRegistration>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const t = (zh: string, en: string) => english ? en : zh;
  useEffect(() => {
    let live = true;
    let id: string | undefined;
    let completed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    setRegistration(undefined); setError('');
    const cancel = (value: string) => { void api.request(`/bots/registrations/${encodeURIComponent(value)}`, 'DELETE').catch(() => undefined); };
    const poll = async () => {
      if (!live || !id) return;
      try {
        const value = await api.request<BotRegistration>(`/bots/registrations/${encodeURIComponent(id)}`, 'GET', undefined, controller.signal);
        if (!live) return;
        setRegistration(value);
        if (value.state === 'completed') { completed = true; completedRef.current(); return; }
        if (value.state === 'failed' || value.state === 'cancelled') return;
        timer = window.setTimeout(() => void poll(), 1500);
      } catch (cause) {
        if (live) setError(errorText(cause));
      }
    };
    // 保留创建请求的结果，关闭弹窗后也能用返回的 ID 取消服务端轮询。
    void api.request<BotRegistration>('/bots/registrations', 'POST', { botId: target?.id }).then(value => {
      id = value.id;
      if (!live) { cancel(id); return; }
      setRegistration(value);
      void poll();
    }).catch(cause => { if (live) setError(errorText(cause)); });
    return () => {
      live = false; controller.abort(); window.clearTimeout(timer);
      if (id && !completed) cancel(id);
    };
  }, [api, target?.id, attempt]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = !!registration?.expiresAt && registration.expiresAt <= now;
  const failed = !!error || registration?.state === 'failed' || registration?.state === 'cancelled' || expired;
  return <Modal isOpen onClose={onClose} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog bot-registration-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}>
    <ModalContent><ModalHeader className="app-dialog-header"><h2>{target ? t('重新授权飞书', 'Reauthorize Feishu') : t('添加飞书 Bot', 'Add Feishu bot')}</h2></ModalHeader>
      <ModalBody className="app-dialog-body bot-registration-body">
        {!failed && registration?.qrCode ? <>
          <img className="bot-qr" src={registration.qrCode} alt={t('飞书授权二维码', 'Feishu authorization QR code')} width={320} height={320} />
          <p>{t('使用飞书扫码，确认创建并授权机器人。', 'Scan with Feishu and confirm the bot authorization.')}</p>
          <span className="bot-qr-expiry">{t(`${Math.max(0, Math.ceil(((registration.expiresAt || 0) - now) / 1000))} 秒后过期`, `Expires in ${Math.max(0, Math.ceil(((registration.expiresAt || 0) - now) / 1000))} seconds`)}</span>
          {registration.url && <Button as="a" href={registration.url} target="_blank" rel="noopener noreferrer" size="sm" variant="light" endContent={<ExternalLink size="1rem" />}>{t('打开授权页面', 'Open authorization page')}</Button>}
        </> : failed ? <p className="settings-error" role="alert">{error || registration?.error || t('二维码已过期，请重试。', 'The QR code expired. Please try again.')}</p>
          : <><Spinner aria-label={t('正在生成二维码', 'Creating QR code')} /><p>{t('正在准备飞书授权…', 'Preparing Feishu authorization…')}</p></>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" onPress={onClose}>{t('取消', 'Cancel')}</Button>{failed && <Button size="sm" color="primary" onPress={() => setAttempt(value => value + 1)}>{t('重新获取二维码', 'Try again')}</Button>}</ModalFooter>
    </ModalContent>
  </Modal>;
}

function BotDialog({ api, bot, project, english, onClose, onSaved, onRegister, onManageProject, onOpenSession }: {
  api: LoopraClient; bot: Bot; project?: Workspace; english: boolean; onClose: () => void; onSaved: () => void;
  onRegister: () => void; onManageProject: (workspace: Workspace) => void; onOpenSession: (hash: string, name: string) => void;
}) {
  const [name, setName] = useState(bot.name);
  const [enabled, setEnabled] = useState(bot.enabled);
  const [users, setUsers] = useState(bot.allowedUserIds.join('\n'));
  const [groups, setGroups] = useState(bot.allowedChatIds.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const t = (zh: string, en: string) => english ? en : zh;
  async function save() {
    setBusy(true); setError('');
    try {
      await api.request(`/bots/${encodeURIComponent(bot.id)}`, 'PUT', { name: name.trim(), enabled, allowedUserIds: botAccessIDs(users), allowedChatIds: botAccessIDs(groups) });
      onSaved();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog bot-manage-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}>
    <ModalContent><ModalHeader className="app-dialog-header"><h2>{t('管理 Bot', 'Manage bot')}</h2></ModalHeader>
      <ModalBody className="app-dialog-body bot-manage-body">
        <Field label={t('名称', 'Name')} value={name} onChange={setName} maxLength={80} disabled={busy} />
        <div className="bot-setting-line"><span>{botStateLabel(bot.state, english)}</span><Switch aria-label={t('启用 Bot', 'Enable bot')} isSelected={enabled} onValueChange={setEnabled} isDisabled={busy} size="sm" /></div>
        <div className="bot-project-setting"><div><span>{t('默认项目', 'Default project')}</span><strong>{project?.name || t('项目已移除', 'Project removed')}</strong></div><Button size="sm" variant="flat" isDisabled={!project || busy} onPress={() => { if (project) onManageProject(project); }}>{t('关联项目', 'Linked projects')}</Button></div>
        <SettingDisclosure heading={t('访问权限', 'Access')}>
          <p className="bot-access-hint">{t('默认仅扫码用户可使用。群聊需加入允许列表，并 @Bot。', 'Only the authorizing user has access by default. Allow a group here and @mention the bot to use it.')}</p>
          <Field label={t('扫码用户 Open ID', 'Owner Open ID')} value={bot.ownerId} onChange={() => undefined} readOnly />
          <TextField label={t('其他允许用户的 Open ID', 'Additional allowed user Open IDs')} value={users} onChange={setUsers} disabled={busy} placeholder="ou_..." rows={2} />
          <TextField label={t('允许的群聊 ID', 'Allowed group chat IDs')} value={groups} onChange={setGroups} disabled={busy} placeholder="oc_..." rows={2} />
        </SettingDisclosure>
        <section className="bot-chat-list"><h3>{t('会话', 'Conversations')}</h3>{bot.chats.length ? [...bot.chats].sort((a, b) => b.updatedAt - a.updatedAt).map((chat, index) => <Button key={chat.chatId} size="sm" variant="light" isDisabled={busy || !project} onPress={() => onOpenSession(bot.workspaceHash, chat.sessionName)}><span>{chat.chatType === 'group' ? t('群聊', 'Group') : t('单聊', 'Direct chat')} {index + 1}</span><span className="bot-chat-id">{chat.chatId}</span><ExternalLink size=".875rem" /></Button>) : <p>{t('在飞书中发送第一条消息后，会话会显示在这里。', 'Send a message in Feishu to start a conversation.')}</p>}</section>
        {bot.error && <p className="settings-error" role="status">{bot.error}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={busy} onPress={onRegister}>{t('重新授权', 'Reauthorize')}</Button><Button size="sm" color="primary" isLoading={busy} isDisabled={!name.trim()} onPress={() => void save()}>{t('保存', 'Save')}</Button></ModalFooter>
    </ModalContent>
  </Modal>;
}
