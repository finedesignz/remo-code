/**
 * pty-persistence.ts — Phase-16 R-PTY-07 / R-PTY-27: supervisor-owned PTY
 * persistence + scrollback replay + the EXPLICIT detach-vs-kill policy.
 *
 * The interactive `claude` PTY is owned by the SUPERVISOR, not by any one client
 * WS connection. A dropped phone/browser connection must NOT kill the session;
 * a reattach must restore live state with scrollback intact.
 *
 * HOSTING (Option C — 16-SPIKE-FINDINGS-rust-conpty.md): the PTY itself lives in
 * the Tauri RUST process (`pty_host.rs`), which owns the authoritative ConPTY +
 * its own scrollback ring and ties PTY lifetime to the supervisor process. This
 * Bun-side module is the SUPERVISOR-SIDE COORDINATOR over `claude-pty-bridge.ts`:
 * it tracks live sessions, applies the detach-vs-kill policy, mirrors the hub's
 * idle-teardown semantics so persistent PTYs don't leak, and keeps a bounded
 * output ring-buffer as the CROSS-PLATFORM baseline (used directly on any
 * non-Rust-host context and exercised by the reattach test). On POSIX where tmux
 * is available the same coordinator can front a detached tmux session for
 * survival across supervisor restarts (capability-gated; see `tmuxAvailable`).
 *
 * DETACH-vs-KILL POLICY (H7 / R-PTY-27):
 *   - client WS DISCONNECT          → DETACH (PTY + scrollback survive; reattach)
 *   - session CLOSE                 → KILL
 *   - idle-reap (no subscribers)    → KILL  (mirrors hub idle-teardown grace)
 *   - supervisor SHUTDOWN (SIGINT/SIGTERM/exit) → KILL all
 * On Option C the Rust host also kills every PTY on a supervisor crash
 * (process-ownership dead-man's-switch), so even a hard crash leaves no orphan.
 *
 * Raw bytes only — this module does NOT import RunnerEvent / agent-protocol /
 * session-bridge, and never reads ~/.claude/.credentials.json.
 */
import { execFileSync } from 'node:child_process'

/** Default scrollback ring cap (bytes) — matches the Rust host's 256 KiB. */
export const DEFAULT_SCROLLBACK_CAP_BYTES = 256 * 1024

/** Default idle-reap grace (seconds) — mirrors the hub's
 *  REMO_SESSION_IDLE_GRACE_SECONDS default of 300s. 0 disables idle reaping. */
export const DEFAULT_IDLE_GRACE_SECONDS = Number(
  process.env.REMO_SESSION_IDLE_GRACE_SECONDS ?? 300,
)

/** A bounded byte ring-buffer keeping the last N bytes for scrollback replay. */
export class RingBuffer {
  private buf = ''
  constructor(private capBytes = DEFAULT_SCROLLBACK_CAP_BYTES) {}
  push(bytes: string): void {
    this.buf += bytes
    if (this.buf.length > this.capBytes) {
      this.buf = this.buf.slice(this.buf.length - this.capBytes)
    }
  }
  snapshot(): string {
    return this.buf
  }
  clear(): void {
    this.buf = ''
  }
  get size(): number {
    return this.buf.length
  }
}

/** Minimal lifecycle surface the coordinator needs from a PTY host/bridge. */
export interface PersistablePty {
  /** KILL the underlying PTY (idempotent). */
  kill(): void
}

interface SessionEntry {
  sessionId: string
  pty: PersistablePty
  ring: RingBuffer
  /** distinct live client connections currently attached. */
  subscribers: number
  /** pending idle-reap timer when subscribers hit 0. */
  idleTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Supervisor-owned persistence coordinator. One instance per supervisor process.
 */
export class PtyPersistence {
  private sessions = new Map<string, SessionEntry>()

  constructor(
    private idleGraceSeconds = DEFAULT_IDLE_GRACE_SECONDS,
    private scrollbackCapBytes = DEFAULT_SCROLLBACK_CAP_BYTES,
  ) {}

  /** Register a freshly-started PTY for a session. Idempotent per session. */
  register(sessionId: string, pty: PersistablePty): SessionEntry {
    let entry = this.sessions.get(sessionId)
    if (entry) return entry
    entry = {
      sessionId,
      pty,
      ring: new RingBuffer(this.scrollbackCapBytes),
      subscribers: 0,
      idleTimer: null,
    }
    this.sessions.set(sessionId, entry)
    return entry
  }

  /** Record live PTY output into the session ring (baseline scrollback). */
  recordOutput(sessionId: string, bytes: string): void {
    this.sessions.get(sessionId)?.ring.push(bytes)
  }

  /** A client ATTACHED — bump subscriber count, cancel any idle-reap, and
   *  return the buffered scrollback to replay before live output resumes. */
  attach(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry) return ''
    entry.subscribers++
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    return entry.ring.snapshot()
  }

  /**
   * A client WS DISCONNECTED — DETACH (do NOT kill). The PTY + scrollback
   * survive for a later reattach. If this was the last subscriber, start the
   * idle-reap grace timer (mirrors hub idle-teardown). Reaching 0 subscribers is
   * NOT an immediate kill — only the grace timer firing reaps it.
   */
  detach(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers > 0) return
    if (this.idleGraceSeconds <= 0) return // idle reaping disabled
    if (entry.idleTimer) return
    const t = setTimeout(() => {
      const e = this.sessions.get(sessionId)
      if (!e) return
      e.idleTimer = null
      if (e.subscribers > 0) return // a reattach raced the timer
      this.kill(sessionId, 'idle_no_subscribers')
    }, this.idleGraceSeconds * 1000)
    if (typeof (t as any).unref === 'function') (t as any).unref()
    entry.idleTimer = t
  }

  /** KILL the PTY (session close / idle-reap / shutdown). Idempotent. */
  kill(sessionId: string, _reason = 'session_close'): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    try { entry.pty.kill() } catch {}
    this.sessions.delete(sessionId)
  }

  /** KILL every hosted PTY — called on supervisor SHUTDOWN. */
  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id, 'supervisor_shutdown')
    }
  }

  // ── read-only accessors (tests + monitoring) ──
  isAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }
  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.subscribers ?? 0
  }
  scrollback(sessionId: string): string {
    return this.sessions.get(sessionId)?.ring.snapshot() ?? ''
  }
  idleReapPending(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.idleTimer
  }
  liveCount(): number {
    return this.sessions.size
  }
}

/**
 * Capability probe: is `tmux` available on this host? POSIX-only survival across
 * supervisor restarts uses a detached tmux session; on Windows (no native tmux)
 * the supervisor-owned persistent PTY + ring-buffer baseline is used instead.
 * Cached after first probe. Windows always returns false.
 */
let _tmuxAvailable: boolean | null = null
export function tmuxAvailable(): boolean {
  if (_tmuxAvailable !== null) return _tmuxAvailable
  if (process.platform === 'win32') {
    _tmuxAvailable = false
    return false
  }
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    _tmuxAvailable = true
  } catch {
    _tmuxAvailable = false
  }
  return _tmuxAvailable
}

/** Test-only: reset the cached tmux probe. */
export function _resetTmuxProbeForTests(): void {
  _tmuxAvailable = null
}
