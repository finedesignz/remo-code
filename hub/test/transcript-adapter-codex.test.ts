import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CodexTranscriptAdapter,
  mapCodexRecord,
  resolveCodexRolloutByMetaId,
} from '../src/telegram/transcript/codex-adapter.ts'
import type { TranscriptEntry } from '../src/telegram/transcript/types.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'codex-rollout.jsonl')
const UNRECOGNIZED = join(import.meta.dir, 'fixtures', 'unrecognized-rollout.jsonl')

describe('Codex transcript adapter — rollout mapping (R-TG-03)', () => {
  it('maps assistant message + function_call, skips reasoning/meta', () => {
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n')
    let skipped = 0
    const entries: TranscriptEntry[] = []
    for (const l of lines) {
      const e = mapCodexRecord(JSON.parse(l), 'sess-1', () => skipped++)
      if (e) entries.push(e)
    }
    const kinds = entries.map((e) => e.kind)
    expect(kinds).toContain('assistant_text')
    expect(kinds).toContain('tool_use')
    // session_meta / turn_context / reasoning are silently dropped (not unknown).
    expect(skipped).toBe(0)
    // CRITICAL: rollout mapping NEVER emits a permission_request in this build.
    expect(kinds).not.toContain('permission_request')
  })

  it('unrecognized top-level + payload types ⇒ skipped, never misclassified (T-20-02)', () => {
    const lines = readFileSync(UNRECOGNIZED, 'utf8').trim().split('\n')
    let skipped = 0
    const entries: TranscriptEntry[] = []
    for (const l of lines) {
      const e = mapCodexRecord(JSON.parse(l), 's', () => skipped++)
      if (e) entries.push(e)
    }
    expect(entries.length).toBe(0)
    expect(skipped).toBe(2)
  })
})

describe('Codex transcript adapter — resolution + scrape fallback (T-20-01, T-20-03)', () => {
  it('resolves a rollout-*.jsonl by matching session_meta id', () => {
    const root = join(import.meta.dir, 'fixtures', 'codex-tree')
    const path = resolveCodexRolloutByMetaId('codex-rollout-abc', root)
    expect(path).not.toBeNull()
    expect(path).toContain('rollout-2026-abc.jsonl')
  })

  it('a non-matching id ⇒ null (deterministic, never newest-file)', () => {
    const root = join(import.meta.dir, 'fixtures', 'codex-tree')
    expect(resolveCodexRolloutByMetaId('some-other-id', root)).toBeNull()
  })

  it('the wrong filename pattern is ignored (name+id strict)', () => {
    // codex-rollout.jsonl is NOT named rollout-* so the resolver never matches it.
    const root = join(import.meta.dir, 'fixtures')
    // matching id exists in that file, but the filename is excluded by pattern.
    const path = resolveCodexRolloutByMetaId('codex-rollout-abc', root)
    expect(path).toContain('codex-tree') // only the rollout-*.jsonl under the subtree matches
  })

  it('persisted id ABSENT ⇒ scrape-mode (no file guess)', async () => {
    const adapter = new CodexTranscriptAdapter()
    const res = await adapter.open(
      { sessionId: 's', projectDir: '/x', cliKind: 'codex' },
      () => {},
    )
    expect(res.mode).toBe('scrape')
    expect(res.path).toBeNull()
    adapter.close()
  })

  it('persisted id present but no matching file ⇒ scrape-mode, NEVER a permission', async () => {
    const adapter = new CodexTranscriptAdapter()
    const got: TranscriptEntry[] = []
    const res = await adapter.open(
      { sessionId: 's', projectDir: '/x', cliKind: 'codex', codexRolloutId: 'does-not-exist' },
      (e) => got.push(e),
    )
    expect(res.mode).toBe('scrape')
    expect(got.some((e) => e.kind === 'permission_request')).toBe(false)
    adapter.close()
  })

  it('persisted transcriptPath present + matching file ⇒ file-mode', async () => {
    const adapter = new CodexTranscriptAdapter()
    const got: TranscriptEntry[] = []
    const res = await adapter.open(
      { sessionId: 's', projectDir: '/x', cliKind: 'codex', transcriptPath: FIXTURE },
      (e) => got.push(e),
    )
    expect(res.mode).toBe('file')
    expect(res.path).toBe(FIXTURE)
    await new Promise((r) => setTimeout(r, 400))
    adapter.close()
    expect(got.some((e) => e.kind === 'assistant_text')).toBe(true)
    expect(got.some((e) => e.kind === 'permission_request')).toBe(false)
  })
})
