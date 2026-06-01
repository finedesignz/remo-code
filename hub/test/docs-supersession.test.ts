/**
 * Phase 19 / 19-04 Task 2 — R-PTY-24 supersession consistency. R-PTY-24 / T-19-05.
 *
 * Asserts the supersession marker (R-PTY-24 superseded by R-TG-01..12: Telegram is
 * a read-only transcript observer, NOT on the programmatic pool, never an API key)
 * is present + consistent across REQUIREMENTS + docs, and that no doc still claims
 * "stays on the programmatic pool by structural necessity" WITHOUT the superseded
 * caveat in the same file.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const REQUIREMENTS = join(REPO, '.planning', 'REQUIREMENTS.md')
const USAGE_COST = join(REPO, 'docs', 'usage-cost.md')

function read(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

describe('19-04 R-PTY-24 supersession (T-19-05)', () => {
  test('REQUIREMENTS marks R-PTY-24 superseded by R-TG', () => {
    const md = read(REQUIREMENTS)
    expect(md.toLowerCase()).toContain('supersed')
    expect(md).toContain('R-PTY-24')
    expect(md).toContain('R-TG-01')
  })

  test('docs/usage-cost.md carries the supersession note', () => {
    const md = read(USAGE_COST)
    expect(md.toLowerCase()).toContain('supersed')
    expect(md).toContain('R-PTY-24')
    expect(md).toContain('R-TG-01')
    expect(md.toLowerCase()).toContain('transcript')
    expect(md.toLowerCase()).toContain('read-only')
    expect(md.toLowerCase()).toContain('programmatic')
  })

  test('no file claims "structural necessity" without a supersession caveat in-file', () => {
    const files = [REQUIREMENTS, USAGE_COST, join(REPO, 'README.md'), join(REPO, 'CLAUDE.md')]
    for (const f of files) {
      const md = read(f)
      if (/structural necessity/i.test(md)) {
        // the same file MUST carry the supersession marker + the R-TG pointer
        expect(md.toLowerCase()).toContain('supersed')
        expect(md).toContain('R-TG-01')
      }
    }
  })

  test('the no-API-key invariant is stated alongside the supersession', () => {
    const md = read(USAGE_COST).toLowerCase()
    expect(md).toContain('api key')
  })
})
