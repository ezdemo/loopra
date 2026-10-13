// Electron-only auxiliary windows still have no React implementation, so they
// always stay on their Vue entry.
const ELECTRON_AUXILIARY = [
  'desktopSplash', 'desktopUpdate', 'desktopOnboarding', 'desktopChatTab',
  'desktopSearch', 'desktopMessage', 'desktopPopup', 'desktopPet',
  'requirementBoard', 'aiBrowser', 'elementInspector'
]

// Keep the existing Electron renderers and auxiliary windows on their Vue entry.
export function usesLegacyRenderer(search, desktop = false) {
  const page = new URLSearchParams(search)
  const auxiliary = ELECTRON_AUXILIARY.some(key => page.get(key) === '1')
  // Opt-in escape hatch: `?react=1` loads the React renderer in the Electron
  // main window (React draws its own frameless chrome via DesktopTitleBar);
  // auxiliary windows are not affected. Default desktop behaviour stays on Vue.
  if (!auxiliary && page.get('react') === '1') return false
  return desktop || auxiliary || page.get('desktopShell') === '1'
}
