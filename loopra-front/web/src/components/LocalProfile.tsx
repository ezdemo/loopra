import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Camera, Check, UserRound } from 'lucide-react';
import { createProfileAvatar, PROFILE_COLORS, type LocalProfile } from '../local-profile';
import { profileSaveError } from '../local-profile-storage';

export function ProfileAvatar({ profile, large = false }: { profile: LocalProfile; large?: boolean }) {
  const initial = Array.from(profile.nickname.trim())[0]?.toLocaleUpperCase();
  return <span className={`profile-avatar profile-color-${profile.color}${large ? ' profile-avatar-large' : ''}`} aria-hidden="true">
    {profile.avatar ? <img src={profile.avatar} alt="" draggable={false} /> : initial ? <span>{initial}</span> : <UserRound size={large ? '1.75rem' : '1rem'} />}
  </span>;
}

export default function ProfileEditor({ profile, english, onSave, onClose }: { profile: LocalProfile; english: boolean; onSave: (value: LocalProfile) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(profile);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadId = useRef(0);
  useEffect(() => () => { uploadId.current++; }, []);
  const colorNames = english ? ['Blue', 'Violet', 'Rose', 'Amber', 'Green', 'Slate'] : ['蓝色', '紫色', '粉色', '橙色', '绿色', '灰色'];

  async function upload(file?: File) {
    if (!file) return;
    const id = ++uploadId.current;
    setBusy(true);
    setError('');
    try {
      const avatar = await createProfileAvatar(file);
      if (id === uploadId.current) setDraft(current => ({ ...current, avatar }));
    } catch (cause) {
      if (id !== uploadId.current) return;
      const reason = cause instanceof Error ? cause.message : '';
      setError(reason === 'size' ? (english ? 'Choose an image smaller than 10 MB.' : '请选择小于 10 MB 的图片')
        : reason === 'format' ? (english ? 'Choose a PNG, JPG or WebP image.' : '请选择 PNG、JPG 或 WebP 图片')
        : (english ? 'Unable to read this image. Try another one.' : '无法读取这张图片，请换一张试试'));
    } finally { if (id === uploadId.current) setBusy(false); }
  }

  async function save() {
    setSaving(true);
    setError('');
    try { await onSave(draft); onClose(); }
    catch (cause) { setError(profileSaveError(cause, english)); }
    finally { setSaving(false); }
  }

  return <Modal isOpen onClose={onClose} isDismissable={!saving} isKeyboardDismissDisabled={saving} hideCloseButton={saving} placement="center" classNames={{ base: 'app-dialog profile-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }}>
    <ModalContent><form className="app-dialog-form" onSubmit={event => { event.preventDefault(); if (!busy && !saving) void save(); }}>
      <ModalHeader className="app-dialog-header"><h2>{english ? 'Your profile' : '个人资料'}</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        <div className="profile-avatar-editor">
          <button type="button" className="profile-avatar-upload" disabled={busy || saving} onClick={() => fileInput.current?.click()} aria-label={english ? 'Change avatar' : '更换头像'}>
            <ProfileAvatar profile={draft} large /><span className="profile-avatar-camera"><Camera size=".875rem" /></span>
          </button>
          <div className="profile-avatar-actions">
            <Button size="sm" variant="flat" isLoading={busy} isDisabled={saving} onPress={() => fileInput.current?.click()}>{english ? 'Upload photo' : '上传头像'}</Button>
            {draft.avatar && <Button size="sm" variant="light" isDisabled={busy || saving} onPress={() => setDraft(current => ({ ...current, avatar: '' }))}>{english ? 'Remove' : '移除'}</Button>}
          </div>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={english ? 'Avatar image' : '头像图片'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
        </div>
        {!draft.avatar && <div className="profile-colors" role="group" aria-label={english ? 'Avatar color' : '头像颜色'}>{PROFILE_COLORS.map((color, index) => <button type="button" key={color} className={`profile-color-option profile-color-${color}`} aria-label={colorNames[index]} title={colorNames[index]} aria-pressed={draft.color === color} disabled={saving} onClick={() => setDraft(current => ({ ...current, color }))}>{draft.color === color && <Check size=".875rem" />}</button>)}</div>}
        <Input autoFocus label={english ? 'Nickname' : '昵称'} labelPlacement="outside" placeholder={english ? 'Enter a nickname' : '输入昵称'} description={english ? 'Leave blank to hide your profile in the sidebar.' : '留空时隐藏侧栏头像与昵称'} value={draft.nickname} maxLength={32} isDisabled={saving} onValueChange={nickname => setDraft(current => ({ ...current, nickname }))} variant="bordered" />
        {error && <p className="profile-error" role="alert">{error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={saving} onPress={onClose}>{english ? 'Cancel' : '取消'}</Button><Button size="sm" type="submit" color="primary" isDisabled={busy} isLoading={saving}>{english ? 'Save' : '保存'}</Button></ModalFooter>
    </form></ModalContent>
  </Modal>;
}
