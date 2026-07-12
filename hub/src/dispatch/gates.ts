/**
 * Shared dispatch gates (Phase 1, C1).
 *
 * The pluggable pre-send gates the pipeline evaluates in order. First block
 * wins. Each gate satisfies the `DispatchGate` interface from `pipeline.ts`.
 *
 * - `thresholdGate`       wraps `checkUserThreshold` (Claude usage gate).
 * - `dailyCostCapGate`    the `isOverCostCap` daily-USD SQL, defined ONCE here
 *                         (the three subsystem copies delegate to this).
 * - `concurrencyGate(id)` wraps `reserveSessionSlot` for supervisor targets.
 *
 * Gate ORDER at the call site is the caller's responsibility, but the canonical
 * order — threshold → cost-cap → (concurrency) → queue — is what every legacy
 * dispatcher uses and what `IR-2` requires. See `pipeline.ts`.
 *
 * IR-1: the cost-cap path is non-bypassable. A subsystem whose `gates[]` omits
 * `dailyCostCapGate` would dispatch uncapped — assert its presence per
 * subsystem when migrating.
 */
import { sql } from '../db/postgres.ts'
import { getTodayTokenCostUsd, getTodayTokenTotal } from '../db/token-usage-dal.ts'
import { countSessionInjectsSince } from '../db/orchestrator-rows-dal.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { reserveSessionSlot } from '../sessions/budget.ts'
import { getUsage } from '../usage/store.ts'
import { isOverProgrammaticHalt } from '../usage/programmatic-leak.ts'
import type { DispatchGate, DispatchRequest } from './pipeline.ts'

/**
 * Daily cost-cap predicate — the SINGLE source of truth for the `isOverCostCap`
 * SQL that scheduler/error-capture/revanote each copied. `dailyCostCapGate`
 * delegates here; the SQL is NOT inlined anywhere else (no double truth).
 *
 * P3a: the cap now compares against REAL accumulated token cost for TODAY (the
 * user's tz), summed from `token_usage` via `getTodayTokenCostUsd`. That ledger
 * captures EVERY turn that emits a usage_event over /ws/agent — interactive,
 * telegram, webhook AND scheduled runs — so manual chat is finally capped, not
 * just scheduled runs. token_usage is the one source, so we do NOT also add
 * `scheduled_task_runs.cost_usd` (would double-count scheduled-run cost, which
 * is already in token_usage).
 *
 * Timing: the cap is checked BEFORE a turn dispatches, but a turn's cost is only
 * known AFTER it completes (usage_event is post-turn). So the turn that crosses
 * the cap is allowed to start; the NEXT dispatch is blocked once accumulated
 * cost >= cap. We deliberately do NOT pre-estimate the pending turn.
 *
 * Returns `{ over, spent, cap }`. `over` is true when today's spend (in
 * `timezone`) is >= the user's cap. The `users.daily_cost_cap_usd` column is
 * NOT NULL DEFAULT 10, so a missing/null cap coalesces to the legacy $10 default
 * (still capped) — unchanged from the pre-P3a gate. Only a non-positive /
 * non-finite cap disables enforcement (fail-open).
 */
export async function getCostCapStatus(
  userId: string,
  timezone: string,
): Promise<{ over: boolean; spent: number; cap: number }> {
  const rows = await sql<{ cap: string | null }[]>`
    SELECT daily_cost_cap_usd::text AS cap FROM users WHERE id = ${userId} LIMIT 1
  `
  const cap = Number(rows[0]?.cap ?? 10)
  if (!Number.isFinite(cap) || cap <= 0) return { over: false, spent: 0, cap: 0 }
  const spent = await getTodayTokenCostUsd(userId, timezone)
  return { over: spent >= cap, spent, cap }
}

/** Boolean convenience wrapper around {@link getCostCapStatus}. */
export async function isOverCostCap(userId: string, timezone: string): Promise<boolean> {
  return (await getCostCapStatus(userId, timezone)).over
}

/** Resolve the user's timezone (default 'UTC') for the cost-cap window. */
async function userTimezone(userId: string): Promise<string> {
  const rows = await sql<{ tz: string | null }[]>`
    SELECT timezone AS tz FROM users WHERE id = ${userId} LIMIT 1
  `
  return rows[0]?.tz ?? 'UTC'
}

/**
 * Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt status.
 *
 * Reads the user's `programmatic_halt_usd` bound (NULL = OFF, the default) and
 * the latest polled programmatic-credit snapshot from the in-memory usage store,
 * delegating the comparison to the single `isOverProgrammaticHalt` predicate.
 *
 * Returns `{ halt, bound, used_usd }`. `halt` is true ONLY when the bound is set
 * (>0) AND the claimed credit used_usd has crossed it. Absent config, absent /
 * unclaimed credit, or a store miss => `halt:false` (fail-open — never a surprise
 * stop). This is the hard-halt's TWIN to `getCostCapStatus`.
 */
export async function getProgrammaticHaltStatus(
  userId: string,
): Promise<{ halt: boolean; bound: number | null; used_usd: number | null }> {
  const rows = await sql<{ bound: string | null }[]>`
    SELECT programmatic_halt_usd::text AS bound FROM users WHERE id = ${userId} LIMIT 1
  `
  const bound = rows[0]?.bound == null ? null : Number(rows[0].bound)
  const credit = getUsage(userId)?.usage.programmatic_credit ?? null
  const halt = isOverProgrammaticHalt(bound, credit)
  return { halt, bound: Number.isFinite(bound as number) ? (bound as number) : null, used_usd: credit?.used_usd ?? null }
}

/**
 * Claude usage threshold gate. Blocks with `quota_threshold_reached:<reason>`
 * when the user crossed their configured 5h / 7d utilization threshold.
 */
export const thresholdGate: DispatchGate = {
  name: 'threshold',
  async check(req: DispatchRequest) {
    const decision = await checkUserThreshold(req.userId)
    if (decision.allowed) return { ok: true }
    const reason = `quota_threshold_reached:${decision.reason}:${decision.utilization_pct}>=${decision.threshold_pct}`
    return { ok: false, reason }
  },
}

/**
 * Daily cost-cap gate (non-bypassable, IR-1). `DispatchRequest` carries no
 * timezone field by design, so the gate resolves the user's timezone then
 * delegates to `isOverCostCap` — the single SQL source of truth.
 */
export const dailyCostCapGate: DispatchGate = {
  name: 'daily_cost_cap',
  async check(req: DispatchRequest) {
    const timezone = await userTimezone(req.userId)
    const status = await getCostCapStatus(req.userId, timezone)
    if (status.over) {
      // Surface accumulated vs cap so dispatch can tell the user the daily cost
      // cap was reached (e.g. "over_daily_cost_cap:$10.42>=$10.00").
      const reason = `over_daily_cost_cap:$${status.spent.toFixed(2)}>=$${status.cap.toFixed(2)}`
      return { ok: false, reason }
    }
    // Phase 18 (R-PTY-18): the opt-in programmatic-credit hard-halt rides the
    // SAME chokepoint as an additional predicate (no parallel gate). Default OFF
    // (null bound) => never fires. When the user-configured bound is crossed,
    // programmatic/automation dispatch is denied with a typed reason. Human
    // interactive PTY turns never reach this gate for this reason (the
    // human-only guard + interactive pool keep them off the programmatic path).
    const halt = await getProgrammaticHaltStatus(req.userId)
    if (halt.halt) {
      const reason = `programmatic_credit_halt:$${(halt.used_usd ?? 0).toFixed(2)}>=$${(halt.bound ?? 0).toFixed(2)}`
      return { ok: false, reason }
    }
    return { ok: true }
  },
}

// ── BSA-04: non-bypassable daily TOKEN ceiling (ALONGSIDE the cost cap) ───────
/**
 * BSA-04 default daily token ceiling. The dollar cost cap is meaningless on a
 * flat-rate Max subscription (reality-doc issue #6 — no per-token billing), so
 * this token-count ceiling is what actually bounds a runaway autospawn loop.
 *
 * Default 50_000_000 (50M) tokens/day: a deliberately conservative-but-defensible
 * ceiling — well above a heavy legitimate Max-20x dev day (cache-read tokens
 * dominate and inflate raw counts), yet low enough to halt an unattended loop
 * within a day. Owner sets the real prod number via REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
 * (this milestone ships the default only). A non-positive / non-finite value
 * DISABLES the token ceiling (fail-open, mirroring the cost cap's 0/neg semantics).
 */
const DEFAULT_DAILY_TOKEN_CAP = 50_000_000

function configuredDailyTokenCap(): number {
  const raw = process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
  if (raw == null || raw.trim() === '') return DEFAULT_DAILY_TOKEN_CAP
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_DAILY_TOKEN_CAP
}

/**
 * Token-cap status: today's consumed tokens (user tz) vs the configured ceiling.
 * `over` is true when tokens >= cap. A non-positive / non-finite cap returns
 * `{ over:false, tokens:0, cap:0 }` (disabled, fail-open). Read at call-time so
 * the env knob + tests apply without a reimport.
 */
export async function getTokenCapStatus(
  userId: string,
  timezone: string,
): Promise<{ over: boolean; tokens: number; cap: number }> {
  const cap = configuredDailyTokenCap()
  if (!Number.isFinite(cap) || cap <= 0) return { over: false, tokens: 0, cap: 0 }
  const tokens = await getTodayTokenTotal(userId, timezone)
  return { over: tokens >= cap, tokens, cap }
}

/** Boolean convenience wrapper around {@link getTokenCapStatus}. */
export async function isOverTokenCap(userId: string, timezone: string): Promise<boolean> {
  return (await getTokenCapStatus(userId, timezone)).over
}

/**
 * Daily TOKEN-cap gate (non-bypassable, BSA-04). ADDED ALONGSIDE
 * `dailyCostCapGate` in the orchestrator inject gate list — it never replaces the
 * cost cap. Resolves the user's tz (DispatchRequest carries none, like the cost
 * gate) then delegates to `getTokenCapStatus`. Blocks with
 * `over_daily_token_cap:<tokens>>=<cap>`.
 */
export const dailyTokenCapGate: DispatchGate = {
  name: 'daily_token_cap',
  async check(req: DispatchRequest) {
    const timezone = await userTimezone(req.userId)
    const status = await getTokenCapStatus(req.userId, timezone)
    if (status.over) {
      const reason = `over_daily_token_cap:${status.tokens}>=${status.cap}`
      return { ok: false, reason }
    }
    return { ok: true }
  },
}

// ── Per-session orchestrator INJECT-RATE ceiling ─────────────────────────────
/**
 * Max orchestrator injects per session per rolling hour. Default 4.
 *
 * The 2026-07 incident: a wedged 60s tick loop injected a macro prompt into ONE
 * session 1,440x/day for 2 days (2,192 turns, 2.83B cache-read tokens). Nothing
 * bounded the RATE — only the (then cache-blind) daily totals. This ceiling makes
 * that shape impossible regardless of what the totals say: a legitimate autonomous
 * cycle finishes a unit of work in far more than 15 minutes, so 4/hour is generous.
 *
 * Non-positive / non-finite ⇒ DISABLED (fail-open), mirroring the cost/token caps.
 */
const DEFAULT_MAX_INJECTS_PER_HOUR = 4

export function maxInjectsPerHour(): number {
  const raw = process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_INJECTS_PER_HOUR
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_MAX_INJECTS_PER_HOUR
}

/**
 * Per-session inject-rate gate. Counts this session's orchestrator injects in the
 * trailing 60 minutes (`countSessionInjectsSince` over the existing
 * `routine_run_log` — no new table) and blocks with
 * `over_session_inject_rate:<n>>=<cap>` once the ceiling is reached. Rows age out
 * of the rolling window, so the gate re-opens on its own.
 *
 * Wired into the orchestrator inject gate list ALONGSIDE thresholdGate /
 * dailyCostCapGate / dailyTokenCapGate — it replaces none of them.
 */
export const sessionInjectRateGate: DispatchGate = {
  name: 'session_inject_rate',
  async check(req: DispatchRequest) {
    const cap = maxInjectsPerHour()
    if (!Number.isFinite(cap) || cap <= 0) return { ok: true } // disabled (fail-open)
    const injects = await countSessionInjectsSince(req.sessionId, 60)
    if (injects >= cap) {
      return { ok: false, reason: `over_session_inject_rate:${injects}>=${cap}` }
    }
    return { ok: true }
  },
}

// ── BSA-04: per-day autospawn LAUNCH-count cap ───────────────────────────────
/**
 * Max autospawn launches per user per day. A second, independent ceiling from the
 * token cap: it bounds how many times the orchestrator may SPAWN a build session
 * in a day (each launch is a cost/risk event regardless of tokens). Default 20.
 * Non-positive / non-finite => disabled (fail-open). BSA-02 calls
 * {@link isOverAutospawnDailyLaunchCap} BEFORE launching.
 */
const DEFAULT_AUTOSPAWN_DAILY_LAUNCHES = 20

export function autospawnDailyLaunchCap(): number {
  const raw = process.env.REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES
  if (raw == null || raw.trim() === '') return DEFAULT_AUTOSPAWN_DAILY_LAUNCHES
  const n = Number(raw)
  return Number.isInteger(n) ? n : DEFAULT_AUTOSPAWN_DAILY_LAUNCHES
}

/**
 * True when `launchesToday` has reached/exceeded the per-day autospawn launch cap.
 * Pure predicate (BSA-02 supplies the count from its launch ledger) so it needs no
 * DB here. A non-positive / non-finite cap => disabled (always false, fail-open).
 */
export function isOverAutospawnDailyLaunchCap(launchesToday: number): boolean {
  const cap = autospawnDailyLaunchCap()
  if (!Number.isInteger(cap) || cap <= 0) return false
  return launchesToday >= cap
}

/**
 * Human-only PTY gate (Phase 16, constraint 3 — R-PTY-10 / R-PTY-28 / H1).
 *
 * The SHARED chokepoint that rejects AUTOMATION sources from ever driving a
 * `pty-interactive` session — the flagged "robot pressing enter via the
 * interactive entrypoint" / ToS-risk move. It is composed into BOTH:
 *   (a) the dispatch pipeline (this DispatchGate form), and
 *   (b) the raw `term.input` relay ingress (the `rejectsActor` helper below),
 * so there is NO second, ungated write route into a PTY session.
 *
 * The ACTOR is SERVER-INFERRED from the connection, never a client-asserted
 * payload field (H1): an authenticated /ws/client opaque-cookie ⇒ `human`;
 * /ws/agent api_keys ⇒ `agent`; dispatch sources name themselves (scheduler /
 * orchestrator-background / auto-dev / error-capture). Only a `human` actor may
 * write to a pty-interactive session.
 *
 * It composes WITH (never replaces) `dailyCostCapGate` — the PTY path introduces
 * no uncapped dispatch route.
 */
export const AUTOMATION_ACTORS: ReadonlySet<string> = new Set([
  'scheduler',
  'orchestrator-background',
  'auto-dev',
  'error-capture',
  'agent',
])

/** True when `actor` is an automation source that must NOT drive a
 *  pty-interactive session. The single decision both the pipeline gate and the
 *  relay ingress use. `human` (server-inferred from a /ws/client cookie) passes;
 *  everything in AUTOMATION_ACTORS is rejected for pty-interactive. */
export function humanOnlyRejectsActor(actor: string, runnerType: string): boolean {
  if (runnerType !== 'pty-interactive') return false
  return actor !== 'human' // any non-human actor (incl. all AUTOMATION_ACTORS) is rejected
}

/**
 * DispatchGate form for the pipeline. Reads the dispatch source + the target
 * session's runner_type. A pty-interactive session driven by an automation
 * source is blocked with `automation_blocked_on_pty:<actor>`. Stream-json
 * sessions are unaffected (still cost-capped by dailyCostCapGate).
 *
 * The source + runner_type are read off the DispatchRequest (the dispatch
 * context already carries the source; runner_type is resolved via the DAL). To
 * keep `DispatchRequest` unchanged we accept them on an optional augmentation
 * the caller threads through — the pipeline composes this gate only for PTY-
 * capable dispatches.
 */
export function humanOnlyPtyGate(
  resolveActorAndRunnerType: (req: DispatchRequest) => Promise<{ actor: string; runnerType: string }>,
): DispatchGate {
  return {
    name: 'human_only_pty',
    async check(req: DispatchRequest) {
      const { actor, runnerType } = await resolveActorAndRunnerType(req)
      if (humanOnlyRejectsActor(actor, runnerType)) {
        return { ok: false, reason: `automation_blocked_on_pty:${actor}` }
      }
      return { ok: true }
    },
  }
}

/**
 * Supervisor concurrency gate — wraps `reserveSessionSlot`. Returns a gate
 * bound to a specific `supervisorId`. At capacity → `{ ok:false, reason }`.
 *
 * NOTE: `reserveSessionSlot` has the side-effect of opening a serialised
 * reservation window; like the legacy dispatcher, this gate is only added to
 * `gates[]` for supervisor-targeted dispatches.
 */
export function concurrencyGate(supervisorId: string): DispatchGate {
  return {
    name: 'concurrency',
    async check(req: DispatchRequest) {
      const reservation = await reserveSessionSlot(req.userId, supervisorId)
      if (reservation.ok) return { ok: true }
      const reason = reservation.reason === 'at_capacity' ? 'at_capacity' : reservation.reason
      return { ok: false, reason }
    },
  }
}
