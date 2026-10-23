// Electron-only auxiliary windows still have no React implementation, so they
// always stay on their Vue entry.
const ELECTRON_AUXILIARY = [
  'desktopSplash', 'desktopUpdate', 'desktopOnboarding', 'desktopChatTab',
  'desktopSearch', 'desktopMessage', 'desktopPopup', 'desktopPet',
  'requirementBoard', 'elementInspector'
]

// The main workspace uses React in both the browser and Electron. Auxiliary
// windows retain their dedicated Vue implementations.
export function usesLegacyRenderer(search) {
  const page = new URLSearchParams(search)
  const auxiliary = ELECTRON_AUXILIARY.some(key => page.get(key) === '1')
  return auxiliary
}
