/**
 * PTYCAP-08-07 Task 1 (F1-A5, T-08-32/33): hostile task names, run errors and ids cannot
 * inject markup, forge digest lines or break a rendered command. Output is ASCII only
 * (characters 9, 10 and 32-126) in BOTH the text and html parts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterAll, mock } from 'bun:test'
import type { Finding, TaskQcResult } from '../src/task-qc/types.ts'

mock.module('../src/lib/email.ts', () => ({ sendEmail: async () => true }))
afterAll(() => mock.restore())

const { buildDigest } = await import(`../src/task-qc/digest.ts?escape=${Date.now()}`)

const ID = 'task-abc_1'
const finding = (over: Partial<Finding> = {}): Finding => ({
  detector: 'FAILING',
  taskId: ID,
  taskName: 'Nightly sweep',
  taskType: 'dev',
  severity: 'high',
  evidence: { lastError: 'boom' },
  proposal: { kind: 'propose_disable', params: { taskId: ID } },
  ...over,
})
const build = (f: Finding, applied: TaskQcResult['applied'] = []) => buildDigest({ findings: [f], applied, proposals: [f], truncated: false }, {})
const ok = (c: string) => c.charCodeAt(0) === 9 || c.charCodeAt(0) === 10 || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)
const asciiOnly = (s: string) => [...s].every(ok)

/** Every hostile string lands in the task name AND in an evidence value AND the subject-free body. */
function hostile(name: string, raw: string) {
  test(name, () => {
    const f = finding({ taskName: raw, evidence: { lastError: raw, note: raw } })
    const d = build(f)
    expect(asciiOnly(d.text)).toBe(true)
    expect(asciiOnly(d.html)).toBe(true)
    expect(asciiOnly(d.subject)).toBe(true)
    // the html part carries no live markup from data
    expect(d.html).not.toMatch(/<script|<img|<iframe|onerror|javascript:/i)
    expect(d.subject).not.toContain(raw.slice(0, 5) || 'zzzz')
  })
}

describe('hostile input classes (one test each)', () => {
  hostile('script tag', '<script>alert(1)</script>')
  hostile('angle brackets and ampersand', 'a < b && c > d &amp; &lt;')
  hostile('double and single quotes', `he said "hi" and 'bye'`)
  hostile('backticks', '`rm -rf /` ${process.env}')
  hostile('newlines and carriage returns', 'line1\nline2\r\nline3\rline4')
  hostile('tab and NUL', 'a\tb\u0000c')
  hostile('ANSI escape', '\u001b[31mred\u001b[0m\u001b]0;title\u0007')
  hostile('emoji', 'launch \u{1F680} done \u{1F4A5}')
  hostile('em dash and curly quotes', '— – “quoted” ‘x’ …')
  hostile('10000 character string', 'A'.repeat(10_000))
  hostile('SQL fragment', "x'; DROP TABLE scheduled_tasks; --")
  hostile('html entity smuggling', '&#60;script&#62;')

  test('script text is escaped in html and present only as inert text', () => {
    const d = build(finding({ taskName: '<script>alert(1)</script>' }))
    expect(d.html).toContain('&lt;script&gt;')
    expect(d.html).not.toContain('<script>')
  })

  test('a 10000 character name is truncated, not rendered whole', () => {
    const d = build(finding({ taskName: 'A'.repeat(10_000) }))
    expect(d.text.length).toBeLessThan(3_000)
    expect(d.html.length).toBeLessThan(6_000)
  })

  test('no digest line can begin with a header forged from data', () => {
    const forged = 'x\nAPPLIED AUTOMATICALLY (99)\n#99 FAILING [high] injected (evil)\nSummary: owned\nPATCH /api/scheduled-tasks/evil'
    const f = finding({ taskName: forged, evidence: { lastError: forged } })
    const d = build(f)
    expect(d.text.match(/^APPLIED AUTOMATICALLY/gm) ?? []).toHaveLength(0)
    expect((d.text.match(/^#\d+ /gm) ?? []).length).toBe(1)
    expect((d.text.match(/^Summary: /gm) ?? []).length).toBe(1)
    // the only PATCH line is the real one for the real id
    const patches = d.text.split('\n').filter((l: string) => l.trimStart().startsWith('PATCH '))
    expect(patches).toEqual([`  PATCH /api/scheduled-tasks/${ID}`])
    // every non-empty line is either indented data or a fixed column-0 line
    for (const line of d.text.split('\n')) {
      if (line === '' || line.startsWith('  ')) continue
      expect(line).toMatch(/^(Task quality|Summary: |FINDINGS \(|APPLIED AUTOMATICALLY \(|#\d+ [A-Z_]+ \[(high|warn|info)\] |\d+ more finding|\[digest truncated)/)
    }
  })

  test('a name with a single quote cannot terminate a SQL literal in a rendered command', () => {
    const f = finding({
      detector: 'DEAD_SESSION',
      taskName: "O'Brien'; DROP TABLE x; --",
      proposal: { kind: 'rebind_session', params: { taskId: ID, staleSessionId: "s'; DROP TABLE y; --" } },
    })
    const d = build(f)
    const cmd = d.text.split('\n').find((l: string) => l.includes('UPDATE scheduled_tasks'))!
    expect(cmd).toContain("session_id IS NOT DISTINCT FROM 's''; DROP TABLE y; --'")
    // every quote inside the literal is doubled: stripping '' pairs leaves a balanced count
    expect((cmd.replace(/''/g, '').match(/'/g) ?? []).length % 2).toBe(0)
    expect(cmd).not.toContain("O'Brien")
  })

  test('a hostile task id is never placed in a command', () => {
    for (const id of ["a'; DROP TABLE t; --", 'a b', '../../etc/passwd', 'x\ny', 'é', '<b>']) {
      const f = finding({ taskId: id, proposal: { kind: 'fix_timezone', params: { taskId: id } } })
      const d = build(f)
      expect(d.text).not.toMatch(/UPDATE scheduled_tasks|PATCH \/api/)
      expect(asciiOnly(d.text)).toBe(true)
    }
  })

  test('hostile applied-fix values are escaped; a rollback with non-ascii data is not rendered corrupted', () => {
    const f = finding({ detector: 'MISCONFIGURED', fixCandidate: 'normalize_timezone', proposal: { kind: 'fix_timezone', params: { taskId: ID } } })
    const applied: TaskQcResult['applied'] = [
      {
        finding: f,
        fix: 'normalize_timezone',
        taskId: ID,
        before: { timezone: '<script>\né' },
        after: { timezone: 'UTC' },
        rollbackSql: "UPDATE scheduled_tasks SET timezone = '<script>\né' WHERE id = 'task-abc_1'",
      },
    ]
    const d = build(f, applied)
    expect(asciiOnly(d.text)).toBe(true)
    expect(asciiOnly(d.html)).toBe(true)
    expect(d.html).not.toContain('<script>')
    expect(d.text).not.toContain("SET timezone = '<script>")
    expect(d.text).toMatch(/rollback SQL .* not shown/i)
  })

  test('hostile evidence array and nested values stay typed and escaped', () => {
    const f = finding({ evidence: { memberIds: ['<b>x</b>', 'y\nz'], flag: true, n: 3, nothing: null } as any })
    const d = build(f)
    expect(asciiOnly(d.text)).toBe(true)
    expect(d.html).not.toContain('<b>')
    expect(d.text).toContain('flag: true')
    expect(d.text).toContain('n: 3')
  })
})
