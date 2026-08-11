import { describe, expect, test } from 'bun:test'
import { parseRevanoteOutput, stripRevanoteEnvelope } from '../src/revanote/result-schema'

describe('parseRevanoteOutput', () => {
  test('envelope path returns parsed result', () => {
    const r = parseRevanoteOutput(
      'Fixed the alignment bug.\n\n<<JSON>>\n{"resolved":true,"action_taken":"updated flex","files_changed":["a.tsx"],"deployed":true}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.resolved).toBe(true)
      expect(r.value.files_changed).toEqual(['a.tsx'])
      expect(r.value.deployed).toBe(true)
      expect(r.preface).toContain('Fixed the alignment bug.')
    }
  })

  test('fenced JSON fallback', () => {
    const r = parseRevanoteOutput(
      'Here is what I did:\n```json\n{"resolved":false,"action_taken":"need more info","files_changed":[],"needs_clarification":true,"clarification_question":"which page?"}\n```',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.resolved).toBe(false)
      expect(r.value.needs_clarification).toBe(true)
      expect(r.value.clarification_question).toBe('which page?')
    }
  })

  test('bare prose → fallback with resolved:false', () => {
    const r = parseRevanoteOutput('Tried but could not reproduce.')
    expect(r.ok).toBe(false)
    expect(r.value.resolved).toBe(false)
    expect(r.value.action_taken).toBe('envelope_missing')
    expect(r.value.agent_reply).toContain('Tried but could not reproduce.')
  })

  test('invalid JSON in envelope → schema fallback', () => {
    const r = parseRevanoteOutput('<<JSON>>\n{not json}\n<<END>>')
    expect(r.ok).toBe(false)
    expect(['invalid_json', 'schema_invalid']).toContain(r.reason)
  })

  test('empty reply → fallback', () => {
    const r = parseRevanoteOutput('')
    expect(r.ok).toBe(false)
    expect(r.value.resolved).toBe(false)
  })

  test('envelope with assumption is preserved (Phase 5 fix contract)', () => {
    const r = parseRevanoteOutput(
      '<<JSON>>\n{"resolved":true,"action_taken":"did it","assumption":"assumed the primary CTA","files_changed":[]}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.assumption).toBe('assumed the primary CTA')
    }
  })

  test('envelope with clarification_reason is preserved (Phase 5 fix contract)', () => {
    const r = parseRevanoteOutput(
      '<<JSON>>\n{"resolved":false,"action_taken":"","files_changed":[],"needs_clarification":true,"clarification_reason":"ambiguous_intent"}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.clarification_reason).toBe('ambiguous_intent')
    }
  })

  // BLOCKER 3 (05-QC.md) — an agent emitting explicit `null` for a field it
  // didn't use (no assumption made, no clarification needed) must NOT blow
  // up the parse. A genuinely successful fix must not be marked `failed`.
  test('explicit null assumption on a resolved result still parses ok (BLOCKER 3)', () => {
    const r = parseRevanoteOutput(
      '<<JSON>>\n{"resolved":true,"action_taken":"did it","assumption":null,"files_changed":[]}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.resolved).toBe(true)
      expect(r.value.assumption ?? null).toBeNull()
    }
  })

  test('explicit null clarification_reason on a resolved result still parses ok (BLOCKER 3)', () => {
    const r = parseRevanoteOutput(
      '<<JSON>>\n{"resolved":true,"action_taken":"did it","clarification_reason":null,"files_changed":[]}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.resolved).toBe(true)
      expect(r.value.clarification_reason ?? null).toBeNull()
    }
  })

  test('explicit null on pre-existing optional siblings still parses ok', () => {
    const r = parseRevanoteOutput(
      '<<JSON>>\n{"resolved":true,"action_taken":"did it","agent_reply":null,"deployed":null,"needs_clarification":null,"clarification_question":null,"files_changed":[]}\n<<END>>',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.resolved).toBe(true)
    }
  })
})

describe('stripRevanoteEnvelope', () => {
  test('removes <<JSON>>…<<END>> block', () => {
    const cleaned = stripRevanoteEnvelope('hello\n<<JSON>>{"x":1}<<END>>\nworld')
    expect(cleaned).not.toContain('<<JSON>>')
    expect(cleaned).not.toContain('<<END>>')
    expect(cleaned).toContain('hello')
    expect(cleaned).toContain('world')
  })

  test('removes ```json fenced block', () => {
    const cleaned = stripRevanoteEnvelope('before\n```json\n{"x":1}\n```\nafter')
    expect(cleaned).not.toContain('```')
    expect(cleaned).toContain('before')
    expect(cleaned).toContain('after')
  })
})
