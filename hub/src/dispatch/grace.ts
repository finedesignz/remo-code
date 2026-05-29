/**
 * Reconnect grace buffer — single deep module (Phase 1, C1).
 *
 * Replaces the three near-identical copies in `scheduler/grace.ts`,
 * `error-capture/grace.ts`, and `revanote/grace.ts`. When a dispatch finds the
 * target agent offline, the pipeline parks an opaque `replay()` thunk here
 * keyed by a target key (sessionId or supervisorId). On agent reconnect the
 * pipeline calls `drain(targetKey)` to re-run each parked replay. Entries older
 * than the TTL (default 10 min — the exact window the three legacy copies use:
 * `10 * 60 * 1000` ms) are NOT replayed; instead their optional `onExpire`
 * side-effect fires exactly once (legacy parity: all three copies expire-marked
 * the run as skipped/failed_offline on TTL lapse — at BOTH drain-time and
 * sweep-time). The 60s sweep observes lapses between drains.
 *
 * In-memory only — best-effort across hub restarts (documented).
 *
 * Depth: the subsystem-specific behaviour (what "expire" persists, what
 * "replay" re-runs) is entirely captured in the opaque thunks the caller
 * registers; this module owns only the buffer, the TTL, the sweep, and the
 * once-only expire dispatch.
 */

/** Default grace window — matches the legacy `TTL_MS = 10 * 60 * 1000`. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60_000

interface Pending {
  replay: () => Promise<void>
  onExpire?: () => Promise<void>
  expiresAt: number
}

export interface GraceRegisterOpts {
  /** Grace window in ms; defaults to DEFAULT_TTL_MS (10 min). */
  ttlMs?: number
  /**
   * Side-effect fired EXACTLY ONCE when this entry is dropped due to TTL
   * expiry — at either drain-time or sweep-time, whichever observes the
   * lapse first. Reproduces the legacy expire-marking that all three copies
   * ran on TTL lapse:
   *   - scheduler:      updateRunStatus(skipped, 'target_offline')
   *   - error-capture:  updateErrorDispatchStatus(skipped, 'target_offline_expired')
   *   - revanote:       updateAnnotationStatus('failed_offline', {skip_reason:'target_offline_expired'})
   * Errors are swallowed/logged — they never break the sweep loop.
   */
  onExpire?: () => Promise<void>
}

export interface GraceBuffer {
  /** Park a replay thunk for `targetKey`. */
  register(targetKey: string, replay: () => Promise<void>, opts?: GraceRegisterOpts): void
  /** Re-run every live parked replay for `targetKey` (called on reconnect). */
  drain(targetKey: string): Promise<void>
}

class GraceBufferImpl implements GraceBuffer {
  private byTarget = new Map<string, Pending[]>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startSweeper()
  }

  register(targetKey: string, replay: () => Promise<void>, opts: GraceRegisterOpts = {}): void {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    const list = this.byTarget.get(targetKey) ?? []
    list.push({ replay, onExpire: opts.onExpire, expiresAt: Date.now() + ttlMs })
    this.byTarget.set(targetKey, list)
  }

  async drain(targetKey: string): Promise<void> {
    const list = this.byTarget.get(targetKey)
    if (!list || list.length === 0) return
    this.byTarget.delete(targetKey)
    const now = Date.now()
    for (const p of list) {
      // TTL-lapsed entries fire their expire side-effect (legacy parity:
      // scheduler/error-capture/revanote all expire-mark on drain-time lapse)
      // then are dropped — never replayed.
      if (p.expiresAt < now) {
        await this.fireExpire(targetKey, p)
        continue
      }
      try {
        await p.replay()
      } catch (err: any) {
        console.error(`[dispatch.grace] drain replay failed target=${targetKey}: ${err?.message ?? err}`)
      }
    }
  }

  /** Fire an entry's onExpire side-effect once; swallow + log any error. */
  private async fireExpire(targetKey: string, p: Pending): Promise<void> {
    if (!p.onExpire) return
    try {
      await p.onExpire()
    } catch (err: any) {
      console.error(`[dispatch.grace] onExpire failed target=${targetKey}: ${err?.message ?? err}`)
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, list] of this.byTarget) {
      const live: Pending[] = []
      for (const p of list) {
        if (p.expiresAt >= now) {
          live.push(p)
        } else {
          // Sweep-time TTL lapse: fire the expire side-effect (legacy parity —
          // all three copies expire-marked in their 60s sweep). Fire-and-forget
          // so one slow/failing thunk never stalls the sweep loop.
          void this.fireExpire(key, p)
        }
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
