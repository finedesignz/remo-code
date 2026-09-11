/**
 * pty-persistence.ts — Phase-16 R-PTY-07 / R-PTY-27: supervisor-owned PTY
 * persistence + scrollback replay + the EXPLICIT detach-vs-kill policy.
 *
 * The interactive `claude` PTY is owned by the SUPERVISOR, not by any one client
 * WS connection. A dropped phone/browser connection must NOT kill the session;
 * a reattach must restore live state (scrollback replay is Rust-host-only, see
 * below).
 *
 * HOSTING (Option C — 16-SPIKE-FINDINGS-rust-conpty.md): the PTY itself lives in
 * the Tauri RUST process (`pty_host.rs`), which owns the authoritative ConPTY,
 * its own scrollback ring, AND replay-on-(re)attach (delivered via
 * `onScrollback` in `claude-pty-bridge.ts`), and ties PTY lifetime to the
 * supervisor process. This Bun-side module is the SUPERVISOR-SIDE COORDINATOR
 * over `claude-pty-bridge.ts`: it tracks live sessions, applies the
 * detach-vs-kill policy, and mirrors the hub's idle-teardown semantics so
 * persistent PTYs don't leak. On POSIX where tmux is available the same
 * coordinator can front a detached tmux session for survival across
 * supervisor restarts (capability-gated; see `tmuxAvailable`).
 *
 * DETACH-vs-KILL POLICY (H7 / R-PTY-27):
 *   - client WS DISCONNECT          → DETACH (PTY survives; reattach)
 *   - session CLOSE                 → KILL
 *   - idle-reap (no subscribers)    → KILL  (mirrors hub idle-teardown grace)
 *   - supervisor SHUTDOWN (SIGINT/SIGTERM/exit) → KILL all
 * On Option C the Rust host also kills every PTY on a supervisor crash
 * (process-ownership dead-man's-switch), so even a hard crash leaves no orphan.
 *
 * Scrollback replay is Rust-host-only (`pty_host.rs`'s own ring, delivered via
 * `onScrollback` in `claude-pty-bridge.ts` on (re)attach) — this Bun-side
 * coordinator used to ALSO keep a per-session `RingBuffer` fed by every PTY
 * byte (`recordOutput`), but nothing ever read it back: `attach()`'s replay
 * return value and the `scrollback()` accessor had no production caller, only
 * tests. Removed; `safeTrimPoint`/`RingBuffer` stay exported as pure utilities
 * because the Rust-parity fixture tests (`pty-persistence-trim.test.ts`)
 * exercise them directly.
 *
 * Raw bytes only — this module does NOT import RunnerEvent / agent-protocol /
 * session-bridge, and never reads ~/.claude/.credentials.json.
 */
import { execFileSync } from 'node:child_process'

/**
 * Default scrollback ring cap (bytes) — MUST match the Rust host's
 * `SCROLLBACK_CAP_BYTES` (supervisor/tauri/src-tauri/src/pty_host.rs).
 *
 * 4 MiB (was 1 MiB, was 256 KiB before that). The ring holds RAW PTY bytes, and
 * a TUI's cursor-motion / SGR escape sequences are most of that volume. Since
 * the client CLEARS its buffer on every (re)attach and re-writes ONLY this ring
 * (TerminalSurface.tsx term.clear()+write()), the ring is the hard ceiling on
 * how far a reconnected/remounted client can scroll back — and on mobile,
 * (re)attach is NOT rare: MobileAccordionRow fully unmounts/remounts
 * TerminalSurface on every panel collapse/expand (`{expanded && <TerminalSurface
 * .../>}`), and iOS routinely reloads a backgrounded PWA/tab. 1 MiB was proven
 * (mobile scrollback-depth investigation, 2026-09) too shallow for real session
 * volume: 4 MiB (~4x) at a bounded, per-session cost (base64 replay frame ≈
 * 5.5 MB, still under the 10 MB WS message cap).
 */
export const DEFAULT_SCROLLBACK_CAP_BYTES = 4 * 1024 * 1024

/** Default idle-reap grace (seconds) — mirrors the hub's
 *  REMO_SESSION_IDLE_GRACE_SECONDS default of 300s. 0 disables idle reaping. */
export const DEFAULT_IDLE_GRACE_SECONDS = Number(
  process.env.REMO_SESSION_IDLE_GRACE_SECONDS ?? 300,
)

/**
 * Maximum distance `safeTrimPoint` may move a cut BACKWARD from `rawCut`
 * (bytes). This is the availability half of the trim contract.
 *
 * Holding the cut back to the start of the sequence enclosing `rawCut` is what
 * keeps a replay from starting mid-sequence — but an enclosing sequence that
 * never terminates would otherwise pin the ring open forever: every push would
 * hold back to the same front byte, `drain(0..0)` would trim nothing, and the
 * ring would grow without bound until the replay frame blew past the hub's
 * 10 MB WS message cap and scrollback died for the session (round-4 QC MAJOR
 * F2). So the hold-back is capped: if the enclosing sequence started more than
 * MAX_TRIM_HOLDBACK_BYTES before `rawCut`, we cut at `rawCut` and accept ONE
 * garbled sequence in the replay rather than losing scrollback entirely.
 *
 * 64 KiB is far larger than any real control sequence (a long OSC-8 hyperlink
 * or OSC-0 title is hundreds of bytes); the only things it truncates are bulk
 * payloads (sixel/DCS graphics) and genuinely malformed/binary output, both of
 * which are already unreplayable as a fragment.
 */
export const MAX_TRIM_HOLDBACK_BYTES = 64 * 1024

/**
 * Minimum overflow (bytes) that must accumulate before the ring re-slices.
 * Trimming copies the retained region, so trimming on every 1-byte push makes
 * `push` O(ring size); batching makes it O(1) amortized. Steady-state ring size
 * is therefore `cap + chunk`, still well inside `cap + MAX_TRIM_HOLDBACK_BYTES`.
 * Capped by the ring's own capacity so tiny test rings still trim.
 */
export const TRIM_CHUNK_BYTES = 4096

/** Escape-grammar parser states (ECMA-48 / xterm). */
const enum EscState {
  /** Not inside any sequence — a safe cut point. */
  Ground = 0,
  /** ESC consumed, second byte not yet seen. */
  Esc = 1,
  /** nF sequence (ESC + 0x20-0x2F...) awaiting its 0x30-0x7E final byte. */
  NfIntermediate = 2,
  /** CSI (ESC [) collecting params/intermediates, awaiting a 0x40-0x7E final. */
  CsiParam = 3,
  /** String sequence (OSC/DCS/PM/APC/SOS) awaiting BEL or ST. */
  StringPayload = 4,
  /** ESC seen inside a string payload — only `ESC \` (ST) closes it. */
  StringEsc = 5,
}

/**
 * Advance the escape-sequence parser by one byte.
 *
 * Grammar (ECMA-48 / xterm), after ESC:
 *  - 0x20-0x2F  intermediate(s), then a final 0x30-0x7E  → nF (e.g. `ESC ( B`)
 *  - 0x30-0x3F  Fp  → COMPLETE two-byte escape (e.g. `ESC 7`, `ESC =`)
 *  - 0x60-0x7E  Fs  → COMPLETE two-byte escape (e.g. `ESC c`)
 *  - 0x5B `[`   CSI → params/intermediates 0x20-0x3F, final 0x40-0x7E
 *  - 0x5D `]` OSC, 0x50 `P` DCS, 0x5E `^` PM, 0x5F `_` APC, 0x58 `X` SOS
 *               → string sequence, closed by BEL (0x07) or ST (`ESC \`)
 *  - any other Fe (0x40-0x5F) → COMPLETE two-byte escape
 *
 * Inside a string sequence an embedded ESC that is not `ESC \` does NOT close
 * it — it is payload (or an error) and the sequence stays open. That is the
 * defect round-4 QC found (F1): treating `ESC 7` / `ESC =` / `ESC ( B` inside
 * an open OSC as if it closed the OSC.
 */
function stepEscState(state: EscState, byte: number): EscState {
  switch (state) {
    case EscState.Ground:
      return byte === 0x1b ? EscState.Esc : EscState.Ground
    case EscState.Esc:
      if (byte >= 0x20 && byte <= 0x2f) return EscState.NfIntermediate
      if (byte === 0x5b) return EscState.CsiParam
      if (byte === 0x5d || byte === 0x50 || byte === 0x5e || byte === 0x5f || byte === 0x58) {
        return EscState.StringPayload
      }
      // Fp / Fs / any other Fe — a complete two-byte escape. Anything else
      // (a stray C0 byte) is malformed; treat it as consumed rather than
      // holding the parser open on garbage.
      return EscState.Ground
    case EscState.NfIntermediate:
      return byte >= 0x20 && byte <= 0x2f ? EscState.NfIntermediate : EscState.Ground
    case EscState.CsiParam:
      return byte >= 0x20 && byte <= 0x3f ? EscState.CsiParam : EscState.Ground
    case EscState.StringPayload:
      if (byte === 0x07) return EscState.Ground
      return byte === 0x1b ? EscState.StringEsc : EscState.StringPayload
    case EscState.StringEsc:
      if (byte === 0x5c) return EscState.Ground // ST
      return byte === 0x1b ? EscState.StringEsc : EscState.StringPayload
  }
}

/**
 * A raw byte-count trim (`buf.slice(rawCut)`) can land INSIDE an escape
 * sequence (CSI `ESC [ ... final`, OSC `ESC ] ... BEL/ST`, DCS, nF, ...).
 * Replaying a stream that *starts* mid-sequence desyncs the client's terminal
 * parser: the orphaned tail (e.g. `38;5;6m`) prints as literal garbage, and the
 * sequence that should have painted the next line gets eaten as parameters —
 * rendering as blank/garbled lines at the top of the replay (reproduced against
 * a real xterm.js parser, mobile scrollback-depth investigation 2026-09).
 *
 * This is a FORWARD parse, not a backward scan. Every prior attempt scanned
 * backward from `rawCut` looking for an ESC and then judged that ESC "on its
 * own terms" (#460 byte-range check, #462 windowed type-aware scan, #468
 * unwindowed walk). All three were wrong for the same structural reason: an
 * ESC byte in isolation carries no information about whether it is a sequence
 * introducer or payload inside an enclosing string sequence, and a backward
 * scan cannot tell the difference without parsing forward anyway. Round-4 QC
 * proved it: 21,055/50,000 cases returned a cut strictly inside an open
 * sequence (F1).
 *
 * `buf` index 0 is GROUND by construction — the ring only ever starts at a
 * previous safe cut (a sequence start, or a ground position) — so parsing
 * forward from 0 to `rawCut` yields the true parser state AT `rawCut`. The
 * scan is O(rawCut), i.e. O(bytes pushed since the last trim), which is what
 * makes RingBuffer.push O(1) amortized instead of O(ring size).
 *
 * Returns `rawCut` when it is a ground (safe) position, otherwise the start
 * index of the sequence enclosing it — unless that start is more than
 * MAX_TRIM_HOLDBACK_BYTES back, in which case `rawCut` is returned so the ring
 * stays bounded (see MAX_TRIM_HOLDBACK_BYTES). The result is never > `rawCut`.
 */
class TrimScanner {
  state: EscState = EscState.Ground
  /** Start index of the sequence currently open, in CURRENT buffer coords. */
  seqStart = -1
  /** How many leading bytes of the current buffer have been parsed. */
  parsed = 0

  /**
   * Parse forward to `limit`, reading bytes through `read`. Only ever moves
   * forward — O(bytes consumed), which is what makes the ring O(1) amortized.
   */
  advanceTo(read: (i: number) => number, limit: number): void {
    for (let i = this.parsed; i < limit; i++) {
      if (this.state === EscState.Ground) this.seqStart = i
      this.state = stepEscState(this.state, read(i))
    }
    if (limit > this.parsed) this.parsed = limit
  }

  /** The safe cut for `rawCut`, given the parser has been advanced to it. */
  cutFor(rawCut: number, maxHoldback: number): number {
    if (this.state === EscState.Ground) return rawCut
    if (rawCut - this.seqStart > maxHoldback) return rawCut
    return this.seqStart
  }

  /** Rebase after the buffer's leading `cut` bytes were dropped. */
  shift(cut: number): void {
    if (this.state !== EscState.Ground && this.seqStart >= cut) {
      this.seqStart -= cut
      this.parsed -= cut
      return
    }
    // Either we were at ground, or the cut landed strictly inside the open
    // sequence (holdback exceeded). Both leave the new front byte as the
    // parser's fresh starting point, which is exactly what a from-scratch
    // safeTrimPoint() assumes — so reset and let it re-derive.
    this.state = EscState.Ground
    this.seqStart = -1
    this.parsed = 0
  }
}

export function safeTrimPoint(
  buf: string,
  rawCut: number,
  maxHoldback = MAX_TRIM_HOLDBACK_BYTES,
): number {
  if (rawCut <= 0) return 0
  const scanner = new TrimScanner()
  scanner.advanceTo((i) => buf.charCodeAt(i), Math.min(rawCut, buf.length))
  return scanner.cutFor(rawCut, maxHoldback)
}

/**
 * A bounded ring of the last N BYTES for scrollback replay.
 *
 * Storage is a `Uint8Array`, matching the Rust host's `Vec<u8>` ring exactly
 * (round-4 QC F4). `push` takes a latin1 BYTE STRING — every JS char is one PTY
 * byte (0x00-0xFF) — and `snapshot` returns one. Never push a decoded UTF-16
 * string: it would break both the byte cap and the escape-grammar scan. Byte
 * storage also keeps `push` genuinely O(1) amortized; a string ring re-flattens
 * its rope on every indexed read, which measured 840 us/push at a 4 MiB cap.
 *
 * Trimming keeps ONE persistent escape-grammar scanner across pushes rather
 * than re-parsing the overflow each time, so `push` is O(bytes pushed)
 * amortized regardless of ring size (round-4 QC MAJOR F2). Size is bounded by
 * `cap + MAX_TRIM_HOLDBACK_BYTES`.
 */
export class RingBuffer {
  /** Backing store. Only `[0, len)` is live. */
  private bytes = new Uint8Array(0)
  private len = 0
  private scanner = new TrimScanner()
  constructor(private capBytes = DEFAULT_SCROLLBACK_CAP_BYTES) {}

  private reserve(extra: number): void {
    const need = this.len + extra
    if (need <= this.bytes.length) return
    let next = Math.max(this.bytes.length * 2, 1024)
    while (next < need) next *= 2
    const grown = new Uint8Array(next)
    grown.set(this.bytes.subarray(0, this.len))
    this.bytes = grown
  }

  push(chunk: string): void {
    this.reserve(chunk.length)
    for (let i = 0; i < chunk.length; i++) this.bytes[this.len + i] = chunk.charCodeAt(i) & 0xff
    this.len += chunk.length
    // Amortize: only trim once at least a chunk of overflow has accumulated, so
    // a stream of 1-byte pushes does not re-copy the ring on every byte. Capped
    // by the ring's own capacity so tiny rings still trim.
    const chunkThreshold = Math.max(1, Math.min(TRIM_CHUNK_BYTES, this.capBytes))
    if (this.len - this.capBytes < chunkThreshold) return
    const rawCut = this.len - this.capBytes
    const read = (i: number) => this.bytes[i]!
    this.scanner.advanceTo(read, rawCut)
    const cut = this.scanner.cutFor(rawCut, MAX_TRIM_HOLDBACK_BYTES)
    if (cut <= 0) return
    this.bytes.copyWithin(0, cut, this.len)
    this.len -= cut
    this.scanner.shift(cut)
  }

  snapshot(): string {
    let out = ''
    const STRIDE = 8192
    for (let i = 0; i < this.len; i += STRIDE) {
      out += String.fromCharCode(...this.bytes.subarray(i, Math.min(i + STRIDE, this.len)))
    }
    return out
  }

  clear(): void {
    this.len = 0
    this.scanner = new TrimScanner()
  }

  get size(): number {
    return this.len
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

  constructor(private idleGraceSeconds = DEFAULT_IDLE_GRACE_SECONDS) {}

  /** Register a freshly-started PTY for a session. Idempotent per session. */
  register(sessionId: string, pty: PersistablePty): SessionEntry {
    let entry = this.sessions.get(sessionId)
    if (entry) return entry
    entry = {
      sessionId,
      pty,
      subscribers: 0,
      idleTimer: null,
    }
    this.sessions.set(sessionId, entry)
    return entry
  }

  /** A client ATTACHED — bump subscriber count and cancel any pending
   *  idle-reap. Scrollback replay is Rust-host-only (`onScrollback`). */
  attach(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.subscribers++
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
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
