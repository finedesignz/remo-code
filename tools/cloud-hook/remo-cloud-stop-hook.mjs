#!/usr/bin/env node
/**
 * remo-code cloud-session Stop hook.
 *
 * Runs inside a claude.ai cloud session at the end of every turn and POSTs the
 * turn's assistant text (+ token usage) to the remo-code hub, so a remo chat can
 * follow a session that stays in the cloud. See docs/cloud-sessions.md.
 *
 * Env (set on the cloud ENVIRONMENT, not committed):
 *   REMO_HUB_URL          e.g. https://app.remo-code.com
 *   REMO_CLOUD_HOOK_KEY   api key minted with ONLY the `cloud:hook` scope
 * Provided by the cloud session itself:
 *   CLAUDE_CODE_REMOTE_SESSION_ID   cse_… — absent locally, so the hook is a no-op there
 *
 * Never blocks or fails the turn: every path exits 0 (so it can never cause a
 * Stop-hook loop). Another Stop hook may block and resume the turn, so this hook
 * can fire more than once per turn: a per-session watermark (last posted message
 * id, in the OS temp dir) makes each firing post only what is new.
 * No dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TIMEOUT_MS = 10_000
const MAX_TEXT = 200_000

/** True for a genuine human prompt (not a tool result, meta/system injection or sidechain). */
function isRealUserEntry(e) {
  if (e?.type !== 'user' || e.isSidechain || e.isMeta) return false
  const c = e.message?.content
  if (typeof c === 'string') return c.trim().length > 0
  if (!Array.isArray(c)) return false
  if (c.some((b) => b?.type === 'tool_result')) return false
  return c.some((b) => b?.type === 'text' && String(b.text ?? '').trim())
}

/**
 * Extract the last turn from transcript JSONL: every main-thread assistant text
 * block after the last real user prompt (and after `afterMessageId`, when that
 * message is inside the turn), with usage summed once per message id (the
 * transcript repeats a message's usage on each of its content-block entries).
 */
export function extractLastTurn(jsonl, afterMessageId = null) {
  const entries = []
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch {}
  }
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserEntry(entries[i])) { start = i + 1; break }
  }
  if (afterMessageId) {
    for (let i = entries.length - 1; i >= start; i--) {
      if (entries[i]?.type === 'assistant' && entries[i].message?.id === afterMessageId) { start = i + 1; break }
    }
  }
  let lastMessageId = null
  const texts = []
  const usageById = new Map()
  let model = null
  for (const e of entries.slice(start)) {
    if (e?.type !== 'assistant' || e.isSidechain) continue
    const m = e.message ?? {}
    if (m.model && m.model !== '<synthetic>') model = m.model
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) texts.push(b.text)
    }
    if (m.id) lastMessageId = m.id
    if (m.usage && m.id) usageById.set(m.id, m.usage)
  }
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  for (const u of usageById.values()) {
    for (const k of Object.keys(usage)) {
      const n = Number(u[k])
      if (Number.isFinite(n) && n > 0) usage[k] += Math.floor(n)
    }
  }
  return { text: texts.join('\n\n').trim(), model, usage, lastMessageId }
}

export function watermarkPath(cloudSessionId) {
  return join(tmpdir(), `remo-cloud-hook-${cloudSessionId}.json`)
}

/**
 * Returns `{ payload, lastMessageId }` or null when there is nothing to post.
 * `watermark` is the last message id already posted for this session.
 */
export function buildPayload(input, env, readFile = (p) => readFileSync(p, 'utf8'), watermark = null) {
  if (!input) return null
  const cloudSessionId = env.CLAUDE_CODE_REMOTE_SESSION_ID
  if (!cloudSessionId || !/^(cse|session)_[A-Za-z0-9_-]{1,128}$/.test(cloudSessionId)) return null
  let turn = { text: '', model: null, usage: null, lastMessageId: null }
  if (input.transcript_path) {
    try { turn = extractLastTurn(readFile(input.transcript_path), watermark) } catch {}
  }
  // A resumed turn (stop_hook_active) must use the transcript delta, never the
  // hook's last-message field, or the first part would be posted twice.
  const last = !input.stop_hook_active && typeof input.last_assistant_message === 'string'
    ? input.last_assistant_message.trim() : ''
  const text = (last || turn.text).slice(0, MAX_TEXT)
  if (!text) return null
  return {
    payload: { cloud_session_id: cloudSessionId, text, model: turn.model, usage: turn.usage },
    lastMessageId: turn.lastMessageId,
  }
}

async function main() {
  const hub = (process.env.REMO_HUB_URL || '').replace(/\/+$/, '')
  const key = process.env.REMO_CLOUD_HOOK_KEY || ''
  if (!hub || !key) return
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  const sid = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || ''
  let watermark = null
  try { watermark = JSON.parse(readFileSync(watermarkPath(sid), 'utf8')).last_message_id ?? null } catch {}
  const built = buildPayload(input, process.env, undefined, watermark)
  if (!built) return
  const { payload, lastMessageId } = built
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${hub}/api/cloud-hook/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!res.ok) console.error(`[remo-cloud-hook] hub answered ${res.status}`)
    else if (lastMessageId) {
      try { writeFileSync(watermarkPath(sid), JSON.stringify({ last_message_id: lastMessageId })) } catch {}
    }
  } catch (err) {
    console.error(`[remo-cloud-hook] post failed: ${err?.message ?? err}`)
  } finally {
    clearTimeout(t)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {}).finally(() => process.exit(0))
}
