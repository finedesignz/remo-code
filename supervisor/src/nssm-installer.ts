import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'

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

export async function ensureNssm(): Promise<boolean> {
  if (existsSync(NSSM_PATH)) return true
  mkdirSync(NSSM_DIR, { recursive: true })
  mkdirSync(LOG_DIR, { recursive: true })
  console.log(`[install] NSSM not found at ${NSSM_PATH}`)
  console.log(`[install] Please download NSSM from ${NSSM_DOWNLOAD}, extract nssm.exe (win64 version), and place it at ${NSSM_PATH}`)
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
