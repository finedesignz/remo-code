/** Human-readable text for a hub `send_refused` on the terminal channel.
 *  Control characters are stripped: the text is written INTO the xterm, so a
 *  reason must never be able to inject escape sequences. */
export function describeTermRefusal(rawReason: string): string {
  // eslint-disable-next-line no-control-regex
  const reason = rawReason.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  if (reason.startsWith('over_daily_cost_cap')) {
    return `Daily cost cap reached (${reason.split(':').slice(1).join(':')}) — prompt not sent. Raise it in Settings → Usage.`
  }
  if (reason.startsWith('over_daily_token_cap')) return 'Daily token cap reached — prompt not sent.'
  if (reason.startsWith('quota_threshold_reached')) return 'Claude usage threshold reached — prompt not sent. Adjust it in Settings → Usage.'
  if (reason === 'pty_preflight_timeout' || reason === 'pty_preflight_error') {
    return 'Could not verify your spend limits right now — prompt not sent. Try again in a moment.'
  }
  if (reason === 'term_backpressure') {
    return 'Input is arriving faster than the terminal can accept it — some keystrokes were dropped.'
  }
  if (reason === 'not_current_writer') {
    return 'Another tab or connection took over this terminal — prompt not sent here.'
  }
  return `Prompt not sent (${reason || 'refused'}).`
}
