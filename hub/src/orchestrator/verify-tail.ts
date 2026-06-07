// hub/src/orchestrator/verify-tail.ts
// Phase 27 (auto-dev-orchestrator) — the MANDATORY terminal deploy/log-verify
// tail that EVERY cycle ends with (locked decision D9).
//
// Reqs:
//   R-ADO-19 — always-appended verify tail: forced redeploy → /health → probe
//              real routes. REUSES the SHIPPED auto-dev P5 deploy-verify
//              (lib/coolify-client.triggerRedeploy + scheduler/deploy-verify-probe.
//              runDeployVerify) — NOT reimplemented.
//   R-ADO-20 — Coolify runtime-log fetch + error-pattern scan in addition to the
//              route probe.
//   R-ADO-21 — bounded fix loop: on failure dispatch a fix agent + re-verify,
//              capped at N=3, then surface to chat. Verify outcome + iteration
//              count written to routine_run_log. NEVER loops unbounded.
//
// SAFETY: requires COOLIFY_TOKEN (coolifyConfigFromEnv) + an app uuid + base url
// from env. Missing any → graceful no-op (`skipped`), never a crash — so with the
// orchestrator flag OFF and/or Coolify unconfigured, prod stays dormant.
//
// The fix dispatch rides the SAME P25 inject seam (injectOrchestratorPrompt) →
// shared dispatch pipeline → dailyCostCapGate (non-bypassable). The hub injects
// TEXT ONLY; the fix agent does the work in its own turn.

import {
  coolifyConfigFromEnv,
  triggerRedeploy,
  fetchAppLogs,
  type CoolifyConfig,
  type RedeployResult,
  type AppLogsResult,
} from '../lib/coolify-client.ts'
import {
  runDeployVerify,
  formatVerifyReport,
  type DeployVerifyResult,
} from '../scheduler/deploy-verify-probe.ts'
import { injectOrchestratorPrompt, type InjectOutcome } from './inject.ts'
import { appendRunLog } from './run-log.ts'
import { notifyChatSurface } from './propose.ts'

// ── Hard bound (R-ADO-21) — non-negotiable; never raise without re-reading D9 ──
export const MAX_FIX_ITERATIONS = 3

// ── Log error-scan patterns (R-ADO-20) — tunable set ──────────────────────────
/**
 * Error-class patterns scanned against the fetched Coolify runtime log. Anchored
 * to word boundaries / line-leading markers to avoid matching benign substrings
 * (e.g. a route literally named "error-capture"). Case-insensitive, multiline.
 */
export const LOG_ERROR_PATTERNS: RegExp[] = [
  /\bunhandled(?:rejection| exception| promise)?\b/i,
  /\buncaught\b/i,
  /\bFATAL\b/,
  /\bpanic:/i,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEADDRINUSE\b/,
  /\b[A-Za-z.]*Exception\b/, // FooException / NullPointerException / etc.
  /^\s*at\s+.+\(.+:\d+:\d+\)\s*$/m, // V8 stack-trace frame
  /\bTraceback \(most recent call last\)/,
  /\b(?:level|severity)["':=\s]+error\b/i, // structured-log error level
  /\bsegmentation fault\b/i,
  /\bout of memory\b/i,
]

/** Lines that look error-ish but are benign — skipped before pattern matching. */
const BENIGN_LINE_PATTERNS: RegExp[] = [
  /\b0 errors?\b/i,
  /\bno errors?\b/i,
  /errorRate["':=\s]+0\b/i,
]

export interface LogScanResult {
  /** true ⇒ no error patterns matched (or no log to scan). */
  clean: boolean
  /** sample of matched lines (capped) for the run-log / surface message. */
  matches: string[]
  /** number of lines scanned. */
  scanned: number
}

/**
 * Scan runtime-log text for error-class patterns. Benign lines are filtered
 * first. Returns `clean:true` for empty/whitespace input (nothing to flag).
 */
export function scanLogForErrors(log: string | null | undefined): LogScanResult {
  const text = (log ?? '').trim()
  if (!text) return { clean: true, matches: [], scanned: 0 }
  const lines = text.split(/\r?\n/)
  const matches: string[] = []
  for (const line of lines) {
    if (BENIGN_LINE_PATTERNS.some((re) => re.test(line))) continue
    if (LOG_ERROR_PATTERNS.some((re) => re.test(line))) {
      matches.push(line.trim().slice(0, 300))
      if (matches.length >= 20) break // cap — don't flood the run-log
    }
  }
  return { clean: matches.length === 0, matches, scanned: lines.length }
}

// ── Surface seam (Phase 28 propose-to-chat — LIVE) ────────────────────────────
/**
 * Thin notify seam — surfaces an exhausted/failed verify tail to chat. Phase 28
 * wires the LIVE path (`notifyChatSurface`, propose.ts) which reuses the SHIPPED
 * P3 notify senders + `notifications_sent` throttle. Notify-only — verify-tail
 * writes its own `verify_failed` run-log row. Tests inject their own notify spy
 * via `depsOverride`; both real-deps builders bind the live notify.
 */
export type NotifySeam = (input: {
  sessionId: string
  userId: string | null
  summary: string
}) => Promise<void>

// ── Injectable deps (tests swap network + dispatch; prod uses the real ones) ──
export interface VerifyTailDeps {
  configFromEnv: () => CoolifyConfig | null
  triggerRedeploy: (cfg: CoolifyConfig, uuid: string) => Promise<RedeployResult>
  fetchAppLogs: (cfg: CoolifyConfig, uuid: string) => Promise<AppLogsResult>
  runDeployVerify: (cfg: CoolifyConfig) => Promise<DeployVerifyResult>
  inject: (input: {
    userId: string
    sessionId: string
    token: string
    prompt: string
  }) => Promise<InjectOutcome>
  notify: NotifySeam
  appendRunLog: typeof appendRunLog
}

// ── Verify-target env resolution ──────────────────────────────────────────────
export interface VerifyTarget {
  appUuid: string
  baseUrl: string
  routes: string[]
}

/**
 * Resolve the verify target from env. Returns null when not configured (→ no-op
 * `skipped`). Routes default to a remo-code-hub-style set when unset.
 */
export function resolveVerifyTargetFromEnv(): VerifyTarget | null {
  const appUuid = process.env.REMO_VERIFY_APP_UUID
  const baseUrl = process.env.REMO_VERIFY_BASE_URL
  if (!appUuid || !baseUrl) return null
  const routesRaw = (process.env.REMO_VERIFY_ROUTES || '/api/sessions,/openapi.json,/docs').trim()
  const routes = routesRaw
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
  return { appUuid, baseUrl: baseUrl.replace(/\/+$/, ''), routes }
}

// ── Run context ───────────────────────────────────────────────────────────────
export interface VerifyTailContext {
  sessionId: string
  repoKey: string | null
  userId: string | null
  /** stamped on the run-log row (D4). */
  decisionRationale?: string | null
  /** optional explicit target (else env). */
  target?: VerifyTarget | null
}

export type VerifyVerdict = 'pass' | 'fail' | 'skipped'

export interface VerifyTailResult {
  verdict: VerifyVerdict
  deployOk: boolean
  routesOk: boolean
  logClean: boolean
  iterations: number
  reason: string
}

function buildRealDeps(target: VerifyTarget): VerifyTailDeps {
  return {
    configFromEnv: coolifyConfigFromEnv,
    triggerRedeploy: (cfg, uuid) => triggerRedeploy(cfg, uuid),
    fetchAppLogs: (cfg, uuid) => fetchAppLogs(cfg, uuid),
    runDeployVerify: () =>
      runDeployVerify({ baseUrl: target.baseUrl, routes: target.routes }),
    inject: (input) => injectOrchestratorPrompt(input),
    notify: notifyChatSurface,
    appendRunLog,
  }
}

/** Compose the fix-agent prompt from a failed verify+scan summary. */
function composeFixPrompt(summary: string): string {
  return [
    'The auto-dev verify tail detected a BROKEN deployment after this cycle.',
    'Diagnose and FIX the root cause, then commit + push so Coolify redeploys.',
    'Do NOT merge to main. Keep the change minimal and verifiable.',
    '',
    'Verify failure detail:',
    summary,
  ].join('\n')
}

/**
 * Run ONE verify pass: redeploy → deploy-verify probe → log fetch + scan.
 * Returns the per-pass verdict + a human summary for the run-log / surface / fix.
 */
async function runOnePass(
  cfg: CoolifyConfig,
  target: VerifyTarget,
  deps: VerifyTailDeps,
): Promise<{ deployOk: boolean; routesOk: boolean; logClean: boolean; summary: string }> {
  const redeploy = await deps.triggerRedeploy(cfg, target.appUuid)
  const verify = await deps.runDeployVerify(cfg)
  const logs = await deps.fetchAppLogs(cfg, target.appUuid)
  const scan = scanLogForErrors(logs.logs)

  const routesOk = verify.pass
  const deployOk = redeploy.ok
  const logClean = scan.clean

  const summaryLines = [
    `redeploy: ${redeploy.ok ? `ok (${redeploy.status})` : `FAILED (${redeploy.status}) ${redeploy.detail ?? ''}`}`,
    formatVerifyReport(target.baseUrl, verify),
    `log-scan: ${scan.clean ? `clean (${scan.scanned} lines)` : `${scan.matches.length} error line(s)`}`,
  ]
  if (!scan.clean) {
    for (const m of scan.matches.slice(0, 5)) summaryLines.push(`  ! ${m}`)
  }
  return { deployOk, routesOk, logClean, summary: summaryLines.join('\n') }
}

/**
 * The MANDATORY terminal verify tail (D9). Always appends exactly one
 * routine_run_log row capturing the outcome. NEVER throws to the caller (the
 * controller wraps it best-effort anyway). Hard-bounded at MAX_FIX_ITERATIONS.
 *
 * Control flow:
 *   1. Resolve config + target — missing → write a `skipped` run-log row + return.
 *   2. for i in 0..N-1:
 *        runOnePass; if deployOk && routesOk && logClean → PASS, stop.
 *        else if i is the LAST allowed iteration → break (exhausted).
 *        else dispatch a fix (cost-cap-gated); a refused/no-session fix also breaks
 *             (no point re-verifying an unchanged deploy).
 *   3. On non-pass after the loop → surface to chat (Phase-28 stub) + log fail.
 */
export async function runVerifyTail(
  ctx: VerifyTailContext,
  depsOverride?: Partial<VerifyTailDeps>,
  targetOverride?: VerifyTarget | null,
): Promise<VerifyTailResult> {
  const target = targetOverride ?? ctx.target ?? resolveVerifyTargetFromEnv()

  // Build deps: real deps need a target to bind runDeployVerify; when target is
  // absent we still allow a fully-injected deps set (tests). configFromEnv is the
  // gate for the no-op path.
  const baseDeps: VerifyTailDeps = target
    ? buildRealDeps(target)
    : {
        configFromEnv: coolifyConfigFromEnv,
        triggerRedeploy: async () => ({ ok: false, status: 0 }),
        fetchAppLogs: async () => ({ ok: false, status: 0, logs: '' }),
        runDeployVerify: async () => ({
          healthOk: false,
          healthPath: null,
          healthStatus: 0,
          routes: [],
          pass: false,
        }),
        inject: (input) => injectOrchestratorPrompt(input),
        notify: notifyChatSurface,
        appendRunLog,
      }
  const deps: VerifyTailDeps = { ...baseDeps, ...depsOverride }

  const cfg = deps.configFromEnv()

  // ── No-op guard: missing Coolify token OR target → skip gracefully ───────────
  if (!cfg || !target) {
    const reason = !cfg ? 'no_coolify_config' : 'no_verify_target'
    await safeLog(deps, ctx, {
      outcome: `verify_skipped:${reason}`,
      deploy_verify_result: `skipped (${reason})`,
    })
    return {
      verdict: 'skipped',
      deployOk: false,
      routesOk: false,
      logClean: true,
      iterations: 0,
      reason,
    }
  }

  let lastSummary = ''
  let deployOk = false
  let routesOk = false
  let logClean = false
  let iterations = 0

  for (let i = 0; i < MAX_FIX_ITERATIONS; i++) {
    iterations = i + 1
    const pass = await runOnePass(cfg, target, deps)
    deployOk = pass.deployOk
    routesOk = pass.routesOk
    logClean = pass.logClean
    lastSummary = pass.summary

    if (deployOk && routesOk && logClean) {
      // ── PASS — stop immediately ───────────────────────────────────────────
      await safeLog(deps, ctx, {
        outcome: 'verify_pass',
        deploy_verify_result: `pass (iter ${iterations}/${MAX_FIX_ITERATIONS})`,
      })
      return { verdict: 'pass', deployOk, routesOk, logClean, iterations, reason: 'verified' }
    }

    // Failure. If we've used the last allowed iteration, stop (exhausted).
    if (i === MAX_FIX_ITERATIONS - 1) break

    // Dispatch a fix, cost-cap-gated. If it can't be dispatched, stop — re-verifying
    // an unchanged deploy would only burn iterations.
    if (!ctx.userId) break
    const inj = await deps.inject({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      token: `orch-verify-fix:${ctx.sessionId}:${Date.now()}`,
      prompt: composeFixPrompt(lastSummary),
    })
    if (inj.kind !== 'dispatched' && inj.kind !== 'queued') {
      lastSummary += `\nfix dispatch ${inj.kind}` + ('reason' in inj ? `: ${inj.reason}` : '')
      break
    }
  }

  // ── Non-pass after the bounded loop → surface to chat (Phase-28 stub) ────────
  const verdictReason = `verify_failed deploy=${deployOk} routes=${routesOk} log=${logClean ? 'clean' : 'errors'} iters=${iterations}/${MAX_FIX_ITERATIONS}`
  await deps
    .notify({
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      summary: `Auto-dev verify tail still FAILING after ${iterations} iteration(s):\n${lastSummary}`,
    })
    .catch(() => {})
  await safeLog(deps, ctx, {
    outcome: 'verify_failed',
    deploy_verify_result: `fail (iter ${iterations}/${MAX_FIX_ITERATIONS}; deploy=${deployOk} routes=${routesOk} log=${logClean ? 'clean' : 'errors'})`,
  })
  return { verdict: 'fail', deployOk, routesOk, logClean, iterations, reason: verdictReason }
}

/** Append one run-log row, swallowing failures (a log error must not wedge the tick). */
async function safeLog(
  deps: VerifyTailDeps,
  ctx: VerifyTailContext,
  fields: { outcome: string; deploy_verify_result: string },
): Promise<void> {
  try {
    await deps.appendRunLog({
      session_id: ctx.sessionId,
      repo_key: ctx.repoKey,
      command: 'deploy-verify',
      decision_rationale: ctx.decisionRationale ?? null,
      outcome: fields.outcome,
      gap_dimension: null,
      pr_url: null,
      reviewer_verdict: null,
      deploy_verify_result: fields.deploy_verify_result,
    })
  } catch (err: any) {
    console.warn(`[orchestrator] verify-tail run-log append failed: ${err?.message ?? err}`)
  }
}
