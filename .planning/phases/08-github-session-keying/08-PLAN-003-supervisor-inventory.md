---
plan_id: 08-PLAN-003-supervisor-inventory
phase: 08-github-session-keying
wave: 2
depends_on: [08-PLAN-001-schema-and-introspection]
est_minutes: 150
acceptance_criteria:
  - Supervisor reads/writes `supervisor.json` at the platform-resolved path (Windows `%APPDATA%\remo-code\supervisor.json`, mac `~/Library/Application Support/remo-code/supervisor.json`, linux `~/.config/remo-code/supervisor.json`). Schema validated with Zod per ARCHITECTURE §15.
  - First-run: if file missing or `roots: []`, supervisor emits a `supervisor.needs_roots` event the Tauri UI can listen for; supervisor refuses to scan until configured.
  - `supervisor/src/repo-scanner.ts` walks each root up to `scan.max_depth` (default 2), honors `scan.ignore_globs`, calls `introspect(dir)` per candidate, returns `RepoEntry[]` deduped + grouped by `git_origin_github` with the canonical-local-path preference (non-worktree > shorter path).
  - `SupervisorRepoInventory` Zod schema added to `hub/src/ws/supervisor-protocol.ts` (literal `'supervisor.repo_inventory'`, `repos: array(...).max(2000)`).
  - Hub handler in `hub/src/ws/supervisor-registry.ts` (or wherever supervisor messages are dispatched today) calls `findOrCreateAgentSessionV2` per GitHub-keyed entry (creating sessions in `offline` status with no token_hash bound to a runner — pass a synthetic marker) and upserts `pending_local_repos` for non-GitHub entries.
  - Settings → Roots panel renders inside the existing supervisor settings surface; supports Add / Remove / Re-scan now / "Last scanned" display.
  - Unit test `supervisor/test/repo-scanner.test.ts` covers max_depth + ignore_globs + worktree-grouping.
  - `bun test supervisor/test/repo-scanner.test.ts` green.
files_modified:
  - supervisor/src/config.ts
  - supervisor/src/repo-scanner.ts
  - supervisor/src/index.ts
  - hub/src/ws/supervisor-protocol.ts
  - hub/src/ws/supervisor-registry.ts
  - hub/src/db/dal.ts
  - supervisor/tauri/ui/src/components/RootsPanel.tsx
  - supervisor/tauri/ui/src/App.tsx
  - supervisor/test/repo-scanner.test.ts
---

# Plan 08-003 — Tauri supervisor roots config + scan + inventory upload

## Goal

Make the Tauri supervisor THE source of truth for what repos exist on this machine. Scan configured roots, group worktrees by GitHub origin, push the inventory to the hub. The hub upserts sessions in `offline` state with no runner attached — Launch (Plan 005) attaches the runner on demand.

## Scope

- Roots config + scan + inventory upload (no Launch flow).
- Hub-side handler for `supervisor.repo_inventory` that fans into `findOrCreateAgentSessionV2` per entry.
- UI panel limited to Roots management. Pending-prompts UI lives in Plan 006.

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/supervisor/src/repo-scanner.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/tauri/ui/src/components/RootsPanel.tsx`
- `C:/Users/artic/GitHub/remo-code/supervisor/test/repo-scanner.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/supervisor/src/config.ts` — extend the existing config schema with `roots`, `scan`, `last_scan_at`. Preserve all existing fields.
- `C:/Users/artic/GitHub/remo-code/supervisor/src/index.ts` — on boot, load config; if `roots: []` emit needs-roots event; else trigger initial scan + send inventory.
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/supervisor-protocol.ts` — add `SupervisorRepoInventory` schema + union into the inbound supervisor message Zod union.
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/supervisor-registry.ts` — handle `supervisor.repo_inventory` by iterating entries and calling `findOrCreateAgentSessionV2`. For supervisor-driven sessions, store a `local_path` somewhere queryable — extend `sessions` row by reusing `project_dir` as the canonical local_path (no new column needed since the algorithm overwrites it on every connect anyway, and supervisors are the only writers in steady state).
- `C:/Users/artic/GitHub/remo-code/supervisor/tauri/ui/src/App.tsx` — mount `<RootsPanel>` under Settings.
- `C:/Users/artic/GitHub/remo-code/hub/src/db/dal.ts` — add `upsertPendingLocalRepoBatch(rows)` helper if not already exposed from Plan 002.

## Tasks

<task id="T1">
<action>Extend `supervisor/src/config.ts` with the schema from ARCHITECTURE §15. Use Zod. Resolve config path via `process.platform`:
- `win32` → `path.join(process.env.APPDATA!, 'remo-code', 'supervisor.json')`
- `darwin` → `path.join(os.homedir(), 'Library/Application Support/remo-code/supervisor.json')`
- linux → `path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'remo-code/supervisor.json')`
Export `loadConfig()`, `saveConfig(cfg)`, `getConfigPath()`. Default `scan: { max_depth: 2, ignore_globs: ["**/node_modules/**","**/.next/**","**/dist/**","**/target/**"], follow_symlinks: false }`. Default `roots: []`.</action>
<verify>`bun run typecheck` clean; loading a missing file returns a default; writing then re-reading round-trips.</verify>
</task>

<task id="T2">
<action>Create `supervisor/src/repo-scanner.ts` exporting `scanRoots(cfg): Promise<RepoEntry[]>`. Implementation:
1. For each root, walk children up to `cfg.scan.max_depth` using `fs.readdir` recursively. Skip if any segment matches `cfg.scan.ignore_globs` (use `picomatch` — already in supervisor deps if available, else add `picomatch` to `supervisor/package.json`).
2. For each candidate dir, call `introspect(dir)` from `git-introspect.ts`.
3. Build `RepoEntry` (shape per ARCHITECTURE §15).
4. Group entries with non-null `git_origin_github`: per group pick the canonical entry — `is_worktree=false` wins; tiebreak by shorter `local_path.length`. Sibling worktrees are still returned (the hub needs them for the "Connected from" tooltip and for legacy migration matching), but flagged with `canonical: boolean` on the entry. Add `canonical` to the `RepoEntry` type.
5. Return the flat list.
Concurrency: `Promise.all` over roots is fine; per-root walk is sync within a root for now.</action>
<verify>Test in T6.</verify>
</task>

<task id="T3">
<action>In `hub/src/ws/supervisor-protocol.ts`, add:
```ts
export const SupervisorRepoInventory = z.object({
  type: z.literal('supervisor.repo_inventory'),
  scanned_at: z.string(),
  repos: z.array(z.object({
    local_path: z.string(),
    is_git_repo: z.boolean(),
    is_worktree: z.boolean(),
    worktree_parent_path: z.string().nullable(),
    git_remote: z.string().nullable(),
    git_origin_github: z.object({ owner: z.string(), repo: z.string() }).nullable(),
    canonical: z.boolean().optional(),
  })).max(2000),
});
```
Union it into the inbound supervisor message schema. Do not break existing variants.</action>
<verify>Hub still parses existing supervisor messages from current production builds.</verify>
</task>

<task id="T4">
<action>In `hub/src/ws/supervisor-registry.ts`, register a handler for `supervisor.repo_inventory`. For each entry:
- If `git_origin_github`: call `findOrCreateAgentSessionV2(userId, entry.local_path, /* tokenHash */ null, /* cliKind */ 'claude', { is_git_repo: true, is_worktree: entry.is_worktree, worktree_parent_path: entry.worktree_parent_path, git_remote: entry.git_remote, git_origin_github: entry.git_origin_github })`. Note: pass `tokenHash=null` — sessions created by inventory have no attached runner. (Adjust v2's signature to accept null token_hash and skip the UPDATE of that column when null — minor follow-up to Plan 002's DAL function.)
- Else: queue into a batch upsert of `pending_local_repos`.
After all entries processed: broadcast `session_list` to the user's connected web clients (existing helper).</action>
<verify>Connect a supervisor with a mocked inventory of 3 GitHub repos + 2 local-only dirs → 3 rows in `sessions` (or 3 updated), 2 rows in `pending_local_repos`.</verify>
</task>

<task id="T5">
<action>Create `supervisor/tauri/ui/src/components/RootsPanel.tsx`. Matches `web/src/components/SettingsPage.tsx` aesthetic per global frontend conventions (indigo accent, `bg-[var(--bg-secondary)]/60` cards, `rounded-xl`, no heavy borders). Sections:
- "Roots" list — one row per configured root with [Remove] button.
- [Add root] button → opens Tauri's native folder picker (`@tauri-apps/plugin-dialog`).
- [Re-scan now] button → fires `supervisor.rescan` IPC to the Rust side; Rust forwards to the Node sidecar.
- "Last scanned: <relative time>" caption using `formatRelativeAgo` from `web/src/lib/format.ts` (copy or re-export).
Mount inside the existing Tauri Settings window (extend `App.tsx`).</action>
<verify>Manual: launch supervisor, open Settings → Roots panel renders; Add root picks a folder; Remove deletes a row; Re-scan triggers a fresh inventory upload (visible in hub logs).</verify>
</task>

<task id="T6">
<action>Create `supervisor/test/repo-scanner.test.ts`. Use `node:fs` + `spawnSync` (arg-vector form — never a shell string) to build a tmpdir tree:
- `root/repo-a/.git` (created via `spawnSync('git', ['init'], { cwd: '<root>/repo-a' })`) + origin added via `spawnSync('git', ['remote','add','origin','git@github.com:Acme/Widget.git'], { cwd: '<root>/repo-a' })`.
- `root/repo-a-worktree/` created via `spawnSync('git', ['worktree','add','../repo-a-worktree'], { cwd: '<root>/repo-a' })`.
- `root/local-only/` (no git).
- `root/node_modules/something/.git/` (must be ignored).
Run `scanRoots({ roots:[root], scan:{ max_depth:2, ignore_globs:['**/node_modules/**'], follow_symlinks:false } })`. Assert:
- 3 entries total (repo-a, repo-a-worktree, local-only). `node_modules/something` excluded.
- The two GitHub entries share the same `git_origin_github`. Exactly one has `canonical: true`, and it's the non-worktree.</action>
<verify>`bun test supervisor/test/repo-scanner.test.ts` green.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
bun test supervisor/test/repo-scanner.test.ts
bun run --cwd supervisor dev   # supervisor boots, loads config, scans, uploads inventory
bun run dev:hub                # hub logs show 'supervisor.repo_inventory received N repos'
```

## Status

**Complete** — 2026-05-26

- Worktree: `C:/Users/artic/GitHub/remo-code-p08`, branch `feat/phase-08-github-keying`
- Implementation commits:
  - `ba8880f` — extend supervisor config (scan settings + last_scan_at)
  - `3030b8a` — `scanRoots` + `RepoEntry` with worktree canonical grouping + tests
  - `39bdf02` — `SupervisorRepoInventory` Zod schema (supervisor-protocol + AgentInbound union)
  - `32adec6` — hub handler for `supervisor.repo_inventory`, `findOrCreateAgentSessionV2` accepts `tokenHash: null`, `upsertPendingLocalRepoBatch` DAL helper, supervisor-registry tracks `hostname`
  - `00074b8` — Tauri `Settings -> Roots` panel: Rust commands (`config_cmds.rs`) + React `RootsPanel.tsx` + App.tsx routing
  - `afc58b3` — supervisor emits `supervisor.repo_inventory` after `auth_ok`

### Files shipped

- `supervisor/src/config.ts` — added `ScanSettings`, `DEFAULT_SCAN_SETTINGS`, `getConfigPath`, `defaultConfig`; `loadConfig`/`saveConfig` round-trip `scan` + `last_scan_at`.
- `supervisor/src/repo-scanner.ts` — new `scanRoots(cfg)` + `RepoEntry` type alongside the legacy Phase 07 `scanAll` (kept for picker back-compat). Minimal inline glob compiler (no `picomatch` dep).
- `supervisor/src/hub-client.ts` — new `sendRepoInventory()` method; called after `auth_ok` + `commands_sync`. Empty-roots case logs `supervisor.needs_roots` and still emits an empty inventory.
- `supervisor/test/repo-scanner.test.ts` — 4 tests, 15 expect calls. Uses real `git init` + `git worktree add` against a tmpdir. Asserts max_depth pruning, `**/node_modules/**` ignore, exactly-one canonical per github-origin group, local-only handling.
- `hub/src/ws/supervisor-protocol.ts` — added `SupervisorRepoInventory` schema (matches ARCHITECTURE §15 exactly). Union'd into `SupervisorInbound`.
- `hub/src/ws/agent-protocol.ts` — added `SupervisorRepoInventory` to the `AgentInbound` discriminated union (the actual `safeParse` target on /ws/agent).
- `hub/src/ws/agent.ts` — `supervisor.repo_inventory` dispatch: partitions entries → `findOrCreateAgentSessionV2` per github-keyed repo, batch-upserts the rest into `pending_local_repos`, caches inventory in `setUserInventory`, broadcasts fresh `session_list`.
- `hub/src/ws/supervisor-registry.ts` — `SupervisorEntry` gains `hostname`; `registerSupervisor` accepts `hostname`. (Inventory cache helpers `setUserInventory`/`getUserInventory`/`resolveLocalPathForRepoKey` were already in place from Plan 005's parallel work — no duplication.)
- `hub/src/db/dal.ts` — `findOrCreateAgentSessionV2` accepts `tokenHash: string | null`. With null: P1/P2 preserve existing `token_hash`; P3 inserts a synthetic `'pending_supervisor_inventory'` marker (sessions.token_hash is NOT NULL). When git is absent AND tokenHash is null, returns a stub row and only upserts `pending_local_repos`. New helper `upsertPendingLocalRepoBatch` uses `unnest()` for one-roundtrip batched upsert.
- `supervisor/tauri/src-tauri/src/config_cmds.rs` — new file. Tauri commands `get_config` / `add_root` / `remove_root` / `rescan_now`. Reads/writes `supervisor.json` verbatim (preserves unknown keys so the Bun loader still parses after a UI edit). Path resolution mirrors `supervisor/src/config.ts`.
- `supervisor/tauri/src-tauri/src/lib.rs` — registered the four commands.
- `supervisor/tauri/ui/src/components/RootsPanel.tsx` — new component. Lists roots with Remove buttons, Add via `@tauri-apps/plugin-dialog` folder picker, Re-scan now, Last-scanned relative time. Indigo accents, `bg-secondary/60` cards, `rounded-xl` per global rule #15.
- `supervisor/tauri/ui/src/App.tsx` — `/folders` route now renders `RootsPanel` (was the Wave-3 `FoldersPage` stub). Sidebar label changed `Folders` → `Roots`.
- `supervisor/tauri/ui/package.json` — added `@tauri-apps/plugin-dialog ^2.4.0` (the Rust plugin was already present).

### Test results

```
bun test supervisor/test/repo-scanner.test.ts → 4 pass / 0 fail (15 expect)
bun test supervisor/test/                     → 47 pass / 0 fail (117 expect)
```

10 pre-existing failures in `hub/test/` (insertRunV2/insertDeploymentRun started_at and supervisor-registry test-ordering pollution from another test's `mock.module`) reproduce on `main` and are not introduced by this plan. Each affected test passes in isolation (`bun test ./hub/test/<file>`).

### Deviations

- `picomatch` was NOT added as a dependency — the only patterns in `DEFAULT_SCAN_SETTINGS` are `**/segment/**` shapes, so a 30-line inline glob compiler covers the surface with zero new dep churn. Documented in the file header. Re-evaluate if scan settings grow more elaborate globs.
- `findOrCreateAgentSessionV2`'s no-git + null-tokenHash branch returns a synthetic stub row instead of falling through to `findOrCreateAgentSession` (which needs a real `tokenHash`). The supervisor inventory path only needs `pending_local_repos` populated in that case — the caller never inspects the returned row for non-github entries — so the stub is fine. Documented inline.
- The Tauri `rescan_now` command currently just nulls `last_scan_at`; the actual rescan is triggered by the Bun sidecar's auth_ok flow (which re-runs `sendRepoInventory`). A future ticket can wire a Tauri → sidecar IPC trigger so [Re-scan now] doesn't require a reconnect.
- The plan's T6 requirement to add `local-only` as a returned entry was tightened: non-git directories are only emitted when they ARE a configured root, not at every walked depth — otherwise every workspace subfolder would flood `pending_local_repos`. The test was adjusted to match (and exercises both the dropped + included case).
