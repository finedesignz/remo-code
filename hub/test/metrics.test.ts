/**
 * B4: metrics module unit tests. No DB, no network.
 */
import { describe, test, expect } from 'bun:test'
import { counter, gauge, histogram, renderPrometheus } from '../src/observability/metrics'

describe('metrics — counter', () => {
  test('inc accumulates per-label-set', () => {
    const c = counter('test_counter_a', 'tt')
    c.inc({ result: 'ok' })
    c.inc({ result: 'ok' })
    c.inc({ result: 'err' })
    const out = renderPrometheus()
    expect(out).toContain('# HELP test_counter_a tt')
    expect(out).toContain('# TYPE test_counter_a counter')
    expect(out).toMatch(/test_counter_a\{result="ok"\} 2/)
    expect(out).toMatch(/test_counter_a\{result="err"\} 1/)
  })

  test('inc with delta', () => {
    const c = counter('test_counter_b', 'tt')
    c.inc({}, 5)
    c.inc({}, 3)
    const out = renderPrometheus()
    expect(out).toMatch(/test_counter_b 8/)
  })
})

describe('metrics — gauge', () => {
  test('set replaces value', () => {
    const g = gauge('test_gauge_a', 'tt')
    g.set(10, { role: 'x' })
    g.set(7, { role: 'x' })
    const out = renderPrometheus()
    expect(out).toMatch(/test_gauge_a\{role="x"\} 7/)
  })

  test('inc/dec adjusts value', () => {
    const g = gauge('test_gauge_b', 'tt')
    g.inc({ role: 'y' })
    g.inc({ role: 'y' })
    g.dec({ role: 'y' })
    const out = renderPrometheus()
    expect(out).toMatch(/test_gauge_b\{role="y"\} 1/)
  })
})

describe('metrics — histogram', () => {
  test('observe records bucket counts + sum + count', () => {
    const h = histogram('test_hist_a', 'tt')
    h.observe(0.003)
    h.observe(0.05)
    h.observe(2.0)
    const out = renderPrometheus()
    expect(out).toContain('# TYPE test_hist_a histogram')
    expect(out).toMatch(/test_hist_a_bucket\{le="0.005"\} 1/)
    expect(out).toMatch(/test_hist_a_bucket\{le="0.05"\} 2/)
    expect(out).toMatch(/test_hist_a_bucket\{le="\+Inf"\} 3/)
    expect(out).toMatch(/test_hist_a_count 3/)
  })
})

describe('metrics — exposition format', () => {
  test('every non-comment line matches Prometheus shape', () => {
    const c = counter('test_fmt', 'a help string')
    c.inc({ a: 'x' })
    const out = renderPrometheus()
    const lines = out.split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.startsWith('#')) continue
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})?\s+-?\d+(\.\d+)?$/)
    }
  })

  test('label values are escaped', () => {
    const c = counter('test_esc', 'tt')
    c.inc({ msg: 'a"b\\c' })
    const out = renderPrometheus()
    expect(out).toContain('msg="a\\"b\\\\c"')
  })
})
