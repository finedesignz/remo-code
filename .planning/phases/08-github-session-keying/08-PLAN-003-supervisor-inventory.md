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
