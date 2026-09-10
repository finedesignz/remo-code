# Phase 09 — Retire npm Packages: Inventory

## 0. Critical Risk Summary (Read First)

| Risk | Severity | Detail |
|------|----------|--------|
| `/ws/agent` is SHARED | HIGH | Both the npm `remo-code-agent` package AND the Tauri supervisor connect to `/ws/agent`. Do NOT delete `hub/src/ws/agent.ts` or its hub routing. |
| `supervisor/src/` is Tauri sidecar source | HIGH | The Tauri MSI bundles `supervisor/src/index.ts` compiled via `bun build --compile`. Deleting `supervisor/src/` breaks the Tauri build. Retire only the npm publishing surface. |
| `agent/src/` is independent of `supervisor/src/` | CONFIRMED SAFE | No imports from `agent/src/` found in `supervisor/src/`. Deleting `agent/` entirely is safe. |
| `channel/` source already gone from disk | INFO | Only hub-side remnants remain; safe to clean up independently. |

## 1. Package Directories

### 1a. `agent/` — `remo-code-agent` v0.4.1 — **DELETE ENTIRELY**
- `agent/package.json`, `agent/tsconfig.json`
- `agent/src/{index,hub-client,config,cli-runner,claude-runner,codex-runner,codex-jsonrpc,seed,local-ui,types,usage-poller}.ts`
- `agent/test/{codex-jsonrpc,codex-runner,seed,usage-poller}.test.ts`

### 1b. `supervisor/` root — `remo-code-supervisor` v0.3.1 — **PARTIAL**
- DELETE: `supervisor/package.json`, `supervisor/README.md`
- KEEP: all of `supervisor/src/` (Tauri sidecar source)
- Remove `"supervisor"` from root `package.json` workspaces

### 1c. `channel/` — already deleted from disk
Only hub-side remnants to clean.

## 2. Workspace + Lockfile
Root `package.json` workspaces: drop `"agent"` and `"supervisor"`. `bun.lockb` regenerates.

## 3. Hub-Side
- DELETE: `hub/src/ws/channel.ts`
- EDIT `hub/src/index.ts`: drop channel imports (lines 47-49), `/ws/channel` upgrade check (285), wsData branch (306-307), open/message/close dispatchers (373, 380, 388)
- EDIT `hub/src/ws/protocol.ts` (3-28): drop `ChannelAuth`/`AssistantMessage`/`ChannelStatus`/`ChannelInbound`
- EDIT `hub/src/db/dal.ts` (860-865): drop `verifyChannelToken`
- KEEP `hub/src/ws/agent.ts` (shared with Tauri)
- No DB tables to drop

## 4. Documentation References
README.md, CLAUDE.md, AGENTS.md, docs/agent.md (DELETE), docs/HANDOFF.md, supervisor/README.md (DELETE),
.planning/codebase/{ARCHITECTURE,INTEGRATIONS,STRUCTURE,STACK}.md, .planning/STATE.md, .planning/REQUIREMENTS.md,
.planning/ROADMAP.md, .planning/debug/cannot-connect-new-servers.md, .planning/phases/05-*/*, .planning/phases/06-*/*,
.planning/phases/07-titanium-auth-cutover/TEST-MATRIX.md, .planning/phases/08-github-session-keying/ARCHITECTURE.md (mention update),
.planning/phases/merge-self-heal/RESEARCH.md, docs/superpowers/specs/*, docs/superpowers/plans/*

## 5. Web UI References (display strings only)
- web/src/components/ConnectModal.tsx (lines 18, 20, 21, 122, 134)
- web/src/components/ApiKeyModal.tsx (35, 37)
- web/src/components/SettingsPage.tsx (410, 412)
- web/src/components/SupervisorPage.tsx (399)
- web/src/components/CommandsList.tsx (48)
- web/src/components/Sidebar.tsx (229, 244 — `title` attrs)

Replace with: link to Tauri MSI release at `https://github.com/finedesignz/remo-code/releases/latest`.

## 6. Tests
Only `agent/test/*` to delete with `agent/`. No supervisor/channel tests. No hub tests reference these.

## 7. CI / Release Workflows
- DELETE `.github/workflows/publish-agent.yml`
- DELETE `.github/workflows/publish-supervisor.yml`
- KEEP `.github/workflows/release-supervisor.yml` (Tauri MSI)
- KEEP `.github/workflows/docs-drift.yml`
- After delete: `npm deprecate remo-code-agent@"*" "Retired. Use the Remo Code Supervisor desktop app: https://github.com/finedesignz/remo-code/releases"` and same for `remo-code-supervisor`.

## 8. External npm Package State
Local versions: agent v0.4.1, supervisor v0.3.1. Confirm via `npm view <pkg> version` before deprecating.

## 9. Memory Files
Update under `~/.claude/projects/C--Users-artic-GitHub-remo-code/memory/`:
- `feedback_claude_remote_default.md` — rewrite to Tauri-first
- `reference_remo_code_connection.md` — rewrite to Tauri-only
- `MEMORY.md` — fix entries for above
- `feedback_run_things_yourself.md` — drop npm publish line
- `reference_deployment_infra.md` — drop agent-as-npm line
- `project_handoff_supervisor_ws_close.md` — stale, low priority

Plus `~/.claude/CLAUDE.md` global "Remo Code" section.

## 10. Risk Callouts
- HIGH: `supervisor/src/` is Tauri sidecar — keep.
- HIGH: `/ws/agent` is shared — keep.
- CONFIRMED SAFE: `agent/` deletion (no cross-imports).
- LOW: External users still on `npx remo-code-agent` keep working until `/ws/agent` is removed (won't be).
- LOW: `channel/` cleanup is independent and risk-free.
