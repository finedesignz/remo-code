/**
 * Phase 20 — Claude projects-JSONL transcript adapter (R-TG-02).
 *
 * Claude Code writes a per-session transcript to:
 *   ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Resolution is DETERMINISTIC (never newest-file — T-20-01):
 *   - `<session-uuid>` is the hub session id (`ctx.sessionId`). Claude's
 *     convention is filename-stem === session id.
 *   - `<project-slug>` is the cwd with path separators (and other non-alnum
 *     chars) replaced by '-'. Observed Claude Code convention; treated as a
 *     best-effort derivation. The PERSISTED `ctx.transcriptPath` (recorded at
 *     PTY spawn — `sessions.transcript_path`) WINS when present, because the
 *     spawner knows the real path; the slug derivation is only the fallback when
 *     no path was persisted.
 *   - If neither the persisted path nor the derived path exists ⇒ SCRAPE-MODE
 *     (assistant_text + turn_complete only; never a directory-listing guess).
 *
 * Record schema is UNSTABLE across Claude Code releases (RESEARCH §1). We parse
 * by `type`; an unknown `type` is SKIPPED + counted (never crashes, never
 * misclassified as an assistant turn or — worse — a permission). FAIL-CLOSED:
 * a permission/user_question only surfaces when it parses into a discrete,
 * enumerated, keystroke-mappable choice set.
 *
 * Observed discriminators (capture from a live `~/.claude/projects/.../<id>.jsonl`
 * — treat as version-unstable, re-verify):
 *   - { "type": "assistant", "message": { "content": [{type:"text", text}, ...] } }
 *   - assistant content item { "type": "tool_use", "name", "input" }
 *   - { "type": "user_question" | "permission_request", "request_id"/"id",
 *       "options": [...] }  (interactive prompt; enumerated options)
 *   - turn boundary: a `{ "type": "result" }` record (turn-complete).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type {
  CliKind,
  TranscriptEntry,
  TranscriptListener,
  TranscriptOpenCtx,
  TranscriptOpenResult,
  TranscriptOption,
  TranscriptSource,
} from './types.ts'
import { tailJsonl, type JsonlTail } from './tail.ts'

/** Claude's projects-dir slug for a cwd. Observed convention: replace every run
 *  of non-alphanumeric chars with a single '-'. Documented best-effort; the
 *  persisted transcript_path is authoritative when present. */
export function claudeProjectSlug(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Deterministic file path from (projectDir, sessionId). NEVER lists a dir. */
export function claudeTranscriptPath(projectDir: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', claudeProjectSlug(projectDir), `${sessionId}.jsonl`)
}

export class ClaudeTranscriptAdapter implements TranscriptSource {
  readonly cliKind: CliKind = 'claude'
  private tail: JsonlTail | null = null
  private skippedUnknown = 0

  async open(ctx: TranscriptOpenCtx, onEntry: TranscriptListener): Promise<TranscriptOpenResult> {
    // Persisted path WINS; else derive deterministically from (projectDir, id).
    const candidate =
      ctx.transcriptPath && ctx.transcriptPath.trim().length > 0
        ? ctx.transcriptPath
        : claudeTranscriptPath(ctx.projectDir, ctx.sessionId)

    if (!existsSync(candidate)) {
      // Absent ⇒ degrade to scrape-mode. We do NOT scan the projects dir for a
      // newest file — a concurrent session in the same project would cross-wire
      // (T-20-01). Scrape-mode emits only assistant_text + turn_complete and is
      // fed from the terminal-byte path elsewhere; here we simply tail nothing.
      return { mode: 'scrape', path: null }
    }

    this.tail = tailJsonl(
      candidate,
      (record) => {
        const entry = mapClaudeRecord(record, ctx.sessionId, () => {
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
    return { mode: 'file', path: candidate }
  }

  close(): void {
    this.tail?.close()
    this.tail = null
  }

  /** Test/diagnostic: how many records were skipped as unknown/unparseable. */
  get skippedUnknownCount(): number {
    return this.skippedUnknown
  }
}

/**
 * Map a single Claude JSONL record → TranscriptEntry, or null when it carries no
 * bridge-relevant signal OR is an unknown/ambiguous shape. `onUnknown` is called
 * for an unrecognized `type` so the adapter can count it.
 *
 * Exported for unit testing the pure mapping in isolation.
 */
export function mapClaudeRecord(
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
    case 'assistant': {
      const text = extractAssistantText(r)
      // An assistant record may carry a tool_use instead of (or before) text.
      const tool = extractFirstToolUse(r)
      if (tool) {
        return { kind: 'tool_use', sessionId, toolName: tool.name, detail: tool.detail }
      }
      if (text && text.trim().length > 0) {
        return { kind: 'assistant_text', sessionId, text }
      }
      return null
    }
    case 'tool_use': {
      const name = typeof r.name === 'string' ? r.name : 'tool'
      return { kind: 'tool_use', sessionId, toolName: name, detail: detailFromInput(r.input) }
    }
    case 'permission_request': {
      // FAIL-CLOSED: require a request id + a discrete enumerable option set.
      const requestId = firstString(r.request_id, r.id)
      const toolName = firstString(r.tool_name, r.toolName, (r as any).tool)
      if (!requestId || !toolName) {
        onUnknown()
        return null
      }
      const options = booleanOrEnumeratedOptions(r.options)
      if (!options) {
        onUnknown()
        return null
      }
      return {
        kind: 'permission_request',
        sessionId,
        requestId,
        toolName,
        toolInput: r.tool_input ?? (r as any).input,
        options,
      }
    }
    case 'user_question': {
      const requestId = firstString(r.request_id, r.id)
      const questionText = firstString(r.question, r.text)
      const options = enumeratedOptions(r.options)
      if (!requestId || !questionText || !options) {
        onUnknown()
        return null
      }
      return {
        kind: 'user_question',
        sessionId,
        requestId,
        questionText,
        options,
        isMultiSelect: r.is_multi_select === true,
      }
    }
    case 'result': {
      // Turn boundary — the assistant's turn completed.
      return { kind: 'turn_complete', sessionId }
    }
    default:
      onUnknown()
      return null
  }
}

function extractAssistantText(r: Record<string, unknown>): string {
  const msg = r.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && (c as any).type === 'text')
      .map((c) => String((c as any).text ?? ''))
      .join('')
  }
  return ''
}

function extractFirstToolUse(r: Record<string, unknown>): { name: string; detail?: string } | null {
  const msg = r.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return null
  for (const c of content) {
    if (c && typeof c === 'object' && (c as any).type === 'tool_use') {
      const name = typeof (c as any).name === 'string' ? (c as any).name : 'tool'
      return { name, detail: detailFromInput((c as any).input) }
    }
  }
  return null
}

function detailFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 79) + '…' : v
  return undefined
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

/** A permission's options: either an explicit enumerated set, or — when the
 *  record carries no options array — the implicit boolean Approve/Deny. */
function booleanOrEnumeratedOptions(raw: unknown): TranscriptOption[] | null {
  if (raw === undefined || raw === null) {
    return [
      { id: 'approve', label: '✅ Approve' },
      { id: 'deny', label: '🚫 Deny' },
    ]
  }
  return enumeratedOptions(raw)
}

/** Strictly parse an enumerated options array; null if not a clean list. */
function enumeratedOptions(raw: unknown): TranscriptOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: TranscriptOption[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item === 'string') {
      out.push({ id: String(i), label: item })
    } else if (item && typeof item === 'object') {
      const label = firstString((item as any).label, (item as any).text, (item as any).title)
      if (!label) return null // ambiguous item ⇒ fail closed
      out.push({ id: String(i), label, description: firstString((item as any).description) })
    } else {
      return null
    }
  }
  return out
}
