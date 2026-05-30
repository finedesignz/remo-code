# Usage Cost Ledger (P2)

Per-turn token + dollar-cost ledger captured from the Claude CLI stream and
persisted on the hub. This is the recording half of usage-monitoring; the
non-bypassable spend cap (P3) is separate and unaffected by P2.

> **Cost is an ESTIMATE.** `cost_usd` is the SDK's authoritative
> `total_cost_usd` per turn when present (`cost_source='sdk'`), else a hub
> list-price estimate (`cost_source='estimated'`). Both are a **subscription
> list-price equivalent**, NOT billed dollars — a Claude Code Max/Pro
> subscriber is not charged per token.

## Flow

```
Claude CLI `result` stream event  (total_cost_usd + usage{4 token buckets})
   ↓  supervisor: ClaudeRunner.parseUsageFromResult → SessionBridge
agent→hub WS  `usage_event`  { session_id, model, tokens, cost_usd, cost_source, ts }
   ↓  hub/src/ws/agent.ts  (RECORD only — no cost-cap routing in P2)
recordTokenUsage()  →  INSERT token_usage  +  UPSERT token_usage_daily (accumulate)
   ↓
GET /api/usage/cost  → today / 7d / total + per-session + per-repo aggregates
```

## Capture (supervisor)

- `supervisor/src/runners/claude-runner.ts` — on the CLI `result` event,
  `parseUsageFromResult(r, lastModel)` extracts `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  the `model` (from the preceding assistant message, since `result` omits it),
  and `total_cost_usd`. `cost_from_sdk=false` when the cost is absent.
- `supervisor/src/runners/session-bridge.ts` — emits the additive
  `usage_event` agent message (only when token counts are present; an error
  result with no `usage` is skipped, not zero-recorded).
- Ships with **supervisor ≥ 0.8.0** (new MSI required for capture).

## Pricing fallback (hub)

`hub/src/usage/pricing.ts` — model→price table (USD per 1M tokens) consulted
**only** when `cost_source='estimated'`. SDK `total_cost_usd` is authoritative
and never recomputed. Prefix-matched (longest prefix wins). Update the `PRICES`
map from <https://www.anthropic.com/pricing> when rates change (last reviewed
2026-05-30: Opus/Sonnet/Haiku 4.x).

## Persistence (hub)

Idempotent DDL in `hub/src/db/schema.sql` (re-runs every boot):

- **`token_usage`** — one row per turn: `id, user_id, session_id, model,
  input/output/cache_creation/cache_read tokens, cost_usd, cost_source,
  created_at`. Indexed by `(user_id, created_at DESC)` and `(session_id)`.
- **`token_usage_daily`** — rollup PK `(user_id, day, model)`; summed tokens +
  cost, upserted via `ON CONFLICT … DO UPDATE` (ADD, not replace) on each event.

DAL: `hub/src/db/token-usage-dal.ts` (`recordTokenUsage`, `sumUserTokenWindows`,
`usageBySession`, `usageByRepo`). All queries scoped by `user_id`.

## Read API

`GET /api/usage/cost` (authed, user-scoped) — `{ timezone, cost_is_estimate:true,
today, seven_day, total, by_session[], by_repo[] }`. Each window/breakdown
carries the four token buckets + `cost_usd`. Per-repo key = `owner/repo` (from
session `github_owner/github_repo`) else `project_dir` else `unknown`.

`GET /api/usage/summary` (P1) is unchanged — subscription OAuth utilization
windows + scheduled-task cost.

## Tests

- `supervisor/test/usage-capture.test.ts` — `parseUsageFromResult` extraction.
- `hub/test/usage-pricing.test.ts` — fallback rate match + estimate math.
- `hub/test/usage-event-handler.test.ts` — insert + daily-upsert accumulation.
- `hub/test/usage-cost-api.test.ts` — `/api/usage/cost` aggregation shape.

## Not in P2

- No cost-cap enforcement on `usage_event` (P3 owns the cap flip).
- No cost UI (P3) — the API is ready for the dashboard.
