/* @vitest-environment jsdom */
import {describe, expect, it} from 'vitest'
import {
  UPDATE_SOURCE_MIRROR,
  UPDATE_SOURCE_NORMAL,
  buildUpdateCommand,
  buildUpdatePrompt,
  loadUpdateSource,
  saveUpdateSource,
  updateScriptName
} from './updateScripts'
import {MIRROR_SOURCES} from './mirrors'

const MIRROR_URL = MIRROR_SOURCES[0].value // e.g. https://gh-proxy.org/

describe('updateScriptName', () => {
  it('builds web scripts for the normal source', () => {
    expect(updateScriptName(UPDATE_SOURCE_NORMAL, false, 'ps1')).toBe('setup.ps1')
    expect(updateScriptName(UPDATE_SOURCE_NORMAL, false, 'sh')).toBe('setup.sh')
  })

  it('builds mirror scripts for the mirror source', () => {
    expect(updateScriptName(UPDATE_SOURCE_MIRROR, false, 'ps1')).toBe('setup-mirror.ps1')
    expect(updateScriptName(UPDATE_SOURCE_MIRROR, false, 'sh')).toBe('setup-mirror.sh')
  })

  it('builds gui scripts for the desktop runtime (Electron)', () => {
    expect(updateScriptName(UPDATE_SOURCE_NORMAL, true, 'ps1')).toBe('setup-gui.ps1')
    expect(updateScriptName(UPDATE_SOURCE_NORMAL, true, 'sh')).toBe('setup-gui.sh')
    expect(updateScriptName(UPDATE_SOURCE_MIRROR, true, 'ps1')).toBe('setup-gui-mirror.ps1')
    expect(updateScriptName(UPDATE_SOURCE_MIRROR, true, 'sh')).toBe('setup-gui-mirror.sh')
  })

  it('treats a concrete mirror URL as a mirror source', () => {
    expect(updateScriptName(MIRROR_URL, false, 'ps1')).toBe('setup.ps1')
    expect(updateScriptName(MIRROR_URL, true, 'sh')).toBe('setup-gui.sh')
  })
})

describe('buildUpdateCommand', () => {
  it('returns windows and unix commands with short labels', () => {
    const cmd = buildUpdateCommand(UPDATE_SOURCE_NORMAL, false)
    expect(cmd.windows).toBe('irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1 | iex')
    expect(cmd.windowsLabel).toBe('irm ...setup.ps1 | iex')
    expect(cmd.unix).toBe('curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.sh | bash')
    expect(cmd.unixLabel).toBe('curl ...setup.sh | bash')
  })

  it('switches to mirror scripts when the mirror source is selected', () => {
    const cmd = buildUpdateCommand(UPDATE_SOURCE_MIRROR, true)
    expect(cmd.windows).toContain('setup-gui-mirror.ps1')
    expect(cmd.windows).toContain('irm https://raw.githubusercontent.com/ezdemo/loopra-release/')
    expect(cmd.unix).toContain('setup-gui-mirror.sh')
  })

  it('injects the chosen mirror via LOOPRA_MIRROR when a concrete mirror URL is selected', () => {
    const cmd = buildUpdateCommand(MIRROR_URL, true)
    expect(cmd.windows).toBe(`$env:LOOPRA_MIRROR='${MIRROR_URL}'; irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui.ps1 | iex`)
    expect(cmd.unix).toBe(`export LOOPRA_MIRROR='${MIRROR_URL}'; curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui.sh | bash`)
  })

  it('uses the environment contract for every listed mirror', () => {
    for (const source of MIRROR_SOURCES) {
      for (const gui of [false, true]) {
        const direct = buildUpdateCommand(UPDATE_SOURCE_NORMAL, gui)
        const mirrored = buildUpdateCommand(source.value, gui)
        expect(mirrored.windows).toBe(`$env:LOOPRA_MIRROR='${source.value}'; ` + direct.windows)
        expect(mirrored.unix).toBe(`export LOOPRA_MIRROR='${source.value}'; ` + direct.unix)
      }
    }
  })

  it('does not inject LOOPRA_MIRROR for the direct or legacy mirror source', () => {
    expect(buildUpdateCommand(UPDATE_SOURCE_NORMAL, false).windows).not.toContain('LOOPRA_MIRROR')
    expect(buildUpdateCommand(UPDATE_SOURCE_MIRROR, false).windows).not.toContain('LOOPRA_MIRROR')
  })
})

describe('buildUpdatePrompt', () => {
  it('includes the electron gui script commands for the desktop runtime', () => {
    const prompt = buildUpdatePrompt(UPDATE_SOURCE_NORMAL, true)
    expect(prompt).toContain('setup-gui.ps1')
    expect(prompt).toContain('setup-gui.sh')
    expect(prompt).toContain('~/.loopra-gui')
  })

  it('switches to mirror scripts when the mirror source is selected', () => {
    const prompt = buildUpdatePrompt(UPDATE_SOURCE_MIRROR, true)
    expect(prompt).toContain('setup-gui-mirror.ps1')
    expect(prompt).toContain('setup-gui-mirror.sh')
  })

  it('uses plain setup scripts for the web runtime', () => {
    const prompt = buildUpdatePrompt(UPDATE_SOURCE_NORMAL, false)
    expect(prompt).toContain('setup.ps1')
    expect(prompt).not.toContain('~/.loopra-gui')
  })
})

describe('update source persistence', () => {
  it('defaults to the normal source', () => {
    localStorage.clear()
    expect(loadUpdateSource()).toBe(UPDATE_SOURCE_NORMAL)
  })

  it('persists the mirror source and restores it', () => {
    localStorage.clear()
    saveUpdateSource(UPDATE_SOURCE_MIRROR)
    expect(loadUpdateSource()).toBe(UPDATE_SOURCE_MIRROR)
  })

  it('resets to the normal source', () => {
    localStorage.clear()
    saveUpdateSource(UPDATE_SOURCE_MIRROR)
    saveUpdateSource(UPDATE_SOURCE_NORMAL)
    expect(loadUpdateSource()).toBe(UPDATE_SOURCE_NORMAL)
  })

  it('persists a concrete mirror URL and restores it', () => {
    localStorage.clear()
    saveUpdateSource(MIRROR_URL)
    expect(loadUpdateSource()).toBe(MIRROR_URL)
  })

  it('ignores unknown mirror values and keeps the normal source', () => {
    localStorage.clear()
    saveUpdateSource('https://not-in-list.example/')
    expect(loadUpdateSource()).toBe(UPDATE_SOURCE_NORMAL)
  })
})
