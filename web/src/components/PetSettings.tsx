import { useState } from 'react';
import { Button, Switch } from '@nextui-org/react';
import { ArrowUpRight, Check, ImageOff, PawPrint, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { PetStore } from '../usePets';
import { petScale } from '../pets';
import { PageActions, SettingRow } from './SettingControls';
import { ConfirmAction } from './RemoteControls';
import PetSprite from './PetSprite';

export default function PetSettings({ pets, enabled, onEnabled, notify, onInitPet, standalone = false, onResetPosition }: {
  pets: PetStore; enabled: boolean; standalone?: boolean; onEnabled: (enabled: boolean) => void | Promise<void>;
  onResetPosition?: () => void | Promise<void>; notify: (message: string) => void; onInitPet?: () => void;
}) {
  const [removing, setRemoving] = useState<string>();
  const [saving, setSaving] = useState(false);
  const available = pets.pets.filter(pet => pet.hasSpritesheet);
  const active = pets.active;
  const busy = pets.loading || saving;
  const scale = active ? petScale(active) : 0.55;
  const sizes = [{ value: 0.4, name: '小' }, { value: 0.55, name: '中' }, { value: 0.75, name: '大' }];
  async function save(task: () => void | Promise<void>) {
    setSaving(true);
    try { await task(); }
    catch (error) { notify(error instanceof Error ? error.message : '保存宠物设置失败'); }
    finally { setSaving(false); }
  }
  async function toggle(value: boolean) {
    await save(async () => {
      if (value && !active && available.length) await pets.select(available[0].name);
      await onEnabled(value);
    });
  }
  return <div className="pet-settings-page" aria-busy={busy}>
    <PageActions title="宠物">
      <Button size="sm" variant="light" isLoading={pets.loading} isDisabled={saving} startContent={!pets.loading && <RefreshCw size={14} />} onPress={() => void pets.refresh()}>刷新宠物列表</Button>
      {onInitPet && <Button size="sm" color="primary" isDisabled={busy} startContent={<Plus size={15} />} onPress={onInitPet}>添加宠物</Button>}
    </PageActions>
    <p className="section-note pet-page-description">选一位工作伙伴，让它陪你聊天、写代码。</p>
    {pets.error && <div className="pet-settings-error" role="alert"><span>{pets.error}</span><button type="button" disabled={busy} onClick={() => void pets.refresh()}>重新加载</button></div>}

    <section className="pet-overview" aria-label="当前宠物" data-setting-title="显示宠物" tabIndex={-1}>
      <div className={`pet-overview-stage ${active ? '' : 'is-empty'}`}>
        {active ? <PetSprite lazy src={pets.imageUrl} name={active.displayName || active.name} scale={0.85} /> : <PawPrint size={48} strokeWidth={1.3} />}
        <span className="pet-stage-ground" />
      </div>
      <div className="pet-overview-details">
        <div className="pet-overview-heading"><span>当前伙伴</span><Switch aria-label="显示宠物" size="sm" isSelected={enabled} isDisabled={busy || (!active && !available.length)} onValueChange={value => void toggle(value)} /></div>
        <h3>{active ? active.displayName || active.name : pets.loading ? '正在加载宠物…' : '还没有选择宠物'}</h3>
        <p>{active?.description || (active ? (standalone ? '在桌面上单独陪伴你，可以拖到屏幕任意位置。' : '在欢迎页和聊天输入框旁陪伴你。') : available.length ? '从下方画廊选择一位伙伴，随时可以更换。' : '添加一位喜欢的伙伴，从这里开始。')}</p>
        <span className={`pet-visibility-status ${enabled && active ? 'is-visible' : ''}`} role="status"><i />{active ? enabled ? (standalone ? '已显示 · 在桌面窗口中' : '已显示 · 正在陪伴你') : '已隐藏 · 开启后显示' : '等待选择'}</span>
      </div>
    </section>

    <section className="pet-display-settings" aria-label="显示设置">
      <h3 className="settings-section-title">显示设置</h3>
      <div className="settings-card">
        <SettingRow title="宠物大小" description={standalone ? '调整桌面窗口里的显示尺寸' : '调整聊天区里的显示尺寸'}>
          <div className="pet-size-control"><div className="pet-size-options" role="radiogroup" aria-label="宠物大小">{sizes.map(size => <button key={size.value} type="button" role="radio" aria-checked={scale === size.value} disabled={!active || busy} onClick={() => void save(() => pets.resize(size.value))}>{size.name}</button>)}</div>
            {active && !sizes.some(size => size.value === scale) && <span className="pet-custom-size">自定义 {Math.round(scale / 0.55 * 100)}%</span>}</div>
        </SettingRow>
        <SettingRow title="宠物位置" description={standalone ? '拖动桌面上的宠物即可移动，也可以回到屏幕右下角' : '拖动宠物即可移动，也可以恢复默认位置'}><Button size="sm" variant="light" isDisabled={!active || busy} startContent={<RotateCcw size={14} />} onPress={() => void save(async () => { await pets.move({ x: 0, y: 0 }); await onResetPosition?.(); })}>重置宠物位置</Button></SettingRow>
      </div>
      <p className="pet-interaction-hint">{standalone ? '单独显示在桌面上。' : ''}点击互动 · 双击跳跃 · 拖动移动 · 右键或长按调整</p>
    </section>

    <section className="pet-library" aria-label="宠物画廊">
      <div className="pet-library-heading"><h3>我的宠物 <span>{pets.pets.length}</span></h3><a href="https://petdex.dev/" target="_blank" rel="noreferrer">浏览宠物图鉴<ArrowUpRight size={14} /></a></div>
      {pets.pets.length ? <div className="pet-gallery">{pets.pets.map(pet => {
        const selected = active?.name === pet.name;
        const title = pet.displayName || pet.name;
        return <article key={pet.name} className={`pet-card ${selected ? 'is-active' : ''} ${pet.hasSpritesheet ? '' : 'is-empty'}`}>
          <button type="button" className="pet-card-main" aria-label={`选择 ${title}`} aria-pressed={selected} disabled={!pet.hasSpritesheet || busy} onClick={() => { if (!selected) void save(() => pets.select(pet.name)); }}>
            <span className="pet-card-preview">{pet.hasSpritesheet ? <PetSprite lazy src={pets.imageUrlFor(pet.name)} name={title} scale={0.45} /> : <ImageOff size={28} strokeWidth={1.3} />}</span>
            <strong>{title}</strong><small>{pet.description || (pet.hasSpritesheet ? '等你一起开始工作' : '图片资源缺失，暂时无法使用')}</small>
          </button>
          <div className="pet-card-footer"><span className={selected ? 'pet-selected-label' : ''}>{selected ? <><Check size={12} />当前使用</> : pet.hasSpritesheet ? '点击选择' : '暂不可用'}</span><Button isIconOnly size="sm" variant="light" aria-label={`删除宠物：${title}`} isDisabled={busy} onPress={() => setRemoving(pet.name)}><Trash2 size={14} /></Button></div>
        </article>;
      })}</div> : <div className="pet-library-empty"><PawPrint size={28} strokeWidth={1.5} /><h4>{pets.loading ? '正在加载宠物…' : pets.error ? '暂时无法读取宠物' : '你的宠物画廊还是空的'}</h4><p>{pets.loading ? '稍等片刻，伙伴马上就来。' : pets.error ? '重新加载后再试试。' : '添加宠物后，会在这里展示和管理。'}</p></div>}
    </section>
  {removing && <ConfirmAction title="删除宠物" onClose={() => setRemoving(undefined)} action={() => pets.remove(removing)} onDone={() => notify(`已删除宠物 ${removing}`)}><p>删除宠物 {removing} 的整个目录？此操作不可恢复。</p></ConfirmAction>}
  </div>;
}
