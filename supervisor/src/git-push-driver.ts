/**
 * Phase 08 §6 — git-push-driver: push a brand-new local folder to a freshly
 * created (empty) GitHub remote. The hub creates the empty remote and dispatches
 * `create_local_repo_and_push`; this driver does the local git work and emits
 * `repo_create_progress` stages in the EXACT order the hub's
 * applySupervisorProgress() maps:
 *
 *   init → commit → remote_add → pushing_locally → pushed → reindexing → done
 *
 * Path-sandbox enforcement (assertWithinRoots) happens in the hub-client caller
 * BEFORE this driver runs — by the time we're here the path is trusted.
 */

/** Result shape of a single git invocation. */
export interface GitRunResult { stdout: string; stderr: string; code: number }

/** Injectable git runner (real impl by default; stubbed in tests). Throws on
 *  non-zero exit (message = stderr) so the driver can catch + fail. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>

/** Stages this driver emits, in order. Mirrors RepoCreateProgress's enum. */
export type PushStage =
  | 'init'
  | 'commit'
  | 'remote_add'
  | 'pushing_locally'
  | 'pushed'
  | 'reindexing'
  | 'done'

export interface PushLocalRepoOpts {
  localPath: string
  remoteUrl: string
  onProgress: (stage: PushStage) => void
  /** Override for tests. Defaults to a real `git` spawn. */
  gitRun?: GitRunner
}

export interface PushLocalRepoResult {
  ok: boolean
  error?: string
  /** Stage at which a failure occurred (for the hub's failJob mapping). */
  failedStage?: PushStage
}

const defaultGitRun: GitRunner = async (args, cwd) => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited ${code}`)
  return { stdout, stderr, code }
}

/** Has this dir any commits yet? `git rev-parse --verify HEAD` exits non-zero
 *  on an empty repo. */
async function hasCommits(git: GitRunner, cwd: string): Promise<boolean> {
  try { await git(['rev-parse', '--verify', 'HEAD'], cwd); return true } catch { return false }
}

/** Is `origin` already configured? */
async function hasOrigin(git: GitRunner, cwd: string): Promise<boolean> {
  try { await git(['remote', 'get-url', 'origin'], cwd); return true } catch { return false }
}

/** Is there anything to commit (staged or unstaged)? */
async function hasChanges(git: GitRunner, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await git(['status', '--porcelain'], cwd)
    return stdout.trim().length > 0
  } catch { return false }
}

export async function pushLocalRepo(opts: PushLocalRepoOpts): Promise<PushLocalRepoResult> {
  const git = opts.gitRun ?? defaultGitRun
  const cwd = opts.localPath
  let stage: PushStage = 'init'
  try {
    // ── init ──────────────────────────────────────────────────────────────
    stage = 'init'
    opts.onProgress('init')
    const alreadyGit = await hasCommits(git, cwd).catch(() => false)
    // `git init` is idempotent — re-running on an existing repo is a no-op.
    await git(['init'], cwd)

    // ── commit ────────────────────────────────────────────────────────────
    stage = 'commit'
    opts.onProgress('commit')
    const committed = await hasCommits(git, cwd)
    if (!committed) {
      await git(['add', '-A'], cwd)
      // Empty-tree guard: if there's still nothing staged, make an empty
      // initial commit so `push` has a ref to send.
      const changes = await hasChanges(git, cwd)
      if (changes) {
        await git(['commit', '-m', 'Initial commit'], cwd)
      } else {
        await git(['commit', '--allow-empty', '-m', 'Initial commit'], cwd)
      }
    } else {
      // Repo already had commits — only commit if there are uncommitted changes.
      if (await hasChanges(git, cwd)) {
        await git(['add', '-A'], cwd)
        await git(['commit', '-m', 'Initial commit'], cwd)
      }
    }
    void alreadyGit // (informational only)

    // ── remote_add ──────────────────────────────────────────────────────────
    stage = 'remote_add'
    opts.onProgress('remote_add')
    if (await hasOrigin(git, cwd)) {
      await git(['remote', 'set-url', 'origin', opts.remoteUrl], cwd)
    } else {
      await git(['remote', 'add', 'origin', opts.remoteUrl], cwd)
    }

    // ── push ────────────────────────────────────────────────────────────────
    stage = 'pushing_locally'
    opts.onProgress('pushing_locally')
    await git(['push', '-u', 'origin', 'HEAD'], cwd)

    opts.onProgress('pushed')
    // ── post-push ─────────────────────────────────────────────────────────
    opts.onProgress('reindexing')
    opts.onProgress('done')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err), failedStage: stage }
  }
}
