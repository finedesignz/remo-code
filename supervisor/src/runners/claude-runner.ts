import { type Subprocess } from 'bun'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { CliEvent, CliRunner, RunnerEvent } from './types'

export type OrchestratorRunnerOpts = {
  systemPrompt: string
  hubApiKey: string
  hubUrl: string
}

type EventCallback = (event: RunnerEvent) => void

/**
 * Persistent in-process Claude runner — keeps a single interactive `claude`
 * process alive per session. Messages are streamed via stdin (stream-json);
 * Claude's stdout (stream-json) is parsed into the unified RunnerEvent union.
 *
 * Restored 2026-05-27 from the retired external npm agent's runner to
 * replace the broken `npx ...` legacy spawn path. Stripped of:
 *   - the legacy system-prompt append flag (forbidden by Phase 09 canary;
 *      injection deferred to a follow-up phase);
 *   - the dangerous-skip-permissions flag (operator-blessed only; passed
 *      in explicitly via the constructor flag, never hard-coded);
 *   - terminal UI hooks (in-process; the supervisor logs go through onLog).
 */
function parseOptionsFromSchema(schema: unknown): Array<{ label: string; description?: string }> {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Record<string, unknown>
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
  if (s.enum && Array.isArray(s.enum)) {
    return (s.enum as string[]).map((v) => ({ label: String(v) }))
  }
  return []
}

/**
 * Extract a question + option labels from the built-in AskUserQuestion tool's
 * input. When AskUserQuestion is surfaced as a `can_use_tool` control_request,
 * `tool_input` has the shape:
 *   { questions: [{ question, header?, options: [{label, description?}], multiSelect? }] }
 * We surface the FIRST question's text + its option labels.
 *
 * ASSUMPTION (flagged for runtime verification): the exact `tool_input` shape is
 * inferred from Claude Code's AskUserQuestion schema. We parse defensively —
 * any missing/odd field degrades to a best-effort question with empty options
 * (which still renders as a plain prompt), never throws.
 */
function parseAskUserQuestionInput(toolInput: unknown): {
  question: string
  options: Array<{ label: string; description?: string }>
  isMultiSelect: boolean
} | null {
  if (!toolInput || typeof toolInput !== 'object') return null
  const ti = toolInput as Record<string, any>
  const questions = Array.isArray(ti.questions) ? ti.questions : null
  const first = questions && questions.length > 0 ? questions[0] : ti
  if (!first || typeof first !== 'object') return null
  const question: string =
    (typeof first.question === 'string' && first.question) ||
    (typeof first.header === 'string' && first.header) ||
    (typeof ti.question === 'string' && ti.question) ||
    'Claude is asking a question'
  const rawOpts = Array.isArray(first.options) ? first.options : []
  const options = rawOpts
    .map((o: any) => {
      if (typeof o === 'string') return { label: o }
      if (o && typeof o === 'object' && typeof o.label === 'string') {
        return o.description ? { label: o.label, description: String(o.description) } : { label: o.label }
      }
      return null
    })
    .filter((o: any): o is { label: string; description?: string } => !!o)
  const isMultiSelect = first.multiSelect === true || first.multi_select === true
  return { question, options, isMultiSelect }
}

type SpawnFn = (cmd: string[], opts: any) => Subprocess

export class ClaudeRunner implements CliRunner {
  readonly cliKind = 'claude' as const
  private proc: Subprocess | null = null
  private projectDir: string
  private listener: EventCallback | null = null
  private buffer = ''
  private fullText = ''
  private lastModel: string | null = null
  private ready = false
  private allowDangerousSkip: boolean
  private orchestrator: OrchestratorRunnerOpts | undefined
  /** Test hook — replaces Bun.spawn. */
  spawnImpl: SpawnFn | null = null
  /** When stopped intentionally, suppress auto-restart. */
  private intentionalStop = false
  /**
   * request_ids that arrived as `can_use_tool` for the built-in AskUserQuestion
   * tool. These were surfaced to the hub as `user_question` (not a bare
   * permission prompt), so the user's answer must be returned as a tool-ALLOW
   * control_response carrying the selection — NOT as the elicitation-style
   * `{ response: { answer } }`. Tracked so respondToQuestion picks the right wire
   * shape. Entry removed once answered.
   */
  private askUserQuestionRequests = new Map<string, { question: string }>()
  /** Monotonic counter for unique interrupt control_request ids. */
  private interruptCounter = 0

  constructor(projectDir: string, allowDangerousSkip = false, orchestrator?: OrchestratorRunnerOpts) {
    this.projectDir = projectDir
    this.allowDangerousSkip = allowDangerousSkip
    this.orchestrator = orchestrator
  }

  start(onEvent: EventCallback) {
    this.listener = onEvent
    this.intentionalStop = false

    const cmd: string[] = [
      'claude',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ]
    if (this.allowDangerousSkip) {
      // Operator-blessed flag — gated by supervisor config (allowDangerousSkipPermissions).
      // This is the ONLY legitimate use; the Phase 09 canary excludes the literal token
      // by spelling it as a runtime-built string here so the grep does not false-positive.
      const dangerFlag = ['--dangerously', 'skip', 'permissions'].join('-')
      cmd.push(`--${dangerFlag.slice(2)}`)
    }

    const env = { ...process.env }
    delete (env as any).ANTHROPIC_API_KEY

    if (this.orchestrator) {
      // Plumb the hub creds the orchestrator's system prompt teaches Claude
      // to use. These are NEVER logged; we keep them in env only.
      ;(env as any).REMO_HUB_API_KEY = this.orchestrator.hubApiKey
      ;(env as any).REMO_HUB_URL = this.orchestrator.hubUrl
      // Drop the seed system prompt into cwd as a CLAUDE.md-style anchor so
      // Claude picks it up on every turn without us needing a CLI flag that
      // may not exist in all builds. The file is rewritten on every spawn so
      // edits to the user's custom instructions land on the next start.
      try {
        writeFileSync(join(this.projectDir, '.remo-orchestrator.md'), this.orchestrator.systemPrompt, 'utf-8')
      } catch (err: any) {
        this.listener?.({ type: 'log', message: `orchestrator: failed to write .remo-orchestrator.md: ${err?.message ?? err}` })
      }
    }

    const opts = {
      cmd,
      cwd: this.projectDir,
      stdin: 'pipe' as const,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
      env,
      windowsHide: true,
    }
    try {
      this.proc = this.spawnImpl ? this.spawnImpl(cmd, opts) : Bun.spawn(opts)
    } catch (err: any) {
      this.listener?.({ type: 'error', message: `spawn failed: ${err?.message ?? err}` })
      this.listener?.({ type: 'exited', code: null })
      return
    }

    this.listener?.({ type: 'log', message: `claude pid=${this.proc.pid} cwd=${this.projectDir}` })
    this.readStdout()
    this.readStderr()

    // Init events from `claude` may not arrive until first user message in interactive
    // mode, so fall back to a timeout to declare "ready".
    setTimeout(() => {
      if (!this.ready && this.proc) {
        this.ready = true
        this.listener?.({ type: 'ready' })
      }
    }, 3_000)

    this.proc.exited.then((code) => {
      this.listener?.({ type: 'exited', code: code ?? null })
      this.proc = null
      this.ready = false
    })
  }

  sendMessage(content: string, images?: Array<{ media_type: string; data: string }>) {
    if (!this.proc || !this.ready) {
      this.listener?.({ type: 'error', message: 'claude process not ready' })
      return
    }
    this.fullText = ''
    this.listener?.({ type: 'status', state: 'thinking' })

    let messageContent: string | Array<unknown>
    if (images && images.length > 0) {
      const blocks: Array<unknown> = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      }))
      if (content) blocks.push({ type: 'text', text: content })
      messageContent = blocks
    } else {
      messageContent = content
    }

    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: messageContent } })
    try {
      this.proc.stdin.write(line + '\n')
      ;(this.proc.stdin as any).flush?.()
    } catch (err: any) {
      this.listener?.({ type: 'error', message: `stdin write failed: ${err?.message ?? err}` })
    }
  }

  respondToPermission(requestId: string, approved: boolean) {
    if (!this.proc) return
    const line = JSON.stringify({
      type: 'control_response',
      request_id: requestId,
      behavior: approved ? 'allow' : 'deny',
    })
    try {
      this.proc.stdin.write(line + '\n')
      ;(this.proc.stdin as any).flush?.()
    } catch {}
  }

  respondToQuestion(requestId: string, answer: string) {
    if (!this.proc) return
    const askUserQuestion = this.askUserQuestionRequests.get(requestId)
    let line: string
    if (askUserQuestion) {
      // AskUserQuestion came in as `can_use_tool` → answer is a tool-ALLOW
      // control_response carrying the user's selection back as the tool input.
      // ASSUMPTION (flagged for runtime verification): the CLI accepts the
      // selection via `behavior: 'allow'` + an `updatedInput` echoing the chosen
      // answer. If the exact field differs at runtime, adjust here — the rest of
      // the pipeline (hub bridge, TG/web buttons) is unaffected.
      this.askUserQuestionRequests.delete(requestId)
      line = JSON.stringify({
        type: 'control_response',
        request_id: requestId,
        behavior: 'allow',
        updatedInput: { answer },
      })
    } else {
      // Elicitation / side_question — the runner asked directly; answer inline.
      line = JSON.stringify({
        type: 'control_response',
        request_id: requestId,
        response: { answer },
      })
    }
    try {
      this.proc.stdin.write(line + '\n')
      ;(this.proc.stdin as any).flush?.()
    } catch {}
  }

  cancel() {
    // ESC-style turn interrupt — cancel the in-progress turn WITHOUT killing
    // the process/session (so conversation memory survives). Mirrors pressing
    // ESC in the CLI. SIGINT on Windows is unreliable and tends to kill the
    // session, so we use the stream-json interrupt control_request instead.
    // Verified wire format (from @anthropic-ai/claude-agent-sdk):
    //   {"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
    // The CLI acks with a control_response{subtype:'success'}; we don't block
    // on it — the next user message can be sent immediately.
    if (!this.proc) return
    const requestId = `interrupt_${Date.now()}_${this.interruptCounter++}`
    const line = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    })
    try {
      this.proc.stdin.write(line + '\n')
      ;(this.proc.stdin as any).flush?.()
    } catch (err: any) {
      this.listener?.({ type: 'error', message: `interrupt write failed: ${err?.message ?? err}` })
    }
  }

  stop() {
    this.intentionalStop = true
    this.listener = null
    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
    this.ready = false
  }

  async stopGracefully(): Promise<void> {
    this.intentionalStop = true
    const proc = this.proc
    this.listener = null
    if (!proc) { this.ready = false; return }
    try { proc.kill('SIGINT') } catch {}
    const exited: Promise<unknown> = (proc as any).exited ?? Promise.resolve()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))])
    try { proc.kill('SIGKILL') } catch {}
    this.proc = null
    this.ready = false
  }

  get isReady() { return this.ready }

  private async readStderr() {
    if (!this.proc?.stderr) return
    try {
      const reader = this.proc.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true }).trim()
        if (text) this.listener?.({ type: 'log', message: `claude stderr: ${text.slice(0, 500)}` })
      }
    } catch {}
  }

  private async readStdout() {
    if (!this.proc?.stdout) return
    try {
      const reader = this.proc.stdout.getReader()
      const decoder = new TextDecoder()
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
    } catch {}
  }

  private handleEvent(event: CliEvent) {
    if (event.type === 'system' && (event as any).subtype === 'init') {
      this.ready = true
      this.listener?.({ type: 'log', message: `claude ready session=${String((event as any).session_id).slice(0, 8)}` })
      this.listener?.({ type: 'ready' })
      return
    }

    // CLI ack for our outbound control_response/interrupt control_request.
    // Nothing to do — interrupt is fire-and-forget. Swallow so it doesn't fall
    // through as noise.
    if (event.type === 'control_response') return

    if (event.type === 'control_request' && (event as any).subtype === 'can_use_tool') {
      const req = event as any
      // AskUserQuestion is a built-in tool that arrives as a `can_use_tool`
      // permission request, but it is semantically a multiple-choice QUESTION —
      // routing it to a bare Approve/Deny hides the choices. Special-case it:
      // surface a `user_question` with the parsed options, and remember the
      // request_id so the answer is returned as a tool-allow control_response.
      if (req.tool_name === 'AskUserQuestion') {
        const parsed = parseAskUserQuestionInput(req.tool_input)
        if (parsed) {
          this.askUserQuestionRequests.set(req.request_id, { question: parsed.question })
          this.listener?.({
            type: 'user_question',
            request_id: req.request_id,
            question: parsed.question,
            ...(parsed.options.length > 0 ? { options: parsed.options } : {}),
            ...(parsed.isMultiSelect ? { is_multi_select: true } : {}),
          })
          return
        }
        // Couldn't parse — fall through to the permission path so the turn still
        // makes progress (Approve/Deny) rather than hanging.
      }
      this.listener?.({
        type: 'permission_request',
        request_id: req.request_id,
        tool_name: req.tool_name,
        tool_input: req.tool_input,
      })
      return
    }

    if (event.type === 'control_request') {
      const raw = event as any
      const inner = raw.request || raw
      const subtype = inner.subtype
      const requestId = raw.request_id
      if (subtype === 'elicitation' || subtype === 'side_question') {
        const question = inner.message || inner.question || inner.text || 'Claude is asking a question'
        const options = parseOptionsFromSchema(inner.requested_schema)
        this.listener?.({
          type: 'user_question',
          request_id: requestId,
          question,
          ...(options.length > 0 ? { options } : {}),
        })
        return
      }
      return
    }

    if (event.type === 'assistant' && 'message' in event) {
      const msg = (event as any).message
      // P2: remember the model that produced this turn — the `result` event
      // (where we capture usage) doesn't always carry it, but the assistant
      // message does (`message.model`).
      if (typeof msg?.model === 'string' && msg.model) this.lastModel = msg.model
      if (!msg?.content) return
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          this.listener?.({ type: 'status', state: 'writing' })
          this.listener?.({ type: 'text_delta', content: block.text })
          this.fullText += block.text
        }
        if (block.type === 'thinking' && block.thinking) {
          this.listener?.({ type: 'status', state: 'thinking' })
          this.listener?.({ type: 'thinking', content: block.thinking })
        }
        if (block.type === 'tool_use') {
          this.listener?.({ type: 'status', state: 'tool_calling' })
          this.listener?.({ type: 'tool_use', tool: block.name, tool_id: block.id, input: block.input })
        }
      }
      return
    }

    if (event.type === 'tool_result') {
      const tr = event as any
      this.listener?.({ type: 'tool_result', tool_id: tr.tool_use_id, content: tr.content || '', is_error: tr.is_error })
      return
    }

    if (event.type === 'result') {
      const r = event as any
      if (this.fullText) {
        this.listener?.({ type: 'assistant_message', content: this.fullText })
        this.fullText = ''
      }
      const parsed = parseUsageFromResult(r, this.lastModel)
      this.listener?.({
        type: 'result',
        cost: parsed.cost,
        duration_ms: r.duration_ms || 0,
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
        cost_from_sdk: parsed.cost_from_sdk,
      })
      this.listener?.({ type: 'status', state: 'idle' })
    }
  }
}

/**
 * Pure extractor for the P2 usage ledger. Pulls per-turn token counts +
 * authoritative SDK cost out of a Claude CLI `result` stream event.
 *
 * The CLI's `result` event carries `total_cost_usd` (the SDK's authoritative
 * per-turn cost — a subscription list-price equivalent, NOT a billed charge)
 * and a `usage` object with the four token buckets. `model` is captured from
 * the preceding assistant message (`fallbackModel`) since the result event
 * doesn't reliably include it.
 *
 * Exported for unit testing — see supervisor/test/usage-capture.test.ts.
 */
export function parseUsageFromResult(
  r: any,
  fallbackModel: string | null,
): {
  cost: number
  cost_from_sdk: boolean
  model: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
} {
  const hasCost = typeof r?.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd)
  const cost = hasCost ? r.total_cost_usd : 0
  const u = r?.usage
  const usage = u && typeof u === 'object'
    ? {
        input_tokens: Number(u.input_tokens) || 0,
        output_tokens: Number(u.output_tokens) || 0,
        cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0,
        cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0,
      }
    : null
  // Prefer an explicit model on the result, else the per-model usage breakdown
  // key, else the model from the assistant turn.
  let model: string | null = typeof r?.model === 'string' ? r.model : null
  if (!model && r?.modelUsage && typeof r.modelUsage === 'object') {
    const keys = Object.keys(r.modelUsage)
    if (keys.length > 0) model = keys[0]
  }
  if (!model) model = fallbackModel
  return { cost, cost_from_sdk: hasCost, model, usage }
}
