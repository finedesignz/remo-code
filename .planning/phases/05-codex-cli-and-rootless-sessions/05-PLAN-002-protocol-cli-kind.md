---
phase: 05-codex-cli-and-rootless-sessions
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/ws/agent-protocol.ts
  - hub/src/ws/protocol.ts
  - hub/src/api/sessions.ts
  - hub/src/ws/channel.ts
files_modified_note: "Touches schema-adjacent code (protocol + API) but does NOT touch dal.ts/schema.sql. Files are disjoint from Plan 001 so both run in Wave 1 in parallel."
autonomous: true
requirements:
  - P05-CLI-KIND
  - P05-ROOTLESS-PROTOCOL
must_haves:
  truths:
    - "Agent can authenticate with optional cli_kind and optional rootless_sessions[] in its auth payload"
    - "Hub auth_ok payload carries cli_kind so the agent knows which CLI to spawn"
    - "POST /api/sessions accepts optional cli_kind and rejects unknown values with 400"
    - "Session list payload (REST + WS session_list) exposes cli_kind, is_rootless, hostname for every row"
    - "Agent advertising rootless_sessions=['claude','codex'] triggers hub-side find-or-create for both ambient rows scoped to that hostname"
  artifacts:
    - path: "hub/src/ws/agent-protocol.ts"
      provides: "AgentAuth.cli_kind, AgentAuth.rootless_sessions Zod fields"
    - path: "hub/src/ws/protocol.ts"
      provides: "HubToAgent.auth_ok.cli_kind, HubToClient.session_list rows include cli_kind/is_rootless/hostname"
    - path: "hub/src/api/sessions.ts"
      provides: "CreateSessionBody.cli_kind"
  key_links:
    - from: "agent auth payload"
      to: "hub findOrCreateRootlessSession (Plan 001)"
      via: "channel.ts handleAuth when rootless_sessions is set"
      pattern: "rootless_sessions.*findOrCreateRootlessSession"
---

<objective>
Wire `cli_kind` and rootless advertisement through the WS protocol layer and the REST session-create API. After this plan, the agent can ask "give me my Claude+Codex ambient sessions on hostname X" in a single auth handshake, and the web UI can create a project session pinned to a chosen CLI.

Purpose: Plan 003 (runner abstraction) needs `auth_ok.cli_kind` to decide which runner to instantiate. Plan 005 (UI) needs the session list rows to carry cli_kind/is_rootless so the sidebar can render badges and the Ambient group.

Output: Protocol schemas + API request shapes updated; channel.ts routes rootless advertisements to the DAL helper from Plan 001.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md
@hub/src/ws/agent-protocol.ts
@hub/src/ws/protocol.ts
@hub/src/api/sessions.ts
@hub/src/ws/channel.ts
@CLAUDE.md

<interfaces>
From hub/src/db/dal.ts (after Plan 001 lands):
- `createSession(userId, name, projectDir, tokenHash, cliKind?, isRootless?, hostname?)`
- `findOrCreateRootlessSession(userId, hostname, cliKind, tokenHashIfCreating, nameIfCreating): Promise<SessionRow>`
- `SessionRow` now includes `cli_kind: 'claude'|'codex'`, `is_rootless: boolean`, `hostname: string | null`

Existing AgentAuth (hub/src/ws/agent-protocol.ts):
```ts
export const AgentAuth = z.object({
  type: z.literal('auth'),
  api_key: z.string().min(1),
  project_dir: z.string().min(1),  // currently required
  hostname: z.string().optional(),
  role: z.enum(['agent','supervisor']).optional(),
  agent_info: AgentInfo.optional(),
})
```

Existing HubToAgent.auth_ok (hub/src/ws/protocol.ts:154):
```ts
{ type: 'auth_ok'; session_id: string }
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend Zod schemas + outbound types for cli_kind and rootless</name>
  <files>hub/src/ws/agent-protocol.ts, hub/src/ws/protocol.ts</files>
  <read_first>
    - hub/src/ws/agent-protocol.ts (AgentAuth lines 23-30 + surrounding shape)
    - hub/src/ws/protocol.ts (HubToAgent lines 153-162, HubToClient.session_list line 173)
  </read_first>
  <behavior>
    - AgentAuth.parse({ type:'auth', api_key:'k', project_dir:'/x', cli_kind:'codex' }) succeeds
    - AgentAuth.parse({ type:'auth', api_key:'k', project_dir:'/x', cli_kind:'gemini' }) fails Zod parse
    - AgentAuth.parse({ type:'auth', api_key:'k', hostname:'h', rootless_sessions:['claude','codex'] }) succeeds (project_dir omitted for rootless-only agent)
    - HubToAgent type accepts `{ type:'auth_ok', session_id:'s', cli_kind:'codex' }` without TS error
    - HubToClient session_list row accepts cli_kind/is_rootless/hostname fields without TS error
  </behavior>
  <action>
    In `agent-protocol.ts` AgentAuth:
    - Make `project_dir` optional (was `z.string().min(1)`; change to `.optional()`). RATIONALE: a rootless-only agent connect has no project dir.
    - Add `cli_kind: z.enum(['claude','codex']).optional()` — when present and `project_dir` is set, hub creates/looks-up a project session with this CLI; when omitted, default 'claude' (backward compat).
    - Add `rootless_sessions: z.array(z.enum(['claude','codex'])).max(2).optional()` — agent advertises ambient session capability.
    - Add a `.refine()` enforcing: at least one of `project_dir` or `rootless_sessions` must be present (otherwise the agent has nothing to subscribe to).

    In `protocol.ts`:
    - Extend the `HubToAgent` `auth_ok` variant to `{ type: 'auth_ok'; session_id: string; cli_kind: 'claude' | 'codex'; system_prompt?: string; seed_files?: unknown[]; rootless_session_ids?: { claude?: string; codex?: string } }`. (`system_prompt` already implied by current code reading `msg.system_prompt` in agent/src/index.ts:67 — make it explicit. `seed_files` placeholder is reserved for Plan 005 — typed as `unknown[]` here, refined in 005.)
    - Extend `HubToClient.session_list` row tuple to include `cli_kind: 'claude' | 'codex'; is_rootless: boolean; hostname: string | null`.

    Do NOT modify `HubToChannel` — the legacy channel WS keeps its current shape (backward compat with deployed channel plugin).
  </action>
  <verify>
    <automated>cd hub; bun run tsc --noEmit -p . ; bun test test/ws-protocol.test.ts 2>$null</automated>
    Add a small unit assertion (inline or in a new test) parsing each behavior bullet above. `grep -n "rootless_sessions" hub/src/ws/agent-protocol.ts` returns ≥1 hit. `grep -n "cli_kind" hub/src/ws/protocol.ts` returns ≥2 hits (auth_ok + session_list).
  </verify>
  <done>
    TS compiles. Zod schemas accept/reject per the behavior list. Outbound types include cli_kind everywhere it's needed for Plans 003+005 to consume.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: REST CreateSessionBody + agent auth handler wiring</name>
  <files>hub/src/api/sessions.ts, hub/src/ws/channel.ts</files>
  <read_first>
    - hub/src/api/sessions.ts (CreateSessionBody lines 9-12, POST handler lines 64-77)
    - hub/src/ws/channel.ts (locate the agent auth handler; specifically the call to findOrCreateAgentSession — extend, don't replace)
  </read_first>
  <behavior>
    - POST /api/sessions with `{ name:'x', cli_kind:'codex' }` returns 201 with `cli_kind:'codex'` in the response body
    - POST /api/sessions with `{ name:'x', cli_kind:'gemini' }` returns 400
    - POST /api/sessions without cli_kind defaults to 'claude' (backward compat)
    - When an agent auths with `{ rootless_sessions:['claude','codex'], hostname:'host-a' }` and no existing rows, two rows are created (one per CLI) and the auth_ok payload includes `rootless_session_ids: { claude:'<id1>', codex:'<id2>' }`
    - Re-authing the same agent (same user, same hostname) returns the SAME two rootless session ids (idempotent — partial unique index from Plan 001 enforces this)
    - An agent auth with both `project_dir:'/repo'` AND `rootless_sessions:['claude']` resolves the project session via findOrCreateAgentSession (using `cli_kind` if provided) AND attaches the rootless claude row; auth_ok.session_id = project session id, auth_ok.rootless_session_ids.claude = ambient row id
  </behavior>
  <action>
    In `hub/src/api/sessions.ts`:
    - Extend `CreateSessionBody` Zod schema: add `cli_kind: z.enum(['claude','codex']).optional()`.
    - In the POST handler, pass `parsed.data.cli_kind ?? 'claude'` to `createSession` (per Plan 001's extended signature). Return the row as-is — `createSession` already returns cli_kind from the RETURNING clause.

    In `hub/src/ws/channel.ts` agent auth handler:
    - After the existing api-key validation, branch on the auth payload:
      a. If `project_dir` is present → call `findOrCreateAgentSession` (existing path), but pass the new `cli_kind` arg (default 'claude') so the row created for a fresh project_dir is pinned to the requested CLI. If the row already exists with a different cli_kind, KEEP the existing cli_kind (don't mutate) and emit an `agent_log` warning back: "Session pinned to <existing cli_kind>; ignoring agent's requested <new cli_kind>".
      b. If `rootless_sessions` is non-empty → for each CLI in the array, call `findOrCreateRootlessSession(userId, hostname, cliKind, generateToken(), `<CLI> (ambient — ${hostname})`)`. Collect the ids into `rootless_session_ids` object.
    - Build the `auth_ok` payload: `{ type:'auth_ok', session_id: <project session id or, when only rootless, the first rootless id>, cli_kind: <of that primary session>, rootless_session_ids: {...}, system_prompt: <existing path>, seed_files: [] /* Plan 005 fills */ }`.
    - When `project_dir` is omitted, `hostname` MUST be present — reject with `{ type:'auth_error', error:'hostname required for rootless-only agent' }` if absent.

    Token generation for new rootless rows uses `generateToken('remo_')` then `hashToken(...)` — same as the existing project-session create path. Do NOT reuse the agent's api-key as the session token.
  </action>
  <verify>
    <automated>cd hub; bun run tsc --noEmit -p . ; bun test test/api/sessions.test.ts test/ws/channel.test.ts 2>$null</automated>
    Manual: `curl -X POST localhost:3040/api/sessions -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" -d '{"name":"x","cli_kind":"codex"}'` returns 201 with `"cli_kind":"codex"`. Same with `"cli_kind":"gemini"` returns 400. Connect a fake agent via WS with `rootless_sessions:['claude','codex']` and observe two rows created in `SELECT id, cli_kind, is_rootless, hostname FROM sessions WHERE hostname='host-a'`.
  </verify>
  <done>
    REST accepts and round-trips cli_kind. Agent auth with rootless_sessions creates idempotent ambient rows scoped to (user, hostname, cli_kind). auth_ok carries cli_kind + rootless_session_ids. Legacy agents (no cli_kind, no rootless) continue to work unchanged.
  </done>
</task>

</tasks>

<verification>
- Zod: AgentAuth + CreateSessionBody accept cli_kind, reject unknown values
- Outbound types: HubToAgent.auth_ok includes cli_kind + rootless_session_ids; session_list rows include cli_kind, is_rootless, hostname
- Idempotency: re-auth same agent twice → same rootless ids; SELECT count from sessions does not grow
- Backward compat: existing agent without cli_kind/rootless_sessions still authenticates and gets its project session
</verification>

<success_criteria>
Protocol surface is ready for Plan 003 to call: agent reads `auth_ok.cli_kind` → spawns the right runner. Plan 005 will read `auth_ok.rootless_session_ids` to know which ambient subscriptions to offer in the sidebar.
</success_criteria>

<output>
Create `.planning/phases/05-codex-cli-and-rootless-sessions/05-02-SUMMARY.md` when done
</output>
