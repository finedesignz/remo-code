import { describe, expect, test } from 'bun:test'
import { parseTriageOutput, TriageResult } from '../src/scheduler/triage-schema'

const valid = {
  error_type: 'DatabaseConnectionError',
  severity: 'high',
  root_cause: 'Postgres refused the connection on port 5432.',
  suggested_fix: 'Verify DATABASE_URL and ensure the DB container is healthy.',
  confidence: 0.85,
}

describe('parseTriageOutput', () => {
  test('valid JSON with all required fields → ok:true', () => {
    const r = parseTriageOutput(JSON.stringify(valid))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.error_type).toBe('DatabaseConnectionError')
      expect(r.value.severity).toBe('high')
      expect(r.value.confidence).toBeCloseTo(0.85)
    }
  })

  test('missing root_cause → ok:false with triage_parse_error', () => {
    const { root_cause: _omit, ...partial } = valid
    const r = parseTriageOutput(JSON.stringify(partial))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('triage_parse_error')
      expect(r.detail).toContain('root_cause')
    }
  })

  test('severity outside enum → ok:false', () => {
    const r = parseTriageOutput(JSON.stringify({ ...valid, severity: 'catastrophic' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('triage_parse_error')
  })

  test('confidence outside [0,1] → ok:false', () => {
    const r = parseTriageOutput(JSON.stringify({ ...valid, confidence: 1.5 }))
    expect(r.ok).toBe(false)
  })

  test('bare prose (not JSON) → ok:false', () => {
    const r = parseTriageOutput('The deployment failed because of reasons.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('triage_parse_error')
  })

  test('JSON wrapped in ```json fences → parser strips and validates ok', () => {
    const fenced = '```json\n' + JSON.stringify(valid) + '\n```'
    const r = parseTriageOutput(fenced)
    expect(r.ok).toBe(true)
  })

  test('affected_files optional: accepted when present, omitted when absent', () => {
    const withFiles = { ...valid, affected_files: ['src/db.ts', 'src/index.ts'] }
    const r1 = parseTriageOutput(JSON.stringify(withFiles))
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.value.affected_files).toEqual(['src/db.ts', 'src/index.ts'])

    const r2 = parseTriageOutput(JSON.stringify(valid))
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value.affected_files).toBeUndefined()
  })

  test('schema is exported and re-usable directly', () => {
    expect(TriageResult.safeParse(valid).success).toBe(true)
  })
})
