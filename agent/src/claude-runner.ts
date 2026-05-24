import { spawn, type Subprocess } from 'bun'
import type { CliEvent } from './types'
import * as ui from './local-ui'

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; content: string }
  | { type: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown }
  | { type: 'user_question'; request_id: string; question: string;
      options?: Array<{ label: string; description?: string }>; is_multi_select?: boolean }
  | { type: 'result'; cost: number; duration_ms: number }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }
  | { type: 'ready' }

type EventCallback = (event: RunnerEvent) => void

/** Extract option labels from an elicitation schema (if it contains enum/oneOf) */
function parseOptionsFromSchema(schema: unknown): Array<{ label: string; description?: string }> {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Record<string, unknown>

  // Check for properties with enum values (AskUserQuestion-style)
  if (s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, any>
    for (const key of Object.keys(props)) {
      const prop = props[key]
      if (prop?.enum && Array.isArray(prop.enum)) {
        return prop.enum.map((v: string) => ({ label: String(v) }))
      }
      if (prop?.oneOf && Array.isArray(prop.oneOf)) {
        return prop.oneOf.map((item: any) => ({
          label: item.const || item.title || String(item),
          description: item.description,
        }))
      }
    }
  }

  // Direct enum at top level
  if (s.enum && Array.isArray(s.enum)) {
    return (s.enum as string[]).map((v) => ({ label: String(v) }))
  }

  return []
}

/**
 * Persistent Claude runner — keeps a single interactive process alive.
 * Messages are sent via stdin in stream-json format, responses streamed from stdout.
 */
export class ClaudeRunner {
  private proc: Subprocess | null = null
  private projectDir: string
  private listener: EventCallback | null = null
  private buffer = ''
  private fullText = ''
  private ready = false
  private localOutput: boolean

  private resumeId: string | undefined
  private systemPrompt: string | undefined

  constructor(projectDir: string, localOutput = false, resumeId?: string, systemPrompt?: string) {
    this.projectDir = projectDir
    this.localOutput = localOutput
    this.resumeId = resumeId
    this.systemPrompt = systemPrompt && systemPrompt.trim() ? systemPrompt : undefined
  }

  /** Update the injected system prompt (applied on next process start) */
  setSystemPrompt(prompt: string | null | undefined) {
    this.systemPrompt = prompt && prompt.trim() ? prompt : undefined
  }

  /** Start the persistent Claude process */
  start(onEvent: EventCallback) {
    this.listener = onEvent

    const cmd = [
      'claude',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ]
    cmd.push('--dangerously-skip-permissions')
    if (this.resumeId) {
      cmd.push('--resume', this.resumeId)
    }
    if (this.systemPrompt) {
      cmd.push('--append-system-prompt', this.systemPrompt)
    }

    // Strip ANTHROPIC_API_KEY from env so Claude CLI uses OAuth subscription
    // instead of potentially invalid project-specific API keys from .env files
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY

    this.proc = spawn({
      cmd,
      cwd: this.projectDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      windowsHide: true,
    })

    console.log(`[runner] spawned claude pid=${this.proc.pid}`)
    this.listener?.({ type: 'log', message: `Starting Claude... (pid ${this.proc.pid})` })

    // Read stdout in background
    this.readStream()

    // Read stderr for diagnostics
    this.readStderr()

    // Mark ready after a short delay — interactive mode may not emit init
    // until first user message, so we can't wait for it
    setTimeout(() => {
      if (!this.ready && this.proc) {
        this.ready = true
        console.log('[runner] ready (timeout-based)')
        this.listener?.({ type: 'ready' })
      }
    }, 3_000)

    // Monitor for unexpected exit — auto-restart after delay
    this.proc.exited.then((code) => {
      console.log(`[runner] claude exited with code ${code}`)
      this.proc = null
      this.ready = false

      // Auto-restart unless intentionally stopped
      if (this.listener) {
        const delay = 3_000
        console.log(`[runner] restarting claude in ${delay / 1000}s...`)
        this.listener?.({ type: 'log', message: `Claude exited (code ${code}), restarting in ${delay / 1000}s...` })
        setTimeout(() => {
          if (this.listener) {
            console.log('[runner] restarting claude process...')
            this.start(this.listener)
          }
        }, delay)
      }
    })
  }

  /** Send a user message to the running Claude process */
  sendMessage(content: string, images?: Array<{ media_type: string; data: string }>) {
    if (!this.proc || !this.ready) {
      console.error('[runner] process not ready, cannot send message')
      this.listener?.({ type: 'error', message: 'Claude process not ready' })
      return
    }

    this.fullText = ''
    this.listener?.({ type: 'status', state: 'thinking' })

    // Build content as array when images are present
    let messageContent: string | Array<unknown>
    if (images && images.length > 0) {
      const blocks: Array<unknown> = images.map((img) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.media_type,
          data: img.data,
        },
      }))
      if (content) {
        blocks.push({ type: 'text', text: content })
      }
      messageContent = blocks
    } else {
      messageContent = content
    }

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: messageContent },
    })

    this.proc.stdin.write(msg + '\n')
    this.proc.stdin.flush()
  }

  /** Respond to a permission request from Claude */
  respondToPermission(requestId: string, approved: boolean) {
    if (!this.proc) {
      console.error('[runner] process not running, cannot respond to permission')
      return
    }

    const response = JSON.stringify({
      type: 'control_response',
      request_id: requestId,
      behavior: approved ? 'allow' : 'deny',
    })

    console.log(`[runner] permission ${approved ? 'approved' : 'denied'} for ${requestId}`)
    this.proc.stdin.write(response + '\n')
    this.proc.stdin.flush()
  }

  /** Respond to a user question from Claude */
  respondToQuestion(requestId: string, answer: string) {
    if (!this.proc) {
      console.error('[runner] process not running, cannot respond to question')
      return
    }

    const response = JSON.stringify({
      type: 'control_response',
      request_id: requestId,
      response: { answer },
    })

    console.log(`[runner] question answered for ${requestId}`)
    this.proc.stdin.write(response + '\n')
    this.proc.stdin.flush()
  }

  /** Cancel the current request */
  cancel() {
    if (this.proc) {
      this.proc.kill('SIGINT')
    }
  }

  /** Stop the process entirely (no auto-restart) */
  stop() {
    this.listener = null // prevent auto-restart
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    this.ready = false
  }

  /** Stop gracefully: SIGINT, wait up to 3s, then SIGKILL. */
  async stopGracefully(): Promise<void> {
    this.listener = null
    const proc = this.proc
    if (!proc) { this.ready = false; return }
    try { proc.kill('SIGINT') } catch {}
    const exited: Promise<unknown> = (proc as any).exited ?? Promise.resolve()
    await Promise.race([exited, new Promise(r => setTimeout(r, 3_000))])
    try { proc.kill('SIGKILL') } catch {}
    this.proc = null
    this.ready = false
  }

  get isReady() { return this.ready }

  private async readStderr() {
    if (!this.proc?.stderr) return
    const reader = this.proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true }).trim()
        if (text) console.error(`[runner:stderr] ${text}`)
      }
    } catch { /* process exited */ }
  }

  private async readStream() {
    if (!this.proc) return
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        this.buffer += decoder.decode(value, { stream: true })
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event: CliEvent = JSON.parse(line)
            this.handleEvent(event)
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err: any) {
      console.error('[runner] stream read error:', err.message)
    }
  }

  private handleEvent(event: CliEvent) {
    // Mark ready after init event
    if (event.type === 'system' && (event as any).subtype === 'init') {
      this.ready = true
      console.log(`[runner] ready, session=${(event as any).session_id}`)
      this.listener?.({ type: 'log', message: `Claude ready (session ${((event as any).session_id as string).slice(0, 8)})` })
      this.listener?.({ type: 'ready' })
      return
    }

    // Permission requests from Claude CLI
    if (event.type === 'control_request' && (event as any).subtype === 'can_use_tool') {
      const req = event as any
      console.log(`[runner] permission requested: ${req.tool_name} (${req.request_id})`)
      if (this.localOutput) ui.printPermissionRequest(req.tool_name, req.tool_input)
      this.listener?.({
        type: 'permission_request',
        request_id: req.request_id,
        tool_name: req.tool_name,
        tool_input: req.tool_input,
      })
      return
    }

    // User questions / elicitations from Claude CLI
    // The request may be nested in a `request` field (SDK format) or flat (CLI format)
    if (event.type === 'control_request') {
      const raw = event as any
      const inner = raw.request || raw // handle both nested and flat formats
      const subtype = inner.subtype
      const requestId = raw.request_id

      if (subtype === 'elicitation' || subtype === 'side_question') {
        // Parse question text and options from various possible field names
        const question = inner.message || inner.question || inner.text || 'Claude is asking a question'
        const rawSchema = inner.requested_schema
        const options = parseOptionsFromSchema(rawSchema)
        console.log(`[runner] user question (${subtype}): ${question.slice(0, 80)} (${requestId})`)
        if (this.localOutput) ui.printQuestion(question, options)
        this.listener?.({
          type: 'user_question',
          request_id: requestId,
          question,
          ...(options.length > 0 ? { options } : {}),
        })
        return
      }

      // Log unknown control_request subtypes for debugging
      console.log(`[runner] unhandled control_request subtype=${subtype} request_id=${requestId}`)
      return
    }

    // Parse assistant content blocks
    if (event.type === 'assistant' && 'message' in event) {
      const msg = (event as any).message
      if (!msg?.content) return
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          this.listener?.({ type: 'status', state: 'writing' })
          this.listener?.({ type: 'text_delta', content: block.text })
          this.fullText += block.text
          if (this.localOutput) ui.printTextDelta(block.text)
        }
        if (block.type === 'thinking' && block.thinking) {
          this.listener?.({ type: 'status', state: 'thinking' })
          this.listener?.({ type: 'thinking', content: block.thinking })
          if (this.localOutput) ui.printThinking(block.thinking)
        }
        if (block.type === 'tool_use') {
          this.listener?.({ type: 'status', state: 'tool_calling' })
          this.listener?.({ type: 'tool_use', tool: block.name, tool_id: block.id, input: block.input })
          if (this.localOutput) ui.printToolUse(block.name, block.input)
        }
      }
    }

    // Tool results
    if (event.type === 'tool_result') {
      const tr = event as any
      this.listener?.({ type: 'tool_result', tool_id: tr.tool_use_id, content: tr.content || '', is_error: tr.is_error })
      if (this.localOutput) ui.printToolResult(tr.content || '', tr.is_error)
    }

    // Final result — emit assembled message and go idle
    if (event.type === 'result') {
      const r = event as any
      if (this.fullText) {
        this.listener?.({ type: 'assistant_message', content: this.fullText })
        this.fullText = ''
      }
      this.listener?.({ type: 'result', cost: r.total_cost_usd || 0, duration_ms: r.duration_ms || 0 })
      this.listener?.({ type: 'status', state: 'idle' })
      if (this.localOutput) ui.printResponseEnd(r.total_cost_usd || 0, r.duration_ms || 0)
    }
  }
}
