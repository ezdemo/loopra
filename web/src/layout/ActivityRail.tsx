import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { Bot, CalendarClock, CircleHelp, MoreHorizontal, Search, Settings, Sparkles } from 'lucide-react';
import { ProfileAvatar } from '../components/LocalProfile';
import { PluginGlyph, type PluginIconRef } from '../components/plugin-icons';
import { IconButton, LoopraMark } from '../components/ui';
import type { LoopraClient } from '../backend';
import type { LocalProfile } from '../local-profile';

type ActivityRailProps = {
  home: boolean; utilityOpen: boolean; skillsOpen: boolean; settingsOpen: boolean; profile: LocalProfile; api: LoopraClient;
  plugins: { id: string; title: string; icon?: PluginIconRef }[];
  onHome: () => void; onSearch: () => void; onSkills: () => void; onSchedules: () => void; onBots: () => void;
  onPlugin: (id: string) => void; onHelp: () => void; onSettings: () => void; onProfile: () => void;
};

export default function ActivityRail(p: ActivityRailProps) {
  const { t } = useTranslation();
  const more = t('nav.moreTools');
  const tools = [
    { id: 'schedules', title: t('nav.scheduledTasks'), icon: <CalendarClock size="1rem" />, action: p.onSchedules },
    { id: 'bots', title: 'Bot', icon: <Bot size="1rem" />, action: p.onBots },
    ...p.plugins.map(item => ({ id: `plugin:${item.id}`, title: item.title, icon: item.icon ? <PluginGlyph api={p.api} pluginId={item.id} icon={item.icon} size="1rem" /> : <span aria-hidden="true">{[...item.title.trim()][0] || '?'}</span>, action: () => p.onPlugin(item.id) })),
  ];
  return <nav className="activity-rail" aria-label={t('nav.workbench')}>
    <div className="activity-group">
      <IconButton label={t('nav.home')} active={p.home} onClick={p.onHome}><LoopraMark small /></IconButton>
      <IconButton label={t('nav.search')} onClick={p.onSearch}><Search size="1rem" /></IconButton>
      <Dropdown placement="right-start">
        <DropdownTrigger><Button isIconOnly variant="light" className={`icon-button${p.utilityOpen ? ' active' : ''}`} aria-label={more} title={more}><MoreHorizontal size="1rem" /></Button></DropdownTrigger>
        <DropdownMenu aria-label={more} items={tools} onAction={key => tools.find(item => item.id === key)?.action()}>
          {item => <DropdownItem key={item.id} textValue={item.title} startContent={item.icon}>{item.title}</DropdownItem>}
        </DropdownMenu>
      </Dropdown>
    </div>
    <div className="activity-group">
      <IconButton label={t('nav.help')} onClick={p.onHelp}><CircleHelp size="1rem" /></IconButton>
      <IconButton label={t('nav.skillsPlugins')} active={p.skillsOpen} onClick={p.onSkills}><Sparkles size="1rem" /></IconButton>
      <IconButton label={t('nav.settings')} active={p.settingsOpen} onClick={p.onSettings}><Settings size="1rem" /></IconButton>
      <IconButton label={p.profile.nickname || t('nav.profile')} onClick={p.onProfile}><ProfileAvatar profile={p.profile} /></IconButton>
    </div>
  </nav>;
}
