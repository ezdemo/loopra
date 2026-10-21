const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')

// Paths are arguments, never shell source. Stage and backup share the target's
// filesystem so each rename is atomic. Do not replace a running app bundle.
const INSTALL_SCRIPT = String.raw`#!/bin/sh
set -eu
stage="$1"
target="$2"
parent_pid="$3"
relaunch="$4"
result="$5"
source="$stage/Loopra.app"
backup="$stage/previous.app"
finish() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ]; then
    printf '%s\n' "macOS 更新安装失败，请重试或从发布页下载。安装日志：$stage/install.log" > "$result"
    if [ -d "$backup" ]; then
      if [ -e "$target" ]; then /bin/mv "$target" "$stage/failed.app" || exit 1; fi
      /bin/mv "$backup" "$target" || exit 1
      if [ "$relaunch" = 1 ]; then /usr/bin/open -n "$target" || true; fi
    fi
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
attempts=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempts=$((attempts + 1))
  [ "$attempts" -le 120 ] || exit 1
  /bin/sleep 1
done
[ -d "$source/Contents" ] && [ -d "$target/Contents" ]
/bin/mv "$target" "$backup"
/bin/mv "$source" "$target"
if [ "$relaunch" = 1 ]; then /usr/bin/open -n "$target"; fi
/bin/rm -f "$result"
trap - EXIT HUP INT TERM
/bin/rm -rf "$stage"
`

function selectMacZip(files, arch = process.arch) {
  const name = `Loopra-macos-${arch}.zip`
  const file = files.find(item => item.info.url === name && item.url.pathname.endsWith(`/${name}`))
  if (!file) throw new Error(`更新包不支持当前 Mac 架构（${arch}），请从发布页下载适用版本。`)
  if (!/^[A-Za-z0-9+/]{86}==$/.test(file.info.sha512 || '') ||
      !Number.isSafeInteger(file.info.size) || file.info.size <= 0) {
    throw new Error('macOS 更新包缺少有效的 SHA-512 校验值或文件大小')
  }
  return file
}

function validateArchiveEntries(list) {
  const entries = list.trim().split(/\r?\n/)
  if (!entries.length || !entries.some(name => name.startsWith('Loopra.app/Contents/'))) throw new Error('更新 ZIP 中缺少 Loopra.app')
  for (const name of entries) {
    if (!/^(?:Loopra\.app|__MACOSX)(?:\/|$)/.test(name) || name.includes('\\') ||
        name.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f]/.test(name)) {
      throw new Error('macOS 更新 ZIP 包含无效路径')
    }
  }
}

class MacAppInstaller {
  constructor({ execPath = process.execPath, userDataPath, run = promisify(execFile), spawnProcess = spawn } = {}) {
    this.execPath = execPath
    this.userDataPath = userDataPath
    this.run = run
    this.spawnProcess = spawnProcess
    this.ready = null
    this.started = false
    this.starting = null
    this.resultFile = path.join(userDataPath, 'desktop-mac-install-error.txt')
  }

  get installationError() {
    try { return fs.readFileSync(this.resultFile, 'utf8').trim() } catch { return '' }
  }

  async prepare(zip, version) {
    const target = path.resolve(this.execPath, '../../..')
    if (!target.endsWith('.app') || target.includes(`${path.sep}AppTranslocation${path.sep}`) ||
        target.startsWith('/Volumes/') || fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('请先将 Loopra.app 移到可写的应用程序目录，再重试自动更新。')
    }
    const parent = path.dirname(target)
    try { await fs.promises.access(parent, fs.constants.W_OK) }
    catch { throw new Error('应用所在目录不可写，请将 Loopra.app 移到可写的应用程序目录后重试。') }
    if (this.started || this.starting) throw new Error('正在安装 macOS 更新')
    if (this.ready) {
      await fs.promises.rm(this.ready.stage, { recursive: true, force: true })
      this.ready = null
    }
    const stage = await fs.promises.mkdtemp(path.join(parent, '.Loopra-update-'))
    try {
      const listing = await this.run('/usr/bin/unzip', ['-Z1', zip], { maxBuffer: 32 * 1024 * 1024 })
      validateArchiveEntries(listing.stdout)
      await this.run('/usr/bin/ditto', ['-x', '-k', zip, stage])
      const bundle = path.join(stage, 'Loopra.app')
      if ((await fs.promises.lstat(bundle)).isSymbolicLink()) throw new Error('更新应用不能是符号链接')
      const plist = path.join(bundle, 'Contents', 'Info.plist')
      const readPlist = async key => (await this.run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
      if (await readPlist('CFBundleIdentifier') !== 'com.loopra.desktop' ||
          await readPlist('CFBundleShortVersionString') !== version) throw new Error('更新应用的标识或版本与清单不符')
      const executable = await readPlist('CFBundleExecutable')
      if (!executable || executable === '.' || executable === '..' || path.basename(executable) !== executable ||
          /[\\\x00-\x1f]/.test(executable)) throw new Error('更新应用的可执行文件无效')
      await fs.promises.access(path.join(bundle, 'Contents', 'MacOS', executable), fs.constants.X_OK)
      const script = path.join(stage, 'install.sh')
      await fs.promises.writeFile(script, INSTALL_SCRIPT, { mode: 0o700 })
      this.ready = { stage, target, script }
    } catch (error) {
      await fs.promises.rm(stage, { recursive: true, force: true })
      throw error
    }
  }

  start(relaunch) {
    if (this.starting) return this.starting
    if (this.started) return Promise.resolve()
    if (!this.ready) return Promise.reject(new Error('macOS 更新尚未准备完成'))
    const { stage, target, script } = this.ready
    // The normal-quit hook cannot await filesystem work: spawn synchronously
    // before Electron exits, then await the spawn event for explicit restarts.
    this.starting = new Promise((resolve, reject) => {
      let log
      try {
        fs.accessSync(path.dirname(target), fs.constants.W_OK)
        fs.mkdirSync(this.userDataPath, { recursive: true })
        log = fs.openSync(path.join(stage, 'install.log'), 'a', 0o600)
        const child = this.spawnProcess('/bin/sh', [script, stage, target, String(process.pid), relaunch ? '1' : '0', this.resultFile], {
          detached: true, stdio: ['ignore', log, log], cwd: '/',
        })
        child.once('error', reject)
        child.once('spawn', () => { this.started = true; child.unref(); resolve() })
      } catch (error) { reject(error) }
      finally { if (log !== undefined) fs.closeSync(log) }
    }).finally(() => { this.starting = null })
    return this.starting
  }
}

// Reuse electron-updater's providers, proxy-aware HTTP executor, progress,
// cancellation, SHA-512 verification and cache. Only Mac installation differs.
function createUnsignedMacUpdater({ AppUpdater }, { adapter, installer, arch = process.arch } = {}) {
  class UnsignedMacUpdater extends AppUpdater {
    constructor() {
      super(undefined, adapter)
      this.installer = installer || new MacAppInstaller({ userDataPath: this.app.userDataPath })
      this.installationError = this.installer.installationError
      this.quitHandlerAdded = false
    }

    doDownloadUpdate(downloadUpdateOptions) {
      const { provider, info } = downloadUpdateOptions.updateInfoAndProvider
      const fileInfo = selectMacZip(provider.resolveFiles(info), arch)
      return this.executeDownload({
        fileExtension: 'zip', fileInfo, downloadUpdateOptions,
        task: (file, options) => this.httpExecutor.download(fileInfo.url, file, options),
        done: async event => {
          if (downloadUpdateOptions.cancellationToken?.cancelled) throw new Error('更新下载已取消')
          this.emit('update-verifying')
          await this.installer.prepare(event.downloadedFile, event.version)
          this.dispatchUpdateDownloaded(event)
          if (!this.quitHandlerAdded) {
            this.quitHandlerAdded = true
            this.app.onQuit(code => {
              if (code === 0 && this.autoInstallOnAppQuit && !this.installer.started) {
                void this.installer.start(false).catch(error => this.dispatchError(error))
              }
            })
          }
        },
      })
    }

    async quitAndInstall(_silent, relaunch = true) {
      await this.installer.start(relaunch)
      this.app.quit()
    }
  }
  return new UnsignedMacUpdater()
}

module.exports = { createUnsignedMacUpdater, MacAppInstaller, selectMacZip, validateArchiveEntries, INSTALL_SCRIPT }
