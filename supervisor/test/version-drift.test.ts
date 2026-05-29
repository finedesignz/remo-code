/**
 * Drift guard (RCA 2026-05-28) — fail the build if the supervisor's reported
 * version can silently diverge from the version that ships in the MSI.
 *
 * Background:
 *   The version reported to the hub in `supervisor.hello` used to be a
 *   hand-maintained `const VERSION = '0.5.8'` in hub-client.ts/index.ts. It
 *   drifted from the real installed version (tauri.conf.json / Cargo.toml were
 *   at 0.6.3), so the web UI showed 0.5.8 forever — a user restart did NOT fix
 *   it because the compiled sidecar genuinely emitted the stale string.
 *
 * The single source of truth at build time is tauri.conf.json's `version`,
 * injected into the compiled sidecar via Bun's --define (see
 * .github/workflows/release-supervisor.yml). The runtime fallback lives in
 * supervisor/src/version.ts as FALLBACK_VERSION for dev/uncompiled runs.
 *
 * This test asserts:
 *   1. FALLBACK_VERSION === tauri.conf.json.version
 *   2. Cargo.toml [package] version === tauri.conf.json.version
 *   3. ui/package.json version === tauri.conf.json.version
 * so the fallback and all three lockstep manifests can never silently drift.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { FALLBACK_VERSION } from '../src/version'

const TAURI_DIR = join(import.meta.dir, '..', 'tauri', 'src-tauri')

function tauriConfVersion(): string {
  const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf-8'))
  return conf.version
}

function cargoTomlVersion(): string {
  const toml = readFileSync(join(TAURI_DIR, 'Cargo.toml'), 'utf-8')
  // First `version = "x.y.z"` under [package].
  const m = toml.match(/^\s*version\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error('could not find version in Cargo.toml')
  return m[1]
}

function uiPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'tauri', 'ui', 'package.json'), 'utf-8'),
  )
  return pkg.version
}

describe('supervisor version single-source drift guard', () => {
  test('FALLBACK_VERSION matches tauri.conf.json version', () => {
    expect(FALLBACK_VERSION).toBe(tauriConfVersion())
  })

  test('Cargo.toml version matches tauri.conf.json version', () => {
    expect(cargoTomlVersion()).toBe(tauriConfVersion())
  })

  test('ui/package.json version matches tauri.conf.json version', () => {
    expect(uiPackageVersion()).toBe(tauriConfVersion())
  })
})
