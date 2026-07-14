/**
 * Thin HTTP client for the remo-code hub's `/api/ext` surface.
 *
 * Config (env):
 *   REMO_HUB_URL   default https://app.remo-code.com
 *   REMO_API_KEY   a `remokey_…` key minted in Settings → Credentials.
 *                  Scope it `ext:read` for a checker task; `ext:ask` only if it
 *                  needs to SPEND TOKENS.
 */
export interface ExtClientConfig {
  hubUrl: string
  apiKey: string
}

export function configFromEnv(): ExtClientConfig {
  const hubUrl = (process.env.REMO_HUB_URL || 'https://app.remo-code.com').replace(/\/+$/, '')
  const apiKey = process.env.REMO_API_KEY || ''
  if (!apiKey) throw new Error('REMO_API_KEY is not set')
  return { hubUrl, apiKey }
}

async function call<T>(
  cfg: ExtClientConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.hubUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`hub returned non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok && res.status !== 202) {
    throw new Error(`hub ${method} ${path} → ${res.status} ${json?.error ?? ''} ${json?.detail ?? ''}`.trim())
  }
  return json as T
}

export const api = {
  listSessions: (cfg: ExtClientConfig) => call<any>(cfg, 'GET', '/api/ext/sessions'),
  readTranscript: (cfg: ExtClientConfig, session: string, tail = 30) =>
    call<any>(cfg, 'GET', `/api/ext/sessions/${encodeURIComponent(session)}/transcript?tail=${tail}`),
  readMemory: (cfg: ExtClientConfig, session: string) =>
    call<any>(cfg, 'GET', `/api/ext/sessions/${encodeURIComponent(session)}/memory`),
  state: (cfg: ExtClientConfig, session: string) =>
    call<any>(cfg, 'GET', `/api/ext/sessions/${encodeURIComponent(session)}/state`),
  ask: (cfg: ExtClientConfig, session: string, body: Record<string, unknown>) =>
    call<any>(cfg, 'POST', `/api/ext/sessions/${encodeURIComponent(session)}/ask`, body),
  getAsk: (cfg: ExtClientConfig, session: string, askId: string) =>
    call<any>(
      cfg,
      'GET',
      `/api/ext/sessions/${encodeURIComponent(session)}/ask/${encodeURIComponent(askId)}`,
    ),
}
