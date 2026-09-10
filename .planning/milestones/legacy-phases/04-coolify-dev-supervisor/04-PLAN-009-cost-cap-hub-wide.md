---
plan_id: 04-PLAN-009-cost-cap-hub-wide
wave: 3
depends_on: [04-PLAN-002-schema-and-migration, 04-PLAN-003-hub-concurrency-gate]
files_modified:
  - hub/src/db/schema.sql
  - hub/src/sessions/cost-cap.ts
  - hub/src/sessions/budget.ts
  - hub/src/scheduler/dispatcher.ts
  - hub/src/ws/agent.ts
  - hub/src/api/users.ts
  - hub/test/cost-cap.test.ts
---

# Plan 04-009 — Lift scheduler daily cost cap to a hub-wide per-user gate

Per ARCHITECTURE-REVIEW §7: a remote supervisor that can fire N parallel sessions racks up $ with no ceiling under the current scheduler-only cap. Lift the counter to a hub-wide `(user_id, day_utc) → cents_spent` aggregator updated from Claude API result messages (already relayed by the agent today), and gate all session-creation paths on the per-user `daily_cost_cap_cents` from Plan 002.

<tasks>

<task id="T1">
<action>Append to `hub/src/db/schema.sql`: `CREATE TABLE IF NOT EXISTS daily_cost_usage ( user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, day_utc DATE NOT NULL, cents_spent INTEGER NOT NULL DEFAULT 0, input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, day_utc) );` plus `CREATE INDEX IF NOT EXISTS idx_daily_cost_usage_day ON daily_cost_usage(day_utc DESC);`. Also add `model_pricing_cents_per_mtok JSONB` column on `users` (nullable; default NULL means use the global default table) for per-user pricing override. Re-running schema.sql remains a no-op.</action>
<read_first>
- hub/src/db/schema.sql (existing idempotent ALTER/CREATE patterns)
- hub/src/scheduler/dispatcher.ts (existing cost-cap counter location to lift from)
</read_first>
<acceptance_criteria>
- `\d daily_cost_usage` shows composite PK `(user_id, day_utc)` + CASCADE FK
- Re-running schema.sql is a no-op
- `users.model_pricing_cents_per_mtok` is nullable JSONB
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `hub/src/sessions/cost-cap.ts`. Exports:
  - `const DEFAULT_PRICING_CENTS_PER_MTOK: Record<string, { input: number; output: number }>` — Opus / Sonnet / Haiku entries with current Anthropic public prices (e.g. Sonnet input $3/Mtok output $15/Mtok → 300/1500 cents per Mtok). Document the source URL in a comment + the date last verified.
  - `function costForUsage({model, input_tokens, output_tokens}, pricing): number /* cents, rounded up */`.
  - `async recordUsage(userId, {model, input_tokens, output_tokens})` — atomic UPSERT: `INSERT INTO daily_cost_usage (user_id, day_utc, cents_spent, input_tokens, output_tokens) VALUES ($1, CURRENT_DATE, $2, $3, $4) ON CONFLICT (user_id, day_utc) DO UPDATE SET cents_spent = daily_cost_usage.cents_spent + EXCLUDED.cents_spent, input_tokens = daily_cost_usage.input_tokens + EXCLUDED.input_tokens, output_tokens = daily_cost_usage.output_tokens + EXCLUDED.output_tokens, updated_at = now()`.
  - `async getTodayUsage(userId): Promise<{ cents_spent: number; cap_cents: number; pct: number }>` — joins `daily_cost_usage` with `users.daily_cost_cap_cents`.
  - `async assertUnderCap(userId): Promise<{ ok: true; pct: number } | { ok: false; cents_spent: number; cap_cents: number }>` — used as a gate.</action>
<read_first>
- hub/src/scheduler/dispatcher.ts (current scheduler cost-cap impl — lift the model/pricing assumptions)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §7
</read_first>
<acceptance_criteria>
- `recordUsage` is idempotent under concurrent calls (the UPSERT handles concurrency — verified via test with `Promise.all` of 10 concurrent recordUsage calls; total cents matches sum)
- `costForUsage` rounds UP (so we never under-bill)
- `getTodayUsage` reflects writes within the same transaction immediately
- Pricing table has a `// Source: https://anthropic.com/pricing — verified 2026-MM-DD` comment
</acceptance_criteria>
</task>

<task id="T3">
<action>Wire the cost cap into:
  (a) `hub/src/ws/agent.ts` — wherever the agent forwards a Claude API `result` event with `usage`, call `recordUsage(userId, {model, input_tokens, output_tokens})`. This is the data ingest.
  (b) `hub/src/sessions/budget.ts` (from Plan 003) — inside `reserveSessionSlot`, BEFORE the capacity check, call `assertUnderCap(userId)` and return `{ ok: false, reason: 'daily_cost_cap_reached', cents_spent, cap_cents }` if exceeded.
  (c) `hub/src/scheduler/dispatcher.ts` — replace the existing scheduler-local counter call with `assertUnderCap`; keep the scheduler's per-task cap as a narrower secondary check (both gates fire).
  (d) Add `PATCH /api/users/me/cost-cap` (Hono route in `hub/src/api/users.ts` — create if missing) with body `{ daily_cost_cap_cents: number }` (Zod min 0, max 1_000_000) so the user can adjust their cap.
  (e) On every Claude usage record, if the new total crosses 50% or 80% of cap for the first time today, broadcast a `cost_cap_warning` WS event to the user's clients (one per threshold per day).</action>
<read_first>
- hub/src/ws/agent.ts (existing `result` event handler + usage relay)
- hub/src/scheduler/dispatcher.ts (current cost-cap call site to replace)
- hub/src/sessions/budget.ts (from Plan 003 — where to add the precheck)
</read_first>
<acceptance_criteria>
- A simulated `result` event with `{model: 'claude-sonnet-...', usage: {input_tokens: 1000, output_tokens: 500}}` updates `daily_cost_usage` by the computed cents
- `reserveSessionSlot` returns `daily_cost_cap_reached` once today's spend ≥ cap
- Scheduler dispatcher skips with reason `daily_cost_cap_reached`
- `PATCH /api/users/me/cost-cap` updates `users.daily_cost_cap_cents` and is reflected on the next `assertUnderCap`
- `cost_cap_warning` fires exactly once per threshold per UTC day (idempotent — store the threshold-crossed flag in memory keyed by user+day, OR rederive from the table on each tick)
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `hub/test/cost-cap.test.ts` (Bun test, env-gated on `REMO_E2E_DB_URL`). Cases: cost rounds up; concurrent recordUsage sums correctly (10 parallel calls × 100 cents = 1000); reserveSessionSlot refuses at cap; scheduler dispatcher skips at cap; PATCH cost-cap updates the gate; 50%/80% warnings fire exactly once each per day.</action>
<read_first>
- hub/test/supervisor-budget.test.ts (from Plan 003)
- hub/src/sessions/cost-cap.ts (unit under test)
</read_first>
<acceptance_criteria>
- `bun test hub/test/cost-cap.test.ts` green with `REMO_E2E_DB_URL` set
- Concurrent test asserts `cents_spent` = exact sum (no lost updates)
- Warning idempotency test verifies one event per threshold, not duplicates on subsequent usage
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `daily_cost_usage` table tracks per-user per-day spend across ALL sessions (interactive + scheduled + self-heal)
- `reserveSessionSlot` blocks once today's spend ≥ user's `daily_cost_cap_cents`
- Cost is computed from Claude API result `usage` — hub-authoritative, never trusts the agent's claimed cost
- Scheduler's per-task cap and the hub-wide cap both fire (defense in depth)
- User can adjust their cap via PATCH; default $20 from Plan 002
- 50% / 80% warnings fire once per UTC day

rollback_plan:
- Disable the precheck in `reserveSessionSlot` (1-line revert); scheduler falls back to its own counter; data table remains but unused.

risks:
- Pricing table drift — Anthropic prices change. Document the rerun procedure (manually re-verify the URL quarterly). For now, slight overestimate is safer than underestimate.
- Streaming sessions accumulate usage gradually — a session that goes from $0 → $5 in one turn may cross the cap mid-stream. Acceptable; the next turn is gated, current turn completes.
