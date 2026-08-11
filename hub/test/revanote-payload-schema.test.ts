/**
 * Phase 5 payload-schema additions: batch + repo fields are optional and
 * parsed; classic payloads still parse (regression).
 */
import { describe, expect, test } from 'bun:test'
import { RevanotePayload } from '../src/revanote/payload-schema'

const base = {
  annotation_id: 'a1',
  page_url: 'https://example.com/page',
  comment: 'change copy',
  callback_url: 'https://revanote.example.com/api/webhooks/how-callback',
}

describe('RevanotePayload Phase 5 fields', () => {
  test('accepts batch + repo fields when present', () => {
    const r = RevanotePayload.safeParse({
      ...base,
      batch_id: '11111111-1111-1111-1111-111111111111',
      batch_size: 3,
      batch_index: 0,
      repo_slug: 'acme/site',
      repo_kind: 'github',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.batch_id).toBe('11111111-1111-1111-1111-111111111111')
      expect(r.data.batch_size).toBe(3)
      expect(r.data.repo_slug).toBe('acme/site')
      expect(r.data.repo_kind).toBe('github')
    }
  })

  test('classic single-shot payload still parses (regression)', () => {
    const r = RevanotePayload.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.batch_id).toBeUndefined()
      expect(r.data.repo_kind).toBeUndefined()
    }
  })

  test('rejects bad repo_kind', () => {
    const r = RevanotePayload.safeParse({ ...base, repo_kind: 'gitlab' })
    expect(r.success).toBe(false)
  })

  test('rejects bad batch_id (not uuid)', () => {
    const r = RevanotePayload.safeParse({ ...base, batch_id: 'not-a-uuid' })
    expect(r.success).toBe(false)
  })

  test('rejects negative batch_index', () => {
    const r = RevanotePayload.safeParse({ ...base, batch_index: -1 })
    expect(r.success).toBe(false)
  })

  test('accepts fix_contract when present (Phase 5)', () => {
    const r = RevanotePayload.safeParse({
      ...base,
      fix_contract: {
        version: 1,
        default: 'best_guess',
        ask_reasons: ['ambiguous_intent', 'conflicting_instruction', 'missing_target', 'out_of_scope'],
      },
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.fix_contract?.default).toBe('best_guess')
    }
  })
})
