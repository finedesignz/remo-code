# Usage + Cost Monitoring — Architecture Spec

**Status:** DESIGN ONLY (no source changes). Author: Backend Architect. Date: 2026-05-30.
**Scope:** First-class token-usage + cost monitoring for remo-code, absorbing the useful
tech from the `ClaudeUsage` PowerShell module (third-party clone of `github.com/backmind/ClaudeUsage`).

**Hard invariant preserved throughout:** the Anthropic OAuth access token lives ONLY on the
dev machine (`~/.claude/.credentials.json`) and is read ONLY by the supervisor. The hub never
sees the OAuth token. All limit polling stays supervisor-side; the hub receives parsed,
non-secret utilization snapshots over `/ws/agent`. **Do not move the OAuth token to the hub.**

---

## 0. Reference: the "technology" in ClaudeUsage

From `C:/Users/artic/GitHub/ClaudeUsage/ClaudeUsage.psm1`:

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`
- **Auth bearer:** `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
  (expiry check: `claudeAiOauth.expiresAt`, unix **milliseconds**; if `now > expiresAt` the
  token is stale → user must `claude setup-token`). (psm1:79-99)
- **Headers** (psm1:117-124):
  ```
  Accept: application/json, text/plain, */*
  Content-Type: application/json
  User-Agent: claude-code/2.0.15
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20
  ```
- **Response shape** — up to four windows, each `{ utilization: number (0-100), resets_at: ISO8601 }`:
  - `five_hour`            — always present (primary session limit)
  - `seven_day`           — Claude Max / enterprise only
  - `seven_day_oauth_apps` — OAuth-app aggregate limit (optional)
  - `seven_day_opus`       — Opus-specific 7-day limit, Max only (psm1:57-58, 219-244)
- **Reset-time / threshold computation** is purely client-side: `timeRemaining = resets_at - now`,
  colour bands `<50 green / <80 yellow / ≥80 red` (psm1:151-157, 188-200). This is the
  "reset countdown" UX worth porting.
- **401 handling:** treat as invalid token, surface a re-auth hint (psm1:250-252).

There is **no `$`/cost data** in this endpoint — it is utilization-only. Cost accounting is
entirely a remo-code build-new concern (Section 3).

---

## 1. Gap analysis

| Capability | ClaudeUsage has | remo-code today | Gap |
|---|---|---|---|
| 5h limit (`five_hour`) | yes | yes — `UsageWindow.five_hour` in `hub/src/usage/store.ts:11`, polled→`usage_report`→`subscription_usage` | **none** |
| 7d limit (`seven_day`) | yes | yes — `store.ts:12`, `agent-protocol.ts:150` | **none** |
| Opus 7d limit (`seven_day_opus`) | yes | **fields scaffolded** (`store.ts:13`, `agent-protocol.ts:151`, threshold gate already reads it `threshold.ts:57,72-75`) but **supervisor poll does not yet emit it** (no `oauth/usage` fetch found in `supervisor/src`/`src-tauri`) | **poll + UI** — wire Opus into the actual fetch + render it |
| OAuth-app limit (`seven_day_oauth_apps`) | yes | fields scaffolded (`store.ts:14`, `agent-protocol.ts:152`); not polled, not rendered | **poll + UI** |
| reset times (`resets_at`) | yes (per window) | carried in payload, **not rendered** anywhere | **UI** — no reset countdown on UsageTab or header widget |
| utilization thresholds | colour bands only | enforcement gate exists (`hub/src/usage/threshold.ts`, sliders in `UsageTab.tsx:143-234`) — **richer than ClaudeUsage** | none (we're ahead) |
| token counts (in/out/cache) | **no** | **no** — runner drops SDK `usage` (`claude-runner.ts:343` forwards only `cost`+`duration_ms`) | **build new** |
| $ cost per message | no | **no** — only `result.total_cost_usd` per *turn*, and only persisted for scheduled runs | **build new** |
| $ cost per session | no | **no** | **build new** |
| $ cost per day | no | **partial** — `sumTodayCostForUser` (`scheduled-tasks-dal.ts:428`) sums ONLY `scheduled_task_runs.cost_usd`; interactive/webhook chat is **uncounted** | **build new** (real per-message cost feeds this) |
| historical aggregation | no | **no** (in-memory `store.ts` cleared on boot; cost only in `scheduled_task_runs`) | **build new** (new tables) |

**Headline:** the limits side is ~90% built (Opus/oauth-apps just need the real poll + render).
The **token + $ accounting side is essentially greenfield** and is the bulk of the work.

---

## 2. PORT from ClaudeUsage (stays in the SUPERVISOR)

Implement/repair the OAuth utilization poll in the supervisor (Bun TS, `supervisor/src/`),
emitting the existing `usage_report` agent message (`agent-protocol.ts:146-155`). Concretely:

- New module `supervisor/src/usage/oauth-poll.ts`:
  - read `~/.claude/.credentials.json`, parse `claudeAiOauth.accessToken` + `expiresAt`
    (ms). If expired/missing → skip the poll, emit nothing, log a one-line re-auth hint
    (mirror psm1:88-99). **Never** forward the token anywhere.
  - `GET https://api.anthropic.com/api/oauth/usage` with the five headers above
    (pin `anthropic-beta: oauth-2025-04-20`).
  - parse all four windows; map directly onto `AgentUsageReport.usage`
    (`five_hour`, `seven_day`, `seven_day_opus?`, `seven_day_oauth_apps?`). Opus + oauth-apps
    are `.nullable().optional()` — pass through when present.
  - poll every **5 min** (matches the store/threshold comments) on a `setInterval`, plus once
    on connect; send via the existing `/ws/agent` sender used for other agent messages.
- The hub already terminates this correctly: `agent.ts:579-590` validates `usage_report`,
  calls `setUsage(userId, …)`, rebroadcasts `subscription_usage`. **No hub change needed for P1**
  beyond confirming Opus/oauth-apps survive the round-trip (they already type-check).

**Do NOT** add the OAuth token, the credentials path, or the Anthropic call to the hub.

---

## 3. BUILD NEW — token + cost accounting

### 3a. Capture per-turn `usage` from the stream (supervisor)

The Claude Code SDK `result` event carries a `usage` object
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)
and `total_cost_usd`. Today `claude-runner.ts:337-344` reads `r.total_cost_usd` + `r.duration_ms`
but **discards `r.usage` and the model id**. Change (P2):

- In the `result` branch, also read `r.usage` and `r.modelUsage`/`r.model` (SDK exposes
  per-model breakdown in `modelUsage`; fall back to the session's model). Emit a new agent
  message `usage_event`:
  ```
  { type:'usage_event', session_id, model,
    input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
    cost_usd /* SDK total_cost_usd — authoritative */, duration_ms }
  ```
- Codex runner: emit the same shape if/when the Codex CLI surfaces token usage; otherwise omit
  (`cost_usd` null → priced as 0, see 3c).

> **Note — Claude subscription "cost":** under a Max/Pro OAuth subscription, `total_cost_usd`
> from the SDK is the **list-price equivalent** of tokens consumed, not a billed-dollar amount
> (the subscription is flat-rate). We treat it as the canonical cost *estimate* for
> budgeting/cap purposes and label it as such in the UI. This is the single most important
> semantic decision — see Section 9.

### 3b. Data model (new tables in `hub/src/db/schema.sql`)

`schema.sql` **re-runs in full every boot** → idempotent DDL ONLY; any backfill is a one-shot
in `hub/scripts/`. Two tables, both keyed by `user_id`:

```sql
-- Raw per-turn token + cost ledger. One row per assistant `result` event.
CREATE TABLE IF NOT EXISTS token_usage (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id            TEXT,                 -- nullable: rootless/ambient turns
  repo                  TEXT,                 -- project_dir basename for per-repo rollup
  model                 TEXT NOT NULL,        -- e.g. claude-opus-4-8
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cost_usd              NUMERIC(12,6) NOT NULL DEFAULT 0,  -- SDK total_cost_usd if present, else priced from tokens
  cost_source           TEXT NOT NULL DEFAULT 'sdk',       -- 'sdk' | 'priced' (tokens×pricing table)
  duration_ms           INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_session ON token_usage(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_repo    ON token_usage(user_id, repo);

-- Pre-aggregated daily rollup for fast UsageTab reads (avoids scanning the raw ledger).
CREATE TABLE IF NOT EXISTS token_usage_daily (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         DATE NOT NULL,                  -- in the user's tz at write time
  model       TEXT NOT NULL,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, model)
);
```

Write path (P2): the hub `usage_event` handler (sibling to `agent.ts:579`) does, in one txn:
INSERT into `token_usage`, then `INSERT … ON CONFLICT (user_id,day,model) DO UPDATE SET … = +EXCLUDED` into `token_usage_daily`. Idempotency: the raw insert is the source of truth; the
daily rollup is derived and re-derivable from raw via a `hub/scripts/` one-shot if it ever drifts.

### 3c. Pricing table (where it lives + freshness)

- `hub/src/usage/pricing.ts` — a typed const map `MODEL_PRICING: Record<string, {input, output,
  cache_write, cache_read /* USD per 1M tokens */}>`, plus a `priceTokens(model, usage)` helper.
- **Authoritative cost = SDK `total_cost_usd`** when present (`cost_source='sdk'`). The pricing
  table is the **fallback** only when a runner omits `cost_usd` (Codex, older CLIs) — then
  `cost_source='priced'`. This keeps us correct without depending on the table being perfectly
  current.
- Freshness: pricing changes rarely; keep it a committed const with a header comment linking the
  Anthropic pricing page + a `// review-by:` date. A docs-drift-style check can warn if a `model`
  seen in `token_usage` has no pricing entry (telemetry, not a hard fail).

### 3d. Cap reconciliation

Today `isOverCostCap` (`gates.ts:35-43`) → `sumTodayCostForUser` sums only
`scheduled_task_runs`. P3 switches the cap to **real total cost** by summing `token_usage`:

```sql
-- new DAL: sumTodayTokenCostForUser(userId, tz)
SELECT COALESCE(SUM(cost_usd),0) FROM token_usage
WHERE user_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2;
```

`isOverCostCap` switches to this sum. **Behaviour change:** the daily cap now also counts
interactive + webhook chat (today it ignores them — `UsageTab.tsx:280` literally says "Manual
chat is not affected"). This is intended and is the cap's correct semantics, but it is a
user-visible change → ships behind its own phase + QC gate (P3) and the UI copy at
`UsageTab.tsx:278-281` must be updated. IR-1 (cap non-bypassable) is preserved — same gate, new
sum. Keep `scheduled_task_runs.cost_usd` for per-run reporting; just stop using it as the cap's
sole source.

---

## 4. Surfaces (reuse existing styling tokens)

**Header widget** (`web/src/components/UsageStrip.tsx` / `ClaudeUsageCard.tsx`,
`useSubscriptionUsage.ts`): add Opus + reset countdown. Show the worst-utilization window with a
`Nh Mm` countdown (ClaudeUsage's `resets_at - now`), colour band `<50/<80/≥80`. Opus surfaces as
a second pill when `seven_day_opus` present.

**UsageTab** (`web/src/pages/settings/UsageTab.tsx`):
- *Limits card* (new): rows for 5h / 7d / 7d-Opus / 7d-OAuth-apps — each util% + reset countdown
  + colour band. Source: `summary.claude_window` (already plumbed, `UsageTab.tsx:28`) extended
  with the optional windows.
- *Cost cards* (existing Today/Week/Month, `UsageTab.tsx:96-100`): now backed by real
  `token_usage` rollups instead of scheduled-only. Add a per-session and per-repo breakdown
  table (today / 7d) below. Label cost as "estimated (subscription list-price equiv.)".
- Keep `Card`/`Field`/`StatusPill` components and `var(--*)` tokens; no new design system.

---

## 5. Transport

**Extend, don't replace.**
- Limits (P1): keep the existing `usage_report` (agent→hub) and `subscription_usage`
  (hub→clients) messages — Opus/oauth-apps already typed in `agent-protocol.ts:151-152` and
  `protocol.ts:346-348` (verify `protocol.ts` outbound shape includes the optional windows; add
  them if `protocol.ts:348` only declares `five_hour`). No new message needed for limits.
- Token/cost (P2): **new** agent message `usage_event` (supervisor→hub) — it's a distinct,
  higher-frequency, persisted event; overloading `usage_report` (a 5-min snapshot) would conflate
  concerns. Hub persists it; no need to live-broadcast per-turn cost (UsageTab polls
  `/api/usage/summary` every 60s, `UsageTab.tsx:55`). Optionally piggyback a fresh `today_usd` on
  the existing `subscription_usage` broadcast for a live header number — nice-to-have, P3.

---

## 6. Phasing (3 shippable PRs, each with its own QC gate)

- **P1 — Limits completion (port).** Supervisor `oauth/usage` poll emitting all four windows
  (incl. Opus + oauth-apps) via `usage_report`; UsageTab Limits card + header widget render
  Opus/oauth-apps + reset countdowns. Pure additive; no schema, no cap change. QC: `usage-store`,
  `threshold`, `usage-summary-api` tests green + manual: header shows Opus pill + countdown.
- **P2 — Token capture + persistence.** Runner emits `usage_event`; new `token_usage` +
  `token_usage_daily` tables (idempotent DDL); hub handler writes both; `pricing.ts` fallback;
  `/api/usage/summary` extended with token/cost-by-session/repo (reads rollup). No cap change yet
  (cap still scheduled-only — keep `UsageTab.tsx:280` copy until P3). QC: new
  `token-usage-dal.test.ts` + `usage-event-handler.test.ts`; verify rollup == raw sum.
- **P3 — Cost UI + cap reconciliation.** `isOverCostCap`→`sumTodayTokenCostForUser`; UsageTab cost
  cards + per-session/per-repo breakdown from real data; update cap copy (`UsageTab.tsx:278-281`).
  Behaviour change (cap now counts manual chat) → explicit QC gate + rollback note. QC:
  `gates.test.ts` updated for new sum; manual: drive a chat turn, confirm `today_usd` rises and
  cap trips on real spend.

---

## 7. ClaudeUsage local deletion

`C:/Users/artic/GitHub/ClaudeUsage` is a **third-party clone** (`github.com/backmind/ClaudeUsage`,
author "Yass Fuentes", psm1:52,56). It is a standalone PowerShell module — **no code dependency in
remo-code** (not imported; grep for the path/endpoint in the repo returns only remo-code's own
re-implementation, never an import of the psm1). Safe to delete locally once P1 lands (its only
value — the endpoint + parsing — is captured in `supervisor/src/usage/oauth-poll.ts`). No build,
CI, or runtime reference. Recommend: keep until P1 merges as a parsing reference, then `rm -rf`.

---

## 8. Boundary & safety checklist

- OAuth token: supervisor-only, never serialized to hub/DB/WS. ✔ (Section 2)
- `schema.sql` idempotent-only; backfills → `hub/scripts/`. ✔ (Section 3b)
- Cost cap stays non-bypassable (IR-1) — same gate, new sum. ✔ (Section 3d)
- All new tables keyed by `user_id`, `ON DELETE CASCADE`. ✔
- No new secrets to hub. ✔

---

## 9. Single most important design decision

**Pricing source + what the cap counts.** Use the SDK's `total_cost_usd` as the authoritative
per-turn cost (`cost_source='sdk'`), with `pricing.ts` only as a fallback for runners that don't
emit it — this avoids a brittle, perpetually-stale pricing table on the hot path. The corollary:
**flip the daily cost-cap from "scheduled runs only" to "real total token cost"**, so the cap
finally counts interactive + webhook chat (the `token_usage` ledger). That is the one
behaviour-changing, user-visible decision in this spec and is deliberately isolated to P3 with its
own QC gate + the UI-copy update at `UsageTab.tsx:278-281`. Cost is surfaced as an *estimate*
(subscription list-price equivalent), not a billed dollar figure.
