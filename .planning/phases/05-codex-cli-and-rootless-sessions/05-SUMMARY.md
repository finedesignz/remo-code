# Phase 05 — Codex CLI + Rootless Ambient Sessions — Summary

**Status:** ~85% shipped on `feat/scheduler-enhancements`. Hub + agent + protocol + docs landed. Web UI surface needs re-application (drafted, reverted by concurrent commits — see Risks).

## What landed (commits, in order)

| Plan | Commit | Scope |
|---|---|---|
| 05-01 schema | `e059411` | `sessions.cli_kind`/`is_rootless`/`hostname` + partial unique index |
| 05-01 DAL | `4972413` | `findOrCreateRootlessSession`, extended `createSession` |
| 05-01 summary | `7efc78a` | `05-01-SUMMARY.md` |
| 05-02 protocol | `1c701a4` | Zod schemas + outbound types (auth_ok, session_list rows) |
| Plan files | `02749ed` | Five `05-PLAN-*.md` committed (were untracked, lost during branch chaos) |
| 05-03 runner abstraction | `8c836bb` | `CliRunner` interface; per-session runner map; per-CLI preflight; Codex stub |
| 05-04 Codex runner | `00f5626` | `CodexRunner` + `JsonRpcClient`; event mapping per research §1.3 |
| 05-05 hub+agent | `595ef58` | `users.*_md` columns; `getUserInstructions`/`updateUserInstructions`; `GET/PUT /api/instructions`; `auth_ok.seed_files`; `agent/src/seed.ts` |

## What's NOT yet committed

1. **Web UI** — `Sidebar` CLI/ambient badges, `SettingsPage` Instructions tab, `useSessions` extended `CodeSession` type. Edits were drafted and applied in-session but reverted by concurrent agent commits on the same branch (`feat/scheduler-enhancements`). Plumbing API exists; UI is the gap.
2. **README + project CLAUDE.md** — Phase 05 section. Skipped under chaos; `docs/codex-and-rootless.md` is the canonical reference.
3. **Tests** — Plan 004 specifies a fixture-based `codex-runner.test.ts`; Plan 005 specifies `seed.test.ts` and `instructions.test.ts`. None written. Pure functions (`translate`, `readFrames`, `writeSeedFiles`, `sanitizeToml`) are unit-test-ready by design.

## Spike outcomes

- **A1 (framing):** Not verified live. JsonRpcClient auto-detects ndjson vs LSP on the first non-whitespace byte from stdout. Both branches functional.
- **A2 (event names):** Implemented exactly per research §1.3 — `item/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, `approval/required`, `error`. Verify and adjust on first live integration.
- **A3 (`--cd` flag):** Belt-and-suspenders — runner sets both `cwd` (process spawn) and `--cd <dir>` arg. If `--cd` is unsupported, the `cwd` still applies.

## Architecture deviations from plan

- **Plan 002 file target:** plan named `hub/src/ws/channel.ts` as the agent auth handler location; actual hub uses `hub/src/ws/agent.ts` (channel.ts is the legacy plugin path with a different protocol). Edits applied to `agent.ts`.
- **`.refine()` invariant on AgentAuth:** kept off the Zod schema to preserve `discriminatedUnion` usage; invariant (project_dir OR rootless_sessions required, hostname required when rootless-only) enforced post-parse in `agent.ts`.
- **DAL `updateUserInstructions`:** dynamic SET clause implemented as a sequence of single-column UPDATEs because `postgres.js` does not support arbitrary identifier interpolation. Three columns → at most three round-trips per PUT. Acceptable.

## Risks / follow-ups

1. **Concurrent branch chaos.** Multiple agent sessions edited and reset this branch during execution; one prior executor's commits were destroyed by a hard reset. The `feat/scheduler-enhancements` branch carries Phase 05 commits interleaved with unrelated scheduler/chat work. Recommend: cherry-pick the eight commits above onto a fresh `feat/phase-05-codex-rootless` branch before merging to main.
2. **Codex live verification.** Nothing tested against a real `codex app-server`. First end-to-end use should be done by a developer with `codex` installed and `OPENAI_API_KEY` set; expect to adjust 1-3 method names or payload field names.
3. **Migration safety on prod hub.** The schema migration is fully idempotent (`ADD COLUMN IF NOT EXISTS`, `DO $$ ... IF NOT EXISTS` for the CHECK constraint, `CREATE UNIQUE INDEX IF NOT EXISTS`). Safe to re-run.
4. **Image attachments to Codex:** unsupported in this iteration — emitter sends an `agent_log` warning and drops the images. Codex protocol does not currently expose a documented image path.

## End-to-end demo (when web UI lands)

1. Set `OPENAI_API_KEY` in agent env (or run `codex login`).
2. Restart `claude-remote`. Agent advertises `rootless_sessions: ['claude', 'codex']`.
3. Hub creates two ambient session rows; agent receives them in `auth_ok.rootless_session_ids`.
4. User edits Settings → Instructions → fills `claude_global_md`. Saves.
5. Restart agent on a fresh tempdir HOME. `~/.claude/CLAUDE.md` is written.
6. From the web UI, switch to the Codex ambient row. Type "say hi". `text_delta` events stream into the existing chat surface.
