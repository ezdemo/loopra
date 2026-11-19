import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@nextui-org/react';
import { Bot, CalendarClock, CircleHelp, MoreHorizontal, Search, Settings, Sparkles } from 'lucide-react';
import { ProfileAvatar } from '../components/LocalProfile';
import { PluginGlyph, type PluginIconRef } from '../components/plugin-icons';
import { IconButton, LoopraMark } from '../components/ui';
import type { LoopraClient } from '../backend';
import type { LocalProfile } from '../local-profile';

type ActivityRailProps = {
  english: boolean; home: boolean; utilityOpen: boolean; skillsOpen: boolean; profile: LocalProfile; api: LoopraClient;
  plugins: { id: string; title: string; icon?: PluginIconRef }[];
  onHome: () => void; onSearch: () => void; onSkills: () => void; onSchedules: () => void; onBots: () => void;
  onPlugin: (id: string) => void; onHelp: () => void; onSettings: () => void; onProfile: () => void;
};

export default function ActivityRail(p: ActivityRailProps) {
  const { english } = p;
  const more = english ? 'More tools' : '更多工具';
  const tools = [
    { id: 'schedules', title: english ? 'Scheduled tasks' : '定时任务', icon: <CalendarClock size="1rem" />, action: p.onSchedules },
    { id: 'bots', title: 'Bot', icon: <Bot size="1rem" />, action: p.onBots },
    ...p.plugins.map(item => ({ id: `plugin:${item.id}`, title: item.title, icon: item.icon ? <PluginGlyph api={p.api} pluginId={item.id} icon={item.icon} size="1rem" /> : <span aria-hidden="true">{[...item.title.trim()][0] || '?'}</span>, action: () => p.onPlugin(item.id) })),
  ];
  return <nav className="activity-rail" aria-label={english ? 'Workbench' : '工作台'}>
    <div className="activity-group">
      <IconButton label={english ? 'Home' : '首页'} active={p.home} onClick={p.onHome}><LoopraMark small /></IconButton>
      <IconButton label={english ? 'Search' : '搜索'} onClick={p.onSearch}><Search size="1rem" /></IconButton>
      <Dropdown placement="right-start">
        <DropdownTrigger><Button isIconOnly variant="light" className={`icon-button${p.utilityOpen ? ' active' : ''}`} aria-label={more} title={more}><MoreHorizontal size="1rem" /></Button></DropdownTrigger>
        <DropdownMenu aria-label={more} items={tools} onAction={key => tools.find(item => item.id === key)?.action()}>
          {item => <DropdownItem key={item.id} textValue={item.title} startContent={item.icon}>{item.title}</DropdownItem>}
        </DropdownMenu>
      </Dropdown>
    </div>
    <div className="activity-group">
      <IconButton label={english ? 'Help' : '帮助'} onClick={p.onHelp}><CircleHelp size="1rem" /></IconButton>
      <IconButton label={english ? 'Skills & Plugins' : '技能与插件'} active={p.skillsOpen} onClick={p.onSkills}><Sparkles size="1rem" /></IconButton>
      <IconButton label={english ? 'Settings' : '设置'} onClick={p.onSettings}><Settings size="1rem" /></IconButton>
      <IconButton label={p.profile.nickname || (english ? 'Profile' : '个人资料')} onClick={p.onProfile}><ProfileAvatar profile={p.profile} /></IconButton>
    </div>
  </nav>;
}
