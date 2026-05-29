/**
 * Reconnect grace buffer — single deep module (Phase 1, C1).
 *
 * Replaces the three near-identical copies in `scheduler/grace.ts`,
 * `error-capture/grace.ts`, and `revanote/grace.ts`. When a dispatch finds the
 * target agent offline, the pipeline parks an opaque `replay()` thunk here
 * keyed by a target key (sessionId or supervisorId). On agent reconnect the
 * pipeline calls `drain(targetKey)` to re-run each parked replay. Entries older
 * than the TTL (default 10 min — the exact window the three legacy copies use:
 * `10 * 60 * 1000` ms) are expired by a 60s sweep and dropped without replay.
 *
 * In-memory only — best-effort across hub restarts (documented).
 *
 * Depth: the subsystem-specific behaviour (what "expire" persists, what
 * "replay" re-runs) is entirely captured in the opaque thunks the caller
 * registers; this module owns only the buffer, the TTL, and the sweep.
 */

/** Default grace window — matches the legacy `TTL_MS = 10 * 60 * 1000`. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60_000

interface Pending {
  replay: () => Promise<void>
  expiresAt: number
}

export interface GraceBuffer {
  /** Park a replay thunk for `targetKey`. ttlMs defaults to DEFAULT_TTL_MS. */
  register(targetKey: string, replay: () => Promise<void>, ttlMs?: number): void
  /** Re-run every live parked replay for `targetKey` (called on reconnect). */
  drain(targetKey: string): Promise<void>
}

class GraceBufferImpl implements GraceBuffer {
  private byTarget = new Map<string, Pending[]>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startSweeper()
  }

  register(targetKey: string, replay: () => Promise<void>, ttlMs: number = DEFAULT_TTL_MS): void {
    const list = this.byTarget.get(targetKey) ?? []
    list.push({ replay, expiresAt: Date.now() + ttlMs })
    this.byTarget.set(targetKey, list)
  }

  async drain(targetKey: string): Promise<void> {
    const list = this.byTarget.get(targetKey)
    if (!list || list.length === 0) return
    this.byTarget.delete(targetKey)
    const now = Date.now()
    for (const p of list) {
      // Expired entries are dropped — the replay thunk owns its own
      // expire-side-effects via the sweep; here we simply skip.
      if (p.expiresAt < now) continue
      try {
        await p.replay()
      } catch (err: any) {
        console.error(`[dispatch.grace] drain replay failed target=${targetKey}: ${err?.message ?? err}`)
      }
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, list] of this.byTarget) {
      const live: Pending[] = []
      for (const p of list) {
        if (p.expiresAt >= now) live.push(p)
      }
      if (live.length === 0) this.byTarget.delete(key)
      else this.byTarget.set(key, live)
    }
  }

  private startSweeper(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    // Don't keep the process alive for the sweep alone.
    if (typeof this.sweepTimer === 'object' && this.sweepTimer && 'unref' in this.sweepTimer) {
      ;(this.sweepTimer as any).unref?.()
    }
  }

  // ── test helpers ──────────────────────────────────────────────────────────
  /** Force one sweep pass synchronously (test-only). */
  _sweepNow(): void {
    this.sweep()
  }

  /** Number of live pending entries for a key (test-only). */
  _pendingCount(targetKey: string): number {
    return this.byTarget.get(targetKey)?.length ?? 0
  }

  /** Clear all buffers (test-only). */
  _reset(): void {
    this.byTarget.clear()
  }

  /** Stop the sweep timer (test-only / shutdown). */
  _stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}

let singleton: GraceBufferImpl | null = null

/** Process-wide singleton grace buffer (owns the 60s sweep). */
export function getGraceBuffer(): GraceBufferImpl {
  if (!singleton) singleton = new GraceBufferImpl()
  return singleton
}
