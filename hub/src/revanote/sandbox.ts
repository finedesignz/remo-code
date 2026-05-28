/**
 * Sandboxed worktree for revanote agent runs (Phase 5).
 *
 * `prepareSandbox` clones or worktree-adds the target repo into an ephemeral
 * directory under the OS temp tree and writes a deny-list marker that the
 * agent run wrapper consumes to enforce file + env exclusions.
 *
 * Cross-side contract: revanote ships `repo_slug` + `repo_kind` on dispatch.
 * `github` repos are shallow-cloned via the existing GitHub App installation
 * token (auth/github-app.ts). `local_path` repos worktree-add from an
 * already-mounted host path (the user accepts the host-disk caveat — see
 * `.planning/phases/revanote-secure-dispatch/00-plan.md`).
 *
 * Secret exclusion (enforced by the run wrapper consuming the deny marker):
 *   • Refuse reads matching `.env*`, `secrets/**`, `.git/config`, `.aws/**`,
 *     `.ssh/**`, `credentials*`.
 *   • Forward only PATH/HOME/USER/TMP/TMPDIR/LANG/LC_* env vars to the agent
 *     process; everything else is dropped.
 *
 * If the existing run-lifecycle.ts spawns the agent through a different path
 * (currently it ships prompts over the WS channel to a long-lived Claude
 * session, not a new spawn) — this module still emits the deny marker so any
 * future spawned wrapper can read it, and exposes `getSandboxEnv()` for
 * callers that DO spawn child processes (diff-sandbox + tests).
 */
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { mintTokenizedCloneUrl } from '../auth/github-app.ts'

export type RepoKind = 'github' | 'local_path'

export interface SandboxHandle {
  sandboxDir: string
  repoSlug: string
  repoKind: RepoKind
  batchId: string
  cleanup: () => Promise<void>
}

export interface PrepareSandboxOpts {
  repoSlug: string
  repoKind: RepoKind
  batchId: string
  /** Override for local_path host root. Defaults to env REVANOTE_LOCAL_REPOS_ROOT. */
  localRepoRoot?: string
  /** Override for GitHub App installation lookup (used in tests). */
  installationId?: number
  /** Override for git binary (tests). */
  gitBin?: string
}

const SANDBOX_ROOT_NAME = 'revanote-sandbox'

const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'USERNAME', 'USERPROFILE',
  'TMP', 'TMPDIR', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  // git needs these
  'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM',
  // node/bun
  'NODE_PATH',
])

/**
 * Glob-ish patterns the run wrapper enforces. Plain strings — converted to
 * RegExp by `pathBlocked()`.
 */
export const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env$/,
  /(^|\/)secrets\//,
  /(^|\/)\.git\/config$/,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)credentials($|\.|_)/i,
] as const

export function pathBlocked(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/')
  return SECRET_PATH_PATTERNS.some((rx) => rx.test(p))
}

/**
 * Build the env object a spawned agent should run with. Drops anything not
 * in the allow-list. Caller is responsible for adding sandbox-specific
 * vars (e.g. cwd, run-id) on top.
 */
export function getSandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(base)) {
    if (ALLOWED_ENV_KEYS.has(key)) out[key] = base[key]
    else if (key.startsWith('LC_')) out[key] = base[key]
  }
  // Always disable git's interactive prompts in sandbox.
  out.GIT_TERMINAL_PROMPT = '0'
  out.GIT_CONFIG_NOSYSTEM = '1'
  return out
}

function runGit(
  gitBin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = getSandboxEnv(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function parseRepoSlug(slug: string): { owner: string; repo: string } | null {
  const m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(slug.trim())
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

async function writeDenyMarker(sandboxDir: string, opts: PrepareSandboxOpts): Promise<void> {
  const marker = {
    version: 1,
    purpose: 'revanote-secure-dispatch Phase 5 sandbox marker',
    repo_slug: opts.repoSlug,
    repo_kind: opts.repoKind,
    batch_id: opts.batchId,
    deny_path_patterns: SECRET_PATH_PATTERNS.map((rx) => rx.source),
    allowed_env_keys: Array.from(ALLOWED_ENV_KEYS),
    created_at: new Date().toISOString(),
  }
  await writeFile(
    join(sandboxDir, '.claude-sandbox-deny'),
    JSON.stringify(marker, null, 2),
    'utf-8',
  )
}

/**
 * Prepare an ephemeral sandbox directory for the given repo.
 *
 * Returns a handle with `cleanup` that recursively removes the sandbox.
 * Callers MUST `cleanup()` in a finally block — leaving thousands of
 * shallow clones around on a hub host will fill disk.
 */
export async function prepareSandbox(opts: PrepareSandboxOpts): Promise<SandboxHandle> {
  const { repoSlug, repoKind, batchId } = opts
  if (!repoSlug) throw new Error('repoSlug required')
  if (!batchId) throw new Error('batchId required')
  if (repoKind !== 'github' && repoKind !== 'local_path') {
    throw new Error(`unsupported repoKind: ${repoKind}`)
  }

  const gitBin = opts.gitBin ?? 'git'
  const root = join(tmpdir(), SANDBOX_ROOT_NAME)
  await mkdir(root, { recursive: true })
  const sandboxDir = await mkdtemp(join(root, `${batchId.slice(0, 8)}-`))

  try {
    if (repoKind === 'github') {
      const parsed = parseRepoSlug(repoSlug)
      if (!parsed) throw new Error(`invalid github repo_slug: ${repoSlug}`)
      const installationId = opts.installationId
      if (!installationId) {
        throw new Error('github installation id required for repo_kind=github')
      }
      const cloneUrl = await mintTokenizedCloneUrl(installationId, parsed.owner, parsed.repo)
      const target = join(sandboxDir, 'repo')
      const result = await runGit(
        gitBin,
        ['clone', '--depth', '1', '--no-tags', '--single-branch', cloneUrl, target],
        sandboxDir,
      )
      if (result.code !== 0) {
        // Redact token from any error surface.
        const safeErr = result.stderr.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
        throw new Error(`git clone failed (code ${result.code}): ${safeErr.slice(0, 400)}`)
      }
      // Strip the tokenized remote so subsequent git ops can't exfil the token.
      await runGit(gitBin, ['-C', target, 'remote', 'set-url', 'origin',
        `https://github.com/${parsed.owner}/${parsed.repo}.git`], sandboxDir)
    } else {
      // local_path: worktree-add from the user's already-mounted root.
      const root = opts.localRepoRoot ?? process.env.REVANOTE_LOCAL_REPOS_ROOT
      if (!root) {
        throw new Error('REVANOTE_LOCAL_REPOS_ROOT not set for repo_kind=local_path')
      }
      const sourceRepo = resolve(root, repoSlug)
      const target = join(sandboxDir, 'repo')
      // Use a unique branch name so concurrent batches don't collide.
      const branch = `revanote/sandbox/${batchId.slice(0, 12)}`
      const result = await runGit(
        gitBin,
        ['-C', sourceRepo, 'worktree', 'add', '-b', branch, target],
        sandboxDir,
      )
      if (result.code !== 0) {
        throw new Error(`git worktree add failed (code ${result.code}): ${result.stderr.slice(0, 400)}`)
      }
    }

    await writeDenyMarker(sandboxDir, opts)

    const cleanup = async (): Promise<void> => {
      try {
        if (repoKind === 'local_path') {
          // best-effort detach: prune any worktree pointer in the source repo.
          const root = opts.localRepoRoot ?? process.env.REVANOTE_LOCAL_REPOS_ROOT
          if (root) {
            const sourceRepo = resolve(root, repoSlug)
            await runGit(gitBin, ['-C', sourceRepo, 'worktree', 'remove', '--force', join(sandboxDir, 'repo')], sandboxDir).catch(() => {})
          }
        }
        await rm(sandboxDir, { recursive: true, force: true })
      } catch (err: any) {
        console.warn(`[revanote.sandbox] cleanup failed dir=${sandboxDir}: ${err?.message ?? err}`)
      }
    }

    return { sandboxDir, repoSlug, repoKind, batchId, cleanup }
  } catch (err) {
    // Cleanup partial state on error.
    await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

// Test-only exports.
export const _internals = {
  parseRepoSlug,
  writeDenyMarker,
  runGit,
  ALLOWED_ENV_KEYS,
}
