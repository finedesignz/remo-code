/**
 * HUB-OBSERVED QC for a work branch (milestone WORK). THE HUB RUNS QC ITSELF.
 *
 * The agent's self-report is advisory metadata. Everything that gates a publish is a
 * fact the HUB established:
 *
 *   1. DIFF SCOPE  — `work_diff_scope` on the supervisor returns the branch's real file
 *                    list (`git diff --name-only origin/<default>...origin/<branch>`).
 *                    The hub checks EVERY path is under `work_sites.site_dir`. A single
 *                    stray file ⇒ `needs_human` / `diff_out_of_scope`, no build, no
 *                    deploy — even on an auto_publish site. THIS is what makes site_dir a
 *                    boundary rather than a request.
 *   2. BUILD       — `work_build` runs the OPERATOR-configured `build_cmd` against the
 *                    branch (deploy credentials scrubbed) and returns its real exit code.
 *                    A non-zero exit ⇒ `qc_failed`, no deploy.
 *   3. HTTPS PROBE — the hub itself fetches `preview_verify_url` (if the operator wired a
 *                    per-branch preview) else `verify_url`, and requires 2xx.
 *
 * HONESTY NOTE (also in docs/remo-work.md): when only `verify_url` is configured, the
 * PRE-publish probe validates that the site is currently HEALTHY — it cannot validate the
 * unpublished change (that URL still serves the old build). The change itself is gated by
 * diff-scope + build pre-publish, and by the POST-publish re-probe (hub/src/work/publish.ts),
 * which records a loud failure + the revert command. Wire `preview_verify_url` to a real
 * per-branch preview deployment to get a pre-publish probe of the actual change.
 */
import { runSupervisorReadCommand, parseSnippet } from '../ext/supervisor-read.ts'

export interface HubQcInput {
  supervisorId: string
  userId: string
  projectDir: string
  branch: string
  defaultBranch: string
  siteDir: string
  buildCmd: string | null
  verifyUrl: string | null
  previewVerifyUrl: string | null
}

export interface HubQc {
  /** ALL of diff_scope + build + probe passed. The ONLY thing a publish may look at. */
  ok: boolean
  failure: 'diff_out_of_scope' | 'diff_unavailable' | 'build_failed' | 'probe_failed' | null
  diff_scope: {
    ok: boolean
    files: string[]
    stray_files: string[]
    head_sha: string | null
    error?: string
  }
  build: { ok: boolean; ran: boolean; exit_code: number | null; output?: string; error?: string }
  probe: { ok: boolean; ran: boolean; url: string | null; status: number | null; error?: string }
  /** ISO timestamp — this evidence is what lands in work_runs.hub_qc. */
  observed_at: string
}

export interface VerifyDeps {
  runCommand: typeof runSupervisorReadCommand
  fetchUrl: (url: string) => Promise<{ status: number }>
}

const REAL_DEPS: VerifyDeps = {
  runCommand: runSupervisorReadCommand,
  fetchUrl: async (url: string) => {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' })
    return { status: res.status }
  },
}

/** Normalise a path for a prefix test: forward slashes, no leading `./`, no trailing `/`. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** TRUE iff `file` lives under `siteDir` (exact-segment prefix — `sites/a2` ≠ `sites/a`). */
export function isUnderSiteDir(file: string, siteDir: string): boolean {
  const f = normPath(file)
  const d = normPath(siteDir)
  if (!d) return false
  return f === d || f.startsWith(`${d}/`)
}

/**
 * Run the hub's own QC. NEVER throws. `ok:true` requires ALL THREE hub-observed checks.
 * A missing build_cmd / verify_url is NOT a pass by omission: `ran:false` ⇒ that check
 * cannot contribute a pass, and `ok` stays false. Fail closed.
 */
export async function runHubQc(i: HubQcInput, deps?: Partial<VerifyDeps>): Promise<HubQc> {
  const d: VerifyDeps = { ...REAL_DEPS, ...deps }
  const qc: HubQc = {
    ok: false,
    failure: null,
    diff_scope: { ok: false, files: [], stray_files: [], head_sha: null },
    build: { ok: false, ran: false, exit_code: null },
    probe: { ok: false, ran: false, url: null, status: null },
    observed_at: new Date().toISOString(),
  }

  // 1) DIFF SCOPE — hub-observed file list, not the agent's claim.
  const diffRes = await d.runCommand(i.supervisorId, i.userId, 'work_diff_scope' as any, [
    i.projectDir,
    i.branch,
    i.defaultBranch,
  ])
  const diff = parseSnippet<{ files: string[]; head_sha: string }>(diffRes)
  if (!diff) {
    qc.diff_scope.error = diffRes.error ?? 'diff_unavailable'
    qc.failure = 'diff_unavailable'
    return qc
  }
  qc.diff_scope.files = diff.files ?? []
  qc.diff_scope.head_sha = diff.head_sha ?? null
  qc.diff_scope.stray_files = qc.diff_scope.files.filter((f) => !isUnderSiteDir(f, i.siteDir))
  if (qc.diff_scope.files.length === 0) {
    qc.diff_scope.error = 'empty_diff'
    qc.failure = 'diff_out_of_scope'
    return qc
  }
  if (qc.diff_scope.stray_files.length > 0) {
    qc.failure = 'diff_out_of_scope'
    return qc
  }
  qc.diff_scope.ok = true

  // 2) BUILD — the hub runs it; the agent's word is not evidence.
  if (i.buildCmd && i.buildCmd.trim()) {
    const buildRes = await d.runCommand(
      i.supervisorId,
      i.userId,
      'work_build' as any,
      [i.projectDir, i.branch, i.buildCmd],
      15 * 60_000,
    )
    const b = parseSnippet<{ build_exit_code: number; output: string }>(buildRes)
    qc.build.ran = true
    if (!b) {
      qc.build.error = buildRes.error ?? 'build_unavailable'
      qc.failure = 'build_failed'
      return qc
    }
    qc.build.exit_code = b.build_exit_code
    qc.build.output = (b.output ?? '').slice(-4_000)
    if (b.build_exit_code !== 0) {
      qc.failure = 'build_failed'
      return qc
    }
    qc.build.ok = true
  } else {
    // No operator build command ⇒ nothing was proven. Not a pass.
    qc.build.error = 'no_build_cmd'
    qc.failure = 'build_failed'
    return qc
  }

  // 3) HTTPS PROBE — the hub fetches it. A hallucinated 200 is not reachable from here.
  const url = i.previewVerifyUrl?.trim() || i.verifyUrl?.trim() || null
  qc.probe.url = url
  if (!url) {
    qc.probe.error = 'no_verify_url'
    qc.failure = 'probe_failed'
    return qc
  }
  qc.probe.ran = true
  try {
    const r = await d.fetchUrl(url)
    qc.probe.status = r.status
    qc.probe.ok = r.status >= 200 && r.status < 300
  } catch (err: any) {
    qc.probe.error = `probe_error: ${err?.message ?? err}`
  }
  if (!qc.probe.ok) {
    qc.failure = 'probe_failed'
    return qc
  }

  qc.ok = qc.diff_scope.ok && qc.build.ok && qc.probe.ok
  return qc
}
