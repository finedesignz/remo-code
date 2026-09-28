// PTYCAP Phase 2: the hub refuses a PTY prompt submit over a spend ceiling with
// `send_refused { channel: 'term', reason }`; TerminalSurface prints this text
// in the terminal so the dropped Enter is never silent.
import { describe, test, expect } from 'bun:test'
import { describeTermRefusal } from '../src/lib/termRefusal'

describe('describeTermRefusal', () => {
  test('cost cap names the figures and where to raise it', () => {
    const t = describeTermRefusal('over_daily_cost_cap:$12.00>=$10.00')
    expect(t).toContain('$12.00>=$10.00')
    expect(t).toContain('Settings → Usage')
  })
  test('token cap, threshold, and fail-closed errors each get a clear message', () => {
    expect(describeTermRefusal('over_daily_token_cap:60000000>=50000000')).toContain('Daily token cap')
    expect(describeTermRefusal('quota_threshold_reached:session_threshold:99>=80')).toContain('usage threshold')
    expect(describeTermRefusal('pty_preflight_timeout')).toContain('Could not verify')
    expect(describeTermRefusal('pty_preflight_error')).toContain('Could not verify')
    expect(describeTermRefusal('not_current_writer')).toContain('Another tab')
    expect(describeTermRefusal('term_backpressure')).toContain('dropped')
  })
  test('an unknown reason still tells the user the prompt was not sent', () => {
    expect(describeTermRefusal('something_new')).toContain('Prompt not sent')
  })
  test('control characters in a reason are stripped (no escape injection into the xterm)', () => {
    const t = describeTermRefusal('weird\x1b[2J\x07reason')
    expect(t).not.toMatch(/[\x00-\x1f]/)
    expect(t).toContain('weird[2Jreason')
  })
})
