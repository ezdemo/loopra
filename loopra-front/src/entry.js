import {usesLegacyRenderer} from './entry-routing'

if (usesLegacyRenderer(window.location.search, !!window.electronAPI)) {
  document.getElementById('root').id = 'app'
  const page = new URLSearchParams(window.location.search)
  document.documentElement.dataset.theme = page.get('theme') === 'dark' ? 'dark' : 'light'
  if (page.get('desktopPet') === '1') {
    document.documentElement.classList.add('desktop-pet-window')
    document.body.style.background = 'transparent'
  }
  if (page.get('desktopChatTab') === '1') {
    document.documentElement.classList.add('desktop-chat-tab-window')
  }
  void import('./main.js')
} else {
  void import('../web/src/main.tsx')
}
