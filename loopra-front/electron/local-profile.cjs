const fs = require('fs')
const path = require('path')

function normalizeProfile(value) {
  const profile = value && typeof value === 'object' ? value : {}
  return {
    nickname: typeof profile.nickname === 'string' ? Array.from(profile.nickname.trim()).slice(0, 32).join('') : '',
    avatar: typeof profile.avatar === 'string' && profile.avatar.length <= 400000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(profile.avatar) ? profile.avatar : '',
    color: ['blue', 'violet', 'rose', 'amber', 'green', 'slate'].includes(profile.color) ? profile.color : 'blue'
  }
}

function registerLocalProfileIpc(ipcMain, app, isAllowed) {
  const file = () => path.join(app.getPath('userData'), 'local-profile.json')
  ipcMain.handle('local-profile-get', event => {
    if (!isAllowed(event)) throw new Error('未授权的个人资料请求')
    try { return normalizeProfile(JSON.parse(fs.readFileSync(file(), 'utf8'))) }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  })
  ipcMain.handle('local-profile-set', (event, value) => {
    if (!isAllowed(event)) throw new Error('未授权的个人资料请求')
    const profile = normalizeProfile(value)
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(profile), 'utf8')
    fs.renameSync(`${file()}.tmp`, file())
    return profile
  })
}

module.exports = { normalizeProfile, registerLocalProfileIpc }
