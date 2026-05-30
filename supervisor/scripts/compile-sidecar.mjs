#!/usr/bin/env bun
/**
 * Compile the supervisor sidecar binary with the authoritative version injected.
 *
 * Single source of truth for the sidecar compile, shared by BOTH the local build
 * (supervisor/tauri/scripts/build-and-update.ps1) and CI
 * (.github/workflows/release-supervisor.yml), so the two can never drift.
 *
 * Reads the `version` from supervisor/tauri/src-tauri/tauri.conf.json and bakes it
 * into the compiled bundle via Bun's `--define process.env.REMO_SUPERVISOR_VERSION`.
 * That env var is what supervisor/src/version.ts reads at runtime to report the
 * version to the hub — so the reported version always matches the MSI/manifest.
 *
 * Paths are resolved relative to THIS script's location, not the cwd, so it works
 * regardless of where it's invoked from. The compile itself runs from `supervisor/`
 * (the parent of `src/` and `tauri/`), matching the CI command exactly.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url)) // supervisor/scripts
const supervisorDir = resolve(scriptDir, '..') // supervisor
const tauriConfPath = resolve(supervisorDir, 'tauri/src-tauri/tauri.conf.json')

const version = JSON.parse(readFileSync(tauriConfPath, 'utf8')).version
if (!version || typeof version !== 'string') {
  console.error(`[compile-sidecar] no version found in ${tauriConfPath}`)
  process.exit(1)
}

console.log(`[compile-sidecar] injecting REMO_SUPERVISOR_VERSION=${version}`)

// Mirror the CI command in release-supervisor.yml exactly (target + outfile verbatim).
const args = [
  'build',
  '--compile',
  '--target=bun-windows-x64',
  '--define',
  `process.env.REMO_SUPERVISOR_VERSION="${version}"`,
  './src/index.ts',
  '--outfile',
  './tauri/src-tauri/binaries/remo-code-supervisor-x86_64-pc-windows-msvc.exe',
]

const res = spawnSync('bun', args, {
  cwd: supervisorDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (res.error) {
  console.error(`[compile-sidecar] failed to spawn bun: ${res.error.message}`)
  process.exit(1)
}
if (res.status !== 0) {
  console.error(`[compile-sidecar] bun build --compile failed (exit ${res.status})`)
  process.exit(res.status ?? 1)
}

console.log(`[compile-sidecar] OK — compiled sidecar at version ${version}`)
