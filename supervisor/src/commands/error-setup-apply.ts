/**
 * error_setup_apply — write SDK install files into a repo, commit, push.
 *
 * RPC contract:
 *   args: [JSON.stringify({ writes: [{path, content}], commit_message: string, branch?: string })]
 *
 * Steps:
 *   1. Validate repo path exists + is a git repo.
 *   2. Write each file (overwrite/create — no merge). Create parent dirs.
 *   3. git add -A
 *   4. git -c user.name='remo-code-bot' -c user.email='bot@remo-code.com'
 *        commit -m "<commit_message>"
 *      → if nothing to commit, reply ok with { nothing_to_commit: true }.
 *   5. git push origin <branch || current>
 *      → push_denied on 403/auth failure.
 *
 * Reply shape (delivered by the dispatcher):
 *   success → { exit_code: 0, snippet: JSON.stringify({ commit_sha, branch, pushed: true }) }
 *   no-op   → { exit_code: 0, snippet: JSON.stringify({ nothing_to_commit: true }) }
 *   fail    → { exit_code: 1, error: 'repo_not_found' | 'invalid_payload'
 *                                     | 'write_failed' | 'commit_failed' | 'push_denied' }
 */
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname, isAbsolute } from 'path'

export interface ApplyPayload {
  writes: Array<{ path: string; content: string }>
  commit_message: string
  branch?: string
  repo_path?: string // optional override; normally supervisor passes via args[0] form
}

export interface ApplyResult {
  ok: boolean
  commit_sha?: string
  branch?: string
  pushed?: boolean
  nothing_to_commit?: boolean
  error?: string
}

async function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { try { proc.kill() } catch {}; reject(new Error('git_timeout')) }, timeoutMs)
  })
  try {
    const code = await Promise.race([proc.exited, timeout])
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { code: code as number, stdout, stderr }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ApplyOptions {
  /** Optional override for git push behavior (used by tests to skip push). */
  skipPush?: boolean
}

export async function runErrorSetupApply(args: string[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  // Two arg shapes supported:
  //   [jsonBlob]                       — payload includes repo_path
  //   [repoPath, jsonBlob]             — repo path explicit
  let repoPath: string | undefined
  let payload: ApplyPayload
  try {
    if (args.length === 1) {
      payload = JSON.parse(args[0]) as ApplyPayload
      repoPath = payload.repo_path
    } else if (args.length >= 2) {
      repoPath = args[0]
      payload = JSON.parse(args[1]) as ApplyPayload
    } else {
      return { ok: false, error: 'invalid_payload' }
    }
  } catch {
    return { ok: false, error: 'invalid_payload' }
  }

  if (!repoPath || !isAbsolute(repoPath) || !existsSync(repoPath)) {
    return { ok: false, error: 'repo_not_found' }
  }
  try {
    if (!statSync(repoPath).isDirectory()) return { ok: false, error: 'repo_not_found' }
  } catch { return { ok: false, error: 'repo_not_found' } }
  if (!existsSync(join(repoPath, '.git'))) {
    return { ok: false, error: 'repo_not_found' }
  }
  if (!Array.isArray(payload.writes) || payload.writes.length === 0) {
    return { ok: false, error: 'invalid_payload' }
  }
  if (typeof payload.commit_message !== 'string' || !payload.commit_message.trim()) {
    return { ok: false, error: 'invalid_payload' }
  }

  // 1. Write files
  for (const w of payload.writes) {
    if (!w || typeof w.path !== 'string' || typeof w.content !== 'string') {
      return { ok: false, error: 'invalid_payload' }
    }
    if (w.path.includes('..') || isAbsolute(w.path)) {
      return { ok: false, error: 'invalid_payload' }
    }
    const abs = join(repoPath, w.path)
    try {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, w.content, 'utf-8')
    } catch {
      return { ok: false, error: 'write_failed' }
    }
  }

  // 2. git add
  const add = await git(['add', '-A'], repoPath)
  if (add.code !== 0) return { ok: false, error: 'commit_failed' }

  // 3. git commit (capture nothing-to-commit case)
  const commit = await git(
    [
      '-c', 'user.name=remo-code-bot',
      '-c', 'user.email=bot@remo-code.com',
      'commit', '-m', payload.commit_message,
    ],
    repoPath,
  )
  if (commit.code !== 0) {
    const combined = (commit.stdout + '\n' + commit.stderr).toLowerCase()
    if (combined.includes('nothing to commit') || combined.includes('no changes added')) {
      return { ok: true, nothing_to_commit: true }
    }
    return { ok: false, error: 'commit_failed' }
  }

  // 4. Resolve branch
  let branch = payload.branch
  if (!branch) {
    const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, 10_000)
    branch = cur.stdout.trim() || 'main'
  }

  // 5. Capture sha
  const sha = await git(['rev-parse', 'HEAD'], repoPath, 10_000)
  const commit_sha = sha.stdout.trim()

  // 6. Push (test escape hatch via skipPush)
  if (opts.skipPush) {
    return { ok: true, commit_sha, branch, pushed: false }
  }
  const push = await git(['push', 'origin', branch], repoPath, 120_000)
  if (push.code !== 0) {
    const combined = (push.stdout + '\n' + push.stderr).toLowerCase()
    if (combined.includes('403') || combined.includes('denied') || combined.includes('permission') || combined.includes('authentication')) {
      return { ok: false, error: 'push_denied' }
    }
    return { ok: false, error: 'push_denied' }
  }

  return { ok: true, commit_sha, branch, pushed: true }
}
