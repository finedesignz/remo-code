// hub/src/corch/memlog-rest.ts
//
// CORCH-15 (R3.8): the real hub->memlog transport. memlog exposes a REST claims API (mcp-servers apps/memlog,
// "REST claims API (COORD P1)") with the same store functions as its MCP tools:
//   POST /v1/claims            {repo, session, cli, branch, worktree, scope}   200 | 409 {holder} | 400 | 403
//   POST /v1/claims/heartbeat  {repo, session}                                 200 | 409
//   POST /v1/claims/release    {repo, session, status, note}                   200
// Auth: `x-api-key`, a per-agent token whose principal (cli + host) is registered in memlog's
// MEMLOG_AGENT_PRINCIPALS. `host` is never sent: it defaults to the principal's, so the hub cannot claim as
// another host. The token is only ever that one header: never logged, returned or placed in an error.
//
// Fail closed, no second transport: 409 is a conflict (the item waits, no attempt consumed); a network error,
// a timeout or any other status is `memlog_unavailable` (nothing dispatches without a claim).

import type { MemlogClient } from './memlog.ts'

const TIMEOUT_MS = 10_000

export interface MemlogRestConfig {
  baseUrl: string
  token: string
  /** The cli of the token's registered principal (memlog rejects a mismatch with 403). */
  cli: string
  fetchImpl?: typeof fetch
}

export function createRestMemlog(cfg: MemlogRestConfig): MemlogClient {
  const doFetch = cfg.fetchImpl ?? fetch
  const base = cfg.baseUrl.replace(/\/+$/, '')
  /** The HTTP status, or 0 when no answer was received. Never throws. */
  const post = async (path: string, body: Record<string, unknown>): Promise<number> => {
    try {
      const res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      void res.body?.cancel().catch(() => {})
      return res.status
    } catch {
      return 0
    }
  }
  const ok = (status: number) => status >= 200 && status < 300
  return {
    async claim(i) {
      const status = await post('/v1/claims', {
        repo: i.repo, session: i.session, cli: cfg.cli, branch: i.branch, worktree: i.worktree, scope: i.scope,
      })
      if (ok(status)) return { ok: true }
      if (status === 409) return { ok: false, reason: 'memlog_conflict' }
      console.warn(`[corch] memlog claim failed status=${status} repo=${i.repo} session=${i.session}`)
      return { ok: false, reason: 'memlog_unavailable' }
    },
    async heartbeat(i) {
      return ok(await post('/v1/claims/heartbeat', { repo: i.repo, session: i.session }))
    },
    async release(i) {
      return ok(await post('/v1/claims/release', { repo: i.repo, session: i.session, status: i.status, note: i.note }))
    },
  }
}
