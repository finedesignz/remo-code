import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('suppressed 4001 reload routes to Login', () => {
  test('useWebSocket emits an unauthorized auth event when the reload guard refuses', () => {
    const src = readFileSync(new URL('../src/hooks/useWebSocket.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/else emitAuthEvent\('unauthorized'\)/)
  })
})
