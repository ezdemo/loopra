export type CapabilitiesTab = 'all' | 'skills' | 'plugins';

export function capabilitiesTabForSection(section: string): CapabilitiesTab | undefined {
  if (section === '技能与插件') return 'all';
  if (section === '技能') return 'skills';
  if (section === '插件' || section === '拓展包' || section === 'OpenAPI') return 'plugins';
  return undefined;
}
