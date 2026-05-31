import { describe, it, expect } from 'bun:test'
import {
  parseQcFindings,
  extractFindingsBlock,
  findingHash,
  type QcFinding,
} from '../src/scheduler/qc-schema'

const block = (lines: string[]) => `<<FINDINGS\n${lines.join('\n')}\nFINDINGS`

describe('parseQcFindings (auto-dev P4)', () => {
  it('returns [] for zero findings (no block)', () => {
    expect(parseQcFindings('just prose, qc clean')).toEqual([])
  })

  it('returns [] for an empty block', () => {
    expect(parseQcFindings(block([]))).toEqual([])
  })

  it('parses N findings', () => {
    const out = parseQcFindings(
      block([
        'finding: severity=high; file=hub/src/x.ts:42; finding_type=correctness; root_cause=rc1; suggested_fix=sf1',
        'finding: severity=low; file=web/src/y.tsx:10; finding_type=reuse; root_cause=rc2; suggested_fix=sf2',
        'finding: severity=critical; file=hub/src/z.ts:7; finding_type=security; root_cause=rc3; suggested_fix=sf3',
      ]),
    )
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({
      severity: 'high',
      file: 'hub/src/x.ts:42',
      finding_type: 'correctness',
      root_cause: 'rc1',
      suggested_fix: 'sf1',
    })
    expect(out[2].finding_type).toBe('security')
  })

  it('skips malformed lines (bad severity / type / missing file) but keeps valid ones', () => {
    const out = parseQcFindings(
      block([
        'finding: severity=bogus; file=a.ts:1; finding_type=correctness; root_cause=r; suggested_fix=s',
        'finding: severity=high; file=b.ts:2; finding_type=nonsense; root_cause=r; suggested_fix=s',
        'finding: severity=high; finding_type=correctness; root_cause=r; suggested_fix=s',
        'finding: severity=medium; file=ok.ts:9; finding_type=security; root_cause=r; suggested_fix=s',
        'this is not a finding line',
      ]),
    )
    expect(out.length).toBe(1)
    expect(out[0].file).toBe('ok.ts:9')
  })

  it('tolerates surrounding prose and a bare closing marker', () => {
    const raw = `Here are my findings.\n\n<<FINDINGS\nfinding: severity=low; file=a.ts:3; finding_type=reuse; root_cause=r; suggested_fix=s\nFINDINGS\n\nSummary: QC review: 1 findings`
    expect(parseQcFindings(raw).length).toBe(1)
  })
})

describe('extractFindingsBlock', () => {
  it('returns the full block including markers', () => {
    const raw = `lead\n${block(['finding: severity=low; file=a.ts:1; finding_type=reuse; root_cause=r; suggested_fix=s'])}\ntrailing`
    const got = extractFindingsBlock(raw)
    expect(got).toContain('<<FINDINGS')
    expect(got).toContain('FINDINGS')
    expect(got).toContain('file=a.ts:1')
  })

  it('returns null when no block present', () => {
    expect(extractFindingsBlock('no block here')).toBeNull()
  })
})

describe('findingHash', () => {
  const f: QcFinding = {
    severity: 'high',
    file: 'hub/src/x.ts:42',
    finding_type: 'correctness',
    root_cause: 'rc',
    suggested_fix: 'sf',
  }

  it('is stable for the same (repo, file, type, top_line)', () => {
    expect(findingHash('repo', f)).toBe(findingHash('repo', f))
  })

  it('ignores root_cause / suggested_fix / severity changes (same root cause hashes same)', () => {
    const f2: QcFinding = { ...f, severity: 'low', root_cause: 'different', suggested_fix: 'other' }
    expect(findingHash('repo', f2)).toBe(findingHash('repo', f))
  })

  it('differs when file, type, line, or repo differ', () => {
    expect(findingHash('repo2', f)).not.toBe(findingHash('repo', f))
    expect(findingHash('repo', { ...f, file: 'hub/src/x.ts:99' })).not.toBe(findingHash('repo', f))
    expect(findingHash('repo', { ...f, finding_type: 'security' })).not.toBe(findingHash('repo', f))
  })
})
