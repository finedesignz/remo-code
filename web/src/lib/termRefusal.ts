/** Human-readable text for a hub `send_refused` on the terminal channel. */
export function describeTermRefusal(reason: string): string {
  if (reason.startsWith('over_daily_cost_cap')) {
    return `Daily cost cap reached (${reason.split(':').slice(1).join(':')}) — prompt not sent. Raise it in Settings → Usage.`
  }
  if (reason.startsWith('over_daily_token_cap')) return 'Daily token cap reached — prompt not sent.'
  if (reason.startsWith('quota_threshold_reached')) return 'Claude usage threshold reached — prompt not sent. Adjust it in Settings → Usage.'
  if (reason === 'pty_preflight_timeout' || reason === 'pty_preflight_error') {
    return 'Could not verify your spend limits right now — prompt not sent. Try again in a moment.'
  }
  return `Prompt not sent (${reason || 'refused'}).`
}
