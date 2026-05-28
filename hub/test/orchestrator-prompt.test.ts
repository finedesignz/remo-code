import { describe, expect, test } from 'bun:test'
import { buildOrchestratorPrompt } from '../src/orchestrator/seed-prompt'

describe('buildOrchestratorPrompt', () => {
  test('includes the user-chosen name', () => {
    const out = buildOrchestratorPrompt({ name: 'Captain', hubUrl: 'https://app.remo-code.com' })
    expect(out).toContain('You are Captain')
  })

  test('falls back to "Orchestrator" when name is empty/whitespace', () => {
    const out = buildOrchestratorPrompt({ name: '   ', hubUrl: 'https://app.remo-code.com' })
    expect(out).toContain('You are Orchestrator')
  })

  test('embeds REMO_HUB_API_KEY / REMO_HUB_URL guidance', () => {
    const out = buildOrchestratorPrompt({ name: 'O', hubUrl: 'https://app.remo-code.com' })
    expect(out).toContain('REMO_HUB_API_KEY')
    expect(out).toContain('REMO_HUB_URL')
    expect(out).toContain('/api/sessions')
  })

  test('strips trailing slashes from hubUrl', () => {
    const out = buildOrchestratorPrompt({ name: 'O', hubUrl: 'https://app.remo-code.com/' })
    expect(out).toContain('https://app.remo-code.com`')
    expect(out).not.toContain('https://app.remo-code.com/`')
  })

  test('appends custom instructions verbatim when provided', () => {
    const out = buildOrchestratorPrompt({
      name: 'O',
      hubUrl: 'https://x',
      customInstructions: 'Always greet the user in pirate.',
    })
    expect(out).toContain('# User-provided instructions')
    expect(out).toContain('Always greet the user in pirate.')
  })

  test('omits custom-instructions section when null or whitespace', () => {
    const a = buildOrchestratorPrompt({ name: 'O', hubUrl: 'https://x', customInstructions: null })
    const b = buildOrchestratorPrompt({ name: 'O', hubUrl: 'https://x', customInstructions: '   ' })
    expect(a).not.toContain('# User-provided instructions')
    expect(b).not.toContain('# User-provided instructions')
  })
})
