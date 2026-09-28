/**
 * tools/cloud-hook/remo-cloud-stop-hook.mjs — transcript → payload (quick 20260927-cloud-sessions).
 */
import { describe, test, expect } from 'bun:test'
// @ts-ignore — plain .mjs tool, no types
import { extractLastTurn, buildPayload } from '../../tools/cloud-hook/remo-cloud-stop-hook.mjs'

const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 })
const lines = [
  { type: 'user', message: { role: 'user', content: 'first prompt' } },
  { type: 'assistant', message: { id: 'm0', model: 'claude-x', content: [{ type: 'text', text: 'OLD answer' }], usage: usage(1, 1) } },
  { type: 'user', message: { role: 'user', content: 'second prompt' } },
  // same message id split over two entries, usage repeated → count once
  { type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'thinking', thinking: 'hmm' }], usage: usage(2, 5) } },
  { type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: usage(2, 5) } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
  { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'system reminder' }] } },
  { type: 'assistant', isSidechain: true, message: { id: 'sc', content: [{ type: 'text', text: 'SUBAGENT' }], usage: usage(9, 9) } },
  { type: 'assistant', message: { id: 'm2', model: 'claude-x', content: [{ type: 'text', text: 'Part A' }], usage: usage(3, 7) } },
  { type: 'assistant', message: { id: 'm3', model: 'claude-x', content: [{ type: 'text', text: 'Part B' }], usage: usage(4, 8) } },
]
const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n'

describe('extractLastTurn', () => {
  test('only the last turn, main thread, text blocks joined', () => {
    const t = extractLastTurn(jsonl)
    expect(t.text).toBe('Part A\n\nPart B')
    expect(t.model).toBe('claude-x')
  })
  test('usage summed once per message id; sidechain excluded', () => {
    const t = extractLastTurn(jsonl)
    expect(t.usage).toEqual({ input_tokens: 2 + 3 + 4, output_tokens: 5 + 7 + 8, cache_creation_input_tokens: 30, cache_read_input_tokens: 300 })
  })
})

describe('buildPayload', () => {
  const env = { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01ABC' }
  const read = () => jsonl
  test('builds from the transcript', () => {
    const b = buildPayload({ transcript_path: '/t.jsonl' }, env, read)
    expect(b.payload).toMatchObject({ cloud_session_id: 'cse_01ABC', text: 'Part A\n\nPart B', model: 'claude-x' })
    expect(b.lastMessageId).toBe('m3')
  })
  test('prefers last_assistant_message when the hook input carries it', () => {
    expect(buildPayload({ transcript_path: '/t.jsonl', last_assistant_message: 'FINAL' }, env, read).payload.text).toBe('FINAL')
  })
  test('resumed turn (another Stop hook blocked): posts only what is after the watermark', () => {
    const b = buildPayload({ transcript_path: '/t', stop_hook_active: true, last_assistant_message: 'Part B' }, env, read, 'm2')
    expect(b.payload.text).toBe('Part B')
    expect(b.payload.usage.output_tokens).toBe(8)
  })
  test('nothing new since the watermark → null', () => {
    expect(buildPayload({ transcript_path: '/t', stop_hook_active: true }, env, read, 'm3')).toBeNull()
  })
  test('a watermark from an earlier turn is ignored', () => {
    expect(buildPayload({ transcript_path: '/t' }, env, read, 'm0').payload.text).toBe('Part A\n\nPart B')
  })
  test('no-op outside a cloud session or with nothing to send', () => {
    expect(buildPayload({ transcript_path: '/t' }, {}, read)).toBeNull()
    expect(buildPayload({ transcript_path: '/t' }, { CLAUDE_CODE_REMOTE_SESSION_ID: 'bad id' }, read)).toBeNull()
    expect(buildPayload({ transcript_path: '/t' }, env, () => '')).toBeNull()
  })
  test('unreadable transcript never throws', () => {
    expect(buildPayload({ transcript_path: '/nope' }, env, () => { throw new Error('ENOENT') })).toBeNull()
  })
})
