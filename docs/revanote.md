# Revanote Integration

> Phase 08 — Inbound visual annotations from Revanote → routed as `user_message` into the appropriate Claude session → outbound callback with the resolution.

## Overview

[Revanote](https://app.revanote.com) is a UI visual-commenting tool. A reviewer leaves an annotation on a deployed page (a comment pinned to a DOM element, with a screenshot, deep-link, and optional thread). Revanote POSTs that annotation to remo-code's hub. The hub:

1. Authenticates the webhook (URL-token + optional HMAC).
2. Resolves the page host to a repo (via user-configured `revanote_app_mappings`).
3. Finds the Claude session bound to that repo's `project_dir`.
4. Sends the annotation as a `user_message` (with a `[revanote: <preview>]` storage prefix so it surfaces with a violet **Annotation** pill in the chat UI).
5. Waits for the agent reply, parses a structured `<<JSON>>{…}<<END>>` envelope.
6. **Gates `resolved: true` on the cited commit actually being merged to the repo's default
   branch** (`commit-verify.ts` — see "Resolved requires a commit merged to the default branch"
   below) before persisting or forwarding it; an unverifiable claim is downgraded to
   `resolved: false` with a reason.
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
  "commit_sha": "the full commit SHA merged to the default branch that made this fix",
  "branch": "the branch it was pushed to",
  "deployed": true,
  "deploy_url": "the live URL re-fetched to confirm the change",
  "needs_clarification": false
}
<<END>>
```

**A resolve must stand on a pushed commit (fix/revanote-verify-pushed).** The agent's envelope is
self-report, and the prompt telling it to push first is not a control: in 2026-09 comments were
reported `resolved` from commits that were never pushed. So `finalizeAnnotationReply` checks every
`resolved: true` itself (`hub/src/revanote/commit-verify.ts`): the reply must carry a `commit_sha`
(7–40 hex), and the hub confirms through the GitHub App (`GET /repos/{owner}/{repo}/commits/{sha}`,
repo from `sessions.github_owner/github_repo`, falling back to the payload's `repo_slug`) that the
commit exists on the remote AND is MERGED to the repo's default branch (`GET /repos/{o}/{r}` ->
`default_branch`, then `compare` default...sha must be `identical`/`behind`; a pushed-but-unmerged
PR-branch tip is rejected `commit_not_on_default_branch`) — and, when a `branch` is given, that the
branch contains it too. The check runs AFTER the merge gate, because the sandbox
path pushes inside the gate. Any failure downgrades the reply to `resolved: false`,
`deployed: false`, annotation `failed`, and the callback's `error` becomes
`unverified_resolve:<reason>` — reasons: `commit_sha_missing`, `commit_sha_invalid`, `repo_unknown`,
`no_github_installation`, `commit_not_pushed`, `commit_not_on_default_branch`, `commit_not_on_branch`, `verify_error`. Fail-closed:
an unverifiable resolve is rejected, never trusted. The verified sha is written to
`annotation_runs.commit_sha` and sent as the callback's `commit_sha`. Escape hatch:
`REMO_REVANOTE_REQUIRE_PUSHED_COMMIT=0|false|no|off` (default ON).

The hub-side parser (`hub/src/revanote/result-schema.ts`) tolerates:

1. The envelope (preferred).
2. A ```` ```json ```` fenced block (fallback).
3. Bare prose (last resort — synthesizes `{ resolved: false, action_taken: "parse_failed", agent_reply: <raw> }`).

The web `MessageBubble` strips the envelope (and stray ```` ```json ```` fences) from the displayed assistant text via `stripRevanoteEnvelope` so the user only sees natural language.

### Resolved requires a commit MERGED to the default branch (commit-verify gate)

**Incident (2026-09-14, Lakeside project):** a background subagent marked 43 annotations
`resolved: true`, citing commit `86ad71296` on every single one. That commit was real but
**dangling** — never on any branch, never pushed, never deployed — and topically unrelated to
any of the 43 fixes. Nothing verified the citation before the hub forwarded `resolved: true` to
revanote, so 43 real client comments were closed with zero shipped work. Root cause: the
prompt *asked* for honest self-verification, but nothing in the hub *enforced* it — the prompt
was advisory, not a gate.

**Follow-up gap (found by QC):** the first version of this gate called only
`GET /repos/{owner}/{repo}/commits/{sha}`, which returns 200 for a commit reachable from ANY
branch — so a sha pushed to an open, unmerged PR branch also passed. Owner rule: resolved only
once the fix is **merged to the default branch**, not merely pushed somewhere.

The fix is code, not prose. `hub/src/revanote/commit-verify.ts`'s `verifyCommitOnRemote()` is
called from `finalizeAnnotationReply` (`run-lifecycle.ts`) **before** any `resolved: true` is
persisted or forwarded:

- The agent's envelope must carry `commit_sha` (the full commit hash, merged to the default
  branch) when it sets `resolved: true`.
- The hub resolves `installation_id` + `repo_slug` from the annotation's stored dispatch
  payload (`payload_raw`, the same fields the Phase 5/6 merge gate already uses), fetches the
  repo's `default_branch` via `GET /repos/{owner}/{repo}` (same pattern the merge gate uses in
  `openPr`), then calls `GET /repos/{owner}/{repo}/compare/{default_branch}...{sha}` via the
  existing GitHub App installation token (`hub/src/auth/github-app.ts` — no new credential;
  this is the same auth the merge gate uses to open/merge PRs).
- Compare `status` **`identical`** (sha IS the default-branch head) or **`behind`** (sha is an
  ancestor of the default-branch head) → the claim is trusted; `resolved: true` proceeds
  unchanged.
- **Anything else** — missing `commit_sha`, missing `installation_id`/`repo_slug` context, an
  unparseable repo slug, a default-branch lookup failure, a compare `status` of `ahead` (an
  unmerged branch tip — the gap this fix closes) or `diverged`, a compare 404 (sha not on the
  remote at all — the exact Lakeside shape), or any other API error — **fails closed**: the
  annotation is downgraded to `resolved: false` before the run/status rows are written and
  before the callback is enqueued. The downgrade reason (`commit_sha_missing` /
  `repo_context_missing` / `repo_slug_unparseable` / `default_branch_lookup_failed` /
  `commit_not_on_default_branch` / `commit_not_on_remote` / `commit_verify_failed`) is recorded
  as the annotation's `skip_reason` and surfaced to revanote as the callback's `error` field, so
  the client-visible state and the reviewer both see *why* it wasn't actually closed.
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

### Batch protocol (feat/revanote-batch-dispatch): one turn, one branch/PR per review, merge+deploy before resolving

A Revanote review commonly dispatches many comments at once (a prior incident was 43 on one
review). Sequential per-annotation dispatch cannot produce "all comments of one review fixed in
ONE PR" on its own: the shared pipeline (`hub/src/dispatch/pipeline.ts` `onSessionReply`) only
releases the next queued token once the CURRENT one finalizes
(`run-lifecycle.finalizeAnnotationReply`), so N comments dispatched one at a time become N
separate agent turns / branches / PRs, relying on the agent's own cross-turn memory to avoid it —
unsatisfiable in practice.

**Coalescing is keyed ONLY on `batch_id`** (`payload_raw.batch_id`, a UUID Revanote stamps on a
burst it fires together — sampled at only 3/88 recent prod annotations at design time, but where
present it correctly grouped a burst; no other grouping key such as `page_url` proximity or
arrival timing alone is used). An annotation without `batch_id` stays on the unchanged
single-annotation path below.

- **Dispatch** (`hub/src/revanote/dispatcher.ts` `dispatchAnnotationRow`): once mapping/session
  resolution succeeds, an annotation carrying `batch_id` is NOT sent — it stays `status='pending'`
  and the call returns without building a prompt.
- **Coalescing sweep** (`hub/src/revanote/batch-dispatch.ts` `sweepBatchDispatch`, boot-started via
  `startBatchSweep()` in `hub/src/index.ts`): a fully DB-state-driven poll (default every
  `REMO_REVANOTE_BATCH_POLL_MS` = 5s, no per-batch timer state, no buffering of annotation content
  in memory — restart-safe by construction). Each tick re-reads `pending` annotations carrying a
  `batch_id`, groups them by `(user_id, batch_id, resolved target session, resolved mapping)`, and
  dispatches a group once no NEW arrival has landed for `REMO_REVANOTE_BATCH_DEBOUNCE_MS` (default
  30s) measured from the group's LATEST `received_at` — a fresh arrival extends the window. A late
  arrival AFTER a group already dispatched forms a brand-new group on a later tick, never appended
  to an in-flight turn. A member that can't resolve a mapping/session fails immediately (same
  `no_mapping_for_host`/`session_not_found_for_repo` semantics as the single path) and never blocks
  its siblings. **The mapping is part of the sub-group key (qcfix/batch-claim, C5)**: prod runs
  ~23 client sites, each with its own mapping/trust config, sharing ONE session, so grouping by
  session alone could put an UNTRUSTED site's annotation in the same dispatched batch as a TRUSTED
  site's — and `renderBatchAnnotationPrompt` derives its one deploy trust/strategy from a single
  member. Grouping by mapping too guarantees every dispatched batch is single-mapping.
- **One prompt, one turn** (`hub/src/revanote/prompt.ts` `renderBatchAnnotationPrompt`): every
  member's reviewer-authored content is fenced separately (still untrusted per item), tagged with
  its EXTERNAL annotation id. The contract: push ONE branch, open ONE PR covering every comment,
  wait for CI, merge it, redeploy the site serving the `page_url` host(s), then re-fetch **each
  comment's own** `page_url` to confirm THAT specific change is live before citing it as resolved.
  Reply once with a single `<<JSON>>{"annotations":[...]}<<END>>` envelope — one object per
  annotation id, each citing its own `commit_sha`/`deploy_url` (`result-schema.ts`
  `RevanoteBatchResult`).
- **A single (non-batched) annotation's contract was corrected in the same change**: it previously
  told the agent to "batch across sequential turns using memory", which was unsatisfiable (the next
  comment is never sent until the current one finalizes). It now reads: this comment in its own
  branch/PR, QC + CI green, merge yourself, redeploy, re-fetch `page_url`, then resolve citing the
  merged SHA — no reference to batching across turns.
- **Finalize reuses `run-lifecycle.finalizeAnnotationReply` UNCHANGED**, once per batch member: the
  array reply is parsed (`result-schema.ts` `parseRevanoteBatchOutput`), each item is rebuilt into a
  single-annotation envelope string (`envelopeForBatchItem`) and run through the EXACT same
  commit-verify gate, DB writes, and callback shape as a non-batched annotation. An annotation
  id omitted from the reply's `annotations[]` array finalizes `resolved: false` /
  `missing_from_reply`. **An unparseable batch reply (no envelope, invalid JSON, a lone
  single-annotation-shaped object, or any other schema mismatch) finalizes every member
  `failed`/`resolved: false` directly, carrying the batch parser's own failure reason
  (`batch_parse_failed:<reason>`)** — it is never re-handed to the single-item parser
  (`parseRevanoteOutput`), which would otherwise happily accept a lone
  `{"resolved":true,...}` object and silently resolve every member from ONE verdict meant for
  at most one annotation (qcfix/batch-claim, F3).
- **Send-time atomic claim (qcfix/r2-claim-at-send, supersedes qcfix/batch-claim's pre-dispatch
  claim)**: the round-1 fix (F2/F4) claimed every member with a conditional
  `UPDATE ... SET status='dispatching' WHERE status='pending'` BEFORE calling `dispatch()` at all —
  which closed the double-send races but opened a new strand class (R2-1): an annotation that only
  ever got QUEUED behind another in-flight send on the same session was ALREADY claimed to
  `'dispatching'` even though nothing was ever sent for it, and a hub restart drops the in-memory
  queue/waiter state that would have promoted and sent it — permanently stranding the row off the
  `'pending'` sweep/retry path with no recovery. The claim now lives INSIDE the pipeline's `send()`
  adapter (`claimAnnotationsAtSend` in `revanote-dal.ts`: a single conditional
  `UPDATE annotations SET status='dispatched' WHERE id = ANY(...) AND status='pending' RETURNING
  id`), immediately before the WS push, for BOTH a first dispatch and a promoted queue re-dispatch
  (`dispatch()` calls the same `send()` either way). A merely-queued annotation/batch never reaches
  this claim and stays `'pending'` — exactly as restart-recoverable as before any claim existed.
  There is no longer a separate `'dispatching'` claim state: the CAS transitions straight
  `pending -> dispatched`, so a lost claim race (`already_claimed`) never leaves the row in an
  intermediate state for `stall-alert.ts` to have to special-case. For a batch, the claim also
  filters the group down to only the ids actually claimed — the prompt sent covers ONLY that
  claimed subset, never a member another caller won first.
- **Manual retry is CAS-gated against live ownership (qcfix/r2-claim-at-send, R2-2)**: a naive
  unconditional reset-to-`'pending'` + re-dispatch on `POST …/retry` could re-pend and re-claim an
  annotation whose first turn was still genuinely in flight, sending it a second time while the
  first was still running. The route now checks `status==='dispatched'` and, only then, consults
  `pipeline.isTokenLive` (single-annotation dispatch) and `batch-dispatch.isAnnotationLiveInBatch`
  (batch dispatch) — both read-only queries against the pipeline's in-memory active-hook/waiter
  state and the batch coalescer's `inFlightBatches` map. Genuinely live → `409 annotation_in_flight`,
  no reset, no re-dispatch. Not live (stranded after a restart — those maps are cleared on restart
  exactly like the claim above) → retry proceeds as before. `pending`/`failed`/`failed_offline`/
  `resolved` rows never consult liveness — the pipeline always releases ownership before setting any
  of those.
- **Batch dispatch token scoping (qcfix/batch-claim, C3)**: a batch's dispatch token (and the
  `inFlightBatches` map key) is `batch:<userId>:<sessionId>:<mappingId>:<batch_id>`, never the raw
  `batch_id` alone. One `batch_id` can legitimately split into several dispatched groups (a
  different resolved session, per C3, or — since C5 — a different resolved mapping within the SAME
  session), and the same `batch_id` can repeat across users; a raw-`batch_id` key would collide two
  of those groups' `inFlightBatches` entries, so a reply meant for one group's members could
  finalize (or orphan) the other group's. The `batch:` prefix also keeps a batch token disjoint by
  construction from a single-annotation dispatch's token (a bare annotation UUID).
- **Timeouts:** a batch turn does N comments' worth of branch/PR/CI/merge/redeploy work in one
  turn, so it needs a longer ceiling than a single annotation's default 20min
  `REVANOTE_FINALIZE_TIMEOUT_MS`. `REMO_REVANOTE_BATCH_RUN_MAX_MS` (default 7,200,000ms = 2h) sets
  BOTH the pipeline's `finalizeTimeoutMs` (the narration-vs-final decision — a message before this
  ceiling that doesn't carry the envelope leaves the hook armed rather than force-finalizing) and
  its `hookMaxMs` (the silent-hook reap ceiling) for a batch dispatch, so a long-running batch turn
  is never mistaken for a hung single-annotation dispatch.
- **Manual retry is unaffected**: `POST /api/revanote/annotations/:id/retry` always dispatches ONE
  annotation immediately (`dispatchPendingAnnotation(id, { forceSingle: true })`), bypassing batch
  coalescing even when the row carries a `batch_id` — a human explicitly retrying one comment
  should not sit behind the debounce window.

The existing Phase 5/6 merge-gate batch aggregation (`batch_size`/`sandbox_dir` in each
annotation's `payload_raw`, `hub/src/revanote/merge-gate.ts`) is a SEPARATE, sandbox-based
mechanism for aggregating merge/PR *decisions* once `sandbox_dir` wiring lands — it predates and is
independent of the dispatch-time coalescing above, and is not wired into it.

Tests: `hub/test/revanote-batch-dispatch.test.ts` (coalescing, debounce reset from the latest
arrival, one-prompt-per-batch, array-reply finalize with the per-item commit-verify gate, a missing
member, an unparseable reply — including a lone single-annotation-shaped object, which must fail
every member rather than resolve them all from one verdict — the no-batch_id single path,
`forceSingle` retry (including a race against a sweep tick over the same row), the send-time claim
surviving a crash mid per-member dispatched-status loop, a queued batch surviving a hub restart
still `'pending'` and re-sweeping successfully (R2-1), one `batch_id` spanning 2 sessions
dispatching + finalizing independently, two differently-trusted mappings sharing one session and
`batch_id` dispatching as isolated single-mapping batches, and the batch-specific finalize
ceiling). `hub/test/revanote-dispatch.test.ts` additionally covers the single-annotation R2-1
restart-recovery case. `hub/test/revanote-retry-guard.test.ts` covers the R2-2 retry
live-ownership CAS (refused while live, allowed once stranded) and the R2-4 `?status=` 400 on an
unrecognized value.

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
  "commit_sha": "3f9c…",
  "error": null
}
```

`commit_sha` is the hub-verified pushed commit behind a resolve (`null` when not resolved).

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

A dispatched comment whose send fails, or whose session dies mid-run and is released by the
dead-session reaper, also gets a `resolved: false` callback with `action_taken: agent_send_failed`
(the adapter's `markFailed`), so Revanote moves it back to todo instead of leaving it in progress.

## Cost cap, thresholds, concurrency

**Round-2 migration:** revanote dispatch now runs on the **shared session-dispatch pipeline** (`hub/src/dispatch/`) — the same deep module the error-capture pilot uses. `hub/src/revanote/dispatcher.ts` is a thin adapter that builds a `RunStore` + a `gates[]` array and calls `dispatch(req, deps)`. The hand-rolled threshold/budget/queue/grace/finalize machinery is gone.

- Gate chain (first block wins, IR-2): `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, revanoteBudgetGate(userId, tz)]`.
  - `sessionInjectRateGate` (default 4 injects/session/hour) bounds the inject RATE, so an annotation flood cannot drive N turns/hour into the bound session.
  - `thresholdGate` + `dailyCostCapGate` are the shared gates in `hub/src/dispatch/gates.ts`. The global daily cost cap is **non-bypassable** (IR-1) — the migration ADDS it (the legacy revanote dispatcher only had the Claude usage threshold + the per-source budget).
  - `revanoteBudgetGate` is a revanote-specific `DispatchGate` (defined in `dispatcher.ts`, exported for unit test) that enforces the per-source split (`users.revanote_budget_pct`, default 60% of the daily cap) **layered ON TOP of** the global cost cap, never a substitute. Over-budget → `revanote_budget_exceeded:<detail>` skip + reject callback.
- The per-session queue (1 in-flight + `REMO_DISPATCH_MAX_WAITERS` FIFO waiters, default 50 — was 1, which dropped every annotation past the second in a burst as `session_busy`) lives in `hub/src/dispatch/session-queue.ts` (instance owned by the pipeline). Concurrent annotations against the same session serialize through it in arrival order; re-dispatching an annotation already queued/in flight is a no-op (token = annotation id); a queued waiter does NOT open an `annotation_run` row until promotion re-dispatches it. Waiters are in memory — a hub restart drops them (revanote's own stale-lease sweep re-dispatches).
- **Silent-agent ceiling:** `finalizeTimeoutMs` (20 min) only fires when a NEW `assistant_message` arrives. An agent that replies "done" without the `<<JSON>>` envelope and then goes quiet used to hold the session slot forever. The boot-started `startHookReaper()` (`pipeline.ts` `reapTimedOutHooks`) finalizes such a hook with empty content after `REMO_DISPATCH_HOOK_MAX_MS` (default 2h) → `envelope_missing` / `resolved:false` callback, then promotes the next waiter.
- **Closed-out runs release their slot (fix/stuck-busy-slot):** `releaseClosedRun` /
  `releaseClosedRunByToken` (`pipeline.ts`) disarm the finalize hook of a run that was closed
  somewhere else and re-dispatch the next waiter. Wired into the scheduler run-reaper (after it
  finalizes a `run_timeout`), the orchestrator stale-lock reaper (which used to `abandon()` the slot
  and DROP its waiters), and the dead-session reaper. On the supervisor side, `endRun` (hub-closed
  runs) and `endOpenRunsForSession` (user disconnect) now also free `supervisors.current_run_id`
  via the guarded `releaseSupervisorSlotIfClosed`.
- **Dead sessions go offline (fix/dead-session-online):** a session whose CLI exited used to keep
  its `/ws/agent` socket (the supervisor forgot the run but not its bridge), so it looked online,
  swallowed every dispatch and was never restarted. The supervisor now closes the bridge whenever
  it stops tracking a run (clean exit, restart cap, breaker trip — needs a new signed MSI). Until
  then the hub's `startDeadSessionReaperSweep()` (`hub/src/ws/dead-session-reaper.ts`) reaps a
  channel that is absent from its host supervisor's FRESH `session_inventory` for
  `REMO_DEAD_SESSION_GRACE_MS` (default 2min): `shutdown` + close 4002, row `offline`, pipeline slot
  released. No fresh inventory for the host = unknown = never reaped.
- **Wedge fix:** when the head parks offline or its send throws, a waiter that queued behind it meanwhile is now re-dispatched. Previously it was moved into the in-flight slot with no finalize hook, so nothing ever freed the slot and every later annotation for that session came back `session_busy` until a hub restart.
- Offline target → parked in the **shared** `getGraceBuffer()` (`hub/src/dispatch/grace.ts`) keyed by `sessionId` (10-min TTL). On agent reconnect, `ws/agent.ts` calls `getGraceBuffer().drain(sessionId)` (one drain replays both error-capture and revanote). TTL lapse → annotation `failed_offline` / `target_offline_expired` via the adapter's `onParkExpire`.
- Finalize: the agent ws assistant_message branch calls `dispatch.onSessionReply(sessionId, content)`, which fires the adapter's `RunStore.onFinalize`. That hook delegates to `run-lifecycle.finalizeAnnotationReply` — envelope parse (`<<JSON>>…<<END>>`) → annotation resolved/failed → merge gate → outbound callback enqueue (callback ALWAYS carries `annotation_id`). There is no longer a revanote-specific `onAgentReply` call in `ws/agent.ts`.

## Quiet-sites alert

`hub/src/revanote/quiet-watch.ts` (boot-started, every `REMO_REVANOTE_QUIET_CHECK_INTERVAL_MS`,
default 15min) looks at each user's whole pipeline across ALL enabled mappings and alerts via the
shared notify fan-out (Telegram + in-app + email) when every client site has gone quiet:

- **stalled** — comments are waiting (`pending`/`dispatched`/`failed_offline`, older than
  `REMO_REVANOTE_QUIET_BACKLOG_MIN_AGE_MS`, default 1h) and not one was resolved on any site in the
  window (`REMO_REVANOTE_QUIET_WINDOW_MS`, default 24h).
- **silent** — nothing received and nothing resolved from any site in the window, although sites
  sent comments in the `REMO_REVANOTE_QUIET_BASELINE_MS` (default 7d) before it — intake broke.

Any resolved comment clears both. Deduped per (user, kind) for `REMO_REVANOTE_QUIET_ALERT_COOLDOWN_MS`
(default 12h). `REMO_REVANOTE_QUIET_ALERT_DISABLED=1` turns it off.

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

## Stall alert (owner-visible, fix/revanote-stall-alert)

All ~23 revanote client sites map onto ONE remo-code session (in-flight cap 1).
When that session wedges, every client's annotations silently pile up
`failed`/`failed_offline`/parked-`pending` with **zero owner-visible signal** —
the callback to revanote reports the failure, but nothing tells the owner. This
does NOT change the one-session-per-fleet architecture (out of scope); it's the
missing alarm.

- `hub/src/revanote/stall-alert.ts` — boot-started sweep (modeled on
  `scheduler/run-reaper.ts`), two independent stall signatures:
  - **Parked/rejected/target-offline**: an `annotations` row sits
    `status='pending' AND skip_reason='session_offline'` (parked offline), or
    `status IN ('failed','failed_offline')` (rejected / grace-TTL-lapsed), older
    than `REMO_REVANOTE_STALL_PARKED_MAX_MS` (default 1h), measured from
    `dispatched_at` when set else `received_at`.
  - **Stuck in-flight run**: an `annotation_runs` row sits `status='in_flight'`
    older than its threshold — `REMO_REVANOTE_STALL_RUN_MAX_MS` (default
    30min) for a single-annotation run, the dispatcher's own
    `finalizeTimeoutMs` (default 20min) should have forced a finalize before
    this; still in_flight at 30min means even that fallback never fired (a
    strictly worse signal — the session/process itself is stuck). **A
    batch-dispatched run is exempt from the 30min threshold** — its annotation
    carries `payload_raw.batch_id`, and it legitimately runs up to
    `REMO_REVANOTE_BATCH_RUN_MAX_MS` (default 2h, read live from
    `batch-dispatch.ts` `batchRunMaxMs()` via `stall-alert.ts`
    `runStallThresholdMs(isBatch)` — never a duplicated default), since one
    batch turn does N comments' worth of branch/PR/CI/merge/redeploy work.
  - Fan-out reuses the existing orchestrator notify channel
    (`orchestrator/notify.ts` `fanOutNotify` — telegram + in-app + emails4agents
    email, per-user channel opt-in respected). No new transport.
  - De-dup: ONE row per user in `revanote_stall_alerts` (`last_alert_at`); at
    most one alert per user per `REMO_REVANOTE_STALL_COOLDOWN_MS` (default 1h)
    — never one email per annotation (there can be dozens across 23 sites at
    once).
  - Sweep cadence `REMO_REVANOTE_STALL_SWEEP_INTERVAL_MS` (default 5min).
    Escape hatch `REMO_REVANOTE_STALL_DISABLED` (`1|true|yes|on`) — no-op.
  - Wired at boot / graceful-shutdown in `hub/src/index.ts` alongside the other
    reapers.
- `hub/test/revanote-stall-alert.test.ts` — fires at threshold (both
  signatures independently), does not fire below threshold, cooldown blocks a
  repeat alert then fires again once elapsed, one user's notify failure never
  aborts the pass for others, load failure is fail-open.

## Out of scope (deferred)

- Coolify deploy-status poll → enriched callback with `live_at`.
- Slack/Discord ping on `resolved: false`.
- Per-mapping prompt-template override.
- Cross-annotation batching WITHOUT a `batch_id` (e.g. grouping by page_url proximity or arrival
  timing alone) — shipped only for annotations that carry `batch_id` (see "Batch protocol" above).
- Two-way replies (agent → user → agent loop in the Revanote thread).
