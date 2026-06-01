/**
 * Phase 20 — backend-agnostic transcript source.
 *
 * After the Phase-17 rip, Telegram has NO structured event source (the
 * stream-json runner + `assistant_message:final` / `permission_request` event
 * bus that the old bridge consumed are gone). Phase 20 re-grounds Telegram on a
 * TRANSCRIPT-TAIL: each backend writes its own on-disk transcript while the PTY
 * runs, and the hub READS those files (read-only — never a programmatic API
 * call, never a stream-json pipe back into the PTY).
 *
 * This module defines the seam every later Phase-20 plan consumes:
 *   - `TranscriptEntry` — the normalized discriminated union the bridge sees.
 *     The bridge NEVER sees a backend-specific shape (Claude JSONL record /
 *     Codex rollout `response_item`); each adapter normalizes to this union.
 *   - `TranscriptSource` — the adapter interface: `open(ctx)` resolves the
 *     on-disk file from the PERSISTED transcript identity captured at PTY spawn
 *     (Phase-16 16-PLAN-002 → `sessions.transcript_path` / `cli_kind`), yields a
 *     stream of `TranscriptEntry`, and `close()` tears the tail down.
 *
 * The `permission_request` member intentionally mirrors the fields of the
 * deleted `PermissionPendingEvent` (hub/src/events/permission-events.ts) so the
 * existing approvals registry keeps keying by `(sessionId, requestId)` verbatim.
 */

/** Backend CLI kind. Mirrors `supervisor/src/runners/types.ts:CliRunner.cliKind`
 *  and the `sessions.cli_kind` column. Local to avoid coupling to the DAL. */
export type CliKind = 'claude' | 'codex'

/**
 * Inputs the adapter resolves the on-disk transcript from (H10). EXPLICITLY
 * carried — adapters never guess "newest file".
 *
 *  - `sessionId` — the hub session UUID. For the Claude adapter this is ALSO the
 *    expected `<session-uuid>.jsonl` filename stem (Claude Code's projects-dir
 *    convention: the CLI writes `~/.claude/projects/<slug>/<session-uuid>.jsonl`
 *    where the stem === the session id). Sourced from the persisted session row.
 *  - `projectDir` — the session's cwd; the Claude adapter derives the project
 *    slug from it (see claude-adapter.ts for the documented derivation).
 *  - `cliKind` — selects the adapter (`index.ts:selectAdapter`).
 *  - `transcriptPath` — the persisted absolute path to the backend transcript,
 *    captured at PTY spawn (Phase-16 `setSessionPtyIdentity` →
 *    `sessions.transcript_path`, read via `getSessionPtyIdentity`). When present
 *    it WINS over any derived path (it is the ground truth the spawner recorded).
 *  - `codexRolloutId` — the Codex `session_meta` id captured at spawn; the Codex
 *    adapter matches it against the rollout file's `session_meta` payload.
 *
 * ABSENT-FIELD ⇒ SCRAPE-MODE DEGRADE RULE (security-critical, H10 / T-20-01):
 * if the field an adapter needs to resolve its file is absent — OR the resolved
 * file is missing — the adapter degrades to scrape-mode (assistant_text +
 * turn_complete only) rather than picking a wrong file. It NEVER falls back to a
 * directory listing / newest-file heuristic; cross-wiring a concurrent session's
 * transcript (and its permissions) to the wrong Telegram chat is the HIGH risk
 * this rule forecloses.
 */
export interface TranscriptOpenCtx {
  sessionId: string
  projectDir: string
  cliKind: CliKind
  /** Absolute path persisted at spawn (Phase-16). Optional — scrape-mode if absent. */
  transcriptPath?: string | null
  /** Codex `session_meta` id persisted at spawn. Optional — scrape-mode if absent. */
  codexRolloutId?: string | null
}

/** A final assistant turn (the bridge forwards this to Telegram). */
export interface AssistantTextEntry {
  kind: 'assistant_text'
  sessionId: string
  text: string
}

/** A tool invocation (the bridge collapses these into one-liners). */
export interface ToolUseEntry {
  kind: 'tool_use'
  sessionId: string
  toolName: string
  /** Best-effort one-line detail (file path / command); never load-bearing. */
  detail?: string
}

/**
 * A pending tool-permission prompt detected in the transcript. Mirrors the
 * deleted `PermissionPendingEvent` field-for-field so the approvals registry
 * keying is unchanged. `options` enumerates the discrete choices the human may
 * pick (for a boolean permission: Approve / Deny). FAIL-CLOSED: an adapter only
 * emits this when it parses a discrete, fully-enumerated, keystroke-mappable
 * choice set; anything ambiguous is skipped (never an optimistic permission).
 */
export interface PermissionRequestEntry {
  kind: 'permission_request'
  sessionId: string
  requestId: string
  toolName: string
  toolInput?: unknown
  /** Enumerated choices. Booleans surface as [{id:'approve'},{id:'deny'}]. */
  options: TranscriptOption[]
}

/** An interactive option-select question (Claude `user_question`). */
export interface UserQuestionEntry {
  kind: 'user_question'
  sessionId: string
  requestId: string
  questionText: string
  options: TranscriptOption[]
  isMultiSelect?: boolean
}

/** A single enumerated choice for a permission_request / user_question. */
export interface TranscriptOption {
  /** Stable identifier for the choice (e.g. 'approve', 'deny', or option index). */
  id: string
  /** Human-readable label rendered on the Telegram button. */
  label: string
  description?: string
}

/**
 * The holder's turn finished. Doubles as (a) the turn-lock RELEASE signal
 * (plan 04) and (b) the "permission no-longer-pending" detector (plan 03) — one
 * transcript observation, two consumers.
 */
export interface TurnCompleteEntry {
  kind: 'turn_complete'
  sessionId: string
}

export type TranscriptEntry =
  | AssistantTextEntry
  | ToolUseEntry
  | PermissionRequestEntry
  | UserQuestionEntry
  | TurnCompleteEntry

export type TranscriptEntryKind = TranscriptEntry['kind']

/** The five normalized entry kinds, for tests + exhaustiveness assertions. */
export const TRANSCRIPT_ENTRY_KINDS: readonly TranscriptEntryKind[] = [
  'assistant_text',
  'tool_use',
  'permission_request',
  'user_question',
  'turn_complete',
] as const

/** A consumer callback for streamed entries. */
export type TranscriptListener = (entry: TranscriptEntry) => void

/**
 * Backend-agnostic transcript source. One implementation per backend (selected
 * by `cliKind`). `open` begins tailing; every normalized entry is delivered to
 * the listener; `close` stops the tail and releases watchers/timers.
 *
 * The interface is intentionally callback-based (not an async iterator) so a
 * single tail can fan to multiple consumers (bridge + turn-lock + permission
 * detector) without buffering, and so `close()` is unambiguous.
 */
export interface TranscriptSource {
  /** Which backend this adapter serves. */
  readonly cliKind: CliKind
  /**
   * Begin tailing the resolved transcript. Returns the resolved MODE so callers
   * can log whether the deterministic file was found or the adapter degraded to
   * scrape-mode (no permissions surfaced in scrape-mode — see types above).
   */
  open(ctx: TranscriptOpenCtx, onEntry: TranscriptListener): Promise<TranscriptOpenResult>
  /** Stop the tail; idempotent. */
  close(): void
}

export interface TranscriptOpenResult {
  /**
   *  - `file`   — the deterministic per-session transcript was resolved + tailed.
   *  - `scrape` — degraded to terminal-byte scrape (no file / absent id / drift);
   *               emits ONLY assistant_text + turn_complete, NEVER permissions.
   */
  mode: 'file' | 'scrape'
  /** The resolved absolute path when `mode==='file'`; null in scrape-mode. */
  path: string | null
}
