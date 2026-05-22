import { existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

async function runGit(args: string[], cwd?: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
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

export interface GitOpResult {
  ok: boolean
  error?: string
  data?: any
}

export async function cloneRepo(cloneUrl: string, targetPath: string): Promise<GitOpResult> {
  try {
    if (existsSync(targetPath)) return { ok: false, error: `target already exists: ${targetPath}` }
    await runGit(['clone', '--no-recurse-submodules', cloneUrl, targetPath], undefined, 600_000)
    const cfgPath = join(targetPath, '.git', 'config')
    if (existsSync(cfgPath)) {
      const raw = readFileSync(cfgPath, 'utf-8')
      const stripped = raw.replace(/https:\/\/[^@\s]+@github\.com/g, 'https://github.com')
      writeFileSync(cfgPath, stripped, 'utf-8')
    }
    return { ok: true, data: { path: targetPath } }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

export async function pullRepo(repoPath: string, branch: string, tokenizedUrl: string): Promise<GitOpResult> {
  try {
    if (await isDirty(repoPath)) return { ok: false, error: 'worktree is dirty; refusing to pull' }
    await runGit(['fetch', tokenizedUrl, branch], repoPath, 120_000)
    await runGit(['checkout', branch], repoPath, 60_000)
    await runGit(['merge', '--ff-only', 'FETCH_HEAD'], repoPath, 60_000)
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
