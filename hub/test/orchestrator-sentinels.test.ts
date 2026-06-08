/**
 * Milestone TMAC — Phase TMAC-01: sentinel-block parser.
 * Pure, no DB. Verifies <<STATE>>/<<NOTIFY>>/<<GATE>> parsing + SAFE fallbacks.
 *
 * Reqs: R-TMAC-01.
 */
import { describe, test, expect } from 'bun:test'
import { parseSentinels } from '../src/orchestrator/sentinels.ts'

describe('sentinels — STATE', () => {
  test('parses the canonical SPEC §5 STATE block', () => {
    const raw = [
      'some preamble text',
      '<<STATE',
      'lifecycle: building',
      'milestone: TMAC',
      'phase: 3/6',
      'last_action: planned phase 3',
      'next_action: execute phase 3',
      'decisions: none',
      'deployed_live: no',
      'STATE>>',
      'trailing text',
    ].join('\n')
    const r = parseSentinels(raw)
    expect(r.state).not.toBeNull()
    expect(r.state!.lifecycle).toBe('building')
    expect(r.state!.milestone).toBe('TMAC')
    expect(r.state!.phase).toBe('3/6')
    expect(r.state!.next_action).toBe('execute phase 3')
    expect(r.state!.deployed_live).toBe('no')
  })

  test('absent STATE → null (no throw)', () => {
    const r = parseSentinels('no sentinels here')
    expect(r.state).toBeNull()
    expect(r.notifies).toEqual([])
    expect(r.gate).toBeNull()
  })

  test('empty STATE field → null', () => {
    const r = parseSentinels('<<STATE\nlifecycle:\nphase: 1/2\nSTATE>>')
    expect(r.state!.lifecycle).toBeNull()
    expect(r.state!.phase).toBe('1/2')
  })
})

describe('sentinels — NOTIFY', () => {
  test('parses inline attrs incl. quoted detail', () => {
    const raw = '<<NOTIFY level=info channel=all detail="shipped v1.2.0, live">>'
    const r = parseSentinels(raw)
    expect(r.notifies).toHaveLength(1)
    expect(r.notifies[0].level).toBe('info')
    expect(r.notifies[0].channel).toBe('all')
    expect(r.notifies[0].detail).toBe('shipped v1.2.0, live')
  })

  test('level defaults to info when unspecified/unknown', () => {
    expect(parseSentinels('<<NOTIFY detail="hi">>').notifies[0].level).toBe('info')
    expect(parseSentinels('<<NOTIFY level=bogus>>').notifies[0].level).toBe('info')
  })

  test('blocking level recognized; multiple NOTIFY blocks', () => {
    const raw = '<<NOTIFY level=blocking detail="a">>\n<<NOTIFY level=info detail="b">>'
    const r = parseSentinels(raw)
    expect(r.notifies).toHaveLength(2)
    expect(r.notifies[0].level).toBe('blocking')
    expect(r.notifies[1].level).toBe('info')
  })
})

describe('sentinels — GATE', () => {
  test('parses reason + detail; first gate wins', () => {
    const raw =
      '<<GATE reason="destructive migration" detail="needs approval">>\n' +
      '<<GATE reason="second">>'
    const r = parseSentinels(raw)
    expect(r.gate).not.toBeNull()
    expect(r.gate!.reason).toBe('destructive migration')
    expect(r.gate!.detail).toBe('needs approval')
  })
})

describe('sentinels — combined / robustness', () => {
  test('STATE + GATE + NOTIFY together (mandatory-gate emission)', () => {
    const raw = [
      '<<STATE',
      'lifecycle: building',
      'STATE>>',
      '<<GATE reason="auth missing" detail="no COOLIFY_TOKEN">>',
      '<<NOTIFY level=blocking channel=all detail="paused on gate">>',
    ].join('\n')
    const r = parseSentinels(raw)
    expect(r.state!.lifecycle).toBe('building')
    expect(r.gate!.reason).toBe('auth missing')
    expect(r.notifies[0].level).toBe('blocking')
  })

  test('empty/garbage input never throws → EMPTY', () => {
    for (const bad of ['', '   ', '<<STATE', '<<NOTIFY', '<<GATE reason=']) {
      const r = parseSentinels(bad as any)
      expect(r).toBeDefined()
    }
    // @ts-expect-error — defensive: null tolerated
    expect(parseSentinels(null)).toEqual({ state: null, notifies: [], gate: null })
  })
})
