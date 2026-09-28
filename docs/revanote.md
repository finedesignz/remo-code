# Revanote Integration

> Phase 08 — Inbound visual annotations from Revanote → routed as `user_message` into the appropriate Claude session → outbound callback with the resolution.

## Overview

[Revanote](https://app.revanote.com) is a UI visual-commenting tool. A reviewer leaves an annotation on a deployed page (a comment pinned to a DOM element, with a screenshot, deep-link, and optional thread). Revanote POSTs that annotation to remo-code's hub. The hub:

1. Authenticates the webhook (URL-token + optional HMAC).
2. Resolves the page host to a repo (via user-configured `revanote_app_mappings`).
3. Finds the Claude session bound to that repo's `project_dir`.
4. Sends the annotation as a `user_message` (with a `[revanote: <preview>]` storage prefix so it surfaces with a violet **Annotation** pill in the chat UI).
5. Waits for the agent reply, parses a structured `<<JSON>>{…}<<END>>` envelope.
6. **Gates `resolved: true` on the cited commit actually existing on the GitHub remote**
   (`commit-verify.ts` — see "Resolved requires a pushed commit" below) before persisting or
   forwarding it; an unverifiable claim is downgraded to `resolved: false` with a reason.
7. POSTs a callback to Revanote with `{ resolved, action_taken, agent_reply, files_changed, commit_sha, deployed, deploy_url, error? }` — with exponential retry on 5xx/network errors.

## Auth & secret

A single per-user UUID (`users.revanote_webhook_secret`) does triple duty:

- URL-path token on the inbound webhook (`POST /api/revanote/webhook/<user_id>/<token>`).
- HMAC signing key for `X-Revuu-Signature: sha256=<hex>` (when Revanote signs the body — verified when the header is present).
- Bearer credential on outbound callbacks (`Authorization: Bearer <secret>`).

**Rotate** via `POST /api/account/revanote-webhook-secret/rotate` — returns `{ user_id, token, webhook_secret, webhook_url, auth_mode }` in one call, replacing both directions atomically.

## Endpoints

### Public (no auth catch-all)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/api/revanote/webhook/:user_id/:token` | Inbound annotation. Returns `202 { accepted, annotation_id, annotation_id_external }` or `400` / `401`. |

### JWT-authed (license-gated)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`    | `/api/account/revanote-webhook-secret`        | Status + full webhook URL (treat the URL as a secret). |
| `POST`   | `/api/account/revanote-webhook-secret/rotate` | Mint a new secret + URL. |
| `GET`    | `/api/account/revanote-webhook-attempts?limit=10` | Recent webhook hits (success + auth_failed + hmac_failed). |
| `PUT`    | `/api/account/revanote-budget-pct`            | Per-source budget split. `{ budget_pct: 1..100 \| null }`. Default 60. |
| `GET`    | `/api/revanote/mappings`                      | List repo mappings. |
| `POST`   | `/api/revanote/mappings`                      | Create. Body: `{ hostname_pattern, repo_path, supervisor_id?, deploy_strategy?, auto_merge?, enabled? }`. |
| `PATCH`  | `/api/revanote/mappings/:id`                  | Partial update. |
| `DELETE` | `/api/revanote/mappings/:id`                  | Remove. |
| `GET`    | `/api/revanote/mappings/resolve?host=…`       | Debug: best-match mapping for a host. |
| `GET`    | `/api/revanote/annotations`                   | List annotations. `?status=&limit=`. |
| `GET`    | `/api/revanote/annotations/:id`               | Annotation + run history. |
| `POST`   | `/api/revanote/annotations/:id/retry`         | Reset to `pending` + re-dispatch. |

## Inbound payload

```jsonc
{
  "source": "revanote",
  "revanote_version": "1.0.0",
  "annotation_id": "<revanote's own id>",
  "annotation_url": "https://app.revanote.com/review/<project_id>#annotation-<id>",
  "page_url": "https://app.example.com/dashboard",
  "screenshot_url": "https://cdn.revanote.com/shots/abc.png",
  "x": 120, "y": 240,
  "element_selector": "button.cta",
  "element_meta": { /* opaque — preserved on annotations.payload_raw */ },
  "capture_viewport": { /* opaque — preserved on annotations.payload_raw */ },
  "comment": "the button is the wrong color",
  "comment_preview": "the button is the wrong colo…",
  "replies": [{ "author": "jay", "text": "really wrong", "ts": "…" }],
  "callback_url": "https://app.revanote.com/api/agent-callbacks",
  "timestamp": 1716800000   /* optional; enforced as 5-min skew when present */
}
```

`element_meta` and `capture_viewport` are passed through to the agent prompt without schema columns — they live in `annotations.payload_raw` so future Revanote-side additions never break the contract.

## Repo→app mappings

Each user defines mappings under Settings → Revanote:

| Field | Meaning |
| ----- | ------- |
| `hostname_pattern` | Literal (`app.example.com`) or leading-glob (`*.example.com`) or `*`. Most-specific match wins; ties broken by most-recently-updated. |
| `repo_path` | Absolute path on the agent host. Hub uses `findSessionByProjectDir(userId, repo_path)` to resolve the bound Claude session. |
| `supervisor_id` | Optional pin to a specific supervisor. |
| `deploy_strategy` | `pr` (default), `direct`, or `none`. Controls the in-prompt instructions to Claude — the hub itself does NOT shell out. **Only honoured when `trusted = true`** (see below). |
| `auto_merge` | Only meaningful with `pr` strategy. **Only honoured when `trusted = true`.** |
| `trusted` | BOOLEAN, **default `false`**. Self-heal containment: an annotation body is webhook-derived, UNTRUSTED prose, so `deploy_strategy='direct'` (commit straight to main) and `auto_merge=true` (squash-merge without review) are inert unless the owner explicitly marks the mapping trusted. Untrusted mapping ⇒ `renderAnnotationPrompt` forces propose-only (PR, human merges) whatever the payload says. Idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `schema.sql`; no UI/API surface yet — flip it in the DB deliberately. |
| `enabled` | Disable a mapping without deleting it. |
| `auto_created` | `true` when the smart-fallback path inserted the row from a supervisor-reported repo host match (user must touch the row in Settings to confirm). |

## Agent prompt envelope

**Untrusted fence + scope contract.** The reviewer's comment, replies, `element_meta`, selector
and page URL are wrapped in an `<untrusted_annotation>…</untrusted_annotation>` fence via the
shared `hub/src/dispatch/untrusted.ts` (`fenceUntrusted` escapes every `<`, so a hostile comment
cannot close the fence and issue instructions), and the prompt is prefixed with the shared
`SCOPE_CONTRACT` (data-not-instructions, minimal change, no unrelated files, stop rather than
guess, propose-only). A `trusted` mapping additionally gets a line saying the Deploy plan
overrides the propose-only rule.

The hub renders a Markdown prompt and instructs Claude to end the reply with:

```
<<JSON>>
{
  "resolved": true,
  "action_taken": "short summary",
  "files_changed": ["a.tsx", "b.ts"],
  "commit_sha": "the full pushed commit SHA that made this fix",
  "deployed": true,
  "deploy_url": "the live URL re-fetched to confirm the change",
  "needs_clarification": false
}
<<END>>
```

The hub-side parser (`hub/src/revanote/result-schema.ts`) tolerates:

1. The envelope (preferred).
2. A ```` ```json ```` fenced block (fallback).
3. Bare prose (last resort — synthesizes `{ resolved: false, action_taken: "parse_failed", agent_reply: <raw> }`).

The web `MessageBubble` strips the envelope (and stray ```` ```json ```` fences) from the displayed assistant text via `stripRevanoteEnvelope` so the user only sees natural language.

### Resolved requires a pushed commit (commit-verify gate)

**Incident (2026-09-14, Lakeside project):** a background subagent marked 43 annotations
`resolved: true`, citing commit `86ad71296` on every single one. That commit was real but
**dangling** — never on any branch, never pushed, never deployed — and topically unrelated to
any of the 43 fixes. Nothing verified the citation before the hub forwarded `resolved: true` to
revanote, so 43 real client comments were closed with zero shipped work. Root cause: the
prompt *asked* for honest self-verification, but nothing in the hub *enforced* it — the prompt
was advisory, not a gate.

The fix is code, not prose. `hub/src/revanote/commit-verify.ts`'s `verifyCommitOnRemote()` is
called from `finalizeAnnotationReply` (`run-lifecycle.ts`) **before** any `resolved: true` is
persisted or forwarded:

- The agent's envelope must carry `commit_sha` (the full pushed commit hash) when it sets
  `resolved: true`.
- The hub resolves `installation_id` + `repo_slug` from the annotation's stored dispatch
  payload (`payload_raw`, the same fields the Phase 5/6 merge gate already uses) and calls
  `GET /repos/{owner}/{repo}/commits/{sha}` via the existing GitHub App installation token
  (`hub/src/auth/github-app.ts` — no new credential; this is the same auth the merge gate uses
  to open/merge PRs).
- **200** (commit exists on the remote) → the claim is trusted; `resolved: true` proceeds
  unchanged.
- **Anything else** — missing `commit_sha`, missing `installation_id`/`repo_slug` context, an
  unparseable repo slug, a 404 (commit not on the remote — the exact Lakeside shape), or any
  other API error — **fails closed**: the annotation is downgraded to `resolved: false` before
  the run/status rows are written and before the callback is enqueued. The downgrade reason
  (`commit_sha_missing` / `repo_context_missing` / `repo_slug_unparseable` /
  `commit_not_on_remote` / `commit_verify_failed`) is recorded as the annotation's `skip_reason`
  and surfaced to revanote as the callback's `error` field, so the client-visible state and the
  reviewer both see *why* it wasn't actually closed.
- `resolved: false` replies (including `needs_clarification`) never touch this gate — it only
  ever narrows a `true` claim, never widens a `false` one.
- The prompt (`hub/src/revanote/prompt.ts`) was updated to make this explicit to the agent:
  `resolved: true` only after the commit is pushed, the site is redeployed, and `page_url` has
  been re-fetched to confirm the change is live — plus the new `commit_sha`/`deploy_url`
  envelope fields. **This prompt text is advisory only.** The code-level gate above is what
  actually prevents a repeat of the incident; an agent that ignores the prompt and pastes a
  fabricated hash is caught by the 404, not by good behavior.

Tests: `hub/test/revanote-commit-verify.test.ts` (the gate itself, GitHub API mocked — no real
network) and `hub/test/revanote-run-lifecycle-commit-gate.test.ts` (the finalize-lifecycle
integration: unpushed/dangling SHA → downgraded, missing SHA → downgraded, verified SHA →
forwarded, `resolved: false` replies bypass the gate entirely).

### Batch protocol (owner directive, 2026-09-27): one branch/PR per review, merge+deploy before resolving

A Revanote review commonly dispatches many comments at once (the incident above was 43 on one
review). The prompt (`hub/src/revanote/prompt.ts`) tells the agent: when handling more than one
comment in the same session, batch every comment onto **one branch** and open **one pull
request** covering all of them — not a branch/PR per comment. Before marking *any* comment
resolved, the agent must, in order: (1) push the batch branch and open the PR once, (2) wait for
CI to go green, (3) merge the PR itself, (4) redeploy the site serving the `page_url` host, (5)
re-fetch **each comment's own** `page_url` to confirm that specific change is live. Only then may
it emit `resolved: true`, citing the **merged** commit SHA on the repo's default branch (never a
local/unmerged branch-tip SHA) as `commit_sha`, and the confirmed live URL as `deploy_url`. A
comment it cannot verify this way gets `resolved: false` or `needs_clarification: true` with a
reason — never a guess.

**This is prompt text, advisory only — same caveat as everywhere else in this doc.** The
code-level gate (`commit-verify.ts`, above) is unchanged and is what actually enforces it: a
merged commit on the default branch is on the remote, so `GET /repos/{owner}/{repo}/commits/{sha}`
returns 200 and the claim passes; an agent that skips the merge and cites its local branch-tip SHA
gets the exact same 404-driven downgrade as the original incident, regardless of what the prompt
asked for.

**Per-comment dispatch is unchanged by this directive.** Investigated 2026-09-27 following
PR #489 ("queue revanote bursts instead of dispatching them as session_busy"): a Revanote review
of N comments does **not** reach the session as one prompt covering the whole batch. Each
annotation is its own dispatch token (`hub/src/revanote/dispatcher.ts` → `dispatch()` in
`hub/src/dispatch/pipeline.ts`), and the per-session `SessionQueue` admits exactly one in-flight
token with the rest FIFO-waiting (`REMO_DISPATCH_MAX_WAITERS`, default 50) — PR #489 raised that
waiter count so a large burst queues instead of being dropped as `session_busy`, it did not change
the one-token-at-a-time shape. So the agent receives N **separate** `user_message` turns, one per
comment, each finalized independently through `run-lifecycle.finalizeAnnotationReply`. The batch
protocol above therefore relies on the agent's own session memory across those sequential turns
(recognizing it already has a batch branch/PR open from an earlier comment in the same review) —
it is not a single-shot batched prompt, and this fix does not restructure dispatch to make it one.
The existing Phase 5/6 merge-gate batch aggregation (`batch_id`/`batch_size` in each annotation's
`payload_raw`, `hub/src/revanote/merge-gate.ts`) is a separate, hub-side mechanism for aggregating
merge/PR *decisions* across per-comment finalizes — it does not itself batch the *prompts*.

## Outbound callback

```http
POST <callback_url>
Authorization: Bearer <revanote_webhook_secret>
X-Revanote-Webhook-Source: remo-code
Content-Type: application/json

{
  "annotation_id": "<external annotation_id>",
  "resolved": true,
  "action_taken": "Updated tailwind class to fix alignment",
  "agent_reply": "Found it — the flex-direction was reversed…",
  "files_changed": ["web/src/components/MessageBubble.tsx"],
  "commit_sha": "a1b2c3d4e5f6...",
  "deployed": true,
  "deploy_url": "https://app.example.com/dashboard",
  "needs_clarification": false,
  "clarification_question": null,
  "error": null
}
```

**Retry curve (jittered ±10%):** `1m → 5m → 15m → 1h → 4h → 12h → dead-letter`. 4xx responses are terminal; 5xx and network errors retry. Each attempt writes a row to `revanote_callback_attempts`; a single worker (30 s tick, `FOR UPDATE SKIP LOCKED` claim) drives delivery.

**`deployed: true` means the agent pushed to the deploy branch — NOT that Coolify finished building and is serving traffic.** Polling deploy-status is deferred to a follow-up phase.

## Pre-dispatch rejection callbacks

The callback is also fired (immediately, with `resolved: false` + an `error` tag) for these pre-dispatch outcomes:

| `error` tag | Meaning |
| ----------- | ------- |
| `budget_threshold` | Claude usage threshold or per-source revanote budget exceeded. |
| `no_target` | No mapping matches the page_url host, or no Claude session bound to the resolved `repo_path`. |
| `session_busy` | The bound session already has 1 in-flight + `REMO_DISPATCH_MAX_WAITERS` (default 50) waiters. |

Session-offline is the exception: it parks in the 10-min grace buffer instead of firing an immediate failure callback.

## Cost cap, thresholds, concurrency

**Round-2 migration:** revanote dispatch now runs on the **shared session-dispatch pipeline** (`hub/src/dispatch/`) — the same deep module the error-capture pilot uses. `hub/src/revanote/dispatcher.ts` is a thin adapter that builds a `RunStore` + a `gates[]` array and calls `dispatch(req, deps)`. The hand-rolled threshold/budget/queue/grace/finalize machinery is gone.

- Gate chain (first block wins, IR-2): `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, revanoteBudgetGate(userId, tz)]`.
  - `sessionInjectRateGate` (default 4 injects/session/hour) bounds the inject RATE, so an annotation flood cannot drive N turns/hour into the bound session.
  - `thresholdGate` + `dailyCostCapGate` are the shared gates in `hub/src/dispatch/gates.ts`. The global daily cost cap is **non-bypassable** (IR-1) — the migration ADDS it (the legacy revanote dispatcher only had the Claude usage threshold + the per-source budget).
  - `revanoteBudgetGate` is a revanote-specific `DispatchGate` (defined in `dispatcher.ts`, exported for unit test) that enforces the per-source split (`users.revanote_budget_pct`, default 60% of the daily cap) **layered ON TOP of** the global cost cap, never a substitute. Over-budget → `revanote_budget_exceeded:<detail>` skip + reject callback.
- The per-session queue (1 in-flight + `REMO_DISPATCH_MAX_WAITERS` FIFO waiters, default 50 — was 1, which dropped every annotation past the second in a burst as `session_busy`) lives in `hub/src/dispatch/session-queue.ts` (instance owned by the pipeline). Concurrent annotations against the same session serialize through it in arrival order; re-dispatching an annotation already queued/in flight is a no-op (token = annotation id); a queued waiter does NOT open an `annotation_run` row until promotion re-dispatches it. Waiters are in memory — a hub restart drops them (revanote's own stale-lease sweep re-dispatches).
- **Silent-agent ceiling:** `finalizeTimeoutMs` (20 min) only fires when a NEW `assistant_message` arrives. An agent that replies "done" without the `<<JSON>>` envelope and then goes quiet used to hold the session slot forever. The boot-started `startHookReaper()` (`pipeline.ts` `reapTimedOutHooks`) finalizes such a hook with empty content after `REMO_DISPATCH_HOOK_MAX_MS` (default 2h) → `envelope_missing` / `resolved:false` callback, then promotes the next waiter.
- **Wedge fix:** when the head parks offline or its send throws, a waiter that queued behind it meanwhile is now re-dispatched. Previously it was moved into the in-flight slot with no finalize hook, so nothing ever freed the slot and every later annotation for that session came back `session_busy` until a hub restart.
- Offline target → parked in the **shared** `getGraceBuffer()` (`hub/src/dispatch/grace.ts`) keyed by `sessionId` (10-min TTL). On agent reconnect, `ws/agent.ts` calls `getGraceBuffer().drain(sessionId)` (one drain replays both error-capture and revanote). TTL lapse → annotation `failed_offline` / `target_offline_expired` via the adapter's `onParkExpire`.
- Finalize: the agent ws assistant_message branch calls `dispatch.onSessionReply(sessionId, content)`, which fires the adapter's `RunStore.onFinalize`. That hook delegates to `run-lifecycle.finalizeAnnotationReply` — envelope parse (`<<JSON>>…<<END>>`) → annotation resolved/failed → merge gate → outbound callback enqueue (callback ALWAYS carries `annotation_id`). There is no longer a revanote-specific `onAgentReply` call in `ws/agent.ts`.

## WS events

Lifecycle events broadcast to all clients of the user (use `subscribe` from `useWebSocket`):

- `revanote_received` — webhook accepted, row inserted.
- `revanote_dispatched` — `user_message` sent to Claude.
- `revanote_skipped` — pre-dispatch gate refused (offline / busy / cap / threshold).
- `revanote_resolved` — agent finished. Includes `resolved`, `files_changed`, `deployed`.
- `revanote_callback_sent` — one callback attempt finished. `delivered: true` is terminal success; `dead: true` is terminal failure.

## Tables (additive — all `CREATE TABLE IF NOT EXISTS`)

| Table | Purpose |
| ----- | ------- |
| `users.revanote_webhook_secret` | Single UUID — URL token + HMAC key + outbound Bearer. |
| `users.revanote_budget_pct` | Per-source daily-cap fraction (1..100, default 60). |
| `revanote_app_mappings` | Hostname pattern → repo_path + deploy strategy. |
| `annotations` | Durable record of every inbound annotation. UNIQUE `(user_id, annotation_id_external)`. |
| `annotation_runs` | One row per Claude turn that processed an annotation. |
| `revanote_callback_attempts` | Retry queue. `next_retry_at IS NULL` = terminal (delivered or dead). |
| `revanote_webhook_attempts` | Audit log (capped 100/user). |

## File map

- `hub/src/api/revanote-webhook.ts` — public ingress.
- `hub/src/api/revanote-mappings.ts` — JWT-authed mapping CRUD.
- `hub/src/api/revanote-annotations.ts` — JWT-authed list / detail / force-retry.
- `hub/src/api/account.ts` — adds `/revanote-webhook-secret*` + `/revanote-budget-pct` endpoints.
- `hub/src/db/revanote-dal.ts` — all revanote queries.
- `hub/src/db/schema.sql` — additive schema (search "Phase 08").
- `hub/src/revanote/payload-schema.ts` — inbound payload zod.
- `hub/src/revanote/result-schema.ts` — `<<JSON>>…<<END>>` envelope parser + `stripRevanoteEnvelope`.
- `hub/src/revanote/prompt.ts` — agent-prompt builder + `previewComment` + `storagePrefix`.
- `hub/src/dispatch/{pipeline,gates,session-queue,grace}.ts` — **shared** session-dispatch pipeline (revanote, error-capture both ride it). Round-2.
- `hub/src/revanote/dispatcher.ts` — thin adapter on `dispatch()`: session/mapping resolve + `RunStore` (annotation_runs lifecycle) + `gates[]` (incl. `revanoteBudgetGate`) + offline `replay`/`onParkExpire` + `send` + outcome→WS-event mapping.
- `hub/src/revanote/run-lifecycle.ts` — `finalizeAnnotationReply` (the `onFinalize` hook body): envelope parse → annotation status → merge gate → callback enqueue. No longer owns a session-keyed Map or queue promotion (the pipeline does).
- `hub/src/revanote/callback.ts` — outbound delivery worker + retry curve (unchanged).
- `hub/src/ws/protocol.ts` — adds 5 revanote lifecycle events to the `HubToClient` union and a `RevanoteEvent` zod union.
- `hub/src/ws/registry.ts` — `broadcastRevanoteEvent`.
- `hub/src/ws/agent.ts` — `onSessionReply` (shared pipeline finalize fan-in) + shared `getGraceBuffer().drain()` on agent connect. The legacy revanote `onAgentReply` + `revanote/grace.ts` drain are removed.

> **Removed in Round-2:** `hub/src/revanote/grace.ts` (replaced by the shared `getGraceBuffer()`); the revanote `onAgentReply`/`onAgentError` + session-registry path (replaced by the pipeline's `onSessionReply` + `RunStore.onFinalize`).
- `web/src/components/RevanotePage.tsx` — annotations list at `#/revanote`.
- `web/src/components/MessageBubble.tsx` — violet **Annotation** pill + envelope strip on assistant replies.
- `web/src/lib/revanote-message.ts` — `parseRevanotePrefix` + `stripRevanoteEnvelope`.

## Tests

- `hub/test/revanote-result-schema.test.ts` — envelope / fence / fallback / bad JSON.
- `hub/test/revanote-prompt.test.ts` — `previewComment` graphemes + envelope shape per strategy.
- `hub/test/revanote-callback.test.ts` — retry curve invariants + dead-letter threshold.
- `hub/test/revanote-webhook.test.ts` — URL-token + HMAC + raw-body-before-parse + audit log + idempotency.
- `hub/test/revanote-message.test.ts` — `[revanote: …]` prefix regex contract.
- `hub/test/revanote-dispatch.test.ts` — **Round-2** adapter↔pipeline wiring: `open()` fires exactly once on dispatch (annotation_run lifecycle), `onSessionReply` finalizes + enqueues the callback (annotation_id always present), the `revanoteBudgetGate` blocks over-budget independently of the cost cap, and IR-1 cost-cap non-bypassable.

## Cross-side contract notes

See `.planning/phases/08-revanote-integration/08-CONTEXT.md` "Confirmed cross-side contract". Briefly:

- Revanote sets `source: 'revanote'`, `revanote_version`, `annotation_url`.
- Hub uses `annotation_url` as the violet pill's href when present; falls back to plain text when absent.
- The rotate endpoint returns BOTH the new URL slug AND the bearer secret in one call.
- The callback always includes `annotation_id` (the external one), even on pre-dispatch rejections.
- Comment preview is sliced locally via `Intl.Segmenter` (`renderAnnotationPrompt` / `previewComment`). If Revanote pre-slices `comment_preview` we use it; otherwise we slice from `comment` (first 30 grapheme clusters).

## Out of scope (deferred)

- Coolify deploy-status poll → enriched callback with `live_at`.
- Slack/Discord ping on `resolved: false`.
- Per-mapping prompt-template override.
- Cross-annotation batching (multiple annotations on the same page within 1 h merged into one Claude turn).
- Two-way replies (agent → user → agent loop in the Revanote thread).
