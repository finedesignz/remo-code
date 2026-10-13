/**
 * PTYCAP-04 automation controls - the NEUTRAL module (D-11).
 *
 * Kill switch (SC-2) + lifetime inject counter (SC-1) + the atomic reservation
 * that consumes the counter immediately before a send. Every dispatcher gate list
 * and the pipeline delegate here; a ten-adapter fan-out must not import a
 * PTY-named module, so this file depends ONLY on:
 *   - db/postgres.ts (the sql tag),
 *   - TYPE-only imports from pipeline.ts (erased at compile time),
 *   - late dynamic imports (orchestrator/notify.ts, db/dal.ts) inside functions.
 * It must NEVER import gates.ts or governed-pty.ts (module cycle, D-11). The two
 * env parsers that duplicate gates.ts (session inject rate cap, inject outcomes)
 * are held equal to the originals by drift tests.
 *
 * Failure direction: every read path FAILS CLOSED. A DB error is never "allowed".
 *
 * Stable, prefix-parseable block reasons:
 *   automation_halted:<scope>             lifetime_inject_exhausted:<n>>=<cap>
 *   over_session_inject_rate:<n>>=<cap>   lifetime_counter_key_missing
 *   lifetime_counter_error                automation_guard_error
 */
import { randomUUID } from 'node:crypto'
import { sql } from '../db/postgres.ts'
import type { DispatchGate, DispatchRequest } from './pipeline.ts'

// ── constants ────────────────────────────────────────────────────────────────
export const AUTOMATION_KILL_SWITCH_GATE_NAME = 'automation_kill_switch'
export const LIFETIME_COUNTER_GATE_NAME = 'lifetime_counter'
export const KILL_SWITCH_ENV = 'REMO_AUTOMATION_KILL_SWITCH'
export const LIFETIME_CAP_ENV = 'REMO_AUTOMATION_LIFETIME_INJECT_CAP'
export const ALARM_PCT_ENV = 'REMO_TOKEN_CAP_ALARM_PCT'
export const DEFAULT_LIFETIME_INJECT_CAP = 1000
export const DEFAULT_ALARM_PCT = 60
export const LIFETIME_WARN_FRACTION = 0.8

/** Duplicate of orchestrator-rows-dal INJECT_OUTCOMES (drift-tested). */
export const RATE_INJECT_OUTCOMES = ['dispatched', 'queued', 'autospawn_launched', 'autospawn_parked'] as const

const DEFAULT_RATE_CAP = 4
const RATE_WINDOW_MINUTES = 60

// ── env readers ──────────────────────────────────────────────────────────────
function truthyEnv(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

function parseLifetimeCap(raw: string | undefined): { ok: boolean; cap: number } {
  if (raw == null || raw.trim() === '') return { ok: true, cap: DEFAULT_LIFETIME_INJECT_CAP }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return { ok: true, cap: n }
  return { ok: false, cap: DEFAULT_LIFETIME_INJECT_CAP }
}

/** Lifetime inject cap per counter key. Garbage/zero/negative => default, never unbounded. */
export function lifetimeInjectCap(): number {
  return parseLifetimeCap(process.env[LIFETIME_CAP_ENV]).cap
}

/** Daily-token-ceiling alarm threshold percent. Garbage => 60, clamped into (0,100], never off. */
export function alarmPct(): number {
  const raw = process.env[ALARM_PCT_ENV]
  if (raw == null || raw.trim() === '') return DEFAULT_ALARM_PCT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ALARM_PCT
  return Math.min(n, 100)
}

/**
 * Duplicate of gates.maxInjectsPerHour (drift-tested): unset/blank => 4; a finite
 * number is taken as is (zero/negative mean "disabled" to callers); garbage => 4.
 */
export function sessionInjectRateCap(): number {
  const raw = process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR
  if (raw == null || raw.trim() === '') return DEFAULT_RATE_CAP
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_RATE_CAP
}

/**
 * Boot guard: a bad lifetime cap is a safety defect, not a warning (copy of
 * assertTokenCapConfig). A garbage alarm pct only warns - alarmPct() has a safe
 * default and the alarm is never silently off.
 */
export function assertAutomationControlsEnv(): void {
  const raw = process.env[LIFETIME_CAP_ENV]
  if (!parseLifetimeCap(raw).ok) {
    throw new Error(
      `${LIFETIME_CAP_ENV}="${raw}" is not a positive number, so the lifetime inject ceiling would be ` +
        'meaningless. The hub refuses to boot with a bad cap. Set it to a positive number of injects ' +
        `per counter key (default ${DEFAULT_LIFETIME_INJECT_CAP}) or unset it.`,
    )
  }
  const pct = process.env[ALARM_PCT_ENV]
  if (pct != null && pct.trim() !== '') {
    const n = Number(pct)
    if (!Number.isFinite(n) || n <= 0) {
      console.warn(`[automation-controls] ${ALARM_PCT_ENV}="${pct}" is not a positive number; using ${DEFAULT_ALARM_PCT}`)
    }
  }
}

/**
 * Boot guard: migrate.ts swallows per-statement DDL failures, which would make
 * every gate fail closed behind one log line. Resolves when all three tables
 * exist, rejects naming the missing ones.
 */
export async function assertAutomationControlsTables(): Promise<void> {
  const rows = await sql<{ ledger: boolean; kill_switch: boolean; alarms: boolean }[]>`
    SELECT to_regclass('automation_inject_ledger') IS NOT NULL AS ledger,
           to_regclass('automation_kill_switch') IS NOT NULL AS kill_switch,
           to_regclass('token_cap_alarms') IS NOT NULL AS alarms
  `
  const r = rows[0]
  const missing: string[] = []
  if (!r?.ledger) missing.push('automation_inject_ledger')
  if (!r?.kill_switch) missing.push('automation_kill_switch')
  if (!r?.alarms) missing.push('token_cap_alarms')
  if (missing.length > 0) {
    throw new Error(`automation controls tables missing: ${missing.join(', ')} (schema.sql DDL did not apply)`)
  }
}

// ── kill switch ──────────────────────────────────────────────────────────────
export type HaltResult = { halted: false } | { halted: true; scope: string }

/**
 * Fresh-read kill-switch predicate. Env break-glass first (no DB), then ONE
 * select over the engaged rows that apply to this user/session. A DB error is
 * ENGAGED (fail closed, scope 'error').
 */
export async function isAutomationHalted(args: { userId: string; sessionId?: string }): Promise<HaltResult> {
  if (truthyEnv(process.env[KILL_SWITCH_ENV])) return { halted: true, scope: 'env' }
  try {
    const rows = await sql<{ scope: string; engaged: boolean }[]>`
      SELECT scope, engaged FROM automation_kill_switch
      WHERE engaged = true
        AND (scope = 'global'
             OR (scope = 'user' AND user_id = ${args.userId})
             OR (scope = 'session' AND session_id = ${args.sessionId ?? ''}))
      ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'user' THEN 1 ELSE 2 END
      LIMIT 1
    `
    const row = rows[0]
    if (row && row.engaged === true) return { halted: true, scope: row.scope }
    return { halted: false }
  } catch (err: any) {
    console.error(`[automation-controls] kill-switch read failed (fail closed): ${err?.message ?? err}`)
    return { halted: true, scope: 'error' }
  }
}

export async function killSwitchCheck(
  req: DispatchRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const h = await isAutomationHalted({ userId: req.userId, sessionId: req.sessionId })
  if (h.halted) return { ok: false, reason: `automation_halted:${h.scope}` }
  return { ok: true }
}

/** Non-consuming kill-switch gate. The Phase 3 governor slot delegates to the same function. */
export const automationKillSwitchGate: DispatchGate = {
  name: AUTOMATION_KILL_SWITCH_GATE_NAME,
  check: killSwitchCheck,
}

export type KillScope = 'global' | 'user' | 'session'

export interface KillSwitchRow {
  id: string
  scope: KillScope
  user_id: string | null
  session_id: string | null
  engaged: boolean
  reason: string | null
  engaged_by: string
  engaged_at: string
}

/** Idempotent engage: the partial unique indexes allow one engaged row per target. */
export async function engageKillSwitch(args: {
  scope: KillScope
  userId?: string | null
  sessionId?: string | null
  reason?: string | null
  engagedBy: string
}): Promise<{ engaged: true; alreadyEngaged: boolean }> {
  const userId = args.scope === 'global' ? null : (args.userId ?? null)
  const sessionId = args.scope === 'session' ? (args.sessionId ?? null) : null
  const rows = await sql<{ id: string }[]>`
    INSERT INTO automation_kill_switch (scope, user_id, session_id, reason, engaged_by)
    VALUES (${args.scope}, ${userId}, ${sessionId}, ${args.reason ?? null}, ${args.engagedBy})
    ON CONFLICT DO NOTHING
    RETURNING id
  `
  return { engaged: true, alreadyEngaged: rows.length === 0 }
}

/** Releases the engaged row for the target (history row stays). Reports whether one was released. */
export async function releaseKillSwitch(args: {
  scope: KillScope
  userId?: string | null
  sessionId?: string | null
  releasedBy: string
}): Promise<{ released: boolean }> {
  const userId = args.scope === 'global' ? null : (args.userId ?? null)
  const sessionId = args.scope === 'session' ? (args.sessionId ?? null) : null
  const rows = await sql<{ id: string }[]>`
    UPDATE automation_kill_switch
       SET engaged = false, released_by = ${args.releasedBy}, released_at = now()
     WHERE engaged = true
       AND scope = ${args.scope}
       AND user_id IS NOT DISTINCT FROM ${userId}::text
       AND session_id IS NOT DISTINCT FROM ${sessionId}::text
    RETURNING id
  `
  return { released: rows.length > 0 }
}

export async function getKillSwitchState(args: { userId: string }): Promise<{
  env: boolean
  global: KillSwitchRow | null
  user: KillSwitchRow | null
  sessions: KillSwitchRow[]
}> {
  const rows = await sql<KillSwitchRow[]>`
    SELECT id, scope, user_id, session_id, engaged, reason, engaged_by, engaged_at
    FROM automation_kill_switch
    WHERE engaged = true
      AND (scope = 'global' OR ((scope = 'user' OR scope = 'session') AND user_id = ${args.userId}))
    ORDER BY engaged_at DESC
  `
  return {
    env: truthyEnv(process.env[KILL_SWITCH_ENV]),
    global: rows.find((r) => r.scope === 'global') ?? null,
    user: rows.find((r) => r.scope === 'user') ?? null,
    sessions: rows.filter((r) => r.scope === 'session'),
  }
}

// ── lifetime counter ─────────────────────────────────────────────────────────
/** Reserve-row count for a key since its latest reset marker. Page/reset rows never count. */
async function countLifetime(q: any, counterKey: string): Promise<number> {
  const rows = await q`
    SELECT COUNT(*)::text AS n FROM automation_inject_ledger
    WHERE counter_key = ${counterKey}
      AND kind = 'inject'
      AND released_at IS NULL
      AND seq > COALESCE(
        (SELECT MAX(seq) FROM automation_inject_ledger WHERE counter_key = ${counterKey} AND kind = 'reset'),
        0)
  `
  return Number(rows[0]?.n ?? 0)
}

/** Non-consuming lifetime gate body. DB error => block. */
export async function lifetimeCounterCheck(
  req: DispatchRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!req.counterKey) return { ok: false, reason: 'lifetime_counter_key_missing' }
  try {
    const n = await countLifetime(sql, req.counterKey)
    const cap = lifetimeInjectCap()
    if (n >= cap) return { ok: false, reason: `lifetime_inject_exhausted:${n}>=${cap}` }
    return { ok: true }
  } catch (err: any) {
    console.error(`[automation-controls] lifetime count failed (fail closed): ${err?.message ?? err}`)
    return { ok: false, reason: 'lifetime_counter_error' }
  }
}

export const automationLifetimeCounterGate: DispatchGate = {
  name: LIFETIME_COUNTER_GATE_NAME,
  check: lifetimeCounterCheck,
}

/**
 * Size of the SET UNION of the session's trailing-window inject records:
 * unreleased ledger reserve rows (keyed by token) and routine_run_log inject
 * rows (keyed by inject_token, or by a row-unique fallback when NULL). A
 * dispatched inject present in both sources counts ONCE. Never a max.
 */
export async function countRateUnion(sessionId: string, minutes: number = RATE_WINDOW_MINUTES, q: any = sql): Promise<number> {
  const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : RATE_WINDOW_MINUTES
  const rows = await q`
    SELECT COUNT(*)::text AS n FROM (
      SELECT token AS k FROM automation_inject_ledger
       WHERE session_id = ${sessionId}
         AND kind = 'inject'
         AND released_at IS NULL
         AND created_at >= now() - make_interval(mins => ${mins})
      UNION
      SELECT COALESCE(inject_token, 'runlog:' || id) AS k FROM routine_run_log
       WHERE session_id = ${sessionId}
         AND outcome = ANY(${[...RATE_INJECT_OUTCOMES]}::text[])
         AND created_at >= now() - make_interval(mins => ${mins})
    ) u
  `
  return Number(rows[0]?.n ?? 0)
}

export type ReserveResult = { ok: true; count?: number } | { ok: false; reason: string }

export interface ReserveArgs {
  userId: string
  sessionId: string
  token: string
  counterKey: string
  actor?: string
  enforceRate?: boolean
}

/**
 * THE atomic reservation. Inside one transaction, under a per-counter-key
 * advisory lock: token-idempotency, then the lifetime count, then (enforceRate)
 * the trailing-60-minute rate union - lifetime first - then update-or-insert.
 * Pages are claimed AFTER the commit (never inside the lock), best-effort.
 * Any throw => blocked, never ok.
 */
export async function reserveInject(args: ReserveArgs): Promise<ReserveResult> {
  const cap = lifetimeInjectCap()
  let outcome: ReserveResult
  try {
    outcome = await (sql as any).begin(async (tx: any): Promise<ReserveResult> => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'lifetime:' + args.counterKey})::bigint)`
      const existing = (
        await tx`
          SELECT id, released_at FROM automation_inject_ledger
          WHERE counter_key = ${args.counterKey} AND token = ${args.token} AND kind = 'inject'
          LIMIT 1
        `
      )[0]
      if (existing && existing.released_at == null) return { ok: true }

      const n = await countLifetime(tx, args.counterKey)
      if (n >= cap) return { ok: false, reason: `lifetime_inject_exhausted:${n}>=${cap}` }

      if (args.enforceRate) {
        const rateCap = sessionInjectRateCap()
        if (Number.isFinite(rateCap) && rateCap > 0) {
          // Second lock, always AFTER the counter-key lock (fixed order, no deadlock):
          // two different counter keys on ONE session must not both pass the rate check.
          await tx`SELECT pg_advisory_xact_lock(hashtext(${'inject-rate:' + args.sessionId})::bigint)`
          const rn = await countRateUnion(args.sessionId, RATE_WINDOW_MINUTES, tx)
          if (rn >= rateCap) return { ok: false, reason: `over_session_inject_rate:${rn}>=${rateCap}` }
        }
      }

      if (existing) {
        await tx`
          UPDATE automation_inject_ledger SET released_at = NULL
          WHERE id = ${existing.id} AND released_at IS NOT NULL
        `
        return { ok: true, count: n + 1 }
      }
      const inserted = await tx`
        INSERT INTO automation_inject_ledger (user_id, session_id, counter_key, actor, token, kind)
        VALUES (${args.userId}, ${args.sessionId}, ${args.counterKey}, ${args.actor ?? ''}, ${args.token}, 'inject')
        ON CONFLICT (counter_key, token) DO NOTHING
        RETURNING id
      `
      if (inserted.length === 0) return { ok: false, reason: 'lifetime_counter_error' }
      return { ok: true, count: n + 1 }
    })
  } catch (err: any) {
    console.error(`[automation-controls] reserve failed (fail closed): ${err?.message ?? err}`)
    return { ok: false, reason: 'lifetime_counter_error' }
  }

  // Post-commit, best-effort pages. Never changes the reserve result.
  try {
    if (outcome.ok && outcome.count != null && outcome.count >= Math.ceil(LIFETIME_WARN_FRACTION * cap)) {
      await pageLifetime(args, 'warn', outcome.count, cap)
    } else if (!outcome.ok && outcome.reason.startsWith('lifetime_inject_exhausted:')) {
      await pageLifetime(args, 'exhausted', cap, cap)
    }
  } catch (err: any) {
    console.warn(`[automation-controls] lifetime page failed: ${err?.message ?? err}`)
  }
  return outcome
}

/** Append-only compensation: stamp released_at while null. Never deletes, never throws. */
export async function releaseInject(args: { counterKey: string; token: string }): Promise<void> {
  try {
    await sql`
      UPDATE automation_inject_ledger SET released_at = now()
      WHERE counter_key = ${args.counterKey} AND token = ${args.token}
        AND kind = 'inject' AND released_at IS NULL
    `
  } catch (err: any) {
    console.error(`[automation-controls] release failed: ${err?.message ?? err}`)
  }
}

/**
 * Claim a one-shot page for (counter key, kind, reset epoch) through a ledger
 * page row. Exactly one concurrent caller gets claimed:true. After a reset the
 * epoch changes, so the next claim succeeds. Page rows never count as injects.
 */
export async function claimLifetimePage(args: {
  userId: string
  sessionId?: string | null
  counterKey: string
  kind: 'warn' | 'exhausted'
}): Promise<{ claimed: boolean }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO automation_inject_ledger (user_id, session_id, counter_key, actor, token, kind)
    SELECT ${args.userId}::text, ${args.sessionId ?? null}::text, ${args.counterKey}::text, 'page',
           'page:' || ${args.kind}::text || ':' || COALESCE(
             (SELECT MAX(seq) FROM automation_inject_ledger WHERE counter_key = ${args.counterKey} AND kind = 'reset'),
             0)::text,
           'page'
    ON CONFLICT (counter_key, token) DO NOTHING
    RETURNING id
  `
  return { claimed: rows.length > 0 }
}

async function pageLifetime(args: ReserveArgs, kind: 'warn' | 'exhausted', n: number, cap: number): Promise<void> {
  const claim = await claimLifetimePage({
    userId: args.userId,
    sessionId: args.sessionId,
    counterKey: args.counterKey,
    kind,
  })
  if (!claim.claimed) return
  try {
    const { fanOutNotify } = await import('../orchestrator/notify.ts')
    const what =
      kind === 'warn'
        ? `has used ${n} of ${cap} lifetime automation injects (80 percent warning)`
        : `is EXHAUSTED at ${n} of ${cap} lifetime automation injects; further injects for this key are refused`
    await fanOutNotify({
      userId: args.userId,
      sessionId: args.sessionId,
      event: 'failure',
      level: 'blocking',
      detail:
        `Automation counter ${args.counterKey} ${what}. ` +
        `Raise ${LIFETIME_CAP_ENV} (hub env) or reset it with POST /api/automation/lifetime/reset ` +
        `{"counter_key":"${args.counterKey}"}.`,
      channels: ['telegram', 'inapp', 'email', 'push'],
    })
  } catch (err: any) {
    console.warn(`[automation-controls] lifetime notify failed: ${err?.message ?? err}`)
  }
}

/** Append a reset marker. Only when the caller already owns rows for the key; history is never touched. */
export async function resetLifetimeCounter(args: {
  userId: string
  counterKey: string
  actor?: string
}): Promise<{ ok: true } | { ok: false; reason: 'unknown_counter_key' }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO automation_inject_ledger (user_id, counter_key, actor, token, kind)
    SELECT ${args.userId}::text, ${args.counterKey}::text, ${args.actor ?? ''}::text, ${'reset:' + randomUUID()}::text, 'reset'
    WHERE EXISTS (
      SELECT 1 FROM automation_inject_ledger
      WHERE counter_key = ${args.counterKey} AND user_id = ${args.userId}
    )
    RETURNING id
  `
  if (rows.length === 0) return { ok: false, reason: 'unknown_counter_key' }
  return { ok: true }
}

// ── pipeline hooks ───────────────────────────────────────────────────────────
export type GuardResult = { ok: true; reserved: boolean } | { ok: false; reason: string }

/**
 * Pre-send guard (before store.open): machine requests re-check the kill switch;
 * a counterKey triggers the atomic reservation. A throw => automation_guard_error.
 */
export async function preSendGuard(
  req: DispatchRequest,
  opts: { machine: boolean; enforceRate: boolean },
): Promise<GuardResult> {
  try {
    if (opts.machine) {
      const h = await isAutomationHalted({ userId: req.userId, sessionId: req.sessionId })
      if (h.halted) return { ok: false, reason: `automation_halted:${h.scope}` }
    }
    if (req.counterKey) {
      const r = await reserveInject({
        userId: req.userId,
        sessionId: req.sessionId,
        token: req.token,
        counterKey: req.counterKey,
        enforceRate: opts.enforceRate,
      })
      if (!r.ok) return { ok: false, reason: r.reason }
      return { ok: true, reserved: true }
    }
    return { ok: true, reserved: false }
  } catch (err: any) {
    console.error(`[automation-controls] preSendGuard failed (fail closed): ${err?.message ?? err}`)
    return { ok: false, reason: 'automation_guard_error' }
  }
}

/** Last halt check, immediately before deps.send (linearization, D-09c). */
export async function finalHaltCheck(
  req: DispatchRequest,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const h = await isAutomationHalted({ userId: req.userId, sessionId: req.sessionId })
  if (h.halted) return { ok: false, reason: `automation_halted:${h.scope}` }
  return { ok: true }
}

// ── key resolver ─────────────────────────────────────────────────────────────
/**
 * Orchestrator counter key: task:<taskId> when the dispatcher knows its task,
 * else the session's 1:1 orchestrator task (idx_scheduled_tasks_orchestrator_unique),
 * else session:<sessionId>. A DB error PROPAGATES (the caller fails closed).
 */
export async function resolveOrchestratorCounterKey(args: {
  userId: string
  sessionId: string
  taskId?: string | null
}): Promise<string> {
  if (args.taskId) return `task:${args.taskId}`
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM scheduled_tasks
    WHERE session_id = ${args.sessionId} AND task_type = 'orchestrator'
    LIMIT 1
  `
  const id = rows[0]?.id
  return id ? `task:${id}` : `session:${args.sessionId}`
}
