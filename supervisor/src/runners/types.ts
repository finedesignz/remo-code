/**
 * In-process CLI runner types — restored 2026-05-27 to replace the retired
 * external npm agent spawn path (Phase 09).
 *
 * Mirrors the shape the legacy `agent/src/cli-runner.ts` used so the hub-side
 * agent-protocol is unchanged. The runner emits `RunnerEvent`s; the bridge
 * (supervisor/src/runners/session-bridge.ts) translates those onto the hub's
 * `/ws/agent` discriminated union.
 */

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; content: string }
  | { type: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown }
  | {
      type: 'user_question'
      request_id: string
      question: string
      options?: Array<{ label: string; description?: string }>
      is_multi_select?: boolean
    }
  | {
      type: 'result'
      cost: number
      duration_ms: number
      // P2 usage ledger — per-turn token counts + authoritative SDK cost.
      // `usage` / `model` are best-effort: a `result` with subtype 'error' or
      // an older CLI may omit them, in which case the bridge skips usage_event.
      model?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
      // True when `cost` came from the SDK's `total_cost_usd` (authoritative).
      // False when absent (hub will estimate from its price table).
      cost_from_sdk?: boolean
    }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }
  | { type: 'ready' }
  | { type: 'exited'; code: number | null }

/**
 * Minimal lifecycle surface `session-bridge` needs from an interactive PTY
 * runner, regardless of whether it is the Rust ConPTY bridge
 * (`ClaudePtyBridge`, prod) or the Node helper fallback (`ClaudePtyRunner`).
 *
 * The two start-opts shapes are a superset here: the Rust bridge keys its PTY
 * by `sessionId` and can replay scrollback (`onScrollback`); the Node runner
 * ignores both. `pid` is OPTIONAL — the Rust bridge has none (the PTY lives in
 * the Tauri process), so session-bridge must tolerate `undefined` (it already
 * does `pty.pid ?? 0`).
 */
export interface PtyLikeStartOpts {
  /** Rust bridge only — keys the PTY in the host registry; ignored by the Node runner. */
  sessionId?: string
  cwd: string
  cols?: number
  rows?: number
  onData: (bytes: string) => void
  /** Rust bridge only — scrollback replay on (re)attach, before live onData. */
  onScrollback?: (bytes: string) => void
  onExit?: (code: number | null) => void
  /** Operator-gated (`allowDangerousSkipPermissions`). When true the PTY spawns
   *  the interactive TUI with `--dangerously-skip-permissions` as its SOLE argv
   *  token (still a permission flag, never a programmatic/stream-json flag). */
  dangerouslySkipPermissions?: boolean
}

export interface PtyLike {
  start(opts: PtyLikeStartOpts): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  /** Node runner exposes the host pid; the Rust bridge has none. */
  readonly pid?: number
}

export interface CliRunner {
  readonly cliKind: 'claude' | 'codex'
  readonly isReady: boolean
  start(onEvent: (e: RunnerEvent) => void): void
  sendMessage(prompt: string, images?: Array<{ media_type: string; data: string }>): void
  respondToPermission(requestId: string, approved: boolean): void
  respondToQuestion(requestId: string, answer: string): void
  cancel(): void
  stop(): void
  stopGracefully(): Promise<void>
}

// Subset of Claude CLI stream-json shapes we care about
export interface CliInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
}
export interface CliAssistantEvent {
  type: 'assistant'
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
  }
  session_id: string
}
export interface CliToolResultEvent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
export interface CliResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  result: string
  duration_ms: number
  total_cost_usd: number
  // Per-turn token usage emitted by the Claude CLI alongside the result.
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  // Some CLI builds report a per-model usage breakdown keyed by model id.
  modelUsage?: Record<string, unknown>
}
export type CliEvent =
  | CliInitEvent
  | CliAssistantEvent
  | CliToolResultEvent
  | CliResultEvent
  | { type: string; [k: string]: unknown }

// Hub → agent message shapes (subset). Hub sends these on /ws/agent after auth_ok.
export type HubToAgent =
  | { type: 'auth_ok'; session_id: string; system_prompt?: string | null; cli_kind?: 'claude' | 'codex' }
  | { type: 'auth_error'; error: string }
  | {
      type: 'user_message'
      id?: string
      session_id?: string
      content: string
      images?: Array<{ media_type: string; data: string }>
      attachments?: Array<{ filename: string; content: string }>
    }
  | { type: 'permission_response'; session_id?: string; request_id: string; approved: boolean }
  | { type: 'question_response'; session_id?: string; request_id: string; answer: string }
  | { type: 'cancel'; session_id?: string }
  | { type: 'shutdown'; reason?: string }
  | { type: 'ping' }

// Agent → hub message shapes (subset). Bridge stamps session_id.
export type AgentToHub =
  | {
      type: 'auth'
      api_key: string
      project_dir: string
      hostname: string
      role?: 'agent'
      agent_info?: Record<string, unknown>
    }
  | { type: 'thinking'; session_id: string; content: string }
  | { type: 'text_delta'; session_id: string; content: string }
  | { type: 'tool_use'; session_id: string; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; session_id: string; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; session_id: string; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; session_id: string; content: string }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; tool_input: unknown }
  | {
      type: 'user_question'
      session_id: string
      request_id: string
      question: string
      options?: Array<{ label: string; description?: string }>
      is_multi_select?: boolean
    }
  | { type: 'agent_log'; session_id: string; message: string }
  // P2 usage ledger — one per assistant turn. Additive; hub persists to
  // token_usage + token_usage_daily. `cost_source` is 'sdk' when total_cost_usd
  // was present, else 'estimated' (hub fills the cost from its price table).
  | {
      type: 'usage_event'
      session_id: string
      model: string | null
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      cost_usd: number
      cost_source: 'sdk' | 'estimated'
      ts: string
    }
  | { type: 'pong' }
