export type CapabilitiesTab = 'skills' | 'plugins' | 'connectors';

export function capabilitiesTabForSection(section: string): CapabilitiesTab | undefined {
  if (section === '技能与插件') return 'plugins';
  if (section === '技能') return 'skills';
  if (section === '插件' || section === '拓展包' || section === 'OpenAPI') return 'plugins';
  if (section === '连接器' || section === 'MCP') return 'connectors';
  return undefined;
}
