/**
 * session_transcript_tail / session_memory — supervisor-native READ-ONLY commands
 * (milestone ASK, Phase 1).
 *
 * The hub container has no `~/.claude/projects/…`; the CLI's on-disk transcript and
 * the project's memory files live on the SUPERVISOR host. These two allowlisted
 * `run_command` handlers (same registry mechanism as `teab_run` / `teab_status`)
 * are the ONLY way the hub can read them.
 *
 * HARD INVARIANTS:
 *   - READ-ONLY. No spawn, no write, no PTY keystroke, no tokens spent.
 *   - The hub NEVER supplies a path to read. It supplies the session's
 *     `project_dir`; the handler DERIVES the CLI's own transcript/memory dir from
 *     it (`~/.claude/projects/<slug>`) and refuses anything that resolves outside
 *     that base. A `..`/absolute/UNC/symlinked argument therefore cannot escape:
 *     see `resolveSessionDir` (fails closed with `path_escape`).
 *   - Output is BYTE-CAPPED (`MAX_BYTES`), truncated from the FRONT (the tail is
 *     what matters), so a huge transcript can never blow up the WS frame.
 *
 * RPC contract:
 *   session_transcript_tail args: [projectDir, n?]  → { turns: [...], truncated }
 *   session_memory           args: [projectDir]     → { files: [{name, content}], truncated }
 *
 * Failure reasons (fail closed): invalid_project_dir | path_escape | no_transcript |
 * no_memory
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep, isAbsolute } from 'path'
import type { CommandResult } from './index'

/** Hard cap on the bytes a single read command may return. */
export const MAX_BYTES = 64_000
/** Default number of transcript turns returned. */
const DEFAULT_TAIL = 30
const MAX_TAIL = 200

/** Base dir the Claude CLI keeps per-project transcripts + memory under. */
export function claudeProjectsBase(): string {
  return resolve(join(homedir(), '.claude', 'projects'))
}

/**
 * Claude's per-project slug: every non-alphanumeric char in the absolute project
 * dir becomes '-' (e.g. `C:\Users\artic\GitHub\remo-code` →
 * `C--Users-artic-GitHub-remo-code`).
 */
export function slugForProjectDir(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Resolve the CLI dir for a project_dir, FAILING CLOSED on anything that would
 * escape `~/.claude/projects`. This is the path-traversal chokepoint: the caller
 * never names a file, and a crafted `project_dir` (`..`, `../../etc`, a relative
 * path, an absolute path with separators that slug into a traversal) either fails
 * `invalid_project_dir` or fails the containment check.
 */
export function resolveSessionDir(
  projectDir: string | undefined,
): { ok: true; dir: string } | { ok: false; error: string } {
  if (!projectDir || typeof projectDir !== 'string') return { ok: false, error: 'invalid_project_dir' }
  const p = projectDir.trim()
  if (!p) return { ok: false, error: 'invalid_project_dir' }
  // The hub always sends an absolute project_dir. Anything else — a relative
  // path, or one carrying a traversal segment — is rejected before we build a path.
  if (!isAbsolute(p)) return { ok: false, error: 'invalid_project_dir' }
  if (p.split(/[\\/]/).some((seg) => seg === '..')) return { ok: false, error: 'invalid_project_dir' }
  if (p.includes('\0')) return { ok: false, error: 'invalid_project_dir' }

  const base = claudeProjectsBase()
  const dir = resolve(join(base, slugForProjectDir(p)))
  // Containment: the resolved dir MUST live strictly under the base.
  if (dir !== base && !dir.startsWith(base + sep)) return { ok: false, error: 'path_escape' }
  return { ok: true, dir }
}

/** Truncate `s` to MAX_BYTES, keeping the TAIL. Returns [text, truncated]. */
export function capBytes(s: string, max: number = MAX_BYTES): [string, boolean] {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return [s, false]
  return [buf.subarray(buf.length - max).toString('utf8'), true]
}

function newestJsonl(dir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return null
  }
  let best: { path: string; mtime: number } | null = null
  for (const n of names) {
    const full = join(dir, n)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs }
    } catch {
      /* skip unreadable */
    }
  }
  return best?.path ?? null
}

export interface TranscriptTurn {
  role: string
  text: string
}

/**
 * Minimal Claude-projects JSONL parse: each line is a JSON record; we keep
 * user/assistant records and flatten their text content. Unknown/tool records are
 * skipped. Deliberately tolerant — a parse failure on one line never fails the read.
 */
export function parseTranscriptJsonl(raw: string, tail: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = rec?.message ?? rec
    const role = msg?.role ?? rec?.type
    if (role !== 'user' && role !== 'assistant') continue
    const content = msg?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b: any) => b.text ?? '')
        .join('\n')
    }
    if (!text.trim()) continue
    turns.push({ role, text })
  }
  return turns.slice(-tail)
}

/** session_transcript_tail args: [projectDir, n?] */
export async function runSessionTranscriptTail(args: string[]): Promise<CommandResult> {
  const r = resolveSessionDir(args?.[0])
  if (!r.ok) return { exit_code: 1, error: r.error }
  const nRaw = Number(args?.[1])
  const tail = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(Math.floor(nRaw), MAX_TAIL) : DEFAULT_TAIL

  if (!existsSync(r.dir)) return { exit_code: 1, error: 'no_transcript' }
  const file = newestJsonl(r.dir)
  if (!file) return { exit_code: 1, error: 'no_transcript' }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { exit_code: 1, error: 'no_transcript' }
  }
  const turns = parseTranscriptJsonl(raw, tail)
  const [text, truncated] = capBytes(JSON.stringify(turns))
  // When the cap bit, the JSON is no longer parseable — return the turns we can
  // fit by dropping from the front until it does.
  if (!truncated) {
    return { exit_code: 0, snippet: JSON.stringify({ turns, truncated: false }) }
  }
  let kept = turns
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > MAX_BYTES) {
    kept = kept.slice(1)
  }
  if (kept.length === 1) {
    const [only] = capBytes(kept[0].text, MAX_BYTES - 200)
    kept = [{ role: kept[0].role, text: only }]
  }
  void text
  return { exit_code: 0, snippet: JSON.stringify({ turns: kept, truncated: true }) }
}

export interface MemoryFile {
  name: string
  content: string
}

/** session_memory args: [projectDir] → the project's memory/*.md (+ MEMORY.md). */
export async function runSessionMemory(args: string[]): Promise<CommandResult> {
  const r = resolveSessionDir(args?.[0])
  if (!r.ok) return { exit_code: 1, error: r.error }
  const memDir = resolve(join(r.dir, 'memory'))
  // Belt-and-braces containment (r.dir is already contained, but assert anyway).
  if (!memDir.startsWith(claudeProjectsBase() + sep)) return { exit_code: 1, error: 'path_escape' }
  if (!existsSync(memDir)) return { exit_code: 1, error: 'no_memory' }

  let names: string[] = []
  try {
    names = readdirSync(memDir).filter((n) => n.endsWith('.md'))
  } catch {
    return { exit_code: 1, error: 'no_memory' }
  }
  // MEMORY.md (the index) first, then the rest alphabetically.
  names.sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))

  const files: MemoryFile[] = []
  let budget = MAX_BYTES
  let truncated = false
  for (const n of names) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const full = resolve(join(memDir, n))
    if (!full.startsWith(memDir + sep)) continue // never follow a name out of the dir
    let content: string
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const size = Buffer.byteLength(content, 'utf8')
    if (size > budget) {
      const [cut] = capBytes(content, budget)
      files.push({ name: n, content: cut })
      truncated = true
      budget = 0
      break
    }
    files.push({ name: n, content })
    budget -= size
  }

  if (files.length === 0) return { exit_code: 1, error: 'no_memory' }
  return { exit_code: 0, snippet: JSON.stringify({ files, truncated }) }
}
