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

export class ClaudeRunner {
  private proc: Subprocess | null = null
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  /**
   * Send a user message to Claude and stream back parsed events.
   * Each call spawns a new `claude -p` process (stateless).
   */
  async *run(message: string): AsyncGenerator<RunnerEvent> {
    this.proc = spawn({
      cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
      cwd: this.projectDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Write user message to stdin and close (Bun FileSink API)
    this.proc.stdin.write(message)
    this.proc.stdin.end()

    yield { type: 'status', state: 'thinking' }

    // Read stdout line by line, parse JSON events (Bun ReadableStream)
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          let event: CliEvent
          try {
            event = JSON.parse(line)
          } catch {
            continue // skip malformed lines
          }

          for (const parsed of this.parseEvent(event)) {
            if (parsed.type === 'text_delta') fullText += parsed.content
            yield parsed
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: CliEvent = JSON.parse(buffer)
          for (const parsed of this.parseEvent(event)) {
            if (parsed.type === 'text_delta') fullText += parsed.content
            yield parsed
          }
        } catch {}
      }

      // Emit final assembled message
      if (fullText) {
        yield { type: 'assistant_message', content: fullText }
      }
    } finally {
      yield { type: 'status', state: 'idle' }
      this.proc = null
    }
  }

  /** Cancel the running process */
  cancel() {
    if (this.proc) {
      this.proc.kill('SIGINT')
    }
  }

  private *parseEvent(event: CliEvent): Generator<RunnerEvent> {
    if (event.type === 'assistant' && 'message' in event) {
      const msg = (event as any).message
      if (!msg?.content) return
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'status', state: 'writing' }
          yield { type: 'text_delta', content: block.text }
        }
        if (block.type === 'thinking' && block.thinking) {
          yield { type: 'status', state: 'thinking' }
          yield { type: 'thinking', content: block.thinking }
        }
        if (block.type === 'tool_use') {
          yield { type: 'status', state: 'tool_calling' }
          yield { type: 'tool_use', tool: block.name, tool_id: block.id, input: block.input }
        }
      }
    }

    if (event.type === 'tool_result') {
      const tr = event as any
      yield { type: 'tool_result', tool_id: tr.tool_use_id, content: tr.content || '', is_error: tr.is_error }
    }

    if (event.type === 'result') {
      const r = event as any
      yield { type: 'result', cost: r.total_cost_usd || 0, duration_ms: r.duration_ms || 0 }
    }
  }
}
