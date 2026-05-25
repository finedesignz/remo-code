import { describe, expect, test } from 'bun:test'
import { translate } from '../src/codex-runner'
import type { RunnerEvent } from '../src/cli-runner'

function collect(): { events: RunnerEvent[]; emit: (e: RunnerEvent) => void } {
  const events: RunnerEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('codex translate()', () => {
  test('reasoning deltas route to thinking events', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('item/started', { id: 'r1', type: 'reasoning' }, itemKinds, emit)
    translate('item/agentMessage/delta', { id: 'r1', delta: 'first' }, itemKinds, emit)
    translate('item/agentMessage/delta', { id: 'r1', delta: 'second' }, itemKinds, emit)
    expect(events[0]).toEqual({ type: 'status', state: 'thinking' })
    expect(events[1]).toEqual({ type: 'thinking', content: 'first' })
    expect(events[2]).toEqual({ type: 'thinking', content: 'second' })
  })

  test('agent_message deltas route to text_delta events', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('item/started', { id: 'm1', type: 'agent_message' }, itemKinds, emit)
    translate('item/agentMessage/delta', { id: 'm1', delta: 'hello ' }, itemKinds, emit)
    translate('item/agentMessage/delta', { id: 'm1', delta: 'world' }, itemKinds, emit)
    expect(events[0]).toEqual({ type: 'status', state: 'writing' })
    expect(events[1]).toEqual({ type: 'text_delta', content: 'hello ' })
    expect(events[2]).toEqual({ type: 'text_delta', content: 'world' })
  })

  test('command_execution pair → tool_use + tool_result with exit_code mapping', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('item/started',
      { id: 'c1', type: 'command_execution', command: 'ls -la' }, itemKinds, emit)
    translate('item/completed',
      { id: 'c1', type: 'command_execution', exit_code: 1, stdout: 'x', stderr: 'oops' },
      itemKinds, emit)
    expect(events).toContainEqual({
      type: 'tool_use', tool: 'bash', tool_id: 'c1', input: { command: 'ls -la' },
    })
    expect(events).toContainEqual({
      type: 'tool_result', tool_id: 'c1', content: 'x\noops', is_error: true,
    })
  })

  test('successful command yields is_error false', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('item/started',
      { id: 'c2', type: 'command_execution', command: 'echo hi' }, itemKinds, emit)
    translate('item/completed',
      { id: 'c2', type: 'command_execution', exit_code: 0, stdout: 'hi' },
      itemKinds, emit)
    expect(events).toContainEqual({
      type: 'tool_result', tool_id: 'c2', content: 'hi', is_error: false,
    })
  })

  test('mcp_tool_call pair → tool_use + tool_result', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('item/started',
      { id: 'm', type: 'mcp_tool_call', name: 'read_file', arguments: { path: '/x' } },
      itemKinds, emit)
    translate('item/completed',
      { id: 'm', type: 'mcp_tool_call', result: 'file contents' }, itemKinds, emit)
    expect(events).toContainEqual({
      type: 'tool_use', tool: 'read_file', tool_id: 'm', input: { path: '/x' },
    })
    expect(events).toContainEqual({
      type: 'tool_result', tool_id: 'm', content: 'file contents', is_error: false,
    })
  })

  test('turn/completed emits assistant_message + idle status', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('turn/completed', { agent_message: 'done' }, itemKinds, emit)
    expect(events).toEqual([
      { type: 'assistant_message', content: 'done' },
      { type: 'status', state: 'idle' },
    ])
  })

  test('approval/required → permission_request', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('approval/required',
      { request_id: 'r1', command: 'rm -rf /', cwd: '/tmp' }, itemKinds, emit)
    expect(events).toEqual([
      {
        type: 'permission_request',
        request_id: 'r1',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /', cwd: '/tmp' },
      },
    ])
  })

  test('error notification → log RunnerEvent', () => {
    const itemKinds = new Map<string, any>()
    const { events, emit } = collect()
    translate('error', { message: 'boom' }, itemKinds, emit)
    expect(events).toEqual([{ type: 'log', message: 'Codex error: boom' }])
  })

  test('itemKinds cleared on completed', () => {
    const itemKinds = new Map<string, any>()
    const { emit } = collect()
    translate('item/started', { id: 'x', type: 'command_execution', command: 'ls' }, itemKinds, emit)
    expect(itemKinds.has('x')).toBe(true)
    translate('item/completed', { id: 'x', type: 'command_execution', exit_code: 0 }, itemKinds, emit)
    expect(itemKinds.has('x')).toBe(false)
  })
})
