/**
 * work_diff_scope / work_build / work_publish — supervisor-native commands for the
 * milestone-WORK "agent proposes, hub disposes" pipeline.
 *
 * The hub container has no checkout of the client repo; the repo lives on the
 * SUPERVISOR host. These three allowlisted `run_command` handlers are how the HUB
 * (not the agent) observes and acts on the work branch:
 *
 *   work_push_branch args: [projectDir, branch]
 *       → { head_sha }
 *     Option (a): the AGENT commits locally on `work/<nonce>` and has NO push credential.
 *     The hub commands THIS to push that local branch to origin. Least authority — the
 *     agent can write files + commit; nothing leaves the box without the hub saying so.
 *
 *   work_diff_scope args: [projectDir, branch, defaultBranch]
 *       → { files: [...], head_sha, base_sha }
 *     Pure READ (`git diff --name-only <base>...<branch>`). The hub compares `files`
 *     against `work_sites.site_dir` — THIS is what makes site_dir a real boundary
 *     instead of a prompt request.
 *
 *   work_build args: [projectDir, branch, cmd]
 *       → { exit_code, output }  (output tail-capped)
 *     Runs the OPERATOR-configured `work_sites.build_cmd` on a detached checkout of
 *     the branch. `cmd` comes from the operator's DB row via the hub — NEVER from the
 *     agent and never from the email.
 *
 *   work_publish args: [projectDir, branch, defaultBranch, verifiedSha, cmd?]
 *       → { merged_sha }
 *     Fast-forward-only merge of the EXACT `verifiedSha` (the SHA the hub's QC verified)
 *     into the default branch + push, then the optional operator `publish_cmd`. BEFORE
 *     merging it asserts `git rev-parse origin/<branch>` still equals `verifiedSha`; if the
 *     tip MOVED after QC it ABORTS with `branch_moved_after_qc` and deploys nothing (TOCTOU
 *     guard). The hub calls this ONLY after site.auto_publish + hub diff-scope + hub build +
 *     hub HTTPS probe, and it merges `verifiedSha` itself — never a re-fetched `origin/<branch>`.
 *
 * HARD INVARIANTS:
 *   - The agent never invokes these (they are hub→supervisor RPCs, not CLI tools).
 *   - `branch` is validated against a strict `work/<id>` shape; `projectDir` must be an
 *     existing git repo. Shell metacharacters in a branch name are therefore impossible.
 *   - Every spawn env goes through the shared `sanitizeSpawnEnv` WITH deploy-credential
 *     scrubbing off ONLY for `work_publish` (which legitimately needs the deploy
 *     credential the operator put on the supervisor host, if any). `work_build` gets a
 *     deploy-credential-free env: a build must never be able to deploy.
 */
import { existsSync } from 'fs'
import { resolve } from 'path'
import { sanitizeSpawnEnv } from '../runners/env-sanitize'
import type { CommandResult } from './index'

/** Tail cap on captured build/publish output. */
export const MAX_OUTPUT_BYTES = 16_000

/** Work branches are hub-generated: `work/<uuid-ish>`. Nothing else is accepted. */
export const WORK_BRANCH_RE = /^work\/[A-Za-z0-9._-]{1,64}$/
const REF_RE = /^[A-Za-z0-9._\/-]{1,100}$/

function tail(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? s.slice(-MAX_OUTPUT_BYTES) : s
}

function badRepo(projectDir: string): string | null {
  if (!projectDir || !existsSync(resolve(projectDir, '.git'))) return 'invalid_project_dir'
  return null
}

async function git(
  projectDir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['git', ...args], {
    cwd: projectDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { code, out: `${out}${err}` }
}

const SHA_RE = /^[0-9a-f]{7,40}$/i

/** Push the agent's LOCAL `work/<id>` branch to origin. Returns the pushed head SHA. */
export async function runWorkPushBranch(args: string[]): Promise<CommandResult> {
  const [projectDir, branch] = args
  const bad = badRepo(projectDir)
  if (bad) return { exit_code: 1, error: bad }
  if (!WORK_BRANCH_RE.test(branch ?? '')) return { exit_code: 1, error: 'invalid_branch' }

  // The supervisor's OWN env — it keeps its git-push credential (the agent's does not).
  const env = { ...process.env }

  const local = await git(projectDir, ['rev-parse', '--verify', `refs/heads/${branch}`], env)
  if (local.code !== 0) return { exit_code: 1, error: 'branch_not_committed_locally' }

  const pushed = await git(projectDir, ['push', '--force-with-lease', 'origin', `${branch}:${branch}`], env)
  if (pushed.code !== 0) return { exit_code: 1, error: `git_push_failed: ${tail(pushed.out)}` }

  return { exit_code: 0, snippet: JSON.stringify({ head_sha: local.out.trim() }) }
}

/** READ-ONLY. The file list of `branch` relative to `defaultBranch`, plus the head SHA. */
export async function runWorkDiffScope(args: string[]): Promise<CommandResult> {
  const [projectDir, branch, defaultBranch = 'main'] = args
  const bad = badRepo(projectDir)
  if (bad) return { exit_code: 1, error: bad }
  if (!WORK_BRANCH_RE.test(branch ?? '')) return { exit_code: 1, error: 'invalid_branch' }
  if (!REF_RE.test(defaultBranch)) return { exit_code: 1, error: 'invalid_default_branch' }

  const env = sanitizeSpawnEnv({ ...process.env })
  const fetched = await git(projectDir, ['fetch', 'origin', '--quiet'], env)
  if (fetched.code !== 0) return { exit_code: 1, error: `git_fetch_failed: ${tail(fetched.out)}` }

  const base = `origin/${defaultBranch}`
  const head = `origin/${branch}`
  const sha = await git(projectDir, ['rev-parse', head], env)
  if (sha.code !== 0) return { exit_code: 1, error: 'branch_not_pushed' }

  const diff = await git(projectDir, ['diff', '--name-only', `${base}...${head}`], env)
  if (diff.code !== 0) return { exit_code: 1, error: `git_diff_failed: ${tail(diff.out)}` }

  const files = diff.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const baseSha = await git(projectDir, ['rev-parse', base], env)

  return {
    exit_code: 0,
    snippet: JSON.stringify({
      files,
      head_sha: sha.out.trim(),
      base_sha: baseSha.out.trim(),
    }),
  }
}

/**
 * Run the OPERATOR-configured build command against the work branch, in a detached
 * checkout, with deploy credentials scrubbed from the env (a build must never deploy).
 */
export async function runWorkBuild(args: string[]): Promise<CommandResult> {
  const [projectDir, branch, cmd] = args
  const bad = badRepo(projectDir)
  if (bad) return { exit_code: 1, error: bad }
  if (!WORK_BRANCH_RE.test(branch ?? '')) return { exit_code: 1, error: 'invalid_branch' }
  if (!cmd || !cmd.trim()) return { exit_code: 1, error: 'no_build_cmd' }

  const env = sanitizeSpawnEnv({ ...process.env }, { scrubDeployCredentials: true })

  const fetched = await git(projectDir, ['fetch', 'origin', '--quiet'], env)
  if (fetched.code !== 0) return { exit_code: 1, error: `git_fetch_failed: ${tail(fetched.out)}` }
  // Detached checkout of the branch tip: never moves the working checkout's branch.
  const co = await git(projectDir, ['checkout', '--detach', `origin/${branch}`], env)
  if (co.code !== 0) return { exit_code: 1, error: `git_checkout_failed: ${tail(co.out)}` }

  const p = Bun.spawn(['bash', '-lc', cmd], {
    cwd: projectDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return {
    exit_code: 0, // the RPC succeeded; the BUILD's exit code is in the payload
    snippet: JSON.stringify({ build_exit_code: code, output: tail(`${out}${err}`) }),
  }
}

/**
 * HUB-ONLY publish: fast-forward-only merge of the work branch into the default branch,
 * push, then the operator's optional `publish_cmd`. `--ff-only` means a work branch that
 * has diverged (someone else pushed) cannot silently rewrite the default branch — it
 * fails and the hub reports `needs_human`.
 */
export async function runWorkPublish(args: string[]): Promise<CommandResult> {
  const [projectDir, branch, defaultBranch = 'main', verifiedSha, cmd] = args
  const bad = badRepo(projectDir)
  if (bad) return { exit_code: 1, error: bad }
  if (!WORK_BRANCH_RE.test(branch ?? '')) return { exit_code: 1, error: 'invalid_branch' }
  if (!REF_RE.test(defaultBranch)) return { exit_code: 1, error: 'invalid_default_branch' }
  if (!SHA_RE.test(verifiedSha ?? '')) return { exit_code: 1, error: 'invalid_verified_sha' }

  const env = { ...process.env } // supervisor's own env — it holds the push credential

  const fetched = await git(projectDir, ['fetch', 'origin', '--quiet'], env)
  if (fetched.code !== 0) return { exit_code: 1, error: `git_fetch_failed: ${tail(fetched.out)}` }

  // TOCTOU GUARD: the hub verified `verifiedSha`. If origin/<branch> has moved since QC
  // (a new commit was pushed), ABORT — we will NOT ship an unverified SHA.
  const tip = await git(projectDir, ['rev-parse', `origin/${branch}`], env)
  if (tip.code !== 0) return { exit_code: 1, error: 'branch_not_pushed' }
  if (tip.out.trim() !== (verifiedSha ?? '').trim()) {
    return {
      exit_code: 1,
      error: `branch_moved_after_qc: verified ${verifiedSha} but origin/${branch} is ${tip.out.trim()}`,
    }
  }

  // Merge the EXACT verified SHA — never `origin/<branch>` (which we just proved equal, but
  // pinning the SHA makes the deployed commit unambiguous and immune to a concurrent fetch).
  const steps: Array<string[]> = [
    ['checkout', defaultBranch],
    ['pull', '--ff-only', 'origin', defaultBranch],
    ['merge', '--ff-only', verifiedSha],
    ['push', 'origin', defaultBranch],
  ]
  for (const s of steps) {
    const r = await git(projectDir, s, env)
    if (r.code !== 0) return { exit_code: 1, error: `git_${s[0]}_failed: ${tail(r.out)}` }
  }
  const sha = await git(projectDir, ['rev-parse', 'HEAD'], env)

  let publishOut = ''
  let publishCode = 0
  if (cmd && cmd.trim()) {
    const p = Bun.spawn(['bash', '-lc', cmd], {
      cwd: projectDir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    publishCode = await p.exited
    publishOut = tail(`${out}${err}`)
  }

  return {
    exit_code: 0,
    snippet: JSON.stringify({
      merged_sha: sha.out.trim(),
      publish_exit_code: publishCode,
      publish_output: publishOut,
    }),
  }
}
