---
phase: 05-codex-cli-and-rootless-sessions
plan: 03
type: execute
wave: 2
depends_on:
  - 05-01
  - 05-02
files_modified:
  - agent/src/cli-runner.ts
  - agent/src/claude-runner.ts
  - agent/src/index.ts
  - agent/src/types.ts
autonomous: true
requirements:
  - P05-RUNNER-ABSTRACTION
must_haves:
  truths:
    - "A CliRunner interface exists with start/stop/sendMessage/respondToPermission/respondToQuestion/setSystemPrompt/cancel/isReady + RunnerEvent emission"
    - "ClaudeRunner implements CliRunner with NO behavior change vs. main (existing Claude sessions work identically)"
    - "agent/src/index.ts reads cli_kind from auth_ok and instantiates the appropriate runner"
    - "Per-CLI preflight: 'claude --version' check only runs when cli_kind='claude'; 'codex --version' check only runs when cli_kind='codex'"
    - "An agent process can host multiple CliRunner instances simultaneously (one per session_id), each with independent stdin/stdout pipes"
    - "RunnerEvent shape is unified — same event types regardless of underlying CLI"
  artifacts:
    - path: "agent/src/cli-runner.ts"
      provides: "CliRunner interface + RunnerEvent union type"
    - path: "agent/src/claude-runner.ts"
      provides: "ClaudeRunner implements CliRunner (refactor)"
    - path: "agent/src/index.ts"
      provides: "Per-session runner instantiation keyed by cli_kind"
  key_links:
    - from: "agent/src/index.ts handleMessage(auth_ok)"
      to: "ClaudeRunner OR CodexRunner (Plan 004)"
      via: "switch on msg.cli_kind"
      pattern: "msg.cli_kind === 'codex'"
---

<objective>
Refactor the agent so the Claude-specific spawn/stream logic lives behind a `CliRunner` interface, and the entry point chooses a runner per session based on `auth_ok.cli_kind`. After this plan, a Codex runner can be slotted in (Plan 004) without further structural changes to `index.ts`. Multiple runners coexist in one agent process so rootless ambient sessions (Plan 005) can spawn alongside the project session.

Purpose: Removes the hard-coded singleton `ClaudeRunner` at `agent/src/index.ts:37`. Establishes the contract Plan 004's `CodexRunner` will implement.

Output: Refactored agent code with green tests; behavior for existing Claude-only users is byte-identical.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-01-SUMMARY.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-02-SUMMARY.md
@agent/src/index.ts
@agent/src/claude-runner.ts
@agent/src/hub-client.ts
@agent/src/types.ts
@CLAUDE.md

<interfaces>
From agent/src/index.ts (current — line numbers from Read of full file):
- Singleton runner: `const runner = new ClaudeRunner(config.projectDir, config.localOutput, config.resume)` (line 37)
- `handleMessage(msg: HubToAgent)` switch on `msg.type`: `auth_ok`, `user_message`, `permission_response`, `question_response`, `cancel`, `shutdown` (lines 64-107)
- `runner.setSystemPrompt(msg.system_prompt)` invoked on auth_ok when system_prompt present (line 68)
- `runner.start(handleRunnerEvent)`, `runner.sendMessage(prompt, images)`, `runner.respondToPermission`, `runner.respondToQuestion`, `runner.cancel()`, `runner.stop()`, `runner.stopGracefully()`, `runner.isReady` — these define the contract surface
- `RunnerEvent` imported from `./claude-runner` (must move to `./cli-runner`)

From Plan 002 (auth_ok payload):
- `{ type:'auth_ok'; session_id; cli_kind:'claude'|'codex'; system_prompt?; seed_files?; rootless_session_ids?: { claude?; codex? } }`
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extract CliRunner interface + RunnerEvent union into agent/src/cli-runner.ts</name>
  <files>agent/src/cli-runner.ts, agent/src/claude-runner.ts</files>
  <read_first>
    - agent/src/claude-runner.ts (full file — extract every public method signature and the RunnerEvent type definition)
    - agent/src/index.ts (lines 1-160 — confirm every method/property the entry point reaches into on `runner`)
  </read_first>
  <behavior>
    - `cli-runner.ts` exports `CliRunner` interface and `RunnerEvent` union; both are usable from `index.ts` without importing from `claude-runner.ts`
    - `ClaudeRunner` declares `implements CliRunner`; TS compiles with no `any` casts at the implements site
    - All existing call sites in `index.ts` that imported `RunnerEvent` from `./claude-runner` now import from `./cli-runner` (or both — barrel re-export is acceptable)
    - No behavioral diff: running `bun agent/src/index.ts` against a real hub still streams Claude events identically
  </behavior>
  <action>
    Create `agent/src/cli-runner.ts`:

    ```ts
    // RunnerEvent — unified event shape emitted by every CLI runner.
    // Codex events (Plan 004) map onto this same union — do NOT add codex-specific variants here.
    export type RunnerEvent =
      | { type: 'ready' }
      | { type: 'thinking'; content: string }
      | { type: 'text_delta'; content: string }
      | { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
      | { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
      | { type: 'status'; state: 'idle'|'thinking'|'tool_calling'|'writing' }
      | { type: 'assistant_message'; content: string }
      | { type: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown }
      | { type: 'user_question'; request_id: string; question: string; options?: Array<{label:string;description?:string}>; is_multi_select?: boolean }
      | { type: 'log'; message: string }
      | { type: 'result'; /* internal — agent ignores */ }

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

    Match the union exactly to the current `RunnerEvent` exported from `claude-runner.ts` (read it first; do not invent fields). If the current union has additional members, include them; if any current variant is unreachable, KEEP it for now (refactor surgically — no scope creep per Karpathy rule).

    In `agent/src/claude-runner.ts`:
    - `import type { CliRunner, RunnerEvent } from './cli-runner'`
    - Change `export class ClaudeRunner` to `export class ClaudeRunner implements CliRunner`
    - Add `readonly cliKind = 'claude' as const`
    - Re-export RunnerEvent from `./cli-runner` as a barrel so existing `import { RunnerEvent } from './claude-runner'` keeps compiling: `export type { RunnerEvent } from './cli-runner'`
    - Remove the in-file `RunnerEvent` type declaration (now lives in cli-runner.ts) — but ONLY after the barrel re-export is in place.

    Do NOT change ClaudeRunner method bodies. This is a pure type-level refactor.
  </action>
  <verify>
    <automated>cd agent; bun run tsc --noEmit -p . ; bun test 2>$null</automated>
    `grep -n "implements CliRunner" agent/src/claude-runner.ts` returns 1 hit. `grep -n "from './cli-runner'" agent/src/*.ts` returns ≥1 hit. Build a fresh agent binary and connect to a real hub: a single Claude turn streams thinking + text_delta + assistant_message events as before.
  </verify>
  <done>
    Interface extracted, ClaudeRunner implements it, all TS green, existing Claude streaming behavior preserved.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Per-session runner instantiation + per-CLI preflight in index.ts</name>
  <files>agent/src/index.ts, agent/src/types.ts</files>
  <read_first>
    - agent/src/index.ts (full file — note the singleton `runner` at line 37, the `runnerStarted` flag at line 56, all 6 handlers in handleMessage)
    - agent/src/types.ts (HubToAgent shape — confirm cli_kind is present after Plan 002)
    - agent/src/cli-runner.ts (just created)
  </read_first>
  <behavior>
    - Preflight `spawnSync('claude', ['--version'])` runs ONLY if the agent will host a Claude session (project session with cli_kind='claude' OR rootless_sessions includes 'claude')
    - Preflight `spawnSync('codex', ['--version'])` runs ONLY if the agent will host a Codex session
    - Either preflight failure exits with a clear actionable error message naming the missing CLI and install URL
    - `auth_ok` with `cli_kind:'claude'` instantiates a ClaudeRunner for `msg.session_id`
    - `auth_ok` with `cli_kind:'codex'` THROWS `not_implemented` (Plan 004 wires the real CodexRunner) — but does NOT crash the agent; it sends an `agent_log` with the message "Codex runner pending Plan 004" and continues idle. Backward-compat path stays green.
    - When `auth_ok.rootless_session_ids` is present, one runner per ambient session id is spawned (lazy: only on first `user_message` for that session id, per research §2.4)
    - `handleMessage` routes `user_message`, `permission_response`, `question_response`, `cancel` to the runner whose session_id matches `msg.session_id`
    - `shutdown` stops ALL runners gracefully
  </behavior>
  <action>
    Restructure `agent/src/index.ts`:

    1. **Move preflight inside `handleMessage(auth_ok)`** (not at module top). Maintain a `Set<'claude'|'codex'>` of CLIs the hub asked for (from `msg.cli_kind` + Object.keys(msg.rootless_session_ids ?? {})). For each, call `spawnSync(<cli>, ['--version'], {stdio:['ignore','pipe','ignore'], timeout:10_000, windowsHide:true, shell:process.platform==='win32'})`. On failure, ui.printError + console.error with the missing CLI's install URL (Claude: https://claude.ai/code, Codex: `npm i -g @openai/codex` then `codex login`) + `process.exit(1)`.

    2. **Replace singleton `runner`** with `const runners = new Map<string, CliRunner>()` keyed by session_id. Track a `Map<string, { cliKind; lazy: boolean; started: boolean }>` for known sessions (populated on auth_ok).

    3. **New `getOrStartRunner(sessionId: string): CliRunner | null`** — looks up the session's cliKind; if 'claude' instantiates `new ClaudeRunner(workingDir, config.localOutput, config.resume)`; if 'codex' calls `createCodexRunner(...)` (stub for now — throws or returns null; Plan 004 wires it). Working dir: for project sessions use `config.projectDir`; for rootless sessions use `path.join(os.homedir(), '.remo-code', 'rootless', cliKind)` (mkdirSync recursive, idempotent).

    4. **Rewrite `handleMessage`**:
       - `auth_ok`: register each session id (project + rootless) into the map. If `msg.system_prompt`, store it on the project runner once it starts (use `pendingSystemPrompt` map). Eagerly start the project session runner (preserving current UX); leave rootless runners lazy.
       - `user_message`: `getOrStartRunner(msg.session_id)?.sendMessage(...)` with existing queueing logic if `!isReady`.
       - `permission_response` / `question_response` / `cancel`: route to `runners.get(msg.session_id)`.
       - `shutdown`: `Promise.all([...runners.values()].map(r => r.stopGracefully()))` then `hub.close()` and exit.

    5. **handleRunnerEvent** now takes `(sessionId: string, event: RunnerEvent)` — bind via `runner.start(e => handleRunnerEvent(sessionId, e))`. Replace `hub.sessionIdValue` reads with the bound sessionId so events from different runners route correctly.

    6. **HubClient**: confirm `hub.send(...)` already accepts arbitrary session_ids (the existing `hub.send({ ...event, session_id: sessionId })` pattern at index.ts:53 does). If `HubClient` was tracking a single primary session_id internally, leave that behavior (it's the project session); but stop using `hub.sessionIdValue` as the source of truth for routing — use the per-runner bound sessionId instead. This may require exposing a `getSessionIds(): string[]` accessor or storing the array externally in index.ts. Pick whichever is the smallest diff.

    7. **Codex stub**: in `getOrStartRunner`, when cliKind==='codex', emit one `sendLog(`Codex runner not yet wired — Plan 004 will implement (session ${sessionId})`)` then return null. Do NOT throw. Subsequent user_messages to that session are silently dropped (logged once per session via a `Set<string>` guard).

    Keep the existing 5-second fallback timer at lines 125-130 — but only fire it for the project session, not rootless sessions.
  </action>
  <verify>
    <automated>cd agent; bun run tsc --noEmit -p . ; bun test 2>$null</automated>
    Manual regression: connect a real agent with a single Claude project session — full chat round-trip works (send message, receive thinking + text + assistant_message). Inspect logs: only `claude --version` preflight ran (no codex check). Connect with `--api-key` for a Codex-configured session → agent_log "Codex runner pending Plan 004" appears, agent stays alive.
  </verify>
  <done>
    Singleton runner replaced by per-session map. Preflight is per-CLI on-demand. Codex sessions are accepted by the protocol layer and stubbed at the runner layer. All existing Claude flows unchanged.
  </done>
</task>

</tasks>

<verification>
- `grep -c "new ClaudeRunner" agent/src/index.ts` returns 1 (inside getOrStartRunner, not at module scope)
- `grep -c "spawnSync('claude'" agent/src/index.ts` confirms preflight moved into handler (not at module top — module-top spawnSync is removed)
- Existing Claude project session: thinking + text + tool_use events stream identically (compare against pre-refactor capture)
- TS green across agent/
</verification>

<success_criteria>
Runner abstraction in place; Plan 004 can drop in `CodexRunner` by implementing CliRunner and replacing the stub in `getOrStartRunner`. Zero behavior change for current users.
</success_criteria>

<output>
Create `.planning/phases/05-codex-cli-and-rootless-sessions/05-03-SUMMARY.md` when done
</output>
