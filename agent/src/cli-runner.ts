// RunnerEvent — unified event shape emitted by every CLI runner.
// Codex events (Plan 004) map onto this same union — do NOT add codex-specific variants here.
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
  | { type: 'result'; cost: number; duration_ms: number }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string }
  | { type: 'ready' }

export interface CliRunner {
  readonly cliKind: 'claude' | 'codex'
  readonly isReady: boolean
  start(onEvent: (e: RunnerEvent) => void): void
  sendMessage(prompt: string, images?: Array<{ media_type: string; data: string }>): void
  respondToPermission(requestId: string, approved: boolean): void
  respondToQuestion(requestId: string, answer: string): void
  setSystemPrompt(prompt: string | null | undefined): void
  cancel(): void
  stop(): void
  stopGracefully(): Promise<void>
}
