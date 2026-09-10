---
plan_id: 04-PLAN-001-budget-reporting
wave: 1
depends_on: []
files_modified:
  - supervisor/src/resources.ts
  - supervisor/src/index.ts
  - supervisor/src/hub-client.ts
  - hub/src/ws/supervisor-protocol.ts
  - supervisor/test/resources.test.ts
  - hub/test/supervisor-protocol.test.ts
autonomous: true
requirements: [REQ-RES-01, REQ-RES-02, REQ-PROTO-01]
---

# Plan 04-001 — Supervisor resource detection + `host_resources` WS message

Containerized supervisor must self-report CPU/RAM/budget so the hub can gate session creation. This plan ships the detection module, periodic reporter, and protocol schema. No hub-side persistence yet (Plan 002 adds the columns; Plan 003 wires the gate). The reporter sends on connect + every 60s.

<tasks>

<task id="T1">
<action>Create `supervisor/src/resources.ts` exporting `detectHostResources(): { cpu_cores: number; total_mem_mb: number; free_mem_mb: number; concurrency_budget: number; source: 'cgroup_v2' | 'cgroup_v1' | 'host_fallback' }`. Read `/sys/fs/cgroup/cpu.max` (v2 — format `"<quota> <period>"`, `"max <period>"` means uncapped) then fall back to `/sys/fs/cgroup/cpu.cfs_quota_us` + `/sys/fs/cgroup/cpu.cfs_period_us` (v1), else `os.cpus().length`. Read `/sys/fs/cgroup/memory.max` (v2, `"max"` means uncapped) then `/sys/fs/cgroup/memory.limit_in_bytes` (v1), else `os.totalmem()`. Treat v1 mem values `>= 2^63 / 2` as uncapped (kernel sentinel). For `free_mem_mb` use `os.freemem()` divided by 1MB. Compute `concurrency_budget = max(1, min(floor(cpu_cores * 0.75), floor(total_mem_mb / 800)))`. Constant `MB_PER_SESSION = 800` exported separately so Plan 004 can tune it. Record `source` based on which path won (v2 takes precedence). Each cgroup read in a try/catch that returns `null` so a missing file never throws.</action>
<read_first>
- supervisor/src/index.ts (existing supervisor boot flow + hub-client wiring)
- hub/src/ws/supervisor-protocol.ts (existing schemas to extend)
- .planning/phases/04-coolify-dev-supervisor/RESEARCH.md (Pattern 1 + Pitfall 1)
</read_first>
<acceptance_criteria>
- Pure function — no side effects beyond fs reads; safe to call repeatedly
- With both cgroup files absent (typical Windows/macOS dev): returns `source: 'host_fallback'` with positive cpu/mem
- `concurrency_budget` is always `>= 1`
- `MB_PER_SESSION` exported and importable by other modules
</acceptance_criteria>
</task>

<task id="T2">
<action>Extend `hub/src/ws/supervisor-protocol.ts` with a Zod schema `HostResourcesMessage = z.object({ type: z.literal('host_resources'), cpu_cores: z.number().int().positive(), total_mem_mb: z.number().int().positive(), free_mem_mb: z.number().int().nonnegative(), concurrency_budget: z.number().int().min(1), source: z.enum(['cgroup_v2','cgroup_v1','host_fallback']) })`. Export it and add to the existing discriminated union of supervisor→hub message types. Do NOT add hub-side persistence here — that's Plan 002. The handler in `hub/src/ws/supervisor.ts` (or wherever supervisor messages are routed) gets a stub case that logs the payload and acks; the real persistence lands in Plan 002.</action>
<read_first>
- hub/src/ws/supervisor-protocol.ts (existing union pattern + schema style)
- hub/src/ws/supervisor-registry.ts (where supervisor messages land today)
</read_first>
<acceptance_criteria>
- Schema rejects negative numbers, missing fields, unknown `source`
- Existing supervisor messages still parse (no breaking changes to the union)
- `grep -n "host_resources" hub/src/ws/supervisor-protocol.ts` matches the new schema
</acceptance_criteria>
</task>

<task id="T3">
<action>In `supervisor/src/index.ts` boot path, after the WS auth handshake succeeds: import `detectHostResources` from `./resources.ts`, call it once, send `{ type: 'host_resources', ...result }` via the hub client. Then `setInterval(() => sendHostResources(), 60_000)`. On WS reconnect, send again immediately. Add a `sendHostResources()` helper in `supervisor/src/hub-client.ts` that calls `detectHostResources` and serializes via the schema (best-effort — log + swallow errors so a single bad read can't crash the supervisor).</action>
<read_first>
- supervisor/src/index.ts (existing boot/auth/heartbeat flow)
- supervisor/src/hub-client.ts (existing send helpers)
</read_first>
<acceptance_criteria>
- `bun run supervisor/src/index.ts` (with valid REMO_API_KEY against a local hub) connects and the hub log shows one `host_resources` event on connect
- Killing the WS connection and reconnecting fires another `host_resources` (no waiting for the 60s interval)
- Throwing inside `detectHostResources` (mock) does NOT terminate the supervisor process — error is logged
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `supervisor/test/resources.test.ts` (Bun test). Mock `fs.readFileSync` and `os` to assert: (a) cgroup v2 path wins when both present, source = `'cgroup_v2'`; (b) v2 `"max"` falls through to v1; (c) v1 falls through to host when both cgroups absent, source = `'host_fallback'`; (d) `concurrency_budget` floors at 1 even on a 1-core / 256MB-RAM machine; (e) `MB_PER_SESSION` is the single source of truth for the divisor.</action>
<read_first>
- hub/test/scheduler.test.ts (Bun test style in this repo — `import { test, expect, mock } from "bun:test"`)
- supervisor/src/resources.ts (the unit under test)
</read_first>
<acceptance_criteria>
- `bun test supervisor/test/resources.test.ts` green with zero env vars set
- Each described case has its own `test(...)` block
- Test does NOT require a real `/sys/fs/cgroup` (it mocks fs)
</acceptance_criteria>
</task>

<task id="T5">
<action>Create `hub/test/supervisor-protocol.test.ts` asserting `HostResourcesMessage` accepts a valid payload and rejects: missing `concurrency_budget`, negative `total_mem_mb`, unknown `source`, `type` mismatch. Two cases for the union: parsing a valid `host_resources` succeeds; parsing an unknown supervisor message type yields a descriptive Zod error (not a crash).</action>
<read_first>
- hub/src/ws/supervisor-protocol.ts (after Plan T2 edit)
- hub/test/scheduler.test.ts (test style)
</read_first>
<acceptance_criteria>
- `bun test hub/test/supervisor-protocol.test.ts` green
- All 4 reject cases assert the Zod failure (`.success === false`)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `detectHostResources` deterministically returns a budget across cgroup v2, v1, and host fallback
- `host_resources` schema exists in `hub/src/ws/supervisor-protocol.ts` and is part of the supervisor→hub union
- Supervisor sends `host_resources` on connect + every 60s, with errors swallowed
- Unit tests cover all three cgroup paths and schema validation

rollback_plan:
- Revert the new files + schema additions; supervisor pre-Plan-001 behavior is unaffected because nothing else yet consumes `host_resources`.

risks:
- 800 MB/session heuristic is a guess — Plan 004 will measure and tune. Document the constant location so the tuning is a one-line change.
- cgroup v1 vs v2 path differences on the Coolify host kernel — falling back through all three paths makes this safe in any environment.
