// Keep the existing Electron renderers and auxiliary windows on their Vue entry.
export function usesLegacyRenderer(search, desktop = false) {
  const page = new URLSearchParams(search)
  return desktop || [
    'desktopShell', 'desktopSplash', 'desktopUpdate', 'desktopOnboarding',
    'desktopChatTab', 'desktopSearch', 'desktopMessage', 'desktopPopup',
    'desktopPet', 'requirementBoard', 'aiBrowser', 'elementInspector'
  ].some(key => page.get(key) === '1')
}
