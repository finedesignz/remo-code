/**
 * Stale-ask reaper (milestone ASK, Phase 2).
 *
 * Same shape + the same idempotency discipline as `hub/src/scheduler/run-reaper.ts`:
 * an ask whose CLI turn never completes would otherwise sit `queued`/`dispatched`
 * forever and the external caller would poll it forever. This sweep finalizes any
 * non-terminal ask older than REMO_ASK_MAX_MS as `timeout`.
 *
 * Idempotency: `finalizeAsk` is a CONDITIONAL UPDATE (`AND status IN
 * ('queued','dispatched')`), so a reply that lands the instant after a reap cannot
 * double-finalize — the loser of the race writes nothing.
 */
import { finalizeAsk, loadOpenAsks } from '../db/ask-dal.ts'

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envFlagOn(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** Hard ask ceiling. Default 15min. */
export function askMaxMs(): number {
  return parsePositiveIntEnv(process.env.REMO_ASK_MAX_MS, 900_000)
}

/** Sweep cadence. Default 60s. */
export function askReaperIntervalMs(): number {
  return parsePositiveIntEnv(process.env.REMO_ASK_REAPER_INTERVAL_MS, 60_000)
}

export interface AskReaperDeps {
  loadOpenAsks: typeof loadOpenAsks
  finalizeAsk: typeof finalizeAsk
}

const REAL_DEPS: AskReaperDeps = { loadOpenAsks, finalizeAsk }

/** One pass. Returns the ask ids this pass actually finalized (won the race for). */
export async function reapStaleAsks(
  now: number = Date.now(),
  deps?: Partial<AskReaperDeps>,
): Promise<string[]> {
  const d: AskReaperDeps = { ...REAL_DEPS, ...deps }
  const reaped: string[] = []

  let asks: Array<{ id: string; created_at_ms: number }> = []
  try {
    asks = await d.loadOpenAsks()
  } catch (err: any) {
    console.warn(`[ask-reaper] open-ask load failed: ${err?.message ?? err}`)
    return reaped
  }

  const ceiling = askMaxMs()
  for (const ask of asks) {
    if (!(now - ask.created_at_ms >= ceiling)) continue
    try {
      const won = await d.finalizeAsk(ask.id, 'timeout', { reason: 'ask_timeout' })
      if (won) reaped.push(ask.id)
    } catch (err: any) {
      console.warn(`[ask-reaper] reap failed ask=${ask.id}: ${err?.message ?? err}`)
    }
  }
  return reaped
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic sweep (idempotent). No-op when REMO_ASK_REAPER_DISABLED. */
export function startAskReaperSweep(): void {
  if (envFlagOn(process.env.REMO_ASK_REAPER_DISABLED)) {
    console.log('[ask-reaper] disabled via REMO_ASK_REAPER_DISABLED — sweep not started')
    return
  }
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    reapStaleAsks().catch((err) =>
      console.warn(`[ask-reaper] sweep pass failed: ${err?.message ?? err}`),
    )
  }, askReaperIntervalMs())
  ;(sweepTimer as any)?.unref?.()
}

export function stopAskReaperSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
