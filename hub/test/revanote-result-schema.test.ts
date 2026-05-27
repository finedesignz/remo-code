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
