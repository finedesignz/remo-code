---
phase: 05-codex-cli-and-rootless-sessions
plan: 05
type: execute
wave: 3
depends_on:
  - 05-02
  - 05-04
files_modified:
  - hub/src/db/schema.sql
  - hub/src/db/dal.ts
  - hub/src/api/instructions.ts
  - hub/src/index.ts
  - hub/src/ws/channel.ts
  - hub/src/ws/protocol.ts
  - agent/src/index.ts
  - agent/src/seed.ts
  - web/src/components/Sidebar.tsx
  - web/src/components/SessionList.tsx
  - web/src/components/NewSessionDialog.tsx
  - web/src/components/SettingsPage.tsx
  - README.md
  - CLAUDE.md
  - docs/codex-and-rootless.md
autonomous: true
requirements:
  - P05-AMBIENT-UI
  - P05-INSTRUCTIONS-SEED
  - P05-DOCS
must_haves:
  truths:
    - "Sidebar shows an 'Ambient' group at the top with one Claude row and one Codex row per connected hostname"
    - "Ambient rows are visible without project filter; clicking opens the same chat surface as project sessions"
    - "First user_message to an ambient session lazily spawns the runner in ~/.remo-code/rootless/{claude|codex}/"
    - "New Session dialog has a CLI picker (Claude/Codex) that sets cli_kind on POST /api/sessions"
    - "Session rows in the sidebar render a small badge ('claude' or 'codex') matching their cli_kind"
    - "Users table has claude_global_md, codex_agents_md, codex_config_toml TEXT columns"
    - "GET/PUT /api/instructions reads/writes the three blobs scoped to the authenticated user"
    - "auth_ok includes seed_files[] derived from the user's three blobs (only those that are non-empty)"
    - "Agent on auth_ok writes each seed file with mode='create_if_absent' ONLY if the local path does not exist; never overwrites"
    - "When a local file exists with a sha256 differing from the hub's, agent emits agent_log warning and leaves the file alone"
    - "Settings page has an Instructions tab with three textareas + Save; the values round-trip through the API"
    - "README documents Codex install + rootless behavior; docs/codex-and-rootless.md gives the full architecture"
  artifacts:
    - path: "hub/src/api/instructions.ts"
      provides: "GET/PUT /api/instructions for user-scoped instruction blobs"
    - path: "agent/src/seed.ts"
      provides: "writeSeedFiles(files[]) — create-if-absent with sha256 drift detection"
    - path: "docs/codex-and-rootless.md"
      provides: "Phase 05 architecture doc"
    - path: "web/src/components/Sidebar.tsx"
      provides: "Ambient group rendering + CLI badges"
  key_links:
    - from: "agent/src/index.ts handleMessage(auth_ok)"
      to: "agent/src/seed.ts writeSeedFiles"
      via: "msg.seed_files passed through verbatim"
      pattern: "writeSeedFiles\\(msg.seed_files"
    - from: "web/src/components/SettingsPage.tsx"
      to: "PUT /api/instructions"
      via: "fetch with credentials"
      pattern: "/api/instructions"
    - from: "hub/src/ws/channel.ts agent auth"
      to: "user.claude_global_md / codex_agents_md / codex_config_toml"
      via: "build seed_files array per the agent's cli_kind + rootless_sessions"
      pattern: "seed_files"
---

<objective>
Ship the UX and persistence layer for Phase 05:
1. Ambient sessions visible in the sidebar (one Claude + one Codex per host, always-present, lazy-spawn).
2. CLI picker in the new-session dialog + CLI badges on session rows.
3. Hub-stored user instructions (CLAUDE.md, AGENTS.md, codex config) that the agent pulls on auth and writes to disk only if absent.
4. Documentation updates (README + CLAUDE.md + new docs/codex-and-rootless.md).

Purpose: Closes Phase 05's user-facing surface. After this plan, a user can install the agent on a fresh machine and within seconds have their personalized Claude + Codex setup mirrored from the hub, with both ambient and project sessions ready to chat.

Output: Working end-to-end Phase 05 — schema, protocol, runners, UI, persistence, docs all in place.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-RESEARCH.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-02-SUMMARY.md
@.planning/phases/05-codex-cli-and-rootless-sessions/05-04-SUMMARY.md
@hub/src/index.ts
@hub/src/ws/channel.ts
@hub/src/ws/protocol.ts
@hub/src/api/sessions.ts
@hub/src/db/dal.ts
@hub/src/db/schema.sql
@agent/src/index.ts
@web/src/components/SettingsPage.tsx
@CLAUDE.md
@README.md

<interfaces>
From Plan 002:
- `auth_ok` payload has `seed_files?: unknown[]` (typed as unknown — this plan refines the type)
- `auth_ok.rootless_session_ids?: { claude?: string; codex?: string }`
- `session_list` rows include cli_kind, is_rootless, hostname

From Plan 003/004:
- Agent has per-session runner map keyed by session_id; rootless runners are LAZY (start on first user_message)

Existing global design tokens (per global CLAUDE.md frontend conventions):
- `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--text-muted`, `--border-color`
- Indigo accent for primary; `rounded-xl` cards / `rounded-lg` inputs
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Hub — instructions schema, REST, seed_files in auth_ok</name>
  <files>hub/src/db/schema.sql, hub/src/db/dal.ts, hub/src/api/instructions.ts, hub/src/index.ts, hub/src/ws/channel.ts, hub/src/ws/protocol.ts</files>
  <read_first>
    - hub/src/db/schema.sql (users table — observe existing ALTER pattern at line 54 for system_prompt; mirror it)
    - hub/src/db/dal.ts (locate getUserById or equivalent; if absent, add a small `getUserInstructions(userId)` helper)
    - hub/src/index.ts (route registration — observe how `sessions` router is mounted; mount `instructions` the same way)
    - hub/src/ws/channel.ts (the agent auth handler updated in Plan 002 — extend it to compute seed_files)
    - hub/src/ws/protocol.ts (HubToAgent.auth_ok shape from Plan 002 — refine seed_files type)
  </read_first>
  <behavior>
    - `users.claude_global_md`, `users.codex_agents_md`, `users.codex_config_toml` exist as TEXT columns, nullable, no default (NULL = "user hasn't set anything yet")
    - `GET /api/instructions` (authed) returns `{ claude_global_md, codex_agents_md, codex_config_toml }` (each possibly null)
    - `PUT /api/instructions` accepts the same three fields, each `z.string().max(100_000).nullable().optional()`; only provided keys are updated. Returns the updated row.
    - On agent auth_ok, hub computes `seed_files` based on which CLIs the agent will host:
      - If hosting Claude (project session with cli_kind='claude' OR rootless 'claude'): include `{ path: '~/.claude/CLAUDE.md', content: user.claude_global_md, sha256: <hex>, mode: 'create_if_absent' }` (only if `claude_global_md` is non-empty)
      - If hosting Codex: include `~/.codex/AGENTS.md` from `codex_agents_md` and `~/.codex/config.toml` from `codex_config_toml` (each only if non-empty)
    - The refined `seed_files` type in protocol.ts is `Array<{ path: string; content: string; sha256: string; mode: 'create_if_absent' | 'sync_if_unchanged' }>`
    - All three blobs are scoped strictly to the authenticated user — no cross-user reads
  </behavior>
  <action>
    `hub/src/db/schema.sql` — add (idempotent):
    ```
    ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_global_md TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS codex_agents_md TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS codex_config_toml TEXT;
    ```
    Add a comment block: "User-scoped instruction blobs synced to agents via auth_ok.seed_files (create_if_absent). NEVER include API keys or auth tokens — sanitize codex_config_toml on write."

    `hub/src/db/dal.ts` — add:
    - `getUserInstructions(userId): Promise<{ claude_global_md: string|null; codex_agents_md: string|null; codex_config_toml: string|null }>`
    - `updateUserInstructions(userId, patch: Partial<...>): Promise<...>` (dynamic SET clause, only update keys present in patch)

    `hub/src/api/instructions.ts` — new Hono router:
    ```ts
    instructions.get('/', async (c) => c.json(await getUserInstructions(c.get('userId'))))
    instructions.put('/', async (c) => {
      const body = PutBody.safeParse(await c.req.json())
      if (!body.success) return c.json({ error: 'invalid input' }, 400)
      // Strip secrets from codex_config_toml: warn-and-remove any line matching `(?i)^(api[_-]?key|token|secret|password)\s*=`.
      // (Use a simple regex pre-pass. Document the allowlist for future hardening.)
      return c.json(await updateUserInstructions(c.get('userId'), body.data))
    })
    ```
    Where `PutBody = z.object({ claude_global_md: z.string().max(100_000).nullable().optional(), codex_agents_md: z.string().max(100_000).nullable().optional(), codex_config_toml: z.string().max(100_000).nullable().optional() })`.

    `hub/src/index.ts` — mount `app.route('/api/instructions', instructions)` next to the sessions router. Apply the same auth middleware.

    `hub/src/ws/protocol.ts` — replace `seed_files?: unknown[]` on auth_ok with the refined typed shape above.

    `hub/src/ws/channel.ts` — after building the auth_ok payload (Plan 002 added `cli_kind` + `rootless_session_ids`), compute `seed_files`:
    - `const cliKinds = new Set<'claude'|'codex'>()`; add the project session's cli_kind (if any) + every rootless cli kind requested.
    - `const inst = await getUserInstructions(userId)`.
    - Walk a static map `[{cliKind:'claude', path:'~/.claude/CLAUDE.md', blob: inst.claude_global_md}, {cliKind:'codex', path:'~/.codex/AGENTS.md', blob: inst.codex_agents_md}, {cliKind:'codex', path:'~/.codex/config.toml', blob: inst.codex_config_toml}]` → keep entries where `cliKinds.has(cliKind) && blob` → compute `sha256` via `crypto.createHash('sha256').update(blob).digest('hex')` → push to seed_files with `mode:'create_if_absent'`.
    - Attach to auth_ok.

    Add unit tests in `hub/test/api/instructions.test.ts` (PUT then GET round-trip, secret-stripping regex catches `api_key=`, oversize body rejected with 400).
  </action>
  <verify>
    <automated>cd hub; bun run tsc --noEmit -p . ; bun test test/api/instructions.test.ts 2>$null ; bun run -e "import('./src/db/migrate.ts').then(m => m.migrate()).then(() => console.log('OK'))"</automated>
    Manual: `curl -X PUT localhost:3040/api/instructions -H 'Authorization: Bearer <jwt>' -H 'Content-Type: application/json' -d '{"claude_global_md":"# Test"}'` then `curl localhost:3040/api/instructions` returns the value. Connect an agent: log auth_ok payload → seed_files has the Claude entry with correct sha256.
  </verify>
  <done>
    Schema migrated, REST endpoints work, secret-stripping in place, auth_ok carries computed seed_files keyed to the agent's hosted CLIs.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Agent — seed.ts writer with create_if_absent + sha drift warning</name>
  <files>agent/src/seed.ts, agent/src/index.ts, agent/test/seed.test.ts</files>
  <read_first>
    - agent/src/index.ts (handleMessage auth_ok — where to call writeSeedFiles; after `sendLog` greeting)
    - hub/src/ws/protocol.ts (the refined seed_files type — keep agent + hub in sync; ideally agent imports the type from a shared module or duplicates the type literal with a comment "MUST MATCH hub/src/ws/protocol.ts")
  </read_first>
  <behavior>
    - `writeSeedFiles(files, emitLog)` is pure-ish: takes the typed array + a logger callback, performs disk writes, never throws (catches per-file errors and reports via emitLog)
    - `~` in `path` is expanded to `os.homedir()`; parent directories created with `fs.mkdirSync(dir, { recursive: true })`
    - `mode:'create_if_absent'`: if file exists (any content) → leave alone; if local sha differs from hub's sha, emit `agent_log` warning: "Local <path> differs from hub version — keep local. Visit Settings → Instructions to reconcile."; if file does NOT exist → write and emit "Seeded <path> from hub"
    - `mode:'sync_if_unchanged'`: not used yet — implement as "if file does not exist, write; if file exists AND local sha matches the hub's prior sha (we don't track that yet locally, so treat as 'leave alone' + warn)". Document the limitation.
    - NEVER overwrite a file. Period. (Karpathy-aligned: smallest correct behavior.)
    - On auth_ok, agent calls `writeSeedFiles(msg.seed_files ?? [], sendLog)` before starting runners
  </behavior>
  <action>
    Create `agent/src/seed.ts`:
    ```ts
    import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
    import { createHash } from 'crypto'
    import { homedir } from 'os'
    import { dirname, resolve } from 'path'

    export type SeedFile = {
      path: string  // may start with ~
      content: string
      sha256: string
      mode: 'create_if_absent' | 'sync_if_unchanged'
    }

    function expand(p: string): string {
      if (p.startsWith('~/') || p === '~') return resolve(homedir(), p.slice(2))
      return resolve(p)
    }
    function sha(s: string): string {
      return createHash('sha256').update(s).digest('hex')
    }

    export function writeSeedFiles(files: SeedFile[], log: (msg: string) => void): void {
      for (const f of files) {
        try {
          const abs = expand(f.path)
          if (!existsSync(abs)) {
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, f.content, { encoding: 'utf8' })
            log(`Seeded ${f.path} from hub (${f.content.length} bytes)`)
            continue
          }
          // File exists — never overwrite.
          const localSha = sha(readFileSync(abs, 'utf8'))
          if (localSha !== f.sha256) {
            log(`Local ${f.path} differs from hub version — keeping local. Reconcile in Settings → Instructions.`)
          }
          // else: identical, silent no-op
        } catch (e: any) {
          log(`Failed to seed ${f.path}: ${e?.message ?? String(e)}`)
        }
      }
    }
    ```

    In `agent/src/index.ts` handleMessage `auth_ok` case (which Plan 003 restructured): after the greeting log, before runner starts, call `writeSeedFiles((msg as any).seed_files ?? [], sendLog)`. Import from `./seed`. Type-narrow `msg.seed_files` against the local SeedFile type.

    Create `agent/test/seed.test.ts` with tests:
    - Writes when absent (tempdir; assert file content matches; assert log starts with "Seeded")
    - Does NOT overwrite when present with same sha (no log emitted)
    - Does NOT overwrite when present with different sha (log starts with "Local ... differs")
    - Tilde expansion: `~/x.md` resolves under `os.homedir()`
    - Per-file error isolation: bad path doesn't abort the loop
  </action>
  <verify>
    <automated>cd agent; bun test test/seed.test.ts ; bun run tsc --noEmit -p .</automated>
    Manual: set `claude_global_md` in hub for a user, restart agent on a fresh tempdir HOME → file appears at `~/.claude/CLAUDE.md`; restart again with a modified local file → agent_log "Local ~/.claude/CLAUDE.md differs from hub version" visible in web UI.
  </verify>
  <done>
    Seed writer is safe (never overwrites), tested, wired into the auth_ok flow.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Web — Ambient sidebar group, CLI picker dialog, CLI badges, Instructions settings tab</name>
  <files>web/src/components/Sidebar.tsx, web/src/components/SessionList.tsx, web/src/components/NewSessionDialog.tsx, web/src/components/SettingsPage.tsx</files>
  <read_first>
    - web/src/components/SessionList.tsx (current row rendering — preserve hover/active styling)
    - web/src/components/Sidebar.tsx (current grouping if any — note where to inject the Ambient group)
    - web/src/components/NewSessionDialog.tsx (current form fields — add the picker)
    - web/src/components/SettingsPage.tsx (canonical visual reference per global CLAUDE.md — mirror its card/tab structure for the new Instructions tab)
  </read_first>
  <behavior>
    - Sidebar renders an "Ambient" group at the top, sticky above project sessions, with a small heading "Ambient (this machine)" or "Ambient — <hostname>" when multiple agents are connected
    - Each ambient row shows: CLI icon/emoji + label "Claude" or "Codex", hostname suffix in muted text, status dot
    - Clicking an ambient row sets the active session_id exactly like clicking a project row — no separate render path
    - Project session rows render a small badge near the name: `claude` or `codex` (uppercase, rounded chip, indigo for codex, gray for claude to keep the existing visual baseline)
    - New Session dialog: adds a CLI radio group (default Claude) → POST body includes `cli_kind`
    - Settings page: new "Instructions" tab (sibling to existing tabs) with three labeled textareas (Claude global CLAUDE.md / Codex AGENTS.md / Codex config.toml) and a Save button that PUTs to `/api/instructions`. After save, toast "Saved — next agent reconnect will sync." Display character count under each textarea. Codex config.toml textarea has a small hint: "Secrets (api_key, token) are stripped on save."
    - Aesthetic rules from global CLAUDE.md: no heavy borders, `bg-[var(--bg-secondary)]/60` cards, `rounded-xl`, indigo accent for primary action, mute everywhere else
  </behavior>
  <action>
    Use existing styling primitives (no new design tokens). Reuse the session row component for ambient rows — pass a prop `kind: 'project' | 'ambient'` to switch the label/badge.

    `NewSessionDialog`: add a horizontal radio pair (two buttons styled as a segmented control) labeled Claude / Codex. State: `const [cliKind, setCliKind] = useState<'claude'|'codex'>('claude')`. Pass in the POST body.

    `Sidebar`: filter the session list into `ambient = sessions.filter(s => s.is_rootless)` and `project = sessions.filter(s => !s.is_rootless)`. Render ambient first under a small uppercase heading. If `ambient.length === 0` (agent hasn't connected yet), render two placeholder rows ("Claude (offline)" / "Codex (offline)") that are click-disabled with a tooltip "Connect an agent to enable ambient sessions" — keep the slot visible so the feature is discoverable.

    `SettingsPage`: add an "Instructions" tab. On mount: `fetch('/api/instructions')` → populate three textareas. Save handler: `fetch('/api/instructions', { method:'PUT', body: JSON.stringify({...}) })`. Use the existing card patterns (don't add ad-hoc borders/colors).

    No new dependencies. No CSS file additions — Tailwind utilities only.
  </action>
  <verify>
    <automated>cd web; bun run build ; bun run tsc --noEmit 2>$null</automated>
    Manual UX walkthrough:
    1. Open the web app — Ambient group appears at top of sidebar (placeholders if no agent connected yet)
    2. Run `claude-remote` — within ~5s the two ambient rows go online; click each, verify chat surface loads
    3. Click "+ New Session" — dialog has Claude/Codex segmented control; create one of each; sidebar shows badges
    4. Settings → Instructions: fill the three boxes, Save, reload page → values persist; restart agent → toast/log indicates files seeded
  </verify>
  <done>
    UI surfaces ship and obey the visual baseline. All four behavior bullets verifiable manually in one walkthrough.
  </done>
</task>

<task type="auto" tdd="false">
  <name>Task 4: Documentation — README, project CLAUDE.md, docs/codex-and-rootless.md</name>
  <files>README.md, CLAUDE.md, docs/codex-and-rootless.md</files>
  <read_first>
    - README.md (current structure — append, do not restructure)
    - CLAUDE.md (project-root — append a Phase 05 section under existing architecture notes)
  </read_first>
  <action>
    `docs/codex-and-rootless.md` — new file. Sections:
    - **Overview** — why Codex + ambient sessions exist; link to research
    - **Per-session CLI selection** — `cli_kind` column, picker UI, how to migrate an existing session (you don't — pinned at create time)
    - **Codex requirements** — `npm i -g @openai/codex`, `codex login` OR `OPENAI_API_KEY`; minimum version (note from Plan 004 spike)
    - **Codex protocol mapping** — table from research §1.3 (event ↔ RunnerEvent)
    - **Ambient sessions** — one Claude + one Codex per (user, hostname); working dir `~/.remo-code/rootless/{cli}/`; lazy-spawn on first message; partial unique index prevents duplicates
    - **Instructions sync** — three blobs on `users`; agent pulls via `auth_ok.seed_files`; `create_if_absent` semantics; drift warning; never overwrites
    - **Settings UI** — where to edit, secret stripping, char limit (100k per blob)
    - **Troubleshooting** — "Codex runner not starting" (run `codex --version`), "ambient session missing" (check hostname is set on agent), "my CLAUDE.md didn't sync" (it already existed — drift warning in agent_log)

    `README.md` — append a "Codex CLI Support" subsection under existing "Local Agent" docs: one paragraph + install snippet + link to `docs/codex-and-rootless.md`. Add a sentence to the architecture overview noting that the agent now hosts multiple CLI subprocesses (Claude + Codex + ambient).

    `CLAUDE.md` (project root) — append two short sections:
    - "Phase 05: Codex + ambient sessions" — pointer to docs/codex-and-rootless.md + a 3-line summary of cli_kind/is_rootless/seed_files
    - Update the "Architecture" diagram comment to mention "spawns Claude Code CLI **or** Codex CLI" and "may host N CLI subprocesses per agent (project + ambient)"

    Keep all docs concise — caveman tone per global CLAUDE.md rule #13. No marketing fluff.
  </action>
  <verify>
    <automated>cd .; ls docs/codex-and-rootless.md README.md CLAUDE.md ; grep -c "cli_kind" docs/codex-and-rootless.md</automated>
    All three files exist; `docs/codex-and-rootless.md` mentions `cli_kind`, `is_rootless`, `seed_files`, `create_if_absent` at least once each. README has a Codex CLI subsection. Project CLAUDE.md references docs/codex-and-rootless.md.
  </verify>
  <done>
    Docs reflect actual shipped behavior; a new contributor can read docs/codex-and-rootless.md and understand the Phase 05 architecture without spelunking code.
  </done>
</task>

</tasks>

<verification>
- Schema: `\d users` shows three new TEXT columns
- API: GET/PUT /api/instructions round-trip the three blobs; oversize/invalid bodies rejected
- Agent: connecting to a hub with non-empty instructions writes files only when absent; drift produces a warning
- UI: Ambient group renders; CLI picker present; CLI badges show on project rows; Settings → Instructions tab works
- Docs: README, project CLAUDE.md, docs/codex-and-rootless.md all present and referenced
</verification>

<success_criteria>
Phase 05 end-to-end demo: install agent fresh on a new machine, log in, agent auto-seeds CLAUDE.md/AGENTS.md, sidebar shows ambient Claude + Codex, user can chat with either, can also create a project session pinned to Codex, and edits to global instructions in Settings propagate on next reconnect.
</success_criteria>

<output>
Create `.planning/phases/05-codex-cli-and-rootless-sessions/05-05-SUMMARY.md` when done.
</output>
