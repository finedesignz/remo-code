/**
 * fix/permission-grant-returnpath — empirical proof of the SUPERVISOR hop.
 *
 * Drives hub→supervisor frames (`permission_response`, `question_response`)
 * through the bridge's real `ws.onmessage` path (via the `wsFactory` test hook)
 * and asserts the runner's `respondToPermission` / `respondToQuestion` fire with
 * the right args. Confirms there is NO schema gate dropping these frames on the
 * supervisor side (HubToAgent is a TS type only; JSON.parse + dispatch).
 *
 * Also asserts the runner emits the CLI `control_response` wire shape when wired
 * to a fake subprocess — closing the last hop to the Claude CLI.
 */
import { describe, test, expect } from 'bun:test'
import { SessionBridge, type SessionBridgeOptions, type SessionBridgeCallbacks } from '../src/runners/session-bridge'
import type { CliRunner } from '../src/runners/types'
import { ClaudeRunner } from '../src/runners/claude-runner'

// Minimal fake WebSocket the bridge will drive. We capture the handlers it sets
// and expose `emit()` to deliver a hub frame through the real onmessage path.
class FakeWs {
  onopen: ((ev?: any) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  sent: any[] = []
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() {}
  emit(obj: any) { this.onmessage?.({ data: JSON.stringify(obj) }) }
}

function makeRunner() {
  const calls: { perm: Array<[string, boolean]>; question: Array<[string, string]> } = { perm: [], question: [] }
  const runner: CliRunner = {
    isReady: true,
    start: () => {},
    sendMessage: () => {},
    respondToPermission: (id: string, approved: boolean) => { calls.perm.push([id, approved]) },
    respondToQuestion: (id: string, answer: string) => { calls.question.push([id, answer]) },
    cancel: () => {},
    stop: () => {},
    stopGracefully: async () => {},
  } as unknown as CliRunner
  return { runner, calls }
}

function makeBridge(fakeWs: FakeWs, runner: CliRunner) {
  const opts: SessionBridgeOptions = {
    runId: 'run-1',
    repoPath: '/repo',
    apiKey: 'k',
    hubUrl: 'http://localhost:3040',
    allowDangerousSkipPermissions: false,
    wsFactory: () => fakeWs as unknown as WebSocket,
    runnerFactory: () => runner,
  }
  const cb: SessionBridgeCallbacks = {
    onLog: () => {},
    onExit: () => {},
    onSpawned: () => {},
  }
  return new SessionBridge(opts, cb)
}

describe('supervisor bridge: hub permission/question frames reach the runner', () => {
  test('permission_response → runner.respondToPermission(request_id, approved)', () => {
    const fakeWs = new FakeWs()
    const { runner, calls } = makeRunner()
    const bridge = makeBridge(fakeWs, runner)
    bridge.start()
    fakeWs.onopen?.()
    // Hub completes auth (sets sessionId + ensures runner).
    fakeWs.emit({ type: 'auth_ok', session_id: 'sess-1', cli_kind: 'claude' })
    // The decisive frame — same shape client.ts / telegram-webhook.ts send.
    fakeWs.emit({ type: 'permission_response', session_id: 'sess-1', request_id: 'req-abc', approved: true })
    expect(calls.perm).toEqual([['req-abc', true]])

    fakeWs.emit({ type: 'permission_response', session_id: 'sess-1', request_id: 'req-def', approved: false })
    expect(calls.perm).toContainEqual(['req-def', false])
  })

  test('question_response → runner.respondToQuestion(request_id, answer)', () => {
    const fakeWs = new FakeWs()
    const { runner, calls } = makeRunner()
    const bridge = makeBridge(fakeWs, runner)
    bridge.start()
    fakeWs.onopen?.()
    fakeWs.emit({ type: 'auth_ok', session_id: 'sess-1', cli_kind: 'claude' })
    fakeWs.emit({ type: 'question_response', session_id: 'sess-1', request_id: 'req-q', answer: 'option-2' })
    expect(calls.question).toEqual([['req-q', 'option-2']])
  })
})

describe('claude-runner: respondToPermission writes CLI control_response', () => {
  test('approve → control_response behavior=allow on stdin', () => {
    const written: string[] = []
    const fakeProc: any = {
      pid: 1,
      stdin: { write: (s: string) => written.push(s), flush: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: new Promise<number>(() => {}),
      kill: () => {},
    }
    const runner = new ClaudeRunner('/repo', false)
    ;(runner as any).spawnImpl = () => fakeProc
    runner.start(() => {})
    runner.respondToPermission('req-abc', true)
    const frame = written.map((w) => JSON.parse(w.trim())).find((m) => m.type === 'control_response')
    expect(frame).toBeDefined()
    expect(frame.request_id).toBe('req-abc')
    expect(frame.behavior).toBe('allow')
  })
})
