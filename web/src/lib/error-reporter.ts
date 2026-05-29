/**
 * Browser-side error reporter (Bundle B3, observability sweep 2026-05-28).
 *
 * Captures unhandled errors + promise rejections + React boundary catches and
 * POSTs them to the hub's existing Sentry envelope intake at
 * `/api/sentry/:project_id/envelope/`. NO new endpoint, NO new dep.
 *
 * Throttle: max 5 reports / 60s / page session, in-memory counter. The 6th and
 * onward in a sliding minute are silently dropped (not buffered).
 *
 * Project id is build-time `VITE_WEB_ERROR_PROJECT_ID`; the row + sentry_key
 * are seeded once by `hub/scripts/ensure-web-error-project.ts`.
 *
 * Fire-and-forget: if the hub is down, the error is lost. No retry, no queue.
 */

// Read lazily so tests can override `import.meta.env` after module load. Vite
// inlines these at build time in production, so the lazy lookup is harmless.
const getEnv = (k: string): string => {
  try { return ((import.meta as any).env?.[k] as string) ?? '' } catch { return '' }
}
const getProjectId = () => getEnv('VITE_WEB_ERROR_PROJECT_ID')
const getHubUrl = () => getEnv('VITE_HUB_URL')
const getRelease = () => getEnv('VITE_RELEASE') || 'web@dev'
const SENTRY_KEY = '__web_self__'

// Throttle: 5 reports per rolling 60s window per page session.
const THROTTLE_MAX = 5
const THROTTLE_WINDOW_MS = 60_000
const sendTimestamps: number[] = []

export interface ReportPayload {
  message: string
  stack?: string
  url?: string
  ua?: string
  release?: string
}

function withinThrottle(now: number): boolean {
  while (sendTimestamps.length > 0 && now - sendTimestamps[0] > THROTTLE_WINDOW_MS) {
    sendTimestamps.shift()
  }
  return sendTimestamps.length < THROTTLE_MAX
}

/**
 * Build a minimal Sentry envelope (gzip not required — intake handles identity
 * encoding). Format: header line + item-header line + item-payload line.
 */
function buildEnvelope(p: ReportPayload): string {
  const eventId = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '')
  const sentAt = new Date().toISOString()
  const envHeader = JSON.stringify({ event_id: eventId, sent_at: sentAt })
  const itemHeader = JSON.stringify({ type: 'event' })
  // Parse stack into Sentry-shaped frames (top-of-stack first). The intake
  // reverses the array (callee-first → top-first) and takes 3, so we hand it
  // the natural top-first order it expects after the reverse.
  const frames = parseStackFrames(p.stack)
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    release: p.release ?? getRelease(),
    request: { url: p.url, headers: { 'User-Agent': p.ua } },
    exception: {
      values: [
        {
          type: extractErrorType(p.message),
          value: p.message,
          // Sentry stores callee-first; the intake reverses then takes top 3.
          // Pass the frames in callee-first order so intake's reverse yields
          // top-first as expected.
          stacktrace: { frames: frames.slice().reverse() },
        },
      ],
    },
  }
  return `${envHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`
}

function extractErrorType(message: string): string {
  // e.g. "TypeError: foo is undefined" → "TypeError"
  const m = /^([A-Z]\w*Error)\b/.exec(message)
  return m ? m[1] : 'Error'
}

// Parses V8/SpiderMonkey/WebKit stack strings into top-first Sentry frames.
function parseStackFrames(stack?: string): Array<{ function: string; filename: string; lineno?: number; colno?: number }> {
  if (!stack) return []
  const out: Array<{ function: string; filename: string; lineno?: number; colno?: number }> = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // V8: "    at functionName (url:line:col)" or "    at url:line:col"
    let m = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line)
    if (m) {
      out.push({ function: m[1], filename: m[2], lineno: +m[3], colno: +m[4] })
      continue
    }
    m = /^at\s+(.+?):(\d+):(\d+)$/.exec(line)
    if (m) {
      out.push({ function: '<anonymous>', filename: m[1], lineno: +m[2], colno: +m[3] })
      continue
    }
    // Firefox: "name@url:line:col"
    m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line)
    if (m) {
      out.push({ function: m[1] || '<anonymous>', filename: m[2], lineno: +m[3], colno: +m[4] })
      continue
    }
    // Unmatched line — skip silently (Error header lines, blank lines, etc.).
  }
  return out.slice(0, 20)
}

export async function reportError(payload: ReportPayload): Promise<boolean> {
  const projectId = getProjectId()
  if (!projectId) return false
  const now = Date.now()
  if (!withinThrottle(now)) return false
  sendTimestamps.push(now)

  const body = buildEnvelope({
    ...payload,
    url: payload.url ?? (typeof location !== 'undefined' ? location.href : undefined),
    ua: payload.ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : undefined),
    release: payload.release ?? getRelease(),
  })

  try {
    // No `credentials: 'include'` — intake is unauth-by-cookie; sentry_key IS the cred.
    await fetch(`${getHubUrl()}/api/sentry/${encodeURIComponent(projectId)}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${SENTRY_KEY}, sentry_client=remo-web/1`,
      },
      body,
      keepalive: true,
    })
    return true
  } catch {
    return false
  }
}

let installed = false

/**
 * Install `window.onerror` + `unhandledrejection` once. Idempotent.
 * Returns the uninstall fn for tests.
 */
export function installGlobalErrorHandlers(): () => void {
  if (installed) return () => {}
  installed = true

  const onError = (event: ErrorEvent) => {
    const err = event.error
    void reportError({
      message: err?.message ?? event.message ?? 'window.onerror',
      stack: err?.stack,
    })
  }

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: any = event.reason
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : safeJson(reason)
    void reportError({
      message: `UnhandledRejection: ${message}`,
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500)
  } catch {
    return String(v)
  }
}

// Test-only handles.
export const _internal = {
  resetThrottle() {
    sendTimestamps.length = 0
  },
  sendCount() {
    return sendTimestamps.length
  },
  buildEnvelope,
  parseStackFrames,
}
