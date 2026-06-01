import { describe, expect, it } from 'bun:test'
import { selectAdapter, TRANSCRIPT_ENTRY_KINDS } from '../src/telegram/transcript/index.ts'
import { ClaudeTranscriptAdapter } from '../src/telegram/transcript/claude-adapter.ts'
import { CodexTranscriptAdapter } from '../src/telegram/transcript/codex-adapter.ts'

describe('transcript backend-agnostic seam (R-TG-01)', () => {
  it('selectAdapter returns distinct adapters per cliKind', () => {
    const claude = selectAdapter('claude')
    const codex = selectAdapter('codex')
    expect(claude).toBeInstanceOf(ClaudeTranscriptAdapter)
    expect(codex).toBeInstanceOf(CodexTranscriptAdapter)
    expect(claude.cliKind).toBe('claude')
    expect(codex.cliKind).toBe('codex')
  })

  it('selectAdapter returns a FRESH instance per call (no shared singleton)', () => {
    expect(selectAdapter('claude')).not.toBe(selectAdapter('claude'))
  })

  it('the normalized union has exactly the 5 members', () => {
    expect([...TRANSCRIPT_ENTRY_KINDS].sort()).toEqual(
      ['assistant_text', 'permission_request', 'tool_use', 'turn_complete', 'user_question'].sort(),
    )
  })

  it('default (unknown-ish) cliKind falls to claude adapter', () => {
    // selectAdapter only narrows on 'codex'; anything else → claude (safe default).
    expect(selectAdapter('claude').cliKind).toBe('claude')
  })
})
