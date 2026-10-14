// hub/src/dispatch/governed-launch.ts
// PTYCAP-07-04 (D-03, D-04; AM-F1-1..AM-F1-3) - the shared governed autospawn
// pre-launch chain + launch.
//
// Extracted from the orchestrator inject seam (maybeAutospawnOffline, post-flag part
// ONLY) so the self-heal path can reuse the BSA chain without inheriting its two
// defects: (1) the cost / threshold / rate / lifetime checks run only AFTER the spawn,
// (2) the autospawn-launch ledger row is best-effort.
//
// Two policies, selected by whether `args.preLaunch` (the governor) is supplied:
//   - LEGACY (no governor, orchestrator): the original order and strings, and a
//     best-effort post-launch ledger row. Gates / reservation are never invoked here
//     (the caller's dispatch tail still runs them AFTER the launch, exactly as before).
//   - HEAL (governor supplied): the full gate list and the atomic lifetime reservation
//     run BEFORE the launch, the ledger row is written BEFORE the launch and a ledger
//     failure REFUSES the launch (fail closed), and the reservation is released on every
//     refusal and on a failed launch (left in place on success so the later dispatch with
//     the same token counts once).
//
// The caller evaluates arming (so heal uses its own flag, never the orchestrator-enabled
// predicate). This module is pure orchestration over injected deps: it imports no
// pipeline types, no DB, and carries no budget-key knowledge - key-bearing reserve and
// release are injected closures (so the counter-key assignment guard allowlist is not
// widened).

import type { LaunchResult } from '../telegram/launch.ts'

export interface LaunchInfo {
  runId: string
  supervisorId: string
}

export type GovernedLaunchResult =
  | { kind: 'launched'; runId: string; supervisorId: string }
  | { kind: 'in_flight' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }

/** Pre-launch governor (heal policy). All three closures carry the budget key themselves. */
export interface PreLaunchGovernor {
  /** Resolve a refusal reason from the full gate list, or null when every gate passes. */
  checkGates: () => Promise<string | null>
  /** Atomically reserve the lifetime budget BEFORE the launch. */
  reserve: () => Promise<{ ok: true } | { ok: false; reason: string }>
  /** Release the reservation (refused / failed launch). Best-effort by the caller's closure. */
  release: () => Promise<void>
}

export interface GovernedLaunchArgs {
  userId: string
  sessionId: string
  repoIdent: string
  tz: string
  /** Evaluated by the caller (its own flag). false => refused 'disabled'. */
  armed: boolean
  /**
   * Optional hook run after the launch-cap check: `{ ok: true }` continues; `{ ok: false,
   * result }` returns `result` verbatim (e.g. an unresolved counter key).
   */
  preflight?: () => Promise<{ ok: true } | { ok: false; result: GovernedLaunchResult }>
  ledger: {
    repoKey: string
    /** The run-log command string the launch-count cap counts (AUTOSPAWN_LAUNCH_COMMAND). */
    command: string
    rationale: (launch?: LaunchInfo) => string
  }
  preLaunch?: PreLaunchGovernor
}

export interface GovernedLaunchDeps {
  isRepoAutospawnAllowed: (userId: string, repoIdent: string) => Promise<boolean>
  supervisorOnlineForUser: (userId: string, sessionId: string) => Promise<boolean>
  getTokenCapStatus: (userId: string, tz: string) => Promise<{ over: boolean }>
  countAutospawnLaunchesToday: (userId: string, tz: string) => Promise<number>
  isOverAutospawnDailyLaunchCap: (launchesToday: number) => boolean
  graceParkPending: (sessionId: string) => boolean
  launchSessionForUser: (a: { userId: string; sessionId: string; machine: true }) => Promise<LaunchResult>
  appendRunLog: (row: {
    session_id: string
    repo_key: string
    command: string
    decision_rationale: string
    outcome: string
  }) => Promise<unknown>
}

function msg(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err)
}

export async function governedLaunch(
  args: GovernedLaunchArgs,
  deps: GovernedLaunchDeps,
): Promise<GovernedLaunchResult> {
  const { userId, sessionId, repoIdent, tz, preLaunch } = args

  if (!args.armed) return { kind: 'refused', reason: 'disabled' }

  // Allowlist (fail-closed: empty allowlist => false => refused not_allowlisted).
  if (!(await deps.isRepoAutospawnAllowed(userId, repoIdent))) {
    return { kind: 'refused', reason: 'not_allowlisted' }
  }

  // A supervisor must be online to host the spawned session.
  if (!(await deps.supervisorOnlineForUser(userId, sessionId))) {
    return { kind: 'refused', reason: 'supervisor_offline' }
  }

  // Token ceiling pre-check so we never SPAWN over it.
  const tokenStatus = await deps.getTokenCapStatus(userId, tz)
  if (tokenStatus.over) return { kind: 'refused', reason: 'over_token_cap' }

  // Per-day launch-count cap (source: today's autospawn-launch ledger rows).
  let launchesToday = 0
  try {
    launchesToday = await deps.countAutospawnLaunchesToday(userId, tz)
  } catch {
    /* best-effort; treat as 0 so a transient read error does not over-block */
  }
  if (deps.isOverAutospawnDailyLaunchCap(launchesToday)) return { kind: 'refused', reason: 'launch_cap' }

  if (args.preflight) {
    const pre = await args.preflight()
    if (!pre.ok) return pre.result
  }

  // Dedupe: a live grace entry means a launch is already in flight for this session.
  if (deps.graceParkPending(sessionId)) return { kind: 'in_flight' }

  const ledgerRow = (launch?: LaunchInfo) => ({
    session_id: sessionId,
    repo_key: args.ledger.repoKey,
    command: args.ledger.command,
    decision_rationale: args.ledger.rationale(launch),
    outcome: 'launched',
  })

  // ── HEAL policy: gates + reservation + ledger ALL before the spawn (AM-F1-2/3) ──
  let reserved = false
  const releaseIfReserved = async (): Promise<void> => {
    if (!preLaunch || !reserved) return
    reserved = false
    try {
      await preLaunch.release()
    } catch {
      /* the closure is best-effort; a stuck reservation expires with its window */
    }
  }

  if (preLaunch) {
    const gateReason = await preLaunch.checkGates()
    if (gateReason) return { kind: 'refused', reason: gateReason }

    const res = await preLaunch.reserve()
    if (!res.ok) return { kind: 'refused', reason: res.reason }
    reserved = true

    try {
      await deps.appendRunLog(ledgerRow())
    } catch {
      await releaseIfReserved()
      return { kind: 'refused', reason: 'ledger_unavailable' }
    }
  }

  // ── Launch ─────────────────────────────────────────────────────────────────────
  let launch: LaunchResult
  try {
    launch = await deps.launchSessionForUser({ userId, sessionId, machine: true })
  } catch (err) {
    await releaseIfReserved()
    return { kind: 'failed', reason: `autospawn_launch_threw: ${msg(err)}` }
  }

  if (!launch.ok) {
    await releaseIfReserved()
    // no_online_supervisor (raced offline) maps to supervisor_offline; capacity / other
    // definitive reasons surface as a typed refusal.
    if (launch.reason === 'no_online_supervisor') return { kind: 'refused', reason: 'supervisor_offline' }
    return { kind: 'refused', reason: `autospawn_launch_${launch.reason}` }
  }

  // ── LEGACY policy: best-effort ledger row after the real spawn ────────────────
  if (!preLaunch) {
    try {
      await deps.appendRunLog(ledgerRow({ runId: launch.runId, supervisorId: launch.supervisorId }))
    } catch {
      /* best-effort - the cap is conservative; a missed ledger row only under-counts */
    }
  }

  return { kind: 'launched', runId: launch.runId, supervisorId: launch.supervisorId }
}
