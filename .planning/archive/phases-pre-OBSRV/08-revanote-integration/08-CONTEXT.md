# Phase 08: Revanote Annotation Integration — Context

**Gathered:** 2026-05-27
**Status:** Ready for planning
**Source:** `.planning/phases/revanote-integration/00-architecture-review.md` (architect-locked)
**Branch:** `feat/phase-08-revanote-integration` (off `origin/main` at `8f0af96`)
**Worktree:** `C:/Users/artic/GitHub/remo-code-phase-08-revanote`

<domain>
## Phase Boundary

Add a new inbound webhook channel: **Revanote** (a UI visual-commenting tool) POSTs annotation comments to remo-code's hub. The hub routes each annotation as a `user_message` into the user's bound Claude session (on the supervisor that hosts the affected repo). The agent fixes the app, git-pushes, and Coolify auto-deploys. The hub posts a callback to Revanote with the resolution.

**Key reuse:** session-queue.claim, enforceCostCap, pickSessionTarget, threshold-gate, error-capture's grace + audit-log patterns. Same URL-token + HMAC ingress shape as Coolify webhook (`/api/coolify/webhook/<user_id>/<token>`), but adds Revanote's `X-Revuu-Signature` HMAC layer on top of the URL token.

**Key novelty:** outbound callback contract with bearer auth + exponential retry queue, repo-mapping table with hostname-pattern resolution, three deploy strategies (`pr | direct | none`), agent prompt envelope `<<JSON>>{...}<<END>>` (matches the existing `revanote-hook` reference impl).

</domain>

<decisions>
## Implementation Decisions (locked by architecture review)

### Module placement
- New first-class module `hub/src/revanote/` parallel to `hub/src/error-capture/` and `hub/src/scheduler/`.
- NOT folded into `scheduler/task_kind`. Annotations are webhook-triggered, 1:1, callback-bound — different lifecycle than scheduled fan-out.

### Inbound webhook
- Route: `POST /api/revanote/webhook/:user_id/:token` mounted OUTSIDE the JWT catch-all (mirrors `sentry-intake` and `coolify-webhook`).
- Dual auth: URL-token (`users.revanote_webhook_secret` == path token, constant-time compare) AND `X-Revuu-Signature: sha256=<hex>` HMAC over raw body using the same secret.
- 5-minute timestamp skew window (using request `timestamp` field from body).
- Read raw body BEFORE JSON parse (Hono `c.req.raw.text()` pattern from Coolify webhook handler).
- Respond `202 { accepted: true, annotation_id }` immediately. NEVER hold the connection open.

### Agent prompt + envelope
- Reuse the `<<JSON>>{...}<<END>>` envelope from `revanote-hook/server.js`.
- Zod schema `RevanoteResult { resolved, action_taken, agent_reply?, files_changed[], needs_clarification, clarification_question? }`.
- Tolerant parser at `hub/src/revanote/result-schema.ts` modeled on `parseTriageOutput` — accepts ```json fences, finds last valid JSON object between markers, falls back to bare prose with `resolved:false`.

### Chat UI surfacing (CRITICAL — user-visible transparency)
- Annotation message MUST be persisted to `messages` table (NOT just an ephemeral `user_message`) so it shows in chat history.
- Stored content: `[revanote: <comment 30-char preview>]\n\n<full agent prompt with page_url, element_selector, screenshot_url, comment, replies>`.
- Mirrors scheduler's `[scheduled: <task name>]\n\n<prompt>` pattern verbatim — see `hub/src/scheduler/senders/agent.ts` storage shape.
- Web client renders a **violet "Annotation" pill** in `MessageBubble` via new `parseRevanotePrefix` helper (modeled on `parseScheduledPrefix` in `web/src/lib/scheduled-message.ts`).
- Pill click → opens `https://app.revanote.com/annotations/<annotation_id>` in a new tab.
- Agent's reply text (the natural-language portion before/after the envelope) renders normally. The `<<JSON>>...<<END>>` envelope itself is stripped from the displayed text via a new `stripEnvelope` helper in `web/src/lib/message-format.ts`.
- Activity events (thinking, tool_use, text_delta, tool_result) flow automatically through the existing `/ws/client` broadcast pipeline — no extra plumbing.

### Repo→app mapping
- New table `revanote_app_mappings(id, user_id, hostname_pattern, repo_path, supervisor_id NULL, deploy_strategy, auto_merge, enabled, created_at, updated_at)`.
- Hostname pattern: literal or glob (`*.foo.com`). Most-specific-pattern wins; ties broken by most-recently-updated.
- Smart fallback: if no row matches, scan user's supervisor-reported repo list for a `git remote get-url origin` host matching `page_url` host; auto-create the mapping row with `auto_created=true` flag (require user confirmation in UI before enabling).
- Mappings live under Settings → Revanote, CRUD via JWT-authed REST `/api/revanote/mappings`.

### Deploy strategies (per mapping)
- `pr` (default): branch `revanote/annotation-<id>`, commit, push, `gh pr create`. If `auto_merge=true`, squash-merge immediately. Coolify auto-deploys on main.
- `direct`: commit on main, push directly. Matches reference impl autonomy.
- `none`: edit only, no push. User reviews locally.
- The Claude session reads the strategy from the rendered prompt and does git ops in-session — hub does NOT shell out separately.

### Outbound callback
- `POST <callback_url>` with `Authorization: Bearer <revanote_webhook_secret>` and body `{ annotation_id, resolved, action_taken, agent_reply?, files_changed[], deployed, error? }`.
- `deployed: true` means "pushed to deploy branch" — NOT "Coolify build finished + serving traffic". Document this in `docs/revanote.md`.
- Retry queue: `revanote_callback_attempts` table, exponential backoff `1m → 5m → 15m → 1h → dead-letter at ~24h`. Jittered.
- 4xx → no retry. 5xx + network → retry. Audit row per attempt.

### Lifecycle + persistence
- Tables (all idempotent `CREATE IF NOT EXISTS`):
  - `users.revanote_webhook_secret TEXT NULL`
  - `revanote_app_mappings` (schema above + in architecture review §2.Q2)
  - `annotations(id, user_id, annotation_id UNIQUE per user, page_url, screenshot_url, x, y, element_selector, comment, replies_json, callback_url, mapping_id, status, received_at)` — `status: pending | dispatched | resolved | failed | failed_offline`
  - `annotation_runs(id, annotation_id FK, session_id, status running|resolved|failed, resolved, action_taken, agent_reply, files_changed JSONB, deployed, error, started_at, finished_at)`
  - `revanote_callback_attempts(id, annotation_id FK, attempt_no, http_status, error, attempted_at, next_retry_at)` indexed on `next_retry_at WHERE next_retry_at IS NOT NULL`
  - `revanote_webhook_attempts(id, user_id, received_at, source_ip, event_type, status, reason, raw_body_preview)` — audit log mirror of `coolify_webhook_attempts`
- `annotations.payload_raw JSONB` — full payload preserved verbatim so any fields not modeled as columns (`element_meta`, `capture_viewport`, future additions) are available to the agent prompt without schema churn

### Confirmed cross-side contract (with revanote plan at `C:/Users/artic/GitHub/revanote/.planning/phases/remo-code-integration/00-revanote-side.md`)
- Revanote sends `source: 'revanote'`, `revanote_version: <semver>`, and **`annotation_url`** deep-link field in the payload.
- `annotation_url` is the violet "Annotation" pill's `href` in `MessageBubble`. Format: `https://app.revanote.com/review/<project_id>#annotation-<annotation_id>`. Use it directly when present; do NOT reconstruct from `annotation_id` alone.
- If `annotation_url` is absent (revanote env not configured), render the pill as plain text (no link).
- Rotate endpoint `POST /api/account/revanote-webhook-secret/rotate` returns `{ user_id, token, webhook_url, webhook_secret }` in one call — both URL slug + bearer rotate together. Revanote's PR 3 settings UI relies on this single-call shape.
- Callback ALWAYS includes `annotation_id`, even on pre-dispatch rejections (`budget_threshold`, `quota_threshold`, `session_offline`, `auth_failed`).
- Comment preview for the pill: slice locally on the web client using `Intl.Segmenter` for emoji safety. If revanote pre-slices `comment_preview` we use it; otherwise we slice from `comment` (first 30 grapheme clusters).
- `element_meta` + `capture_viewport` are passed through to the agent prompt without schema columns — preserved in `annotations.payload_raw`.

### Cost cap, threshold gate, concurrency
- `enforceCostCap` from `hub/src/scheduler/dispatcher.ts` applied — uniformly with scheduled tasks.
- Per-source budget split: user-configurable `revanote_budget_pct` (default 60% of daily cap). Surfaced as "throttled by cap" in callback when exceeded.
- Threshold gate (PR #52 `claude_*_threshold_pct`) — applied. Over threshold → callback `error: 'budget_threshold'`, no dispatch.
- `session-queue.claim` keyed on `(supervisor_id, repo_path)` (NOT `session_id`) so concurrent annotations against the same repo serialize, preventing `git push` races.

### Out of scope
- Coolify deploy-status polling before callback (callback fires on push, not on serving — see architecture review §5.9).
- Per-annotation cost/$ accounting beyond what the dispatcher already records.
- A revanote-side "force retry" trigger (revanote owner can add later; we expose a Force Retry button in our UI).
- Mobile dashboard for annotation runs (mobile-friendly list is fine; full detail drawer is desktop-only).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture (source of truth for this phase)
- `.planning/phases/revanote-integration/00-architecture-review.md` — full review (Q1–Q6 + risks + 5-PR breakdown + reuse table)

### Reference implementation (read-only — pattern source)
- `C:/Users/artic/GitHub/revanote-hook/server.js` — HMAC verify, FIFO queue, Claude subprocess, envelope parse, callback. Migrate the SHAPE, not the runtime.

### Existing remo-code modules to reuse / mirror
- `hub/src/scheduler/session-queue.ts` — claim/release (reuse verbatim; rekey on `(supervisor_id, repo_path)`)
- `hub/src/scheduler/dispatcher.ts` `enforceCostCap`, `pickSessionTarget` — reuse
- `hub/src/scheduler/triage-schema.ts` `parseTriageOutput` — pattern source for envelope parser
- `hub/src/scheduler/senders/agent.ts` — pattern for `[revanote: …]` storage prefix + agent send
- `hub/src/error-capture/grace.ts` — 10-min offline buffer pattern
- `hub/src/error-capture/dispatcher.ts` — claim/release lifecycle pattern; near-duplicate ok
- `hub/src/api/coolify-webhook.ts` — URL-token + raw-body-before-parse pattern (this also has the legacy HMAC code path we revive for revanote)
- `hub/src/api/sentry-intake.ts` — pattern for mounting BEFORE JWT catch-all
- `hub/src/api/account.ts` `*CoolifyWebhookSecret` — pattern for `*RevanoteWebhookSecret`
- `hub/src/db/dal.ts` `getUserCoolifyWebhookSecret`, `rotateUserCoolifyWebhookSecret` — parallel helpers
- `hub/src/scheduler/budget-gate.ts` (PR #52) — `claude_*_threshold_pct` enforcement; reuse
- `hub/src/supervisor/concurrency.ts` (PR #25) — reservation primitive

### Web side
- `web/src/lib/scheduled-message.ts` `parseScheduledPrefix` — pattern source for `parseRevanotePrefix`
- `web/src/components/MessageBubble.tsx` — where to render the violet "Annotation" pill
- `web/src/components/SettingsPage.tsx` — add new "Revanote" tab
- `web/src/components/SchedulesPage.tsx`, `ScheduleRunsDrawer.tsx` — pattern for `RevanotePage.tsx` + `RevanoteRunDrawer.tsx`

### WS protocol
- `hub/src/ws/protocol.ts` — add 3 new events: `annotation_received`, `annotation_dispatched`, `annotation_resolved`. Coordinate at line level with Phase 05 + Phase 07 sessions (this file is high-contention).

### Global rules (CLAUDE.md user-global)
- Rule #7 — emails4agents for any notification email
- Rule #17 — Postgres on Coolify (no Supabase, no Mongo)
- Rule #19 — fresh branch per concern; this branch is `feat/phase-08-revanote-integration`
- Rule #20 — main session stays in canonical; this work lives in the dedicated worktree
- Rule #21 — every app exposes `/openapi.json` + `/docs`; new routes must be declared via `@hono/zod-openapi` `createRoute` in `hub/src/api/_openapi.ts` AS MIGRATED (currently only `/api/profile/cost-today` is in the spec — incremental migration is OK)

</canonical_refs>

<specifics>
## Specific Implementation Hints

### Storage prefix for chat surfacing
```ts
// Mirror of [scheduled: ...] but with violet pill instead of indigo
const STORE_PREFIX = `[revanote: ${truncate(annotation.comment, 30)}]`;
const stored = `${STORE_PREFIX}\n\n${renderAnnotationPrompt(annotation, mapping)}`;
await insertMessage(sessionId, 'user', stored);
sendToAgent(sessionId, stored);  // hub also broadcasts user_message via /ws/client
```

### Envelope strip for displayed text
```ts
// Strip <<JSON>>...<<END>> from assistant_message before render
// Implementation: web/src/lib/message-format.ts
export function stripRevanoteEnvelope(text: string): string {
  return text.replace(/<<JSON>>[\s\S]*?<<END>>/g, '').replace(/```json[\s\S]*?```/g, '').trim();
}
```

### Pill rendering
```tsx
// In MessageBubble.tsx after parseScheduledPrefix check
const annotation = parseRevanotePrefix(content);
if (annotation) {
  return (
    <a href={`https://app.revanote.com/annotations/${annotation.id}`}
       target="_blank" rel="noopener"
       className="inline-flex items-center gap-1 px-2 py-0.5 rounded
                  bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30
                  hover:bg-violet-500/25 text-xs font-medium">
      Annotation: {annotation.preview}
    </a>
  );
}
```

### Per-source budget split helper
```ts
// hub/src/revanote/budget.ts
// Reads users.revanote_budget_pct (default 60), computes user's daily revanote cap = daily_cap * pct/100,
// blocks dispatch when current revanote-attributed spend exceeds that cap.
// Attribution: scheduled_task_runs.source = 'revanote' (add column) OR use annotation_runs.cost_usd.
// Recommend: cost_usd on annotation_runs, summed by today-window.
```

### Concurrent-repo serialization
```ts
// hub/src/scheduler/session-queue.ts already serializes per session.
// For revanote, claim with key `revanote:${supervisor_id}:${repo_path}` so two annotations
// against the same repo wait their turn even if they target different sessions.
// (Sessions are per-CLI-instance; repo can be touched by multiple sessions.)
```

</specifics>

<deferred>
## Deferred Ideas

- Coolify deploy-status poll → callback enriched with `live_at` timestamp. Slower but more accurate. Phase 09+.
- Slack/Discord notification on `resolved: false` (needs_clarification). Phase 09+.
- Per-mapping prompt template override (advanced users want custom instructions per app). Phase 09+.
- Cross-annotation context: if 5 annotations on the same page within 1h, batch into one session turn. Phase 09+.
- Two-way replies: agent's `agent_reply` shows in revanote thread, user can respond, second turn fires. Out of scope here — needs revanote-side change too.

</deferred>

---

*Phase: 08-revanote-integration*
*Context written: 2026-05-27 from architect review*
