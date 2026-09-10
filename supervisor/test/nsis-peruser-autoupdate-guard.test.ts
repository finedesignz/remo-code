/**
 * Guard: silent auto-update is only safe on a PER-USER installer.
 *
 * Background (v0.8.3 RCA, then v0.13.0 / #326):
 *   `downloadAndInstall()` runs the bundled installer unattended. Under the old
 *   per-machine MSI that installer wrote to `Program Files` + HKLM, so Windows
 *   raised a UAC consent dialog with nobody at the keyboard. The update hung
 *   mid-flight and could leave the install corrupted — which is exactly why
 *   `auto_update` was defaulted to FALSE in v0.8.3.
 *
 *   v0.13.0 flips the default back ON. That is ONLY defensible because the bundle
 *   moved to an NSIS installer in `currentUser` mode, which writes solely to
 *   %LOCALAPPDATA% + HKCU and therefore cannot raise UAC. The default-ON and the
 *   per-user installer are a package deal: revert the installer shape to
 *   per-machine while leaving auto_update defaulting ON and the silent-UAC hang
 *   comes straight back, silently.
 *
 * This test welds the two together. If someone changes the bundle target back to
 * MSI, or flips NSIS `installMode` off `currentUser`, this fails and points them
 * at the auto_update default they must flip in the same commit.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC_TAURI = join(import.meta.dir, '..', 'tauri', 'src-tauri')

function tauriConf(): any {
  return JSON.parse(readFileSync(join(SRC_TAURI, 'tauri.conf.json'), 'utf-8'))
}

/** The Rust default lives in config_cmds.rs: `.unwrap_or(<bool>)`. */
function autoUpdateDefault(): boolean {
  const rs = readFileSync(join(SRC_TAURI, 'src', 'config_cmds.rs'), 'utf-8')
  const m = rs.match(/map\.get\("auto_update"\)[\s\S]*?unwrap_or\((true|false)\)/)
  if (!m) throw new Error('could not locate the auto_update default in config_cmds.rs')
  return m[1] === 'true'
}

describe('silent auto-update requires a UAC-free per-user installer', () => {
  test('auto_update defaults ON — so the installer MUST be per-user NSIS', () => {
    // If a future change defaults auto_update OFF again, the coupling below is moot
    // and this assertion is what tells you the rest of the test no longer applies.
    expect(autoUpdateDefault()).toBe(true)

    const conf = tauriConf()
    expect(conf.bundle.targets).toEqual(['nsis'])
    expect(conf.bundle.windows.nsis.installMode).toBe('currentUser')
  })

  test('the updater artifacts the auto-updater consumes are still produced', () => {
    // downloadAndInstall() needs latest.json + a signed bundle; without this the
    // default-ON updater is pointing at nothing.
    expect(tauriConf().bundle.createUpdaterArtifacts).toBe(true)
  })
})
