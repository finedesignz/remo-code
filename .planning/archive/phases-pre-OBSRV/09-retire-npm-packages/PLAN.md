# Phase 09 — Retire Legacy npm Packages: Execution Plan

Five atomic phases, one commit per phase, executed on `chore/retire-npm-packages` worktree at `C:/Users/artic/GitHub/remo-code-retire-npm`. Canonical checkout HEAD is NOT touched. Tauri MSI desktop app is the only supported local app.

Reference: `.planning/phases/09-retire-npm-packages/INVENTORY.md`.

Release URL for all UI/doc replacements: `https://github.com/finedesignz/remo-code/releases/latest`.

---

## Phase A — Delete the `agent/` package

**Files (delete):**
- `agent/` (entire directory: `package.json`, `tsconfig.json`, `src/*.ts`, `test/*.test.ts`)
- `.github/workflows/publish-agent.yml`

**Files (edit):**
- `package.json` — remove `"agent"` from `workspaces`.

**Verification:**
- `bun install` (regenerates `bun.lockb` for the trimmed workspace).
- `cd hub && bun test` — must stay green; hub does not import from `agent/`.
- `bun run build:web` — must stay green; web does not import from `agent/`.

**Commit:** `chore: delete agent/ workspace and publish-agent CI`

---

## Phase B — Shrink `supervisor/` to Tauri sidecar source only

**Files (delete):**
- `supervisor/package.json`
- `supervisor/README.md`
- `.github/workflows/publish-supervisor.yml`

**Files (keep — Tauri MSI source):**
- All of `supervisor/src/` (bundled via `bun build --compile` by the Tauri build).
- `supervisor/tauri/` (Tauri app project — wraps the compiled sidecar).
- `supervisor/test/` (existing tests for sidecar source).

**Files (edit):**
- `package.json` — remove `"supervisor"` from `workspaces`.

**Verification:**
- `bun install` (regenerates `bun.lockb`).
- `cd hub && bun test`.
- `bun run build:web`.
- `ls supervisor/src/index.ts` — must still exist.
- `ls .github/workflows/release-supervisor.yml` — Tauri MSI release workflow must still exist.

**Commit:** `chore: drop supervisor npm publishing surface (keep Tauri sidecar)`

---

## Phase C — Delete dead channel code from hub

**Files (delete):**
- `hub/src/ws/channel.ts`

**Files (edit):**
- `hub/src/index.ts`:
  - Lines 47-49: remove `import { createChannelWsData, handleChannelOpen, handleChannelMessage, handleChannelClose } from './ws/channel'`.
  - Line 285: change `if (url.pathname === '/ws/channel' || url.pathname === '/ws/client' || url.pathname === '/ws/agent')` to `if (url.pathname === '/ws/client' || url.pathname === '/ws/agent')`.
  - Lines 306-307: remove the `else if (url.pathname === '/ws/channel')` branch.
  - Line 373: remove `else if (ws.data.type === 'channel') handleChannelOpen(...)` from open dispatcher.
  - Line 380: remove `else if (ws.data.type === 'channel') await handleChannelMessage(...)` from message dispatcher.
  - Line 388: remove `else if (ws.data.type === 'channel') handleChannelClose(...)` from close dispatcher.
- `hub/src/ws/protocol.ts`:
  - Lines 3-28: delete the `ChannelAuth`, `AssistantMessage`, `ChannelStatus`, `ChannelInbound` Zod schemas (the whole `// -- Channel <-> Hub --` block).
- `hub/src/db/dal.ts`:
  - Lines 860-865: delete the `// ── Channel token ──` section + `verifyChannelToken` function.

**Verification:**
- `cd hub && bun test` — must stay green (no hub test references the channel path).
- `cd hub && bunx tsc --noEmit` (or `bun run build` if present) — type-check passes.
- `bun run build:web` — must stay green.
- `grep -r "ws/channel\|verifyChannelToken\|ChannelInbound\|ChannelAuth\|ChannelStatus" hub/ web/` — returns nothing in `hub/src/` or `web/src/` (planning/docs hits are fine; handled in Phase D).

**Commit:** `chore(hub): remove dead /ws/channel route and verifyChannelToken`

---

## Phase D — Documentation + web UI sweep

**Files (delete):**
- `docs/agent.md`

**Files (edit — web UI, replace `npx remo-code-*` strings with Tauri MSI release link):**
- `web/src/components/ConnectModal.tsx` — make Tauri MSI download the primary path (lines 18, 20, 21, 122, 134); remove the npm `agentCmd`/`aliasCmd` block; remove the `npx remo-code-supervisor install` block; keep only the MSI download link.
- `web/src/components/ApiKeyModal.tsx` (lines 35, 37) — replace npm command strings with MSI release link copy.
- `web/src/components/SettingsPage.tsx` (lines 410, 412) — same.
- `web/src/components/SupervisorPage.tsx` (line 399) — replace `npx remo-code-supervisor install ...` block with MSI download instructions.
- `web/src/components/CommandsList.tsx` (line 48) — change "Run `remo-code-supervisor` on your machine" to "Install the Remo Code Supervisor desktop app".
- `web/src/components/Sidebar.tsx` (lines 229, 244) — drop "claude-remote" wording from `title` attrs; say "supervisor session".

**Files (edit — repo docs):**
- `README.md` — strip every npm-install/`npx`/`claude-remote` flow; document Tauri MSI as the only install path with the release URL; keep the architecture diagram (it stays accurate).
- `CLAUDE.md` — update the "Commands" section: drop `claude-remote` and `npx remo-code-agent` examples; reference the Tauri MSI; keep hub/web dev commands.
- `AGENTS.md` (if it documents agent/supervisor packages, update similarly).
- `docs/HANDOFF.md` — annotate that agent/supervisor npm packages are retired.
- `docs/scheduled-tasks.md`, `docs/codex-and-rootless.md`, `docs/grid-view.md`, `docs/coolify-webhook-migration.md`, `docs/error-capture.md`, `docs/self-heal-integration.md` — only edit if they reference `npx remo-code-agent`, `claude-remote`, or `npx remo-code-supervisor`; replace with "Tauri Supervisor app".
- `docs/auth.md` — same scan.
- `.planning/codebase/{ARCHITECTURE,INTEGRATIONS,STRUCTURE,STACK}.md`, `.planning/STATE.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/debug/cannot-connect-new-servers.md` — update narrative only; do not rewrite history.
- `.planning/phases/05-*/*`, `.planning/phases/06-*/*`, `.planning/phases/07-titanium-auth-cutover/TEST-MATRIX.md`, `.planning/phases/08-github-session-keying/ARCHITECTURE.md`, `.planning/phases/merge-self-heal/RESEARCH.md` — append a one-line "Note (Phase 09)" annotation rather than mutating prior plans.
- `docs/superpowers/specs/*`, `docs/superpowers/plans/*` — annotate, do NOT delete (these are historical specs).

**Verification:**
- `bun run build:web` — Vite build must pass (catches JSX/import regressions in the 6 edited components).
- `grep -rn "npx remo-code-agent\|npx remo-code-supervisor\|claude-remote" README.md CLAUDE.md AGENTS.md docs/ web/src/` — returns no results in shipped UI/docs (annotations under `.planning/` or `docs/superpowers/` are allowed and expected).
- `grep -rn "docs/agent.md" .` — returns no results.

**Commit:** `docs+web: retire npm-package install paths, link Tauri MSI release`

---

## Phase E — Memory + global CLAUDE.md sweep

**Files (rewrite — `~/.claude/projects/C--Users-artic-GitHub-remo-code/memory/`):**
- `feedback_claude_remote_default.md` — rewrite: "Always recommend the Tauri Supervisor desktop app. Don't suggest `npx remo-code-agent` or `claude-remote`."
- `reference_remo_code_connection.md` — rewrite: Tauri MSI release URL is the only install; describe sidecar architecture (`supervisor/src/index.ts` compiled into MSI); drop trusted-publishing/auto-restart npm notes.
- `MEMORY.md` — update the bullets that reference the two files above; remove or rewrite stale references.
- `feedback_run_things_yourself.md` — drop the "npm publish" example line; keep deploy/run-yourself directive.
- `reference_deployment_infra.md` — drop the "agent runs as `npx remo-code-agent`" line; replace with "supervisor runs as Tauri MSI desktop app".
- `project_handoff_supervisor_ws_close.md` — append "STALE — Phase 09 retired the npm supervisor; ws-close repro no longer reproducible against MSI."

**Files (edit — global):**
- `~/.claude/CLAUDE.md` — find the "## Remo Code" section; rewrite the `claude-remote` alias guidance to "Install the Remo Code Supervisor desktop app from https://github.com/finedesignz/remo-code/releases/latest". Drop the `claude-remote` shell-alias instructions and the `npx remo-code-agent` example.

**Verification (manual — no test gate, this is documentation outside the repo):**
- Open each updated file, eyeball for stale references to `npx remo-code-agent`, `claude-remote`, or `npm publish` of these packages.
- Confirm `~/.claude/CLAUDE.md` no longer instructs Claude to recommend npm.

**Commit:** none — memory files live outside the repo. Just update them in place after the worktree work is done.

---

## After all five phases

1. From the worktree: `git push -u origin chore/retire-npm-packages`.
2. `gh pr create --title "chore: retire legacy npm packages (claude-remote, remo-code-supervisor npm)" --body @PR-BODY.md` (body lists phases A–E + inventory path + v0.3.1 release link).
3. `gh pr merge --squash --admin --delete-branch`.
4. Wait for Coolify auto-deploy from `main`. Poll `curl -fsS https://app.remo-code.com/health` until `{"ok":true}` (or until 5 min elapsed).
5. `npm view remo-code-agent version` + `npm view remo-code-supervisor version`. If `npm whoami` succeeds, run:
   - `npm deprecate remo-code-agent@"*" "Retired. Use the Remo Code Supervisor desktop app: https://github.com/finedesignz/remo-code/releases"`
   - `npm deprecate remo-code-supervisor@"*" "Retired. Use the Remo Code Supervisor desktop app: https://github.com/finedesignz/remo-code/releases"`
   - If not authenticated, surface the exact commands in the final report.
6. Cleanup: `git -C C:/Users/artic/GitHub/remo-code worktree remove --force C:/Users/artic/GitHub/remo-code-retire-npm`.

## Hard constraints

- Do NOT touch the canonical checkout's HEAD (it is on `fix/coolify-webhook-unsigned`).
- Do NOT delete files outside the inventory.
- Do NOT introduce emojis.
- If any phase QC fails (test/build), STOP, fix, retry. Do NOT push broken work.
