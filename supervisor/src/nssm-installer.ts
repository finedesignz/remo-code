import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, platform, arch } from 'os'

export const NSSM_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'remo-code')
export const LOG_DIR = join(NSSM_DIR, 'logs')
export const NSSM_PATH = join(NSSM_DIR, 'nssm.exe')
export const SERVICE_NAME = 'RemoCodeSupervisor'

const NSSM_DOWNLOAD = 'https://nssm.cc/release/nssm-2.24.zip'

async function nssm(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([NSSM_PATH, ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: code as number, stdout, stderr }
}

// Try common locations for a bundled unzip tool. Windows 10+ ships `tar.exe`
// which transparently handles .zip via libarchive — that's our preferred path.
async function unzipNssm(zipPath: string, destDir: string): Promise<boolean> {
  const tarPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  if (existsSync(tarPath)) {
    const proc = Bun.spawn([tarPath, '-xf', zipPath, '-C', destDir], { stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    const code = await proc.exited
    if (code === 0) return true
    const stderr = await new Response(proc.stderr).text()
    console.warn(`[install] tar -xf failed (code=${code}): ${stderr}`)
  }
  // PowerShell fallback (Expand-Archive). Slower, but available on all supported Windows.
  const psPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(psPath)) {
    const proc = Bun.spawn([psPath, '-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    const code = await proc.exited
    if (code === 0) return true
    const stderr = await new Response(proc.stderr).text()
    console.warn(`[install] Expand-Archive failed (code=${code}): ${stderr}`)
  }
  return false
}

async function findNssmExeIn(dir: string): Promise<string | null> {
  // NSSM 2.24 zip contains nssm-2.24/win64/nssm.exe and nssm-2.24/win32/nssm.exe.
  // Pick the arch-appropriate one.
  const want = (arch() === 'x64' || arch() === 'arm64') ? 'win64' : 'win32'
  // Walk one level — keeps this self-contained without pulling fs/promises readdir types.
  const { readdirSync, statSync } = await import('fs')
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const sub = join(dir, e.name, want, 'nssm.exe')
    if (existsSync(sub)) return sub
  }
  // Last-ditch: try either subdir.
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const variant of ['win64', 'win32']) {
      const sub = join(dir, e.name, variant, 'nssm.exe')
      if (existsSync(sub)) return sub
    }
  }
  return null
}

async function downloadNssm(): Promise<boolean> {
  try {
    console.log(`[install] downloading NSSM from ${NSSM_DOWNLOAD} ...`)
    const res = await fetch(NSSM_DOWNLOAD)
    if (!res.ok) {
      console.warn(`[install] NSSM download failed: HTTP ${res.status}`)
      return false
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = join(NSSM_DIR, 'nssm.zip')
    writeFileSync(zipPath, buf)
    const extractDir = join(NSSM_DIR, 'nssm-extract')
    mkdirSync(extractDir, { recursive: true })
    const ok = await unzipNssm(zipPath, extractDir)
    if (!ok) return false
    const found = await findNssmExeIn(extractDir)
    if (!found) {
      console.warn('[install] NSSM extracted but nssm.exe not found in expected layout')
      return false
    }
    // Move into place.
    const { copyFileSync, rmSync } = await import('fs')
    copyFileSync(found, NSSM_PATH)
    try { rmSync(extractDir, { recursive: true, force: true }) } catch {}
    try { rmSync(zipPath, { force: true }) } catch {}
    console.log(`[install] NSSM installed at ${NSSM_PATH}`)
    return true
  } catch (e: any) {
    console.warn(`[install] NSSM auto-install failed: ${e?.message || e}`)
    return false
  }
}

export async function ensureNssm(): Promise<boolean> {
  if (existsSync(NSSM_PATH)) return true
  mkdirSync(NSSM_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  // Auto-download attempt first — keeps `npx remo-code-supervisor install ...` truly one-shot.
  if (platform() === 'win32') {
    const ok = await downloadNssm()
    if (ok) return true
  }
  console.log(`[install] NSSM not found at ${NSSM_PATH}`)
  console.log(`[install] Auto-download failed. Please download NSSM from ${NSSM_DOWNLOAD}, extract nssm.exe (win64 version), and place it at ${NSSM_PATH}`)
  console.log(`[install] Then re-run: npx remo-code-supervisor install`)
  return false
}

function bunPath(): string {
  // Best-effort: resolve from Bun.argv0 or PATH
  return process.execPath
}

function entryScriptPath(): string {
  // For `npx remo-code-supervisor install`, the script we want the service to run is this same package's run command.
  // We resolve the supervisor's own bin script by walking up from process.argv[1].
  // Fallback: just shell out to `npx` style.
  return process.argv[1] || ''
}

export interface InstallOptions {
  apiKey: string
  hubUrl?: string
  roots: string[]
  serviceUser?: string
  servicePassword?: string
}

export async function installService(opts: InstallOptions): Promise<void> {
  if (platform() !== 'win32') {
    throw new Error('Service install currently supports Windows only. Use `remo-code-supervisor run` to run in foreground on other OSes.')
  }
  const ok = await ensureNssm()
  if (!ok) throw new Error('NSSM not installed')

  mkdirSync(LOG_DIR, { recursive: true })

  const bun = bunPath()
  const entry = entryScriptPath()

  // Remove existing service first (idempotent)
  await nssm(['stop', SERVICE_NAME]).catch(() => {})
  await nssm(['remove', SERVICE_NAME, 'confirm']).catch(() => {})

  let r = await nssm(['install', SERVICE_NAME, bun, entry, 'run'])
  if (r.code !== 0) throw new Error(`nssm install failed: ${r.stderr || r.stdout}`)

  await nssm(['set', SERVICE_NAME, 'DisplayName', 'Remo Code Supervisor'])
  await nssm(['set', SERVICE_NAME, 'Description', 'Remote-control supervisor for Claude Code sessions'])
  await nssm(['set', SERVICE_NAME, 'Start', 'SERVICE_AUTO_START'])
  await nssm(['set', SERVICE_NAME, 'AppStdout', join(LOG_DIR, 'stdout.log')])
  await nssm(['set', SERVICE_NAME, 'AppStderr', join(LOG_DIR, 'stderr.log')])
  await nssm(['set', SERVICE_NAME, 'AppRotateFiles', '1'])
  await nssm(['set', SERVICE_NAME, 'AppRotateBytes', '10485760'])

  if (opts.serviceUser && opts.servicePassword) {
    const r2 = await nssm(['set', SERVICE_NAME, 'ObjectName', opts.serviceUser, opts.servicePassword])
    if (r2.code !== 0) throw new Error(`nssm set ObjectName failed: ${r2.stderr || r2.stdout}`)
  }

  const r3 = await nssm(['start', SERVICE_NAME])
  if (r3.code !== 0) throw new Error(`nssm start failed: ${r3.stderr || r3.stdout}`)
  console.log(`[install] Service ${SERVICE_NAME} installed and started.`)
  console.log(`[install] Logs: ${LOG_DIR}`)
}

export async function uninstallService() {
  if (platform() !== 'win32') return
  if (!existsSync(NSSM_PATH)) {
    console.log('[uninstall] nssm not present; nothing to do')
    return
  }
  await nssm(['stop', SERVICE_NAME]).catch(() => {})
  await nssm(['remove', SERVICE_NAME, 'confirm']).catch(() => {})
  console.log(`[uninstall] Service ${SERVICE_NAME} removed.`)
}

export async function statusService(): Promise<string> {
  if (platform() !== 'win32') return 'not-windows'
  if (!existsSync(NSSM_PATH)) return 'nssm-missing'
  const r = await nssm(['status', SERVICE_NAME])
  return r.stdout.trim() || 'unknown'
}
