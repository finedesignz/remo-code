/**
 * Phase 20 — Codex rollout-JSONL transcript adapter + byte-scrape fallback
 * (R-TG-03).
 *
 * Codex CLI writes a per-session rollout transcript to (community-reverse-
 * engineered, version-UNSTABLE — RESEARCH §2, captured against Codex v0.130.0):
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<UUID>.jsonl
 *   (Windows: %USERPROFILE%\.codex\sessions\... — homedir() resolves both.)
 *
 * Each line: { "timestamp", "type": "session_meta"|"response_item"|"turn_context",
 *              "payload": {...} }.
 *   - `session_meta.payload.id` carries the session's rollout id → use it to
 *     RESOLVE THIS session's file by matching `ctx.codexRolloutId` (NOT newest).
 *   - `response_item.payload` is an OpenAI Responses-style item:
 *       { type: "message", role: "assistant", content: [{type:"output_text"|"text", text}] }
 *       { type: "function_call", name, arguments }   → tool_use
 *
 * RESOLUTION (deterministic, never newest-file — T-20-01):
 *   - Persisted `ctx.transcriptPath` (recorded at spawn) WINS when present.
 *   - Else, if `ctx.codexRolloutId` is present, the resolver scans the sessions
 *     date-tree for the file whose `session_meta.payload.id` MATCHES that id.
 *   - If neither is available, OR the file is missing, OR a line's schema is
 *     unrecognized ⇒ SCRAPE-MODE.
 *
 * SCRAPE-MODE (fail-closed at the source — T-20-03): emits ONLY assistant_text +
 * turn_complete, NEVER a permission_request. You cannot reliably fail-closed-
 * parse a discrete approve/deny out of raw terminal bytes, so Codex permissions
 * in fallback mode are simply not surfaced to Telegram (the human handles them on
 * the xterm surface). This adapter NEVER fabricates a permission in scrape-mode.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type {
  CliKind,
  TranscriptEntry,
  TranscriptListener,
  TranscriptOpenCtx,
  TranscriptOpenResult,
  TranscriptSource,
} from './types.ts'
import { tailJsonl, type JsonlTail } from './tail.ts'

export function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions')
}

/**
 * Resolve a Codex rollout file by matching a persisted `session_meta` id against
 * the date-tree. Returns the path or null (⇒ scrape-mode). Deterministic: it
 * matches the id, it does NOT pick the newest file. Bounded: reads only the
 * first line of each candidate (where session_meta lives).
 */
export function resolveCodexRolloutByMetaId(rolloutId: string, root = codexSessionsRoot()): string | null {
  if (!rolloutId || !existsSync(root)) return null
  // Walk YYYY/MM/DD; match a rollout-*.jsonl whose first session_meta id matches.
  const stack: string[] = [root]
  const candidates: string[] = []
  while (stack.length) {
    const dir = stack.pop()!
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) candidates.push(p)
    }
  }
  for (const file of candidates) {
    try {
      const head = readFileSync(file, 'utf8').split('\n', 1)[0] ?? ''
      if (!head.trim()) continue
      const rec = JSON.parse(head) as Record<string, unknown>
      if (rec.type === 'session_meta') {
        const id = (rec.payload as Record<string, unknown> | undefined)?.id
        if (typeof id === 'string' && id === rolloutId) return file
      }
    } catch {
      continue // unparseable head — skip; never a wrong-file match
    }
  }
  return null
}

export class CodexTranscriptAdapter implements TranscriptSource {
  readonly cliKind: CliKind = 'codex'
  private tail: JsonlTail | null = null
  private skippedUnknown = 0

  async open(ctx: TranscriptOpenCtx, onEntry: TranscriptListener): Promise<TranscriptOpenResult> {
    let path: string | null = null
    if (ctx.transcriptPath && ctx.transcriptPath.trim().length > 0 && existsSync(ctx.transcriptPath)) {
      path = ctx.transcriptPath
    } else if (ctx.codexRolloutId) {
      path = resolveCodexRolloutByMetaId(ctx.codexRolloutId)
    }

    if (!path || !existsSync(path)) {
      // Absent id / missing file ⇒ scrape-mode. No newest-file guess; no
      // permission_request ever emitted in this mode (T-20-03).
      return { mode: 'scrape', path: null }
    }

    this.tail = tailJsonl(
      path,
      (record) => {
        const entry = mapCodexRecord(record, ctx.sessionId, () => {
          this.skippedUnknown++
        })
        if (entry) onEntry(entry)
      },
      {
        onParseError: () => {
          this.skippedUnknown++
        },
      },
    )
    return { mode: 'file', path }
  }

  close(): void {
    this.tail?.close()
    this.tail = null
  }

  get skippedUnknownCount(): number {
    return this.skippedUnknown
  }
}

/**
 * Map a single Codex rollout record → TranscriptEntry, or null. Unknown
 * top-level `type` / unknown `payload.type` ⇒ onUnknown() + null (skip, never
 * misclassify). Exported for unit testing.
 *
 * NOTE: file-mode here surfaces assistant_text + tool_use + turn_complete. We do
 * NOT emit permission_request from the rollout file in this build — the rollout
 * approval-item shape is not yet captured against the installed Codex version
 * (RESEARCH open Q2), and surfacing an unverified shape would risk a mis-parse on
 * a security boundary. This is deliberately fail-closed: Codex permissions are
 * handled on the xterm surface until the approval-item shape is captured.
 */
export function mapCodexRecord(
  record: unknown,
  sessionId: string,
  onUnknown: () => void,
): TranscriptEntry | null {
  if (!record || typeof record !== 'object') {
    onUnknown()
    return null
  }
  const r = record as Record<string, unknown>
  const type = r.type

  switch (type) {
    case 'session_meta':
    case 'turn_context':
      // Metadata lines — no bridge signal, not "unknown" (don't count).
      return null
    case 'response_item': {
      const payload = r.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== 'object') {
        onUnknown()
        return null
      }
      const ptype = payload.type
      if (ptype === 'message') {
        const role = payload.role
        if (role !== 'assistant') return null // user echoes aren't forwarded
        const text = extractCodexMessageText(payload)
        if (text && text.trim().length > 0) return { kind: 'assistant_text', sessionId, text }
        return null
      }
      if (ptype === 'function_call') {
        const name = typeof payload.name === 'string' ? payload.name : 'tool'
        return { kind: 'tool_use', sessionId, toolName: name, detail: codexCallDetail(payload) }
      }
      if (ptype === 'reasoning') {
        return null // thinking — never forwarded
      }
      onUnknown()
      return null
    }
    default:
      onUnknown()
      return null
  }
}

function extractCodexMessageText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && ((c as any).type === 'output_text' || (c as any).type === 'text'))
      .map((c) => String((c as any).text ?? ''))
      .join('')
  }
  return ''
}

function codexCallDetail(payload: Record<string, unknown>): string | undefined {
  const args = payload.arguments
  if (typeof args === 'string') return args.length > 80 ? args.slice(0, 79) + '…' : args
  return undefined
}
