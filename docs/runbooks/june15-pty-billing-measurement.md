# Operator Runbook — June-15 PTY Billing Classification Measurement

**Run this on or after 2026-06-15, at the live prod UI, signed in as the operator.**

This is the hands-on companion to [`docs/cutover-gate-june15.md`](../cutover-gate-june15.md) and the
[`cutover-gate-checklist.md`](../../.planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md).
It exists because the measurement **cannot be run by any cloud/automated agent** — it requires a real
operator driving an interactive `claude` PTY turn at the live web terminal and reading the live
dual-bucket usage snapshot. Fill the checklist's Result column from what you observe here.

---

## Why this is overdue (read first)

- The web/phone human terminal was cut over to the **interactive Claude PTY** on **2026-06-04**.
- Prod currently runs Claude-PTY as the default human backend via an **operator override**
  (`claude_interactive_confirmed = true`).
- The cutover gate's own decision rule says this flag should stay **unset** (→ fail-safe `codex-pty`)
  **until check 1 below records `interactive`**. So every human web/phone turn since June 4 has been
  billing **without a confirmed classification**.
- **Billing exposure:** if interactive `claude` PTY turns actually bill the *programmatic* pool rather
  than the *interactive* subscription buckets, the override has been mis-billing for the whole window.
  This measurement closes that gap.

---

## What you'll read (the dual-bucket snapshot)

All four checks are a **before/after diff** of the live usage snapshot. Source of truth:

- **Endpoint:** `GET /api/usage/summary` → field **`claude_window`** (the in-memory OAuth snapshot,
  rebroadcast on the `subscription_usage` WS path). Authenticated (your session cookie).
- **Interactive buckets** — utilization/`used` on the subscription windows:
  - `claude_window.five_hour`
  - `claude_window.seven_day`
  - (Max-only, if present) `seven_day_opus`, `seven_day_oauth_apps`
- **Programmatic bucket** — the Agent-SDK dollar credit pool:
  - `claude_window.programmatic_credit.used_usd`

> The snapshot is **in-memory only** (resets on hub restart) and is **not** persisted to the DB, which
> is why there is no historical query — you must diff two live readings around one controlled turn.

### How to snapshot

Either read the Usage tab in the web UI, or pull it directly (replace `<COOKIE>` with your session
cookie value, or run from an authenticated browser devtools fetch):

```bash
curl -s https://app.remo-code.com/api/usage/summary \
  -H "Cookie: remo_session=<COOKIE>" | jq '.claude_window | {
    five_hour, seven_day, seven_day_opus, seven_day_oauth_apps,
    programmatic_used_usd: .programmatic_credit.used_usd
  }'
```

Record the BEFORE object, run the controlled turn, wait for the supervisor poll to refresh (~5 min
interval — `supervisor/src/usage/oauth-poll.ts`), then record the AFTER object and diff.

---

## The four checks

For each: **snapshot → run ONE controlled interactive `claude` PTY turn → snapshot → diff**. The
turn MUST be the genuine interactive TUI (raw bytes, empty argv — **no** `-p`, no
`--input-format`/`--output-format`, no `stream-json`, no API key). A trivial prompt like
"say hello" is enough to move a bucket.

| # | Check | How | Record |
|---|-------|-----|--------|
| 1 | Interactive `claude` PTY turn → which bucket? | One interactive turn, signed in via `login` (OAuth). | `interactive` \| `programmatic` \| `unknown` |
| 2a | `login` auth path | Same as #1, explicitly via `login`. | per-auth result |
| 2b | `setup-token` auth path (**SUSPECT**) | Repeat once authed via `setup-token`; it may carry the programmatic class. | per-auth result |
| 3 | Subagent + hook + MCP inside an interactive session | One interactive turn that triggers a subagent, a hook, and an MCP tool call. Confirms in-session automation doesn't silently bill programmatic under an interactive turn. | `interactive` \| `programmatic` \| `unknown` |
| 4 | Headless reclassification (**ONGOING WATCH**) | Re-run #1 periodically — Anthropic may reclassify how `login` credentials bill over time. Not one-time. | result + date |

**Reading the diff:** if the `five_hour`/`seven_day` interactive utilization moved and
`programmatic_credit.used_usd` did **not**, the result is `interactive`. If `programmatic_used_usd`
rose, the result is `programmatic`. If neither clearly moved (or the poll didn't refresh), record
`unknown` and retry.

---

## Decision rule (UNAMBIGUOUS)

Apply based on **check 1**:

- **`interactive`** ⇒ keep Claude-PTY. Set / confirm `claude_interactive_confirmed = true` and
  `default_human_backend = 'claude'` (resolves to `claude-pty`). The current override is now *justified*.
- **`programmatic`** ⇒ **FAIL-SAFE.** Set `default_human_backend = 'codex'` (resolves to `codex-pty`)
  and leave `claude_interactive_confirmed` unset. Alert + investigate the week of mis-billing.
- **`unknown` / not-yet-measured** ⇒ **FAIL-SAFE** to `codex-pty`. Claude-PTY is never the default
  until check 1 records `interactive`.

The flip is a **recorded config change**, not automatic, and is reversible: a later check-4 result of
`programmatic` re-disables Claude-PTY (selector unlists it; only an explicit operator override
re-enables). Logic lives in `supervisor/src/runners/backend-selector.ts`.

---

## After measuring

1. Fill the **Result** + **Recorded by** + **Date** columns in
   `.planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md`.
2. Fill the **Decision** table (`claude_interactive_confirmed`, `default_human_backend`).
3. Apply the config per the decision rule.
4. Update the project memory note `project_interactive_pty_runner_milestone.md` (the "MUST re-verify
   June-15 billing" line) with the result + date.

> **Separate gate — not part of this measurement:** the ChatSurface (stream-json) deletion is gated
> independently by `tools/cutover-deletion-gate.mjs`, which needs the two on-device attestation
> triplets in `16-VERIFICATION.md` (render_fidelity + mobile_reattach). Do **not** delete ChatSurface
> based on the billing result alone.
