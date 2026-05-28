# Revanote Secure Dispatch — remo-code side

**Cross-repo plan:** `C:/Users/artic/GitHub/revanote/.planning/phases/batched-secure-dispatch/00-plan.md`
**Branch:** `feat/phase5-agent-sandbox`
**Owner:** remo-code hub
**Status:** Phase 5 in progress

## Context

Revanote Phases 1–4 shipped. Outbound dispatch now ships batched annotations
sharing a `batch_id`, plus `repo_slug` + `repo_kind` for hard-bound project
targets. Phases 5–6 land on remo-code: sandboxed agent runs, diff gating,
risk classification, and merge automation.

## Cross-side contract (inbound)

Revanote → remo-code `POST /api/webhooks/revanote/:userId/:secret` payload
additions (all optional, additive):

| Field | Type | Meaning |
|---|---|---|
| `batch_id` | uuid | Shared id across N annotations dispatched in one quiet-period fire. |
| `batch_size` | int | Total count of annotations in this batch. |
| `batch_index` | int | 0-indexed position. |
| `repo_slug` | string | `owner/repo` (GitHub) OR free-form local path. |
| `repo_kind` | `'github'\|'local_path'` | Routes clone vs worktree-add. |

## Cross-side contract (outbound callback additions)

Existing fields (`annotation_id`, `resolved`, `action_taken`, `agent_reply`,
`files_changed`, `deployed`, `needs_clarification`, `clarification_question`,
`error`, `source`) UNCHANGED.

New optional fields on `RevanoteCallbackPayload`:

| Field | Type | Meaning |
|---|---|---|
| `batch_id` | uuid | Echo of inbound batch_id. |
| `risk_class` | `'minor'\|'major'\|'breaking'` | Output of risk classifier. |
| `merge_decision` | `'auto_merged'\|'pr_opened'\|'blocked'` | Outcome of merge gate. |
| `pr_url` | string | GitHub PR URL when opened or auto-merged. |
| `diff_summary` | string | First 20 file paths + total line counts. |
| `diff_hash` | string | sha256 of the diff body. |

## Phase 5 deliverables (this PR)

1. **`hub/src/revanote/payload-schema.ts`** — accept new optional fields. Already
   passes through via `.passthrough()` but adds typed slots for downstream code.
2. **`hub/src/revanote/sandbox.ts`** (new) — `prepareSandbox(repoSlug, repoKind,
   batchId)`:
   - `github`: shallow clone via existing `mintTokenizedCloneUrl` (auth/github-app.ts).
   - `local_path`: `git worktree add` from a user-mounted path.
   - Writes sentinel files for the run wrapper to enforce file + env exclusions.
   - Returns `{ sandboxDir, cleanup }`.
3. **`hub/src/revanote/diff-sandbox.ts`** (new) — `analyzeDiff(sandboxDir,
   baseRef)`:
   - Hard-reject on secret-path globs and content regex.
   - Soft-flag on dependency / lockfile diffs.
   - Returns `{ ok, blockedReasons, softFlags, diffText, diffHash, fileSummary }`.
4. **`hub/src/revanote/risk-classifier.ts`** (new) — `classifyRisk(diff,
   softFlags)`:
   - Heuristic-first (CSS-only → minor; migration/lockfile/route changes → major;
     exported-symbol or env-var changes → breaking).
   - LLM escalation deferred: returned `rationale` flags when an LLM would be
     consulted. *Phase-6 follow-up: wire the existing Anthropic client.*
5. **`hub/src/revanote/run-lifecycle.ts`** — wire the gate sequence at agent-reply
   time: diff check → classify → merge_decision → callback. Batch-state tracking
   in-memory under a `Map<batchId, BatchState>`; merge fires only when
   `batch_size` annotations reported AND none blocked AND no clarification
   siblings.
6. **`hub/src/revanote/callback.ts`** — extend `RevanoteCallbackPayload` type so
   the new fields persist through the queue.
7. **Tests** under `hub/test/`:
   - `revanote-payload-schema.test.ts` (extend existing if convenient): batch
     fields accepted; missing fields still parse.
   - `revanote-diff-sandbox.test.ts`: `.env` path blocked; secret-regex blocked;
     dep-bump soft-flagged; clean diff passes.
   - `revanote-risk-classifier.test.ts`: CSS-only → minor; migration → major;
     exported-function add → breaking.
   - `revanote-merge-gate.test.ts`: clean+minor → `auto_merged`; clean+major →
     `pr_opened`; dirty → `blocked`. PR-open + git stubbed via `mock.module`.

## Phase 6 deliverables (next PR — NOT THIS BRANCH)

- Coolify-deploy decoupling: only auto-merge for `repo_kind='github'` writes to
  default branch; major/breaking opens PR and posts emails4agents notification.
- Wire LLM escalation in the classifier.
- Surface `agent_paused` short-circuit on inbound webhook side (revanote ships
  the kill switch in Phase 3; this side honors it by reading `users` flag).

## Constraints

- Hard-bound: HMAC and rate-limit verification stay untouched.
- Hard-bound: classic callback shape stays — new fields are additive only.
- No new env vars outside Coolify env. Reuse existing GitHub App + Anthropic
  clients.
- Bun runtime. `Bun.spawn` for git commands; node-compat OK.
- If the LLM client isn't trivially reusable, **stub the interface** and document
  the gap here for Phase 6 — do not invent it.

## Known gaps documented for Phase 6

- **LLM escalation** in `risk-classifier.ts`: currently heuristic-only. The
  existing `hub/src/scheduler/post-run/*` paths use an internal Anthropic
  client; risk-classifier accepts an injected `llm?: LlmEscalator` callback so
  Phase 6 can wire it without changing the signature.
- **Local-path sandboxing of host secrets**: when `repo_kind='local_path'` the
  worktree shares an inode tree with the user's working copy. Env-var stripping
  protects against in-process exfil, but the user must accept that their local
  uncommitted files are on the same disk. Documented limitation.
- **CI-green gate** for auto-merge: this PR detects `merge_decision='auto_merged'`
  optimistically when classifier says `minor` AND diff-sandbox clean. Phase 6
  will gate on `GET /repos/:owner/:repo/commits/:sha/check-runs` before merge.

## Acceptance for Phase 5

- Tests pass under `bun test hub/test/revanote-{diff-sandbox,risk-classifier,merge-gate,payload-schema}.test.ts`.
- Existing revanote test suite still passes (no regressions in
  `revanote-webhook.test.ts`, `revanote-callback.test.ts`,
  `revanote-result-schema.test.ts`).
- A clean CSS-only diff in a stubbed batch routes to `auto_merged`.
- A `.env`-touching diff routes to `blocked`.
- A migration-touching diff routes to `pr_opened`.
