// CodexRunner — implements CliRunner over `codex app-server` stdio JSON-RPC.
//
// SPIKE STATUS (2026-05-25): The Codex app-server protocol detail below
// (method names, payload shapes) is derived from Plan 04 research §1.3
// and is NOT yet verified against a live Codex binary on this host. The
// translate() function is pure and unit-testable; correctness against the
// real server is verified on first live integration. Adjust this file in
// place when actual protocol differs — it is the source of truth.

import { spawn, type Subprocess } from 'bun'
import type { CliRunner, RunnerEvent } from './cli-runner'
import { JsonRpcClient } from './codex-jsonrpc'
import * as ui from './local-ui'

type ItemKind = 'reasoning' | 'command_execution' | 'mcp_tool_call' | 'agent_message' | 'unknown'

type EventCallback = (event: RunnerEvent) => void

/**
 * Pure translation of a Codex JSON-RPC notification into RunnerEvent emissions.
 * Exported for unit tests. Mutates `itemKinds` to track currentItemId → kind.
 */
export function translate(
  method: string,
  params: any,
  itemKinds: Map<string, ItemKind>,
  emit: EventCallback,
) {
  switch (method) {
    case 'item/started': {
      const id: string = params?.id
      const type: string = params?.type
      if (!id) return
      const kind: ItemKind =
        type === 'reasoning' ? 'reasoning' :
        type === 'command_execution' ? 'command_execution' :
        type === 'mcp_tool_call' ? 'mcp_tool_call' :
        type === 'agent_message' ? 'agent_message' :
        'unknown'
      itemKinds.set(id, kind)

      if (kind === 'reasoning') {
        emit({ type: 'status', state: 'thinking' })
      } else if (kind === 'command_execution') {
        emit({ type: 'status', state: 'tool_calling' })
        emit({
          type: 'tool_use',
          tool: 'bash',
          tool_id: id,
          input: { command: params?.command ?? '' },
        })
      } else if (kind === 'mcp_tool_call') {
        emit({ type: 'status', state: 'tool_calling' })
        emit({
          type: 'tool_use',
          tool: params?.name ?? 'mcp',
          tool_id: id,
          input: params?.arguments ?? {},
        })
      } else if (kind === 'agent_message') {
        emit({ type: 'status', state: 'writing' })
      }
      return
    }

    case 'item/agentMessage/delta': {
      const id: string = params?.id
      const delta: string = params?.delta ?? ''
      if (!delta) return
      const kind = id ? itemKinds.get(id) ?? 'agent_message' : 'agent_message'
      if (kind === 'reasoning') {
        emit({ type: 'thinking', content: delta })
      } else {
        emit({ type: 'text_delta', content: delta })
      }
      return
    }

    case 'item/completed': {
      const id: string = params?.id
      const kind = id ? itemKinds.get(id) ?? 'unknown' : 'unknown'
      if (kind === 'command_execution') {
        const stdout: string = params?.stdout ?? ''
        const stderr: string = params?.stderr ?? ''
        const exitCode: number = params?.exit_code ?? 0
        emit({
          type: 'tool_result',
          tool_id: id,
          content: stdout + (stderr ? '\n' + stderr : ''),
          is_error: exitCode !== 0,
        })
      } else if (kind === 'mcp_tool_call') {
        emit({
          type: 'tool_result',
          tool_id: id,
          content: typeof params?.result === 'string' ? params.result : JSON.stringify(params?.result ?? null),
          is_error: !!params?.is_error,
        })
      }
      if (id) itemKinds.delete(id)
      return
    }

    case 'turn/completed': {
      const agentMessage: string = params?.agent_message ?? ''
      if (agentMessage) emit({ type: 'assistant_message', content: agentMessage })
      emit({ type: 'status', state: 'idle' })
      return
    }

    case 'approval/required': {
      const requestId: string = params?.request_id ?? params?.id
      emit({
        type: 'permission_request',
        request_id: requestId,
        tool_name: 'bash',
        tool_input: { command: params?.command, cwd: params?.cwd },
      })
      return
    }

    case 'error': {
      emit({ type: 'log', message: `Codex error: ${params?.message ?? 'unknown'}` })
      return
    }
  }
}

export class CodexRunner implements CliRunner {
  readonly cliKind = 'codex' as const
  private proc: Subprocess | null = null
  private client: JsonRpcClient | null = null
  private listener: EventCallback | null = null
  private threadId: string | null = null
  private ready = false
  private workingDir: string
  private localOutput: boolean
  private resumeThreadId: string | undefined
  private systemPrompt: string | undefined
  private itemKinds = new Map<string, ItemKind>()
  private turnInFlight = false

  constructor(workingDir: string, localOutput = false, resume?: { threadId: string }, systemPrompt?: string) {
    this.workingDir = workingDir
    this.localOutput = localOutput
    this.resumeThreadId = resume?.threadId
    this.systemPrompt = systemPrompt && systemPrompt.trim() ? systemPrompt : undefined
  }

  setSystemPrompt(prompt: string | null | undefined) {
    const next = prompt && prompt.trim() ? prompt : undefined
    if (this.ready) {
      this.listener?.({ type: 'log', message: 'Codex: system prompt change requires runner restart; ignored' })
      return
    }
    this.systemPrompt = next
  }

  start(onEvent: EventCallback) {
    this.listener = onEvent

    this.proc = spawn({
      cmd: ['codex', 'app-server', '--cd', this.workingDir],
      cwd: this.workingDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })

    console.log(`[codex-runner] spawned codex pid=${this.proc.pid}`)
    this.listener?.({ type: 'log', message: `Starting Codex... (pid ${this.proc.pid})` })

    this.client = new JsonRpcClient(this.proc)
    this.client.onError((err) => {
      console.error('[codex-runner] client error:', err.message)
      this.listener?.({ type: 'error', message: err.message })
    })
    this.client.onNotification((method, params) => {
      if (!this.listener) return
      translate(method, params, this.itemKinds, this.listener)
      if (method === 'turn/completed') this.turnInFlight = false
    })

    void this.readStderr()
    void this.initialize()

    this.proc.exited.then((code) => {
      console.log(`[codex-runner] codex exited with code ${code}`)
      this.proc = null
      this.client = null
      this.ready = false
      this.turnInFlight = false
    })
  }

  private async initialize() {
    if (!this.client) return
    try {
      await this.client.request('initialize', {
        client: { name: 'remo-code-agent', version: '0.4.x' },
        ...(this.systemPrompt ? { system_prompt: this.systemPrompt } : {}),
      })
      this.client.notify('initialized', {})

      if (this.resumeThreadId) {
        const r = await this.client.request<{ thread_id: string }>('thread/resume', {
          thread_id: this.resumeThreadId,
        })
        this.threadId = r?.thread_id ?? this.resumeThreadId
      } else {
        const r = await this.client.request<{ thread_id: string }>('thread/start', {})
        this.threadId = r?.thread_id ?? null
      }
      this.ready = true
      this.listener?.({ type: 'ready' })
      this.listener?.({ type: 'log', message: `Codex ready (thread ${this.threadId?.slice(0, 8) ?? 'unknown'})` })
    } catch (err: any) {
      this.listener?.({ type: 'error', message: `Codex initialize failed: ${err?.message ?? String(err)}` })
    }
  }

  sendMessage(prompt: string, _images?: Array<{ media_type: string; data: string }>): void {
    if (!this.client || !this.ready || !this.threadId) {
      this.listener?.({ type: 'error', message: 'Codex runner not ready' })
      return
    }
    if (_images?.length) {
      this.listener?.({ type: 'log', message: 'Codex: image attachments not supported; sending text only' })
    }
    this.turnInFlight = true
    this.listener?.({ type: 'status', state: 'thinking' })
    this.client.notify('turn/start', { thread_id: this.threadId, input: prompt })
    if (this.localOutput) ui.printUserMessage(prompt)
  }

  respondToPermission(requestId: string, approved: boolean): void {
    this.client?.notify('approval/response', {
      request_id: requestId,
      decision: approved ? 'approve' : 'deny',
    })
  }

  respondToQuestion(_requestId: string, _answer: string): void {
    this.listener?.({ type: 'log', message: 'Codex does not support user_question; ignored' })
  }

  cancel(): void {
    if (!this.client || !this.threadId) return
    this.client.notify('turn/cancel', { thread_id: this.threadId })
    this.turnInFlight = false
  }

  stop(): void {
    this.listener = null
    try { this.client?.close() } catch {}
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
    this.ready = false
  }

  async stopGracefully(): Promise<void> {
    this.listener = null
    const proc = this.proc
    if (!proc) { this.ready = false; return }
    try { this.client?.notify('shutdown', {}) } catch {}
    try { proc.kill('SIGTERM') } catch {}
    const exited: Promise<unknown> = (proc as any).exited ?? Promise.resolve()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    try { proc.kill('SIGKILL') } catch {}
    try { this.client?.close() } catch {}
    this.proc = null
    this.client = null
    this.ready = false
  }

  get isReady() { return this.ready && !this.turnInFlight }

  private async readStderr() {
    if (!this.proc?.stderr) return
    const reader = this.proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true }).trim()
        if (text) console.error(`[codex-runner:stderr] ${text}`)
      }
    } catch { /* exited */ }
  }
}
