/**
 * Tests for hub/src/scheduler/log-classifier.ts (Phase 06 holdover, shipped
 * in Phase 11 cleanup). One case per advertised pattern + clean-log + edge
 * cases.
 */
import { describe, test, expect } from 'bun:test'
import { classifyLogs, _PATTERN_NAMES } from '../src/scheduler/log-classifier.ts'

function expectMatchOnly(text: string, name: string): void {
  const r = classifyLogs(text)
  expect(r.hasErrors).toBe(true)
  const names = r.matches.map((m) => m.pattern)
  expect(names).toContain(name)
}

describe('scheduler/log-classifier', () => {
  test('exposes 16 pattern names', () => {
    expect(_PATTERN_NAMES.length).toBe(16)
  })

  test('clean log → no matches, hasErrors=false', () => {
    const clean = [
      'Server listening on port 3040',
      '2026-05-27T18:00:00.000Z INFO request id=abc duration=12ms status=200',
      '[scheduler] tick at 18:05',
      'Bun build complete in 2.1s',
      'GET /healthz 200 4ms',
    ].join('\n')
    const r = classifyLogs(clean)
    expect(r.hasErrors).toBe(false)
    expect(r.matches).toHaveLength(0)
  })

  test('1. panic_or_fatal', () => {
    expectMatchOnly('runtime error: PANIC: invalid memory ref', 'panic_or_fatal')
  })

  test('2. unhandled_exception', () => {
    expectMatchOnly('node: unhandledRejection: TypeError x is null', 'unhandled_exception')
  })

  test('3. out_of_memory', () => {
    expectMatchOnly('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'out_of_memory')
  })

  test('4. port_in_use', () => {
    expectMatchOnly('Error: listen EADDRINUSE: address already in use :::3040', 'port_in_use')
  })

  test('5. econnrefused', () => {
    expectMatchOnly('connect ECONNREFUSED 127.0.0.1:5432', 'econnrefused')
  })

  test('6. http_5xx', () => {
    expectMatchOnly('upstream returned HTTP/1.1 502 Bad Gateway after 30s', 'http_5xx')
  })

  test('7. segfault', () => {
    expectMatchOnly('child process received SIGSEGV (segmentation fault)', 'segfault')
  })

  test('8. stack_overflow', () => {
    expectMatchOnly('RangeError: Maximum call stack size exceeded', 'stack_overflow')
  })

  test('9. error_line', () => {
    expectMatchOnly('[migrate] error: relation already exists', 'error_line')
  })

  test('10. container_exit_nonzero', () => {
    expectMatchOnly('container exited with non-zero status 137', 'container_exit_nonzero')
  })

  test('11. deploy_failed', () => {
    expectMatchOnly('coolify: deployment failed for application 9af3', 'deploy_failed')
  })

  test('12. migration_failed', () => {
    expectMatchOnly('drizzle: migration failed — column users.foo does not exist', 'migration_failed')
  })

  test('13. postgres_fatal', () => {
    expectMatchOnly('postgres[1234]: 2026-05-27 18:00:00 UTC [user@db] FATAL: too many connections', 'postgres_fatal')
  })

  test('14. auth_failure', () => {
    expectMatchOnly('JWT verification failed: token expired', 'auth_failure')
  })

  test('15. out_of_disk', () => {
    expectMatchOnly('write /var/log/app.log: no space left on device', 'out_of_disk')
  })

  test('16. dns_failure', () => {
    expectMatchOnly('Error: getaddrinfo ENOTFOUND api.example.com', 'dns_failure')
  })

  test('multiple patterns in one log accumulate', () => {
    const r = classifyLogs([
      'ECONNREFUSED 127.0.0.1:5432',
      'JavaScript heap out of memory',
      'deployment failed',
    ].join('\n'))
    const names = r.matches.map((m) => m.pattern)
    expect(r.hasErrors).toBe(true)
    expect(names).toContain('econnrefused')
    expect(names).toContain('out_of_memory')
    expect(names).toContain('deploy_failed')
  })

  test('empty / non-string input → no errors', () => {
    expect(classifyLogs('').hasErrors).toBe(false)
    // @ts-expect-error — runtime branch
    expect(classifyLogs(null).hasErrors).toBe(false)
    // @ts-expect-error — runtime branch
    expect(classifyLogs(undefined).hasErrors).toBe(false)
  })

  test('sample is truncated at ~240 chars', () => {
    const long = 'ECONNREFUSED ' + 'x'.repeat(500)
    const r = classifyLogs(long)
    const m = r.matches.find((m) => m.pattern === 'econnrefused')
    expect(m).toBeDefined()
    expect(m!.sample.length).toBeLessThanOrEqual(241) // 240 + ellipsis
  })
})
