---
phase: 05-codex-cli-and-rootless-sessions
plan: 04
type: execute
wave: 2
depends_on:
  - 05-03
files_modified:
  - agent/src/codex-runner.ts
  - agent/src/codex-jsonrpc.ts
  - agent/src/index.ts
  - agent/test/codex-runner.test.ts
autonomous: true
requirements:
  - P05-CODEX-INTEGRATION
must_haves:
  truths:
    - "CodexRunner implements CliRunner, spawns `codex app-server`, completes initialize → thread/start → turn/start handshake"
    - "item/agentMessage/delta events translate to RunnerEvent.text_delta with the same content payload"
    - "item/started (type=reasoning) translates to RunnerEvent.thinking"
    - "item/started (type=command_execution) + item/completed pair translate to tool_use + tool_result with consistent tool_id"
    - "turn/completed final agent message emits RunnerEvent.assistant_message"
    - "approval/required notifications emit RunnerEvent.permission_request; permission_response from hub sends approval/response back to Codex"
    - "Cancel mid-turn sends Codex's turn/cancel (or interrupt) request; runner becomes ready again for the next user message"
    - "Spike-verified A1/A2/A3 from research (framing, event names, --cd) — any deviation documented in SUMMARY"
  artifacts:
    - path: "agent/src/codex-runner.ts"
      provides: "CodexRunner class implementing CliRunner over codex app-server"
    - path: "agent/src/codex-jsonrpc.ts"
      provides: "Newline-delimited JSON-RPC client (request/notification/response correlation by id)"
    - path: "agent/test/codex-runner.test.ts"
      provides: "Event-mapping unit tests using a fake stdio pipe pumping fixture JSON-RPC frames"
  key_links:
    - from: "agent/src/codex-runner.ts onCodexEvent"
      to: "RunnerEvent emission via onEvent callback"
      via: "translate() switch on codex event type"
      pattern: "item/agentMessage/delta.*text_delta"
    - from: "agent/src/index.ts getOrStartRunner('codex')"
      to: "new CodexRunner(...)"
      via: "replace the Plan 003 stub"
      pattern: "new CodexRunner"
---

<objective>
Implement `CodexRunner` over `codex app-server` stdio JSON-RPC. Wire it into the agent's per-session runner factory, replacing the Plan 003 stub. After this plan, a session with `cli_kind:'codex'` produces a live, streaming Codex chat with thinking, tool execution, and permission flow visible in the existing web UI — using the same RunnerEvent shape Claude already emits.

Purpose: Delivers the headline feature of Phase 05 — Codex as a peer to Claude. All downstream UI/web work (Plan 005) consumes events through the unified RunnerEvent contract from Plan 003, so no web changes are required to render Codex output (only to display the badge — handled in 005).

Output: A working Codex runner plus a fixture-based event-mapping test that locks the protocol mapping for future maintenance.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-03-SUMMARY.md
@agent/src/claude-runner.ts
@agent/src/cli-runner.ts
@agent/src/index.ts
@CLAUDE.md

<interfaces>
From Plan 003 (agent/src/cli-runner.ts):
```ts
export interface CliRunner {
  readonly cliKind: 'claude' | 'codex'
  readonly isReady: boolean
  start(onEvent: (e: RunnerEvent) => void): void
  sendMessage(prompt: string, images?: Array<{ media_type: string; data: string }>): void
  respondToPermission(requestId: string, approved: boolean): void
  respondToQuestion(requestId: string, answer: string): void
  setSystemPrompt(prompt: string): void
  cancel(): void
  stop(): void
  stopGracefully(): Promise<void>
}
```

Codex App Server protocol (from research §1.1-1.3, MUST verify in Task 1 spike):
- Spawn: `codex app-server` (no extra args needed at minimum; `--cd <dir>` sets cwd if supported in app-server mode — ASSUMPTION A3, verify)
- Framing: newline-delimited JSON-RPC 2.0 over stdio (ASSUMPTION A1, verify — may be LSP-style Content-Length headers)
- Handshake: client sends `initialize` request → server returns capabilities → client sends `initialized` notification
- Conversation: `thread/start` request returns `thread_id`; subsequent `turn/start { thread_id, input }` triggers streaming
- Notifications inbound: `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `approval/required`, `error`
- Outbound: `turn/start`, `turn/cancel` (or `$/cancelRequest`), `approval/response`, `thread/resume`
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Spike Codex framing + build JSON-RPC stdio client</name>
  <files>agent/src/codex-jsonrpc.ts, agent/test/codex-jsonrpc.test.ts</files>
  <read_first>
    - .planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md §1.1, §1.2, §5 (open questions #1)
    - agent/src/claude-runner.ts (mirror stdio parsing patterns — line buffering, JSON.parse-per-line if Claude does newline framing)
  </read_first>
  <behavior>
    - Spike: spawn `codex app-server --help` and inspect stdout for any documented framing flag. If `codex` is unavailable on the build host, skip the live spike and code defensively for newline-delimited JSON, with a fallback parser for LSP-style `Content-Length:` headers gated by a feature-detect on the first byte (`{` → newline-delimited; `C` → LSP framing).
    - Client exposes `JsonRpcClient(child: ChildProcess)` with:
      - `request<T>(method: string, params?: unknown): Promise<T>` — sends `{jsonrpc:'2.0', id, method, params}`, resolves on matching `id` in response, rejects on error
      - `notify(method: string, params?: unknown): void` — fire-and-forget
      - `onNotification(handler: (method: string, params: unknown) => void)`
      - `onError(handler: (err: Error) => void)`
      - `close(): void`
    - Correlates responses by integer id (monotonic counter starting at 1)
    - Buffers partial stdout lines (chunk boundaries mid-message); only emits complete frames
    - On `child.stdout` 'end' or 'error', rejects all pending requests with a clear error
  </behavior>
  <action>
    Create `agent/src/codex-jsonrpc.ts`:
    - Implement two framing modes behind a single `read(buffer): Frame[]` function: `'ndjson'` (split by `\n`, parse each non-empty line) and `'lsp'` (read `Content-Length: <n>\r\n\r\n<n bytes>`). Auto-detect on first non-whitespace byte.
    - Implement the JsonRpcClient class above. Use `child.stdin.write(serialized + (framing==='ndjson' ? '\n' : ''))` for ndjson, or LSP-style headers otherwise.
    - Generic types: `request<TParams, TResult>(method, params: TParams): Promise<TResult>`.

    Create `agent/test/codex-jsonrpc.test.ts`:
    - Use a mock ChildProcess (Readable/Writable streams). Feed pre-recorded ndjson frames; assert request/response correlation, notification emission, and that partial chunks (split mid-frame) are buffered correctly.
    - Test framing auto-detect: first chunk `{"jsonrpc"...` → ndjson; first chunk `Content-Length: 42\r\n` → LSP.

    **Document the spike outcome in `agent/src/codex-jsonrpc.ts` header comment**: which framing the live `codex app-server --version` actually uses on the build host (if reachable), or "ASSUMED ndjson — verify on first live integration test".
  </action>
  <verify>
    <automated>cd agent; bun test test/codex-jsonrpc.test.ts ; bun run tsc --noEmit -p .</automated>
    Tests cover: request → response correlation (3 concurrent requests, responses arrive out of order), notification fan-out, partial chunk buffering (split a 200-byte frame across 5 chunks), and framing auto-detect for both modes.
  </verify>
  <done>
    JsonRpcClient handles both framing modes, correlates correctly, all tests green. Comment header documents the spike result or the verification TODO for first live integration.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: CodexRunner implementing CliRunner + event mapping + wire into index.ts</name>
  <files>agent/src/codex-runner.ts, agent/test/codex-runner.test.ts, agent/src/index.ts</files>
  <read_first>
    - agent/src/cli-runner.ts (CliRunner interface — implement EVERY method)
    - agent/src/claude-runner.ts (mirror lifecycle: start/stop/cancel/stopGracefully/respondToPermission patterns)
    - .planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md §1.3 (event mapping table — implement EXACTLY this mapping)
    - agent/src/codex-jsonrpc.ts (just-built client)
  </read_first>
  <behavior>
    - `new CodexRunner(workingDir, localOutput, resume?: { threadId: string })` constructs without spawning
    - `start(onEvent)` spawns `codex app-server` with `cwd=workingDir` (and `--cd workingDir` arg as well — belt+suspenders for assumption A3); on first stdout byte, completes initialize handshake, then `thread/start` (or `thread/resume` if `resume.threadId` provided), then sets `isReady=true` and emits `RunnerEvent.ready`
    - `sendMessage(prompt)` calls `turn/start { thread_id, input: prompt }`. While a turn is in flight, `isReady=false`; on `turn/completed`, `isReady=true`
    - Notification handlers translate per research §1.3:
      - `item/agentMessage/delta { delta }` → emit `{ type:'text_delta', content: delta }`
      - `item/started { id, type:'reasoning' }` → emit `{ type:'thinking', content:'' }` (subsequent reasoning deltas append via item/agentMessage/delta scoped to that id — keep a `currentItemId → kind` map for routing)
      - `item/started { id, type:'command_execution', command }` → emit `{ type:'tool_use', tool:'bash', tool_id: id, input: { command } }`
      - `item/completed { id, type:'command_execution', exit_code, stdout, stderr }` → emit `{ type:'tool_result', tool_id: id, content: stdout + (stderr ? '\n'+stderr : ''), is_error: exit_code !== 0 }`
      - `item/started { id, type:'mcp_tool_call', name, arguments }` → emit `{ type:'tool_use', tool: name, tool_id: id, input: arguments }`; matching `item/completed` → tool_result
      - `turn/completed { agent_message }` → emit `{ type:'assistant_message', content: agent_message }` then `{ type:'status', state:'idle' }`
      - `approval/required { request_id, command, cwd }` → emit `{ type:'permission_request', request_id, tool_name:'bash', tool_input:{ command, cwd } }`
      - `error { message }` → emit `{ type:'log', message: 'Codex error: '+message }`
    - `respondToPermission(requestId, approved)` → `notify('approval/response', { request_id: requestId, decision: approved ? 'approve' : 'deny' })`
    - `cancel()` → `notify('turn/cancel', { thread_id })` (fallback `$/cancelRequest` if server rejects unknown method — log + retry)
    - `setSystemPrompt(prompt)` → store; pass via `initialize` params `{ system_prompt: prompt }` if not already initialized, else log "Codex: system prompt change requires restart" (Codex app-server may not support live update — degrade gracefully)
    - `stop()` → SIGTERM child; `stopGracefully()` → send shutdown notification (if supported), await exit with 5s timeout then SIGTERM
    - `respondToQuestion(requestId, answer)` → currently emit `agent_log` "Codex does not support user_question; ignored" (Codex has no analog as of research; revisit if confirmed)

    Unit tests use a fixture file of recorded Codex frames (build a minimal one from the protocol docs / research; if a real Codex binary is available, capture from `codex app-server` directly and save to `agent/test/fixtures/codex-turn.ndjson`).
  </behavior>
  <action>
    Create `agent/src/codex-runner.ts` implementing the behavior above. Use `child_process.spawn('codex', ['app-server', '--cd', workingDir], { stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: process.platform==='win32' })`. Pipe stderr to console for diagnostics (gated on localOutput like ClaudeRunner does).

    Maintain internal state:
    - `threadId: string | null`
    - `isReady: boolean = false`
    - `currentTurn: { promise: Promise<void>; cancel: () => void } | null`
    - `itemKinds: Map<string, 'reasoning'|'command_execution'|'mcp_tool_call'|'agent_message'>`
    - `pendingApprovals: Map<string, void>` (for sanity logging)

    Implement `translate(method: string, params: any, emit: (e: RunnerEvent) => void)` as a pure function so the test can call it directly with fixture frames.

    Create `agent/test/codex-runner.test.ts`:
    - Test `translate()` directly with synthetic frames covering every row in the research §1.3 table — assert the exact RunnerEvent shape emitted.
    - Test currentItemId routing: an `item/started reasoning` followed by 3 `item/agentMessage/delta` then `item/completed reasoning` produces 3 `thinking` events (NOT text_delta) because the routing map says reasoning.
    - Test that `item/started agent_message` followed by deltas produces `text_delta` events.
    - Test command_execution pair: started + completed with exit_code=1 → tool_use + tool_result(is_error=true).

    In `agent/src/index.ts`:
    - Import `CodexRunner` from `./codex-runner`.
    - In `getOrStartRunner` (added in Plan 003), replace the `cliKind==='codex'` stub: `return new CodexRunner(workingDir, config.localOutput, resume ? { threadId: resume } : undefined)`. The Plan 003 `agent_log` warning is removed.
    - Preflight: `codex --version` check (already added in Plan 003 Task 2) — extend the error message to recommend `npm i -g @openai/codex` AND `codex login`.

    Document A1/A2/A3 spike outcomes in the SUMMARY: if any framing/event-name/flag differs from the assumption, log the deviation and adjust the code (which is the source of truth post-spike).
  </action>
  <verify>
    <automated>cd agent; bun test test/codex-runner.test.ts test/codex-jsonrpc.test.ts ; bun run tsc --noEmit -p .</automated>
    Every event-mapping bullet from the behavior list has a corresponding `expect(...)` in the test file. Live integration (gated — only if `CODEX_TEST=1` env): spawn a real `codex app-server`, send a `turn/start { input: "say hi" }`, observe at least one `text_delta` + one `assistant_message` reaches the onEvent callback.
  </verify>
  <done>
    CodexRunner implements CliRunner end-to-end. Event mapping is locked by unit tests. index.ts spawns a real Codex process for cli_kind='codex' sessions. Spike findings documented in SUMMARY.
  </done>
</task>

</tasks>

<verification>
- `agent/src/codex-runner.ts` exports CodexRunner; `agent/src/index.ts` instantiates it
- Unit test file `agent/test/codex-runner.test.ts` covers every mapping row from research §1.3
- `bun run tsc --noEmit -p agent` is green
- Manual smoke (if Codex installed on dev host): create a session with cli_kind='codex', send "say hi" via web UI, observe streaming text in the chat view
</verification>

<success_criteria>
A user can hold a real conversation with Codex through the existing web UI, with thinking, tool execution, and approval prompts rendering through the same UI components Claude uses. Web layer required zero changes.
</success_criteria>

<output>
Create `.planning/phases/05-codex-cli-and-rootless-sessions/05-04-SUMMARY.md` when done. Include a "Spike Outcomes" section documenting actual Codex framing/event-names/flags vs. research assumptions A1/A2/A3.
</output>
