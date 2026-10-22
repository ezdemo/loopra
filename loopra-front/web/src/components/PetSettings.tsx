import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { PetStore } from '../usePets';
import { petScale } from '../pets';
import { SelectField, SettingRow, SettingSwitch } from './SettingControls';
import { ConfirmAction } from './RemoteControls';
import PetSprite from './PetSprite';

export default function PetSettings({ pets, enabled, onEnabled, notify, onInitPet }: {
  pets: PetStore; enabled: boolean; onEnabled: (enabled: boolean) => void | Promise<void>; notify: (message: string) => void; onInitPet?: () => void;
}) {
  const [removing, setRemoving] = useState<string>();
  const available = pets.pets.filter(pet => pet.hasSpritesheet);
  const active = pets.active;
  async function toggle(value: boolean) {
    try {
      if (value && !active && available.length) await pets.select(available[0].name);
      await onEnabled(value);
    } catch (error) { notify(error instanceof Error ? error.message : '保存宠物设置失败'); }
  }
  function save(task: Promise<void>) { void task.catch(error => notify(error instanceof Error ? error.message : '保存宠物设置失败')); }
  return <><h3 className="settings-section-title">宠物</h3><div className="settings-card">
    <SettingRow title="宠物" description="在欢迎页和聊天输入框旁显示宠物"><SettingSwitch label="宠物" value={enabled} onChange={value => void toggle(value)} /></SettingRow>
    <div className="settings-pet-body" aria-busy={pets.loading}>
      {active && <div className="settings-pet-current"><PetSprite lazy src={pets.imageUrl} name={active.displayName || active.name} scale={0.65} /><div><strong>{active.displayName || active.name}</strong><p>{enabled ? '已开启 · 陪你一起工作' : '已关闭 · 开启后显示'}</p></div></div>}
      {available.length > 0 && <SelectField compact label="选择宠物" value={active?.name || ''} options={available.map(pet => ({ value: pet.name, label: pet.displayName || pet.name }))} onChange={name => save(pets.select(name))} />}
      {active && <SelectField compact label="宠物大小" value={String(petScale(active))} options={[{ value: '0.4', label: '小' }, { value: '0.55', label: '中' }, { value: '0.75', label: '大' }, ...(![0.4, 0.55, 0.75].includes(petScale(active)) ? [{ value: String(petScale(active)), label: '自定义' }] : [])]} onChange={scale => save(pets.resize(Number(scale)))} />}
      {active && <Button size="sm" variant="light" onPress={() => save(pets.move({ x: 0, y: 0 }))}>重置宠物位置</Button>}
      <div className="pet-gallery" aria-label="宠物画廊">
        {pets.pets.map(pet => <div key={pet.name} className={`pet-card ${active?.name === pet.name ? 'is-active' : ''} ${pet.hasSpritesheet ? '' : 'is-empty'}`}>
          <button type="button" className="pet-card-main" title={`选择 ${pet.displayName || pet.name}`} aria-pressed={active?.name === pet.name} onClick={() => save(pets.select(pet.name))}>
            {pet.hasSpritesheet ? <PetSprite lazy src={pets.imageUrlFor(pet.name)} name={pet.displayName || pet.name} scale={0.3} /> : <span className="pet-card-empty">无精灵图</span>}
            <strong>{pet.displayName || pet.name}</strong>
            {pet.description && <small>{pet.description}</small>}
          </button>
          <Button isIconOnly size="sm" variant="light" aria-label={`删除宠物：${pet.displayName || pet.name}`} isDisabled={pets.loading} onPress={() => setRemoving(pet.name)}>×</Button>
        </div>)}
      </div>
      <div className="workbench-actions"><Button className="settings-outlined-action" size="sm" variant="light" isLoading={pets.loading} onPress={() => void pets.refresh()}>刷新宠物列表</Button>{onInitPet && <Button size="sm" variant="light" onPress={onInitPet}>初始化宠物</Button>}<Button size="sm" variant="light" onPress={() => window.open('https://petdex.dev/', '_blank', 'noreferrer')}>去网站看看</Button></div>
      {pets.error ? <p role="alert" className="settings-error">{pets.error}</p> : !active && <p role="status" className="form-hint">{pets.loading ? '正在加载宠物…' : available.length ? '请选择一个宠物' : '服务端还没有可用宠物。安装后点击重新加载。'}</p>}
      {active && <p className="form-hint pet-interaction-hint">点击宠物互动，双击跳跃；拖动可移动，右键或长按可调整大小和关闭。</p>}
    </div>
  </div>
  {removing && <ConfirmAction title="删除宠物" onClose={() => setRemoving(undefined)} action={() => pets.remove(removing)} onDone={() => notify(`已删除宠物 ${removing}`)}><p>删除宠物 {removing} 的整个目录？此操作不可恢复。</p></ConfirmAction>}
  </>;
}
