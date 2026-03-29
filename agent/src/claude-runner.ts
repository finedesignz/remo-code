import { spawn, type Subprocess } from 'bun'
import type { CliEvent } from './types'

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; content: string }
  | { type: 'result'; cost: number; duration_ms: number }
  | { type: 'error'; message: string }
  | { type: 'ready' }

type EventCallback = (event: RunnerEvent) => void

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

  constructor(projectDir: string, localOutput = false) {
    this.projectDir = projectDir
    this.localOutput = localOutput
  }

  /** Start the persistent Claude process */
  start(onEvent: EventCallback) {
    this.listener = onEvent

    this.proc = spawn({
      cmd: [
        'claude',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
      ],
      cwd: this.projectDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    console.log(`[runner] spawned claude pid=${this.proc.pid}`)

    // Read stdout in background
    this.readStream()

    // Mark ready after a short delay — interactive mode may not emit init
    // until first user message, so we can't wait for it
    setTimeout(() => {
      if (!this.ready && this.proc) {
        this.ready = true
        console.log('[runner] ready (timeout-based)')
        this.listener?.({ type: 'ready' })
      }
    }, 3_000)

    // Monitor for unexpected exit
    this.proc.exited.then((code) => {
      console.log(`[runner] claude exited with code ${code}`)
      this.proc = null
      this.ready = false
    })
  }

  /** Send a user message to the running Claude process */
  sendMessage(content: string) {
    if (!this.proc || !this.ready) {
      console.error('[runner] process not ready, cannot send message')
      this.listener?.({ type: 'error', message: 'Claude process not ready' })
      return
    }

    this.fullText = ''
    this.listener?.({ type: 'status', state: 'thinking' })

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    })

    this.proc.stdin.write(msg + '\n')
    this.proc.stdin.flush()
  }

  /** Cancel the current request */
  cancel() {
    if (this.proc) {
      this.proc.kill('SIGINT')
    }
  }

  /** Stop the process entirely */
  stop() {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    this.ready = false
  }

  get isReady() { return this.ready }

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
      this.listener?.({ type: 'ready' })
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
          if (this.localOutput) process.stdout.write(block.text)
        }
        if (block.type === 'thinking' && block.thinking) {
          this.listener?.({ type: 'status', state: 'thinking' })
          this.listener?.({ type: 'thinking', content: block.thinking })
          if (this.localOutput) process.stdout.write(`\x1b[2m${block.thinking}\x1b[0m`)
        }
        if (block.type === 'tool_use') {
          this.listener?.({ type: 'status', state: 'tool_calling' })
          this.listener?.({ type: 'tool_use', tool: block.name, tool_id: block.id, input: block.input })
          if (this.localOutput) process.stdout.write(`\x1b[36m> ${block.name}\x1b[0m\n`)
        }
      }
    }

    // Tool results
    if (event.type === 'tool_result') {
      const tr = event as any
      this.listener?.({ type: 'tool_result', tool_id: tr.tool_use_id, content: tr.content || '', is_error: tr.is_error })
      if (this.localOutput) {
        const preview = (tr.content || '').slice(0, 200)
        if (tr.is_error) {
          process.stdout.write(`\x1b[31m  Error: ${preview}\x1b[0m\n`)
        } else {
          process.stdout.write(`\x1b[2m  ${preview}${(tr.content || '').length > 200 ? '...' : ''}\x1b[0m\n`)
        }
      }
    }

    // Final result — emit assembled message and go idle
    if (event.type === 'result') {
      const r = event as any
      if (this.localOutput && this.fullText) {
        process.stdout.write('\n')
      }
      if (this.fullText) {
        this.listener?.({ type: 'assistant_message', content: this.fullText })
        this.fullText = ''
      }
      this.listener?.({ type: 'result', cost: r.total_cost_usd || 0, duration_ms: r.duration_ms || 0 })
      this.listener?.({ type: 'status', state: 'idle' })
      if (this.localOutput) {
        process.stdout.write(`\x1b[2m  ($${r.total_cost_usd?.toFixed(4) || '?'}, ${((r.duration_ms || 0) / 1000).toFixed(1)}s)\x1b[0m\n\n`)
      }
    }
  }
}
