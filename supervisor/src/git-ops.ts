import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = 60_000,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { proc.kill() } catch {}
      reject(new Error(`git timed out: ${args.join(' ')}`))
    }, timeoutMs)
  })
  try {
    const code = await Promise.race([proc.exited, timeout])
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (code !== 0) throw new Error(stderr.trim() || `git exited ${code}`)
    return { stdout, stderr, code: code as number }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function isDirty(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['status', '--porcelain'], repoPath, 10_000)
    return stdout.trim().length > 0
  } catch { return false }
}

export async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, 10_000)
    return stdout.trim() || null
  } catch { return null }
}

export async function listBranches(repoPath: string): Promise<{ branches: string[]; current: string | null }> {
  const current = await currentBranch(repoPath)
  try {
    const { stdout } = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath, 10_000)
    const local = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    let remote: string[] = []
    try {
      const { stdout: r } = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repoPath, 10_000)
      remote = r.split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.endsWith('/HEAD'))
        .map((s) => s.replace(/^[^/]+\//, ''))
    } catch {}
    const merged = Array.from(new Set([...local, ...remote])).sort((a, b) => {
      if (a === current) return -1
      if (b === current) return 1
      if (a === 'main' || a === 'master') return -1
      if (b === 'main' || b === 'master') return 1
      return a.localeCompare(b)
    })
    return { branches: merged, current }
  } catch {
    return { branches: current ? [current] : [], current }
  }
}

export interface GitOpResult {
  ok: boolean
  error?: string
  data?: any
}

/**
 * Split `https://<token>@host/path` into `{ url: https://host/path, token }`
 * so the token never lands in argv. Caller passes the token via GIT_ASKPASS
 * env. When the URL has no embedded token we pass it through unchanged.
 *
 * Why: process command lines are world-readable on Windows for other users
 * on the box (wmic / Process Explorer / WMI). Argv-borne tokens leak.
 */
export function splitTokenFromUrl(url: string): { url: string; token: string | null } {
  const m = url.match(/^(https?:\/\/)([^@/\s]+)@(.+)$/)
  if (!m) return { url, token: null }
  const userinfo = decodeURIComponent(m[2]!)
  // userinfo can be `user:token` or just `token` (GitHub PAT-only). We hand
  // back the credential bytes verbatim; askpass returns them as the password
  // and git asks for username separately (we just echo the same string to
  // satisfy the username prompt — GitHub treats the PAT-as-username flow OK
  // when paired with x-access-token as password, but the simple safe path
  // here is to honor `token` as password regardless of user portion).
  const colonIdx = userinfo.indexOf(':')
  const token = colonIdx >= 0 ? userinfo.slice(colonIdx + 1) : userinfo
  return { url: `${m[1]}${m[3]}`, token }
}

/**
 * Run `op(cleanUrl, env)` with a temp GIT_ASKPASS script that echoes the
 * token to stdin. Cleans up the temp dir afterward. When `tokenizedUrl` has
 * no embedded token, the env is left untouched and the URL is passed through.
 */
async function withAskpass<T>(
  tokenizedUrl: string,
  op: (cleanUrl: string, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const { url: cleanUrl, token } = splitTokenFromUrl(tokenizedUrl)
  if (!token) return op(cleanUrl, {})

  const dir = mkdtempSync(join(tmpdir(), 'remo-askpass-'))
  const isWin = process.platform === 'win32'
  const script = isWin
    ? join(dir, 'askpass.cmd')
    : join(dir, 'askpass.sh')
  // The askpass shim is invoked once per credential prompt. It must print
  // the secret on stdout and exit. We do NOT echo the token directly in the
  // script body — instead we read it from REMO_GIT_TOKEN in env. Other local
  // users CAN read env of a process they don't own only via debugging
  // privileges on Windows; argv is readable without privileges. This is a
  // strict improvement.
  if (isWin) {
    // CMD batch: `@echo off` suppresses command echo. `%REMO_GIT_TOKEN%` is
    // expanded by cmd at invocation time, not written to a file.
    writeFileSync(script, '@echo off\r\necho %REMO_GIT_TOKEN%\r\n', 'utf-8')
  } else {
    writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$REMO_GIT_TOKEN"\n', 'utf-8')
    try { chmodSync(script, 0o700) } catch {}
  }
  try {
    return await op(cleanUrl, {
      GIT_ASKPASS: script,
      GCM_INTERACTIVE: 'never',      // disable Git Credential Manager popups
      GIT_TERMINAL_PROMPT: '0',       // never prompt on tty
      REMO_GIT_TOKEN: token,
    })
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

export async function cloneRepo(cloneUrl: string, targetPath: string): Promise<GitOpResult> {
  try {
    if (existsSync(targetPath)) return { ok: false, error: `target already exists: ${targetPath}` }
    await withAskpass(cloneUrl, (url, env) =>
      runGit(['clone', '--no-recurse-submodules', url, targetPath], undefined, 600_000, env),
    )
    // Belt-and-braces: even though we no longer write the token into the
    // remote URL (askpass path), older clones may have legacy tokenized
    // remotes on disk. Sweep `.git/config` to be safe.
    const cfgPath = join(targetPath, '.git', 'config')
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, 'utf-8')
      const stripped = raw.replace(/https:\/\/[^@\s]+@github\.com/g, 'https://github.com')
      if (stripped !== raw) writeFileSync(cfgPath, stripped, 'utf-8')
    }
    return { ok: true, data: { path: targetPath } }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

export async function pullRepo(repoPath: string, branch: string, tokenizedUrl: string): Promise<GitOpResult> {
  try {
    if (await isDirty(repoPath)) return { ok: false, error: 'worktree is dirty; refusing to pull' }
    await withAskpass(tokenizedUrl, (url, env) =>
      runGit(['fetch', url, branch], repoPath, 120_000, env),
    )
    await runGit(['checkout', branch], repoPath, 60_000)
    await runGit(['merge', '--ff-only', 'FETCH_HEAD'], repoPath, 60_000)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

// Pull an already-configured local repo against its existing remote (no token needed).
// Optionally checks out a branch first. Refuses if the worktree is dirty.
export async function pullLocal(repoPath: string, branch?: string): Promise<GitOpResult> {
  try {
    if (await isDirty(repoPath)) return { ok: false, error: 'worktree is dirty; refusing to pull' }
    if (branch) {
      try { await runGit(['checkout', branch], repoPath, 30_000) } catch (err: any) {
        return { ok: false, error: `checkout failed: ${err.message}` }
      }
    }
    await runGit(['pull', '--ff-only'], repoPath, 120_000)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

export async function checkoutBranch(repoPath: string, branch: string, create: boolean): Promise<GitOpResult> {
  try {
    if (await isDirty(repoPath)) return { ok: false, error: 'worktree is dirty; refusing to switch branches' }
    if (create) await runGit(['checkout', '-b', branch], repoPath, 30_000)
    else await runGit(['checkout', branch], repoPath, 30_000)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}
