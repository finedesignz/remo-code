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
import type { CorchProject, CorchStore } from './store.ts'
import type { CorchTimers } from './dispatcher.ts'

export const GSDC_BACKOFF_BASE_MS = 1000
export const GSDC_BACKOFF_CAP_MS = 5 * 60 * 1000
/** A stream that stayed up at least this long counts as healthy: the next reconnect starts the ladder over. */
export const GSDC_HEALTHY_STREAM_MS = 30000
/** No bytes (events or keepalive comments) for this long => treat the stream as dead and reconnect. */
export const GSDC_IDLE_TIMEOUT_MS = 3 * 60 * 1000
const MAX_FRAME_BYTES = 2 * 1024 * 1024

export interface GsdcOutage {
  /** Enabled-project owners; the real notifier fans out to each. Never includes console text. */
  userIds: string[]
  /** Stable error signature: unreachable | http_5xx | http_401 | http_402 | http_403 | http_<n> | stream_error | stream_error:<code> | stream_ended | bad_payload | token_unset | url_unset */
  signature: string
}

export interface GsdcDeps {
  store: Pick<CorchStore, 'listEnabledProjects' | 'enqueueWorkItem' | 'cancelQueuedBySourceRefs'>
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>
  timers: CorchTimers
  notifyOutage: (o: GsdcOutage) => Promise<void>
  /** A new item was queued for this user: evaluate now (event-driven). */
  onEnqueued: (userId: string) => Promise<void>
  now?: () => number
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
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) buf += dec.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
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
    try {
      return await res.json()
    } catch {
      throw new GsdcFailure('bad_payload')
    }
  }

  /** Re-read the boards of the given summaries (enrolled only) and apply the result all-or-nothing. */
  async function handleSummaries(summaries: BoardSummary[], base: string, token: string, signal: AbortSignal): Promise<void> {
    const enabled = await deps.store.listEnabledProjects()
    const byIdent = new Map<string, CorchProject[]>()
    for (const p of enabled) byIdent.set(p.repo_ident, [...(byIdent.get(p.repo_ident) ?? []), p])

    const reads: Array<{ summary: BoardSummary; projects: CorchProject[]; board: BoardDetail }> = []
    for (const summary of summaries) {
      const projects = byIdent.get(`github://${summary.slug.toLowerCase()}`)
      if (!projects || projects.length === 0) continue
      // A project the console is not authoritative about is skipped before any read (no upsert, no cancel).
      if (summary.active_runs > 0 || summary.stale || summary.divergent) continue
      const raw = await fetchJson(base, token, `/api/board/projects/${encodeURIComponent(summary.id)}`, signal)
      const parsed = BoardDetail.safeParse(raw)
      if (!parsed.success) throw new GsdcFailure('bad_payload')
      reads.push({ summary, projects, board: parsed.data })
    }

    // Every read succeeded: apply.
    const touched = new Set<string>()
    for (const { summary, projects, board } of reads) {
      const d = deriveCandidate(summary.slug, summary, board)
      if (d.kind === 'skip') continue
      for (const project of projects) {
        await deps.store.cancelQueuedBySourceRefs(project.id, 'gsd_console', d.doneRefs)
        if (d.candidate) {
          const r = await deps.store.enqueueWorkItem({
            userId: project.user_id,
            projectId: project.id,
            source: 'gsd_console',
            sourceRef: d.candidate.sourceRef,
            title: d.candidate.title,
            body: d.candidate.body,
            priority: project.priority,
          })
          if (r.created) touched.add(project.user_id)
        }
      }
    }
    for (const userId of touched) {
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
        for await (const ev of parseSse(res.body)) {
          rearmIdle()
          if (stopped || gen !== generation) return
          if (ev.event === 'stream-error') {
            let code = ''
            try {
              code = String((JSON.parse(ev.data) as { code?: unknown }).code ?? '')
            } catch {
              /* signature falls back to plain stream_error */
            }
            throw new GsdcFailure(/^[a-z0-9_.-]{1,40}$/i.test(code) ? `stream_error:${code}` : 'stream_error')
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
          await handleSummaries(summaries, cfg.baseUrl, cfg.token, ac.signal)
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
