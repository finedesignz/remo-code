import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ClaudeTranscriptAdapter,
  claudeProjectSlug,
  claudeTranscriptPath,
  mapClaudeRecord,
} from '../src/telegram/transcript/claude-adapter.ts'
import type { TranscriptEntry } from '../src/telegram/transcript/types.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'claude-transcript.jsonl')

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('Claude transcript adapter — record mapping (R-TG-02, T-20-02)', () => {
  it('maps each known record type and SKIPS the unknown one', () => {
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n')
    let skipped = 0
    const entries: TranscriptEntry[] = []
    for (const l of lines) {
      const e = mapClaudeRecord(JSON.parse(l), 'sess-1', () => skipped++)
      if (e) entries.push(e)
    }
    const kinds = entries.map((e) => e.kind)
    expect(kinds).toContain('assistant_text')
    expect(kinds).toContain('tool_use')
    expect(kinds).toContain('permission_request')
    expect(kinds).toContain('user_question')
    expect(kinds).toContain('turn_complete')
    // The weird_future_record line is skipped, never misclassified.
    expect(skipped).toBe(1)
    expect(kinds.filter((k) => k === 'permission_request').length).toBe(1)
  })

  it('boolean permission (no options array) becomes Approve/Deny — fail-closed shape', () => {
    const e = mapClaudeRecord(
      { type: 'permission_request', request_id: 'r1', tool_name: 'Bash' },
      's',
      () => {},
    )
    expect(e?.kind).toBe('permission_request')
    if (e?.kind === 'permission_request') {
      expect(e.options.map((o) => o.id)).toEqual(['approve', 'deny'])
    }
  })

  it('permission with no request id ⇒ skipped (never an optimistic permission)', () => {
    let skipped = 0
    const e = mapClaudeRecord({ type: 'permission_request', tool_name: 'Bash' }, 's', () => skipped++)
    expect(e).toBeNull()
    expect(skipped).toBe(1)
  })

  it('a non-object record ⇒ skipped', () => {
    let skipped = 0
    expect(mapClaudeRecord('garbage', 's', () => skipped++)).toBeNull()
    expect(skipped).toBe(1)
  })
})

describe('Claude transcript adapter — deterministic file resolution (T-20-01)', () => {
  it('slug + path derivation are deterministic from (projectDir, sessionId)', () => {
    const slug = claudeProjectSlug('/home/u/My Repo')
    expect(slug).toBe('home-u-My-Repo')
    const p = claudeTranscriptPath('/home/u/My Repo', 'uuid-1')
    expect(p).toContain('uuid-1.jsonl')
    expect(p).toContain(slug)
  })

  it('two sessions in ONE project resolve to DISTINCT files', () => {
    const a = claudeTranscriptPath('/home/u/proj', 'sess-A')
    const b = claudeTranscriptPath('/home/u/proj', 'sess-B')
    expect(a).not.toBe(b)
    expect(a).toContain('sess-A.jsonl')
    expect(b).toContain('sess-B.jsonl')
  })

  it('absent file ⇒ scrape-mode (NEVER a newest-file guess)', async () => {
    const adapter = new ClaudeTranscriptAdapter()
    const res = await adapter.open(
      { sessionId: 'nope', projectDir: '/no/such/dir', cliKind: 'claude' },
      () => {},
    )
    expect(res.mode).toBe('scrape')
    expect(res.path).toBeNull()
    adapter.close()
  })

  it('persisted transcriptPath WINS and tails appended lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-tail-'))
    const file = join(dir, 'sess.jsonl')
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n')
    const adapter = new ClaudeTranscriptAdapter()
    const got: TranscriptEntry[] = []
    const res = await adapter.open(
      { sessionId: 'sess', projectDir: '/whatever', cliKind: 'claude', transcriptPath: file },
      (e) => got.push(e),
    )
    expect(res.mode).toBe('file')
    expect(res.path).toBe(file)
    await wait(120)
    // append a new turn — tail should pick it up
    writeFileSync(file, JSON.stringify({ type: 'result', subtype: 'success' }) + '\n', { flag: 'a' })
    await wait(700)
    adapter.close()
    expect(got.some((e) => e.kind === 'assistant_text')).toBe(true)
    expect(got.some((e) => e.kind === 'turn_complete')).toBe(true)
  })
})
