import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import type { CapabilitiesTab } from '../capabilities-navigation';
import type { PluginContext } from './PluginFrame';
import SkillsPage from './SkillsPage';
import { ExtensionManager } from './ResourceManagers';

export default function SkillsAndPluginsPage({ api, tab, onTabChange, onRefresh, onPluginsChanged, onBack, context }: {
  api: LoopraClient;
  tab: CapabilitiesTab;
  onTabChange: (tab: CapabilitiesTab) => void;
  onRefresh: () => Promise<void>;
  onPluginsChanged: () => void;
  onBack: () => void;
  context?: PluginContext;
}) {
  return <section className="skills-hub capabilities-hub" aria-label="技能与插件">
    <div className="skills-hub-inner">
      <header className="skills-hub-heading"><h1>技能与插件</h1><div className="skills-hub-actions"><Button size="sm" variant="light" onPress={onBack}>返回会话</Button></div></header>
      <nav className="skills-hub-tabs capabilities-hub-tabs" aria-label="技能与插件分类">
        {([['skills', '技能'], ['plugins', '插件']] as const).map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => onTabChange(id)}>{label}</button>)}
      </nav>
      {tab === 'skills' ? <SkillsPage api={api} onRefresh={onRefresh} onBack={onBack} embedded /> : <ExtensionManager api={api} context={context} onChanged={onPluginsChanged} embedded />}
    </div>
  </section>;
}
