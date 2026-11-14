// hub/src/corch/gsdc-ingest.ts
//
// CORCH-04 (CORCH-R1.14, R1.15, R1.16): gsd-console board ingestion. The hub consumes
// GET /api/board/stream (SSE, Bearer gsdc_ token with board:read). On a `snapshot` / `project` event it
// re-reads GET /api/board/projects/{id} for ENROLLED projects only and turns the derivation (gsdc-derive.ts)
// into queued `gsd_console` work items (idempotent upsert) and cancel-on-done.
//
// FAIL CLOSED: every failure (unreachable, 5xx, 401/402/403, stream-error, malformed payload, partial config)
// produces ZERO upserts and ZERO cancellations. A snapshot applies all-or-nothing: every enrolled board is
// read first, and nothing is written unless every read succeeded. One owner notification per outage (an
// outage ends at the next fully applied snapshot / project event). The token never leaves the Authorization
// header: it is not logged, stored, or put in a notification.
//
// NO POLLING: there is no interval here. Reconnects are re-armed through the injected CorchTimers (the same
// single timer seam the dispatcher uses); stream end and errors arm exactly one timeout each.

import { gsdcConfig } from './flag.ts'
import { BoardDetail, BoardSummary, deriveCandidate } from './gsdc-derive.ts'
import type { CorchProject, CorchStore, GsdcApplyEntry } from './store.ts'
import type { CorchTimers } from './dispatcher.ts'

export const GSDC_BACKOFF_BASE_MS = 1000
export const GSDC_BACKOFF_CAP_MS = 5 * 60 * 1000
/** A stream that stayed up at least this long counts as healthy: the next reconnect starts the ladder over. */
export const GSDC_HEALTHY_STREAM_MS = 30000
/** No bytes (events or keepalive comments) for this long => treat the stream as dead and reconnect. */
export const GSDC_IDLE_TIMEOUT_MS = 3 * 60 * 1000
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_BOARD_BYTES = 8 * 1024 * 1024
/** Event-wide cap on derived text (done refs + candidate text) held for one transaction. */
const MAX_DERIVED_BYTES = 16 * 1024 * 1024
/** stream-error codes the console is known to send (hosted/runs/hub.js); anything else collapses to plain stream_error. */
const KNOWN_STREAM_ERROR_CODES = new Set(['listener_unavailable'])

export interface GsdcOutage {
  /** Enabled-project owners; the real notifier fans out to each. Never includes console text. */
  userIds: string[]
  /** Stable error signature: unreachable | http_5xx | http_401 | http_402 | http_403 | http_<n> | stream_error | stream_error:<code> | stream_ended | bad_payload | apply_failed | token_unset | url_unset */
  signature: string
}

export interface GsdcDeps {
  store: Pick<CorchStore, 'listEnabledProjects' | 'applyGsdcBoards'>
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>
  timers: CorchTimers
  notifyOutage: (o: GsdcOutage) => Promise<void>
  /** A new item was queued for this user: evaluate now (event-driven). */
  onEnqueued: (userId: string) => Promise<void>
  now?: () => number
}

/** Read a JSON body with a hard byte cap (a hostile or broken console cannot make the hub buffer without bound). */
async function readBoundedJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MAX_BOARD_BYTES || !res.body) throw new GsdcFailure('bad_payload')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BOARD_BYTES) {
        await reader.cancel().catch(() => {})
        throw new GsdcFailure('bad_payload')
      }
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  } catch (err) {
    throw err instanceof GsdcFailure ? err : new GsdcFailure('bad_payload')
  }
}

class GsdcFailure extends Error {
  constructor(readonly signature: string) {
    super(signature)
  }
}

export function backoffMs(failures: number): number {
  return Math.min(GSDC_BACKOFF_CAP_MS, GSDC_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
}

function httpSignature(status: number): string {
  return status >= 500 ? 'http_5xx' : `http_${status}`
}

/** Parse SSE blocks from a byte stream; yields {event, data} per blank-line terminated block. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void = () => {},
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) {
        onChunk() // any bytes, keepalive comments included, prove the stream is alive
        // Normalize the WHOLE buffer: a CRLF split across two chunks must still collapse to one newline.
        buf = (buf + dec.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
      }
      if (buf.length > MAX_FRAME_BYTES) throw new GsdcFailure('bad_payload')
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (data.length > 0 || event !== 'message') yield { event, data: data.join('\n') }
      }
      if (done) return
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

export function createGsdcIngest(deps: GsdcDeps) {
  const now = deps.now ?? (() => Date.now())
  let stopped = true
  let abort: AbortController | null = null
  let timer: unknown = null
  let failures = 0
  let outage = false
  let generation = 0

  const clearTimer = () => {
    if (timer !== null) deps.timers.clearTimeout(timer)
    timer = null
  }

  async function reportFailure(signature: string): Promise<void> {
    failures++
    if (outage) return
    outage = true
    try {
      const users = [...new Set((await deps.store.listEnabledProjects()).map((p) => p.user_id))]
      await deps.notifyOutage({ userIds: users, signature })
    } catch (err: any) {
      console.error(`[corch.gsdc] outage notification failed: ${err?.message ?? err}`)
    }
  }

  function arm(ms: number, gen: number): void {
    clearTimer()
    timer = deps.timers.setTimeout(() => {
      timer = null
      if (!stopped && gen === generation) void connect(gen)
    }, ms)
  }

  async function fetchJson(base: string, token: string, path: string, signal: AbortSignal): Promise<unknown> {
    let res: Response
    try {
      res = await deps.fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal })
    } catch {
      throw new GsdcFailure('unreachable')
    }
    if (!res.ok) throw new GsdcFailure(httpSignature(res.status))
    return readBoundedJson(res)
  }

  /** Re-read the boards of the given summaries (enrolled only) and apply the result all-or-nothing. */
  async function handleSummaries(
    summaries: BoardSummary[],
    base: string,
    token: string,
    signal: AbortSignal,
    alive: () => boolean,
  ): Promise<void> {
    const enabled = await deps.store.listEnabledProjects()
    const byIdent = new Map<string, CorchProject[]>()
    for (const p of enabled) byIdent.set(p.repo_ident, [...(byIdent.get(p.repo_ident) ?? []), p])

    // Each board is derived the moment it is read and then dropped: memory stays bounded by the compact entries
    // (title <= 200, body <= 4000 chars per enrolled project), not by the size of every board in the snapshot.
    const entries: GsdcApplyEntry[] = []
    let derivedBytes = 0
    for (const summary of summaries) {
      const projects = byIdent.get(`github://${summary.slug.toLowerCase()}`)
      if (!projects || projects.length === 0) continue
      // A project the console is not authoritative about is skipped before any read (no upsert, no cancel).
      if (summary.active_runs > 0 || summary.stale || summary.divergent) continue
      const raw = await fetchJson(base, token, `/api/board/projects/${encodeURIComponent(summary.id)}`, signal)
      const parsed = BoardDetail.safeParse(raw)
      if (!parsed.success) throw new GsdcFailure('bad_payload')
      // Canonical (lowercase) slug, like the hub repo_ident: a case change in the console must not fork the identity.
      const d = deriveCandidate(summary.slug.toLowerCase(), summary, parsed.data)
      if (d.kind === 'skip') continue
      const bytes = d.doneRefs.reduce((n, r) => n + r.length, 0) + (d.candidate ? d.candidate.title.length + d.candidate.body.length + d.candidate.sourceRef.length : 0)
      for (const project of projects) {
        derivedBytes += bytes
        if (derivedBytes > MAX_DERIVED_BYTES) throw new GsdcFailure('bad_payload')
        entries.push({ projectId: project.id, userId: project.user_id, priority: project.priority, doneRefs: d.doneRefs, candidate: d.candidate })
      }
    }

    // Every read succeeded: apply the whole event in ONE transaction. Nothing is written once the ingest was
    // stopped or superseded: the store re-checks `alive` inside the transaction and rolls back.
    if (!alive()) return
    let touched: string[]
    try {
      touched = await deps.store.applyGsdcBoards(entries, alive)
    } catch (err: any) {
      if (!alive()) return // stopped mid-transaction: rolled back, not a failure
      console.error(`[corch.gsdc] apply failed: ${err?.message ?? err}`)
      throw new GsdcFailure('apply_failed')
    }
    for (const userId of touched) {
      if (!alive()) return // no evaluation (launch) once stopped, superseded or aborted
      try {
        await deps.onEnqueued(userId)
      } catch (err: any) {
        console.error(`[corch.gsdc] evaluate after enqueue failed: ${err?.message ?? err}`)
      }
    }
  }

  async function connect(gen: number): Promise<void> {
    if (stopped || gen !== generation) return
    const cfg = gsdcConfig()
    if (cfg.state === 'off') return // flag OFF or source unconfigured: no connection, no timer
    if (cfg.state === 'partial') {
      // A misconfiguration cannot heal without a restart: notify once, do not retry.
      await reportFailure(cfg.signature)
      return
    }
    const ac = new AbortController()
    abort = ac
    const startedAt = now()
    let gotSnapshot = false
    let idle: unknown = null
    const rearmIdle = () => {
      if (idle !== null) deps.timers.clearTimeout(idle)
      idle = deps.timers.setTimeout(() => ac.abort(), GSDC_IDLE_TIMEOUT_MS)
    }
    try {
      let res: Response
      try {
        rearmIdle()
        res = await deps.fetch(`${cfg.baseUrl}/api/board/stream`, {
          headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'text/event-stream' },
          signal: ac.signal,
        })
      } catch {
        throw new GsdcFailure('unreachable')
      }
      if (!res.ok || !res.body) throw new GsdcFailure(res.ok ? 'stream_ended' : httpSignature(res.status))

      // Events are processed strictly in order.
      try {
        for await (const ev of parseSse(res.body, rearmIdle)) {
          if (stopped || gen !== generation) return
          if (ev.event === 'stream-error') {
            let code = ''
            try {
              code = String((JSON.parse(ev.data) as { code?: unknown }).code ?? '')
            } catch {
              /* signature falls back to plain stream_error */
            }
            // Only recognized codes become part of the signature: console text never reaches logs or notifications.
            throw new GsdcFailure(KNOWN_STREAM_ERROR_CODES.has(code) ? `stream_error:${code}` : 'stream_error')
          }
          if (ev.event !== 'snapshot' && ev.event !== 'project') continue
          let payload: unknown
          try {
            payload = JSON.parse(ev.data)
          } catch {
            throw new GsdcFailure('bad_payload')
          }
          const rawList = ev.event === 'snapshot' ? (payload as { projects?: unknown })?.projects : [payload]
          if (!Array.isArray(rawList)) throw new GsdcFailure('bad_payload')
          const summaries: BoardSummary[] = []
          for (const r of rawList) {
            const s = BoardSummary.safeParse(r)
            if (!s.success) throw new GsdcFailure('bad_payload')
            summaries.push(s.data)
          }
          await handleSummaries(summaries, cfg.baseUrl, cfg.token, ac.signal, () => !stopped && gen === generation && !ac.signal.aborted)
          if (ev.event === 'snapshot') gotSnapshot = true
          // A fully applied event ends any outage.
          outage = false
          if (now() - startedAt >= GSDC_HEALTHY_STREAM_MS) failures = 0
        }
      } catch (err) {
        // A read error or an idle-timeout abort is an unreachable console; our own failures keep their signature.
        throw err instanceof GsdcFailure ? err : new GsdcFailure('unreachable')
      }
      if (stopped || gen !== generation) return
      // Stream ended (10 minute server lifetime, or the live connection is down).
      if (!gotSnapshot) throw new GsdcFailure('stream_ended')
      if (now() - startedAt >= GSDC_HEALTHY_STREAM_MS) failures = 0
      else failures++ // a stream that ends right after its snapshot must not reconnect in a tight loop
      arm(backoffMs(failures === 0 ? 1 : failures), gen)
    } catch (err) {
      if (stopped || gen !== generation) return
      const signature = err instanceof GsdcFailure ? err.signature : 'unreachable'
      console.error(`[corch.gsdc] source failure: ${signature}`)
      await reportFailure(signature)
      if (stopped || gen !== generation) return
      arm(backoffMs(failures), gen)
    } finally {
      if (idle !== null) deps.timers.clearTimeout(idle)
      ac.abort() // never leave a failed or finished SSE connection open (the console caps streams per account)
      if (abort === ac) abort = null
    }
  }

  return {
    /** Start consuming. A no-op (no connection, no timer, no store access) while CORCH is OFF or the source is unset. */
    start(): void {
      if (!stopped) return
      if (gsdcConfig().state === 'off') return
      stopped = false
      generation++
      void connect(generation)
    },
    stop(): void {
      stopped = true
      generation++
      clearTimer()
      abort?.abort()
      abort = null
    },
    /** Test hook: current consecutive-failure count. */
    get failures() {
      return failures
    },
  }
}

export type GsdcIngest = ReturnType<typeof createGsdcIngest>
