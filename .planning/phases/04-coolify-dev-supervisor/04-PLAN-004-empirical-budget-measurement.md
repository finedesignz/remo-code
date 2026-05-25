---
plan_id: 04-PLAN-004-empirical-budget-measurement
wave: 4
depends_on: [04-PLAN-006-coolify-deploy, 04-PLAN-007-worktree-per-session]
files_modified:
  - scripts/measure-session-footprint.ts
  - docs/budget-measurement.md
  - supervisor/src/resources.ts
autonomous: false
requirements: [REQ-MEASURE-01]
---

# Plan 04-004 — Empirically measure session footprint, tune `MB_PER_SESSION`

The 800 MB/session constant in Plan 001 is a guess (RESEARCH.md Assumption A1, Pitfall #2). Before declaring Phase 04 done, run a measurement against the actual Coolify deploy and tune. This plan is a checkpoint: human-in-the-loop because the run is interactive (watch a session for 10 minutes), and the resulting constant change must be reviewed.

<tasks>

<task id="T1">
<action>Create `scripts/measure-session-footprint.ts` (Bun script). Takes args `--sessions N --duration-min M --prompt-file path.md`. Spawns N parallel `claude-agent` child processes through the existing `ProcessManager` (or, equivalently, calls the supervisor's session-create flow N times via WS). Every 30s for M minutes: sample `process.memoryUsage()` for each child PID via `ps -o rss= -p <pid>` (sum the RSS across the child and its `claude` subprocess), record to `out/session-footprint-<timestamp>.csv` with columns `t_seconds, session_idx, child_rss_mb, claude_rss_mb, total_rss_mb`. Print summary at exit: per-session p50/p95/max RSS, mean across sessions, overall peak.</action>
<read_first>
- supervisor/src/process-manager.ts (how children are spawned + how to enumerate live PIDs)
- supervisor/src/index.ts (any existing scripts that drive ProcessManager directly)
</read_first>
<acceptance_criteria>
- `bun scripts/measure-session-footprint.ts --sessions 2 --duration-min 1 --prompt-file scripts/_test-prompt.md` runs locally without crashing
- CSV output exists at the documented path with one row per (sample, session)
- Summary print includes p50, p95, max
- Script does NOT require Coolify to run (works on dev machine for sanity check)
</acceptance_criteria>
</task>

<task id="T2" type="checkpoint:human-verify">
<what-built>Measurement script ready; needs an actual run on the Coolify supervisor.</what-built>
<how-to-verify>
1. SSH/exec into the Coolify supervisor container (deployed in Plan 006)
2. Copy a representative prompt to `/workspaces/_measurement-prompt.md` (something that exercises a few tool calls, e.g. "read the repo's README and list the top 5 files by line count")
3. Run: `bun scripts/measure-session-footprint.ts --sessions 4 --duration-min 10 --prompt-file /workspaces/_measurement-prompt.md`
4. Wait 10 minutes. Capture the printed summary AND the CSV at `out/session-footprint-*.csv`
5. Re-run with `--sessions 8 --duration-min 10` if container has the RAM
6. Paste the summary + max-RSS-per-session figure into the resume signal
</how-to-verify>
<resume-signal>Paste the per-session p95 RSS in MB (e.g. "p95 = 620 MB across 4 sessions on the 16GB container"). I'll tune `MB_PER_SESSION` accordingly and commit.</resume-signal>
</task>

<task id="T3">
<action>Based on the measured p95 RSS from T2, update `MB_PER_SESSION` in `supervisor/src/resources.ts` to `ceil(p95 * 1.15)` (15% headroom for spikes). Add a comment explaining the source (`// Tuned 2026-MM-DD from out/session-footprint-<timestamp>.csv: p95 = X MB across N sessions`). Add `docs/budget-measurement.md` documenting: the script invocation, the dataset (date, container spec, prompt used), the resulting p95/max, the chosen constant, and the rerun procedure for future tuning.</action>
<read_first>
- supervisor/src/resources.ts (the constant location from Plan 001)
- The CSV output + summary from T2
</read_first>
<acceptance_criteria>
- `MB_PER_SESSION` updated to a measured value with a citing comment
- `docs/budget-measurement.md` exists with all 5 documented sections
- `bun test supervisor/test/resources.test.ts` still passes (tests reference the constant by import, not literal)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `MB_PER_SESSION` reflects an actual measurement, not a guess, before declaring Phase 04 done
- `docs/budget-measurement.md` documents the dataset + rerun procedure so the constant can be re-tuned by anyone
- The measurement script is reusable for future hardware changes

rollback_plan:
- Revert `MB_PER_SESSION` to 800; supervisor still functions, budget is just conservative.

risks:
- A single measurement run may not capture worst-case memory usage (e.g., a session with a very long context + many tool results). The 15% headroom mitigates; future tuning lowers the constant if the data warrants.
- This plan is wave 4 and depends on Coolify deploy (Plan 006) being live — coordinate scheduling.
