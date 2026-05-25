// Tracks the most recent user-originated message per session in localStorage.
// Used by the auto-nudge gate so we don't re-send a status-update prompt
// within an hour of the user's last message, or twice in a row.

const KEY = (sid: string) => `remo:last-user-msg:${sid}`

export interface LastUserMsg {
  ts: number
  content: string
}

export function recordUserMessage(sessionId: string, content: string) {
  if (!sessionId) return
  try {
    const payload: LastUserMsg = { ts: Date.now(), content }
    localStorage.setItem(KEY(sessionId), JSON.stringify(payload))
  } catch {}
}

export function readLastUserMessage(sessionId: string): LastUserMsg | null {
  if (!sessionId) return null
  try {
    const raw = localStorage.getItem(KEY(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastUserMsg
    if (typeof parsed?.ts !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
