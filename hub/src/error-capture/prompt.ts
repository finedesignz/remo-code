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
  return [
    `An uncaught error was just reported by your deployed app **${project.name}**.`,
    ``,
    `**Error:** \`${error.error_type}: ${error.error_value}\``,
    `**Release:** ${error.release ?? '(unknown)'}`,
    `**Top frames:**`,
    formatFrames(frames),
    ``,
    `Please investigate the root cause, implement a fix on the default branch, commit + push. Coolify will auto-deploy. If the issue is genuinely transient or external (third-party outage, etc.), explain in a brief reply and do not commit.`,
  ].join('\n')
}
