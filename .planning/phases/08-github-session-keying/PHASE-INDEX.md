# Phase 08 — GitHub-Backed Session Keying — Plan Index

Source design: [`ARCHITECTURE.md`](./ARCHITECTURE.md). All plans implement that doc literally — no re-design.

## Wave grouping

| Wave | Plan | Depends on | Est. min |
|------|------|------------|----------|
| 1 | [`08-PLAN-001-schema-and-introspection`](./08-PLAN-001-schema-and-introspection.md) | — | 90 |
| 2 | [`08-PLAN-002-hub-session-resolution`](./08-PLAN-002-hub-session-resolution.md) | 001 | 120 |
| 2 | [`08-PLAN-003-supervisor-inventory`](./08-PLAN-003-supervisor-inventory.md) | 001 | 150 |
| 3 | [`08-PLAN-004-rest-endpoints`](./08-PLAN-004-rest-endpoints.md) | 002, 003 | 90 |
| 3 | [`08-PLAN-005-launch-and-create-github`](./08-PLAN-005-launch-and-create-github.md) | 002, 003 | 240 |
| 4 | [`08-PLAN-006-frontend-docs-e2e`](./08-PLAN-006-frontend-docs-e2e.md) | 004, 005 | 180 |

**Total est.:** ~870 min (~14.5 hours focused work; ARCHITECTURE §13 estimates 4–5 dev-days end-to-end).

## Why this DAG

- **Wave 1** is the only true foundation: schema migration + the pure git-introspection module. Everything else depends on the data shape it defines.
- **Wave 2** splits along ownership: hub-side DAL/WS (`002`) and supervisor-side scan/inventory (`003`) touch disjoint codebases and can be implemented in parallel. Both consume the schema + introspection from Wave 1.
- **Wave 3** is the user-facing API surface. REST endpoints (`004`) and the Launch / Create-on-GitHub flows (`005`) both need the resolved session shape from Wave 2 and the supervisor inventory pipeline. They're disjoint (`004` is read endpoints + dismiss; `005` is the launch + repo-creation orchestration) and can run in parallel.
- **Wave 4** is the integration layer: web UI consumes everything, Storybook stories per global rule #21, docs per global rule #14, end-to-end test that asserts the §11 scenarios all the way through. Single plan, single PR.

## Plan summaries

### 08-PLAN-001 — Schema + shared git introspection (Wave 1)
Additive ALTERs on `sessions`, two new tables (`dismissed_local_sessions`, `pending_local_repos`), partial unique index `idx_sessions_user_repo_key`. Pure `git-introspect.ts` module with `spawnSync` (no shell), `parseGitRemote` + `buildRepoKey`. Full unit coverage of URL parsing and worktree detection.

### 08-PLAN-002 — Hub session resolution + WS auth frame (Wave 2)
`findOrCreateAgentSessionV2` implements ARCHITECTURE §4 priority-1/2/3 in one transaction with `FOR UPDATE` + `ON CONFLICT … DO UPDATE`. `AgentAuth` gets optional `git` field (back-compat). `/ws/agent` handler swaps to v2.

### 08-PLAN-003 — Tauri supervisor roots + scan + inventory (Wave 2)
`supervisor.json` config (platform-resolved path), `scanRoots` with `max_depth` + `ignore_globs`, `RepoEntry` grouping with canonical-path preference. New `SupervisorRepoInventory` WS message dispatched to `findOrCreateAgentSessionV2`. Settings → Roots panel in the Tauri UI.

### 08-PLAN-004 — REST: pending-prompts + dismiss-local (Wave 3)
`GET /api/sessions/pending-prompts` + `POST /api/sessions/dismiss-local`. `CodeSession` API shape gains `repo_key` / `github_owner` / `github_repo`. OpenAPI-decorated, docs/api.md regenerated.

### 08-PLAN-005 — Launch-on-demand + Create-on-GitHub (Wave 3)
`POST /api/sessions/:id/launch`, `POST /api/sessions/:id/clone-here`, `POST /api/sessions/:id/create-github-repo`. Ports `claude-runner.ts` + `codex-runner.ts` into the supervisor sidecar (the agent-CLI retirement). GitHub App scope probe via the gateway pair — never reaches for a `GITHUB_TOKEN` env var. In-memory job state with `repo_create_progress` WS events.

### 08-PLAN-006 — Frontend + Storybook + docs + E2E (Wave 4)
Sidebar "NEEDS ATTENTION" section, Launch / Clone buttons, `<CreateGithubRepoModal>` with live progress + scope-missing tooltip, SessionTooltip updates. Storybook stories per global rule #21. `docs/github-session-keying.md` deep-dive, README + CLAUDE.md updates, agent CLI deprecation banner. E2E test asserting two worktrees collapse to one session row.

## Constraints honored

- **No re-design.** Algorithm, schema, message shapes, edge cases, threat model — all sourced from ARCHITECTURE.md verbatim.
- **Tauri-only runner model.** Plan 005 ports the runners into the supervisor sidecar; agent CLI keeps working for one release with a deprecation banner (per ARCHITECTURE §17).
- **Schema migrations stay plain.** No `DO $$ ... $$` blocks needed — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` cover every change. (The PR #63 parser supports DO blocks now; we just don't need them here.)
- **Gateway-pair for GitHub creds.** No new env vars on the hub. Reuses the pattern in `hub/src/scheduler/post-run/github-issue.ts`.
- **Plan format mirrors Phase 06.** YAML frontmatter shape, `<task>` blocks, files-to-create/edit, verification commands.
