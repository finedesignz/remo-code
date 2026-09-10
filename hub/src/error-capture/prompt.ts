/**
 * Error-dispatch prompt builder (W3/T1).
 *
 * Builds the `user_message` body sent to Claude on the project's bound
 * session when an error passes all intake gates. Plain text — written
 * directly to Claude's stdin, no HTML/markdown escaping needed.
 *
 * Up to 8 frames are included (top of stack first). If the stacktrace is
 * absent or unparseable, we just omit the frames block.
 */
import type { ErrorProject, ErrorRow } from '../db/error-capture-dal.ts'
import { fenceUntrusted, SCOPE_CONTRACT } from '../dispatch/untrusted.ts'

interface Frame {
  filename?: string | null
  function?: string | null
  lineno?: number | null
  colno?: number | null
}

const MAX_FRAMES = 8

function extractFrames(stack: unknown): Frame[] {
  if (!stack) return []
  // Sentry envelope shape: { frames: [...] }. Accept either an array directly
  // or a wrapper object.
  const arr: any[] = Array.isArray(stack)
    ? stack
    : Array.isArray((stack as any)?.frames)
      ? (stack as any).frames
      : []
  // Sentry frames are ordered oldest→newest. We want newest first.
  const reversed = [...arr].reverse()
  return reversed.slice(0, MAX_FRAMES).map((f) => ({
    filename: f?.filename ?? f?.file ?? null,
    function: f?.function ?? f?.func ?? null,
    lineno: typeof f?.lineno === 'number' ? f.lineno : (typeof f?.line === 'number' ? f.line : null),
    colno: typeof f?.colno === 'number' ? f.colno : null,
  }))
}

function formatFrames(frames: Frame[]): string {
  if (frames.length === 0) return '(no stacktrace available)'
  return frames
    .map((f) => {
      const file = f.filename ?? '<unknown>'
      const line = f.lineno ?? '?'
      const fn = f.function ?? 'anonymous'
      return `  at ${file}:${line} (${fn})`
    })
    .join('\n')
}

export function buildErrorMessage(
  error: Pick<ErrorRow, 'error_type' | 'error_value' | 'stacktrace_json' | 'release'>,
  project: Pick<ErrorProject, 'name'>,
): string {
  const frames = extractFrames(error.stacktrace_json)
  // SECURITY: every field below arrives on the wire from a Sentry envelope whose
  // key is a client-side DSN (public by design). error_type / error_value / frame
  // filenames are attacker-controllable, so the whole report is FENCED as data and
  // the dispatch carries the scope contract (propose-only — no push, no deploy).
  const report = [
    `Error: ${error.error_type}: ${error.error_value}`,
    `Release: ${error.release ?? '(unknown)'}`,
    `Top frames:`,
    formatFrames(frames),
  ].join('\n')
  return [
    `An uncaught error was just reported by your deployed app **${project.name}**.`,
    ``,
    SCOPE_CONTRACT,
    ``,
    fenceUntrusted('untrusted_error_report', report),
    ``,
    `Investigate the root cause and, if it is a real defect, PROPOSE a fix as a PULL REQUEST`,
    `on a new branch for human review. Do NOT push to the default/main branch, do NOT merge,`,
    `and do NOT deploy. If the issue is genuinely transient or external (third-party outage,`,
    `etc.), explain in a brief reply and change nothing.`,
  ].join('\n')
}
