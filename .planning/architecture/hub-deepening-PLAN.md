# Hub Deepening — Architecture Review & Sequenced Refactor Plan

Branch: `refactor/hub-deepening` · Worktree: `remo-code-refactor-hub-deepening`
Lens: deep modules (small interface, large behaviour) vs shallow copy-N-times patterns. Deletion test throughout.

---

## Executive Summary

Six candidates were proposed from a prior exploration pass. Validated against live code (line counts re-measured, repetition quantified, the "leaky seam" claims checked against the actual source). Verdict:

| # | Candidate | Verdict | Why |
|---|-----------|---------|-----|
| **C1** | Unify the 4 inbound dispatch pipelines into one deep module | **DO (anchor)** | Genuine deep module. The grace buffer is ~90% identical across 3 files; the dispatch state-machine (threshold → cost-cap → queue-claim → send → finalize → promote) is the same shape in all 4. Deletion test passes hard: removing the module re-scatters the cost-cap + queue + grace logic across 4 subsystems. |
| **C3** | Relocate `session-queue.ts` out of `scheduler/`, kill global state + `setOnPromote` callback setter | **DO (fold into C1)** | The leaky `setOnPromote` seam and 7 cross-subsystem reaches into `scheduler/` for a non-scheduler primitive are real. But this is *not* a standalone phase — it is the queue half of C1's interface. Fold it in. |
| **C2** | Extract one deep webhook-intake module (auth gate) | **DO (scoped down)** | Real, but smaller than claimed. The genuinely-identical core is the **auth gate** (raw-body-before-parse → constant-time token compare → optional HMAC over `${ts}.${rawBody}` → skew → audit-row capped 100/user). That core repeats ~4×. The "1,194 LOC / 70% boilerplate" figure is **wrong**: webhooks total **1,354** LOC and telegram-webhook's 564 LOC is mostly command/picker/photo logic, not auth. Extract the ~50-LOC auth core, leave per-webhook bodies alone. |
| **C4** | Split `db/dal.ts` god-module; extract `telegram-dal.ts` | **DEFER (weak)** | Hygiene only. `dal.ts` is **1,753** LOC / 101 exports (claim said 1,712). The telegram helpers (10, not 31) and chat-tabs are the obvious extractions, and `chat-tabs-dal.ts` already exists as the pattern. Deletion test is **neutral** — moving functions between files changes no interface and removes no duplicated complexity. Do it as a low-risk cleanup *after* the load-bearing work, or drop. |
| **C5** | Replace `protocol.ts` `notification` catch-all with a discriminated sub-union | **DROP** | Central premise is **false**. `HubToClient.notification` is already well-typed (`{title, body, severity, url, run_id, task_id}`), not `{data: unknown}`. The per-subsystem Zod discriminatedUnions (`ScheduledRunEvent`, `ErrorCaptureEvent`, `RevanoteEvent`) **already exist**. The only real smell is that `HubToClient` is a hand-maintained TS `type` union parallel to the Zod schemas — a typing-tidiness issue, not a parsing-pushed-to-callers leak. Not worth a back-compat-risky touch to the wire format. |
| **C6** | Subsystem registry for `index.ts` mounting | **PARTIAL (lighter fix)** | `index.ts` is **547** LOC (claim said 526). Mount/middleware ordering *is* load-bearing and invisible. But a `{name, router, mountBefore}` registry adds indirection that hides the very ordering it claims to manage, and Hono's middleware semantics (`app.use` order = execution order) don't compose cleanly through a declarative table. Better: a **mount-order assertion test** + a documented ordering invariant block. Skip the registry. |

### Recommended phase order

```
Phase 1  C1+C3  Session-dispatch pipeline (deep module) + queue relocation   [L / high]   ANCHOR
Phase 2  C2     Webhook auth-gate deep module                                 [M / med]
Phase 3  C6     Mount-order assertion test + invariant doc (NO registry)      [S / low]
Phase 4  C4     telegram-dal.ts + chat-tabs-dal.ts extraction (optional)      [S / low]
         C5     DROPPED
```

C1 first because it is the anchor and C3 folds into it. C2 is independent of C1 (different seam: ingress-auth vs dispatch) and *could* run in parallel in a second worktree, but the webhooks call the dispatchers C1 touches, so sequential is safer. C6/C4 are cleanup, last.

---

## Phase 1 — Session-Dispatch Pipeline (C1 + C3) · ANCHOR

### Goal
One deep module owns the inbound→session dispatch state-machine that scheduler / error-capture / revanote / telegram each re-implement: threshold gate → cost-cap → per-session queue claim → offline-grace park → send `user_message` on agent socket → finalize on next `assistant_message` → promote waiter. Subsystems shrink to: *resolve target + build prompt + map outcome*. The queue moves out of `scheduler/` and loses its global-state + callback-setter seam.

### What's genuinely shared (measured)
- **Grace buffer** — `scheduler/grace.ts` (93), `error-capture/grace.ts` (74), `revanote/grace.ts` (85). Same `Map<targetKey, Pending[]>`, same 10-min TTL, same 60s sweep, same `register`/`drain`/`sweep`/`startSweeper`. ~90% identical. **Deep-module win.**
- **Queue claim** — all 4 use `scheduler/session-queue.ts` verbatim (`enqueue` → `dispatched`/`queued`/`dropped`; `markFinished` promote). Already one impl, but reached into across subsystem lines.
- **Finalize-on-reply** — `error-capture/run-lifecycle.ts` (114) and `revanote/run-lifecycle.ts` (209) are explicitly "mirrors" of each other: `Map<sessionId, ActiveRun>`, `onAgentReply` finalizes + promotes waiter via `queue.markFinished`. Same skeleton; revanote adds envelope-parse + callback-enqueue tail.
- **Gate sequence** — threshold (`checkUserThreshold`) then cost-cap then queue, in that order, in all 4 dispatchers.

### What's legitimately different (absorb as config/hooks, NOT special-cases)
- **cost-cap source**: `reserveSessionSlot` (supervisor concurrency, already centralized in `sessions/budget.ts`) vs `isOverCostCap` (daily USD, SQL copied 3×). Revanote adds a *second* per-source `revanote_budget_pct` gate. → pluggable pre-send gate list.
- **run-row persistence**: scheduler writes `scheduled_task_runs`; error-capture writes `error_runs`; revanote writes `annotation_runs`; telegram writes **no run row** (it's user traffic). → the run-row is a subsystem-supplied `RunStore` adapter, nullable for telegram.
- **finalize tail**: revanote parses the `<<JSON>>…<<END>>` envelope and enqueues a callback; others just snapshot output. → `onFinalize(content)` hook returns subsystem-specific side-effects.
- **offline action**: scheduler replays via `runNow`; error-capture re-runs `dispatchPendingError`; revanote re-dispatches the annotation. → grace stores an opaque `replay()` thunk.

### Interface design (the seam)

`hub/src/dispatch/` — new directory. Two cooperating deep modules.

```ts
// hub/src/dispatch/session-queue.ts  (relocated from scheduler/, C3)
// Same FIFO semantics (1 in-flight + 1 waiter), but NO global mutable `slots`
// module var and NO setOnPromote setter. The queue is an instance owned by the
// pipeline; promotion is an explicit return value, not a registered callback.

export type EnqueueResult = 'dispatched' | 'queued' | 'dropped'

export class SessionQueue {
  enqueue(sessionId: string, token: string): EnqueueResult
  /** returns the promoted waiter token (or null) — caller decides what to do */
  markFinished(sessionId: string): string | null
  currentInFlight(sessionId: string): string | null
  abandon(sessionId: string): void
}
```

```ts
// hub/src/dispatch/pipeline.ts  (the deep module)
//
// One call ships a prompt to a session through every gate + the queue + grace,
// and registers the finalize hook. Caller supplies adapters for the parts that
// legitimately vary; everything else (gate order, queue claim, offline park,
// promote-on-reply) lives behind this seam.

export interface DispatchRequest {
  userId: string
  sessionId: string
  /** stable id used as the queue token + finalize key (runId, errorId, 'tg:<chat>:<update>') */
  token: string
  prompt: string
  images?: Array<{ media_type: string; data: string }>
  attachments?: Array<{ filename: string; content: string }>
}

/** Pluggable pre-send gates, evaluated in order. First block wins. */
export interface DispatchGate {
  name: string
  check(req: DispatchRequest): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** Subsystem persistence + finalize behaviour. Null store = telegram (no run row). */
export interface RunStore {
  /** persist a run row, return its id (or null to use req.token) */
  open?(req: DispatchRequest): Promise<string | null>
  markSkipped(token: string, reason: string): Promise<void>
  markDispatched?(token: string): Promise<void>
  /** called when the agent's next assistant_message lands on this session */
  onFinalize(token: string, content: string): Promise<void>
  markFailed(token: string, error: string): Promise<void>
}

export type DispatchOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'dropped_busy' }
  | { kind: 'parked_offline' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface PipelineDeps {
  gates: DispatchGate[]          // [threshold, costCap, ...subsystem-specific]
  store: RunStore | null
  /** offline replay thunk, parked in grace and re-run on reconnect */
  replay: (req: DispatchRequest) => Promise<void>
}

export function dispatch(req: DispatchRequest, deps: PipelineDeps): Promise<DispatchOutcome>

// agent.ts assistant_message handler calls exactly ONE function now:
export function onSessionReply(sessionId: string, content: string): Promise<void>
// (looks up the active finalize hook for sessionId across all subsystems,
//  runs store.onFinalize, then promotes the queue waiter and re-dispatches it)
```

```ts
// hub/src/dispatch/grace.ts  (the single deep grace buffer, replaces 3 copies)
export interface GraceBuffer {
  register(targetKey: string, replay: () => Promise<void>, ttlMs?: number): void
  drain(targetKey: string): Promise<void>   // called on agent reconnect
}
export function getGraceBuffer(): GraceBuffer   // process singleton, owns the 60s sweep
```

Shared gates live in `hub/src/dispatch/gates.ts`:
```ts
export const thresholdGate: DispatchGate            // wraps checkUserThreshold
export const dailyCostCapGate: DispatchGate         // the isOverCostCap SQL, ONCE
export const concurrencyGate: (supervisorId: string) => DispatchGate  // wraps reserveSessionSlot
```

**Depth check**: the interface is `dispatch(req, deps)` + `onSessionReply(sessionId, content)` + 3 small adapter types. Behind it: gate ordering, queue FIFO, offline park/drain/sweep, finalize-and-promote, the `tg:` token convention, all the audit/skip persistence. Large behaviour, small interface. Passes.

### Migration steps (strangler-fig)
1. **Land the module** under `hub/src/dispatch/` with full unit tests. Nothing wired yet. Move `session-queue.ts` here as `SessionQueue` class; keep a thin back-compat shim re-exporting the old functional API from `scheduler/session-queue.ts` so `scheduler.test.ts` stays green until step 5.
2. **Migrate error-capture first** (smallest, 188+74+114 LOC). Reimplement `dispatchPendingError` + grace + run-lifecycle on top of `dispatch()`. Delete `error-capture/grace.ts`. Keep `error-capture/dispatcher.ts` as a thin adapter (resolve project → build `RunStore` for `error_runs` → call `dispatch`).
3. **Migrate revanote** (265+85+209+callback). The envelope-parse + callback-enqueue become the `onFinalize` hook body. Delete `revanote/grace.ts`.
4. **Migrate scheduler** (the big one, 518). Its `fireTask` keeps the cron/fan-out/triage-routing logic but the per-target send path delegates to `dispatch()`. `init()`/`setOnPromote` wiring is replaced by `onSessionReply`. Delete `scheduler/grace.ts`.
5. **Migrate telegram** (`dispatch.ts`, 146). Drop the local `isOverCostCap` copy — use `dailyCostCapGate`. `RunStore = null`. Delete the duplicated SQL.
6. **Rewire `agent.ts`** (lines 463-540): the three `await import(...run-lifecycle)` + `onSessionIdleAndPromote` calls collapse to one `onSessionReply(sessionId, content)`.
7. **Delete the back-compat shim** and the old `scheduler/session-queue.ts`; update `scheduler.test.ts` imports to the new path (the queue *semantics* tests move with it — same assertions, new import).

### Risk + rollback
- **Risk: high.** This touches the cost-cap path (CLAUDE.md: non-bypassable) in all 4 subsystems and the agent finalize fan-out. A bug here either double-dispatches (burns cap + Anthropic quota) or silently drops user messages.
- **Mitigation**: migrate one subsystem per PR (steps 2-5 are 4 separate PRs behind the step-1 module PR). Each PR is independently revertable because the un-migrated subsystems still run on their own copies until their PR lands.
- **Rollback**: revert the per-subsystem PR; that subsystem returns to its own dispatcher/grace. The shared module stays, harmlessly unused by the reverted subsystem.

### Test that proves it
- New `hub/test/dispatch-pipeline.test.ts` (no DB): gate-ordering (threshold-before-costcap-before-queue), queue dispatch/queue/drop + promotion, grace register/drain/TTL-expire, `onSessionReply` finalize-then-promote. This is the new contract file; mirror the `session-queue` describe-block assertions verbatim from `scheduler.test.ts` so the FIFO semantics are provably unchanged.
- `hub/test/scheduler.test.ts` MUST stay green at every step (CLAUDE.md: it is *the* contract). The `scheduler/session-queue` import path is the only churn; assertions unchanged.
- Per-subsystem e2e regression: `scheduled-tasks.e2e.test.ts`, `phase-08.e2e.test.ts` (revanote), `telegram-bridge.test.ts`, `self-capture.test.ts` (error-capture) all green after their step.

---

## Phase 2 — Webhook Auth-Gate Deep Module (C2)

### Goal
One deep module owns the public-webhook *authentication & audit* pipeline that coolify / sentry / revanote / telegram each repeat. The per-webhook *business bodies* stay where they are — only the auth/audit envelope is extracted.

### What's genuinely shared (measured, scoped down from the claim)
Across `coolify-webhook.ts` (338), `revanote-webhook.ts` (184), `telegram-webhook.ts` (564), `sentry-intake.ts` (108): the repeated **auth core** is ~40-60 LOC each:
- read **raw body before any parse** (`c.req.text()` / `c.req.arrayBuffer()`),
- `constantTimeEqualStr` (literally copy-pasted into coolify, revanote, telegram — three identical 6-line fns),
- optional HMAC `sha256` over `${ts}.${rawBody}` with `timingSafeEqual`,
- 5-min skew check (`SKEW_SECONDS = 300`, duplicated),
- audit row capped 100/user (the `OFFSET 100` trim lives in `dal.ts` but the *call discipline* — log every hit incl. auth-fail, preview-only, never store the bad token — is copied),
- uniform 401 that doesn't leak which check failed.

**Correction to the exploration claim**: telegram-webhook is NOT 70% auth boilerplate. Its bulk is `pickLargestPhoto`, `fetchPhotoAsDataUri`, `dispatchInbound`, command/picker routing. Only ~50 LOC is the shared auth surface. The deep module captures that 50 LOC × 4, not the whole file.

### Real per-webhook differences (absorb as config)
- **sentry**: no HMAC, no skew; credential is `X-Sentry-Auth` header / `?sentry_key=`, resolved via DB lookup (`getErrorProjectBySentryKey`) not URL-path compare; on auth-fail returns **no audit row** (different from the others). → config: `{ credentialSource: 'header', verifyHmac: false, auditOnAuthFail: false }`.
- **coolify**: dual-path (URL-token primary + legacy HMAC headers w/ Deprecation/Sunset); IP allowlist (`users.coolify_webhook_allowed_ips` + `cidr.ts`); `EVENT_ALIAS` underscore→dotted normalize. → config: `{ ipAllowlist: true, legacyHmacPath: true }`; EVENT_ALIAS stays in the *body*, not the auth module.
- **telegram**: single global `config.telegram.webhookSecret` (not per-user); 503 when unset; `(chat_id, update_id)` dedupe (that's a *dispatch* concern, stays in the body); auth-fail → **no audit row** (table-fill DoS guard). → config: `{ credentialSource: 'url-secret', secretScope: 'global', auditOnAuthFail: false }`.
- **revanote**: per-user URL-token + optional-when-present HMAC (`X-Revuu-Signature`); audits every hit incl. auth-fail.

### Interface design (the seam)

```ts
// hub/src/webhooks/intake.ts  (deep module)

export interface IntakeConfig {
  /** where the credential comes from */
  credentialSource: 'url-token' | 'url-secret' | 'header'
  /** look up the expected secret for this request (per-user or global) */
  resolveSecret(c: Context): Promise<{ ownerId: string | null; secret: string | null }>
  verifyHmac: boolean
  hmacHeader?: string            // 'x-coolify-signature' | 'x-revuu-signature'
  hmacRequiredWhenPresent?: boolean
  skewSeconds?: number           // default 300; 0 disables
  ipAllowlist?: (ownerId: string) => Promise<string[]>   // coolify only
  /** audit policy — coolify/revanote audit auth-fails; sentry/telegram do not */
  audit?: {
    record(row: AuditRow): Promise<void>   // already capped-100 in the DAL
    onAuthFail: boolean
  }
}

export type IntakeResult =
  | { ok: true; ownerId: string | null; rawBody: string }
  | { ok: false; status: 401 | 403 | 503; body: object }  // uniform, non-leaky

/** Runs the full gate: raw-body → secret compare → HMAC → skew → IP → audit.
 *  Returns the raw body for the caller to Zod-parse + dispatch. */
export function runIntake(c: Context, cfg: IntakeConfig): Promise<IntakeResult>

// shared crypto helpers, defined ONCE (kill the 3 copies):
export function constantTimeEqual(a: string, b: string): boolean
export function verifyHmacSig(secret: string, ts: string, rawBody: string, sig: string): boolean
```

Each webhook handler becomes:
```ts
route.post('/webhook/:user_id/:token', async (c) => {
  const auth = await runIntake(c, coolifyIntakeConfig)
  if (!auth.ok) return c.json(auth.body, auth.status)
  const payload = CoolifyWebhookPayload.safeParse(JSON.parse(auth.rawBody))   // body-specific
  // ...existing business logic, unchanged...
})
```

**Depth check**: `runIntake(c, cfg) → IntakeResult` is the whole interface. Behind it: raw-body discipline, constant-time compare, HMAC verify, skew, IP allowlist, audit-every-hit-or-not, uniform non-leaky errors. The differences are *data* (config), not *code paths*. Passes — and critically, it makes the security invariants impossible to get wrong per-webhook (they're enforced once).

### Migration steps (strangler-fig)
1. Land `hub/src/webhooks/intake.ts` + `constantTimeEqual`/`verifyHmacSig` with unit tests. Nothing wired.
2. Migrate **revanote-webhook** first (cleanest single-path URL-token+HMAC). Replace inline auth with `runIntake`. Keep the existing `revanote-webhook.test.ts` green.
3. Migrate **telegram-webhook** (global-secret, no-audit-on-fail config). Body logic untouched.
4. Migrate **coolify-webhook** (dual-path: two `IntakeConfig`s, one per route; IP allowlist).
5. Migrate **sentry-intake** (header credential, no HMAC). Smallest config.
6. Delete the 3 copied `constantTimeEqualStr` fns and the duplicated `SKEW_SECONDS`.

### Risk + rollback
- **Risk: medium.** Security-critical (constant-time compare, raw-body-before-parse, HMAC). But each webhook is one route; migrate + test independently.
- **Rollback**: revert the per-webhook PR; the inline auth returns. Module stays unused for that webhook.

### Test that proves it
- New `hub/test/webhook-intake.test.ts`: constant-time compare (timing-equal-length + mismatch), HMAC verify pass/fail, skew accept/reject at ±301s, IP allowlist allow/deny, uniform 401 shape, audit-on-fail vs no-audit policy.
- Existing per-webhook tests stay green: `coolify-webhook.test.ts`, `coolify-webhook-secret.test.ts`, `revanote-webhook.test.ts`, `telegram-webhook.test.ts`, `cidr.test.ts`.

---

## Phase 3 — Mount-Order Assertion Test + Invariant Doc (C6, lighter fix) · NO REGISTRY

### Goal
Make `index.ts`'s load-bearing-but-invisible mount/middleware ordering *explicit and tested* without adding a registry indirection that would hide the ordering it manages.

### Why not the registry
Hono middleware executes in `app.use` registration order. The invariants that matter — public webhooks mounted *before* the JWT catch-all; license gate *after* auth; CSRF allowlist skipping webhooks — are all about **relative order of `app.use`/`app.route` calls**. A `{name, router, mountBefore}` declarative table re-expresses ordering as a dependency graph the framework then has to topologically flatten back into call order: more code, more indirection, same fragility, and the `mountBefore` edges become a second source of truth that can drift from the actual security requirement. The registry fails the depth test — it's shallow (interface complexity ≈ the ordering it encodes).

### The lighter fix (two parts)
1. **Invariant block** at the top of `index.ts`: a single commented ordering contract listing the must-hold relations (webhooks-before-JWT, auth-before-license-gate, csrf-skips-public-paths) with the line ranges that satisfy each. Already partially present as scattered `// MUST be mounted BEFORE` comments — consolidate into one authoritative block.
2. **`hub/test/mount-order.test.ts`** — boots the Hono app (or a route-table introspection) and asserts:
   - an unauthenticated POST to each public webhook path returns 401/403/503/202 (route mounted, auth ran) — **never 404** (would mean it fell through to the JWT catch-all and got swallowed) and **never 200-without-auth**.
   - an unauthenticated GET to a protected `/api/*` route returns 401 (JWT catch-all active).
   - the CSRF guard does NOT fire on the public webhook paths (they're in the skip list).
   This is the `known-paths-registry.test.ts` pattern already in the suite — extend it.

### Risk + rollback
- **Risk: low.** Additive test + comment. No runtime change.
- **Rollback**: delete the test file.

### Test that proves it
- `hub/test/mount-order.test.ts` is itself the deliverable. Pairs with existing `license-gate.test.ts`, `csrf.test.ts`, `ws-client-license-gate.test.ts`.

---

## Phase 4 — DAL Split (C4, optional cleanup) · DEFER or DROP

### Goal (if done)
Extract `telegram-dal.ts` (10 helpers, lines 1612-1730 of `dal.ts`) and `chat-tabs` helpers into siblings, matching the existing `chat-tabs-dal.ts` / `revanote-dal.ts` / `scheduled-tasks-dal.ts` / `supervisor-dal.ts` / `orchestrator-dal.ts` pattern. Document a split threshold (e.g. "subsystem owns ≥6 DAL helpers → own `*-dal.ts`").

### Why deferred / droppable
- `dal.ts` is **1,753 LOC / 101 exports** — large, but the deletion test is **neutral**: moving functions to a new file changes no interface, hides no caller complexity, removes no duplication. It's file-hygiene, not deepening. Pure navigability gain.
- The exploration's own framing calls it "the weakest candidate." Agreed. It earns its place only as a *trailing* cleanup once the load-bearing C1/C2 work is merged and stable, to avoid churning `dal.ts` (which C1's `dailyCostCapGate` and C2's audit calls both touch) during the risky phases.

### Migration steps (if done)
1. Move the 10 `getUserByTelegramChatId` … `logTelegramInbound` helpers + `TelegramUserRow`/`TelegramInboundLogInput` types into `hub/src/db/telegram-dal.ts`.
2. Re-export from `dal.ts` for one commit (back-compat), update importers, then drop the re-exports.
3. Add the threshold note to `hub/src/db/README` or a `// DAL split policy` comment.

### Risk + rollback
- **Risk: low** (mechanical move). **Rollback**: revert.

### Test
- `db-dal-auth.test.ts`, `telegram-api.test.ts`, `chat-tabs.test.ts` green. No new test needed (no behaviour change).

---

## Invariant-Risk Register

Every place the refactor could silently weaken a security/correctness invariant from CLAUDE.md, with the explicit verification step.

| ID | Invariant (source) | Phase at risk | How it could break | Verification |
|----|--------------------|---------------|--------------------|--------------|
| **IR-1** | **Cost-cap non-bypassable** (`enforceCostCap`/`checkUserThreshold`/`reserveSessionSlot`) | C1 | A subsystem migrated to `dispatch()` whose `gates[]` omits the cost-cap gate would dispatch uncapped. | `dispatch-pipeline.test.ts`: assert `dispatch()` with a cost-capped user returns `{kind:'skipped'}` and never calls the send fn. Per-subsystem: assert each subsystem's `PipelineDeps.gates` includes both `thresholdGate` and the daily-cost gate (snapshot test of the gate list). |
| **IR-2** | **Gate ordering** (threshold *before* cost-cap *before* queue) | C1 | Reordering gates could let a queued run skip a gate re-check on waiter promotion. Scheduler re-checks threshold at promotion today. | Test: promotion path (`onSessionReply` → promote waiter) re-runs the gate list before re-dispatch; assert a user who crossed the cap *while queued* gets `skipped_quota`, matching current `dispatcher.init()` behaviour. |
| **IR-3** | **Raw-body-before-parse** (all webhooks) | C2 | If `runIntake` parses JSON before computing HMAC, the signature check is meaningless. | `webhook-intake.test.ts`: HMAC is computed over the exact bytes returned as `rawBody`; assert a body that parses-equal but byte-differs (whitespace) fails HMAC. |
| **IR-4** | **Constant-time secret compare** | C2 | A refactor that compares with `===` or short-circuits on length-mismatch *before* the timing-safe path leaks timing. | `webhook-intake.test.ts`: `constantTimeEqual` returns false for unequal-length without throwing; uses `timingSafeEqual` (assert via spy or by code-review gate). Length-prefix guard is acceptable (current code does it). |
| **IR-5** | **Audit-every-hit, capped 100/user, preview-only, never store bad token** | C2 | Centralizing audit could (a) drop the cap, (b) start logging the wrong token, (c) stop auditing auth-fails where they were audited. | `webhook-intake.test.ts`: auth-fail with `auditOnAuthFail:true` writes a row with `raw_body_preview` ≤500 chars and NO token field; `auditOnAuthFail:false` (sentry/telegram) writes none. Cap-100 trim already tested in DAL — keep `coolify-webhook.test.ts` green. |
| **IR-6** | **No audit row on telegram/sentry auth-fail** (table-fill DoS guard) | C2 | Uniform audit policy would regress this into a DoS vector. | Covered by IR-5 `auditOnAuthFail:false` assertion. |
| **IR-7** | **Outbound forwards ONLY `assistant_message:final`** (telegram bridge) | C1 | `onSessionReply` consolidation must not start forwarding `thinking`/`text_delta`. | `telegram-bridge.test.ts` green; assert the finalize hook fires only on `assistant_message`, not on deltas (agent.ts line 469 branch unchanged). |
| **IR-8** | **Webhook-before-JWT mount order** | C3-doc/C6 | A future edit reorders mounts; public webhook falls into JWT catch-all → 404, silently breaking ingress. | `mount-order.test.ts` (Phase 3): unauth webhook POST ≠ 404. |
| **IR-9** | **`/ws/agent` keyed by api_keys, never user license** | C1 | Pipeline changes must not introduce a license check on the agent traffic path. | No license gate added to dispatch path; `ws-client-license-gate.test.ts` + agent auth tests green. |
| **IR-10** | **Single-use / dedupe semantics** (telegram `(chat_id,update_id)`, magic-link jti) | C2 | Dedupe is a *dispatch/body* concern; moving auth out must not move dedupe out or weaken its 200-on-dup short-circuit. | Keep dedupe in the webhook body (not in `runIntake`); `telegram-webhook.test.ts` dup-update test green. |

---

## Sequencing & Effort Summary

| Phase | Candidate | Effort | Risk | Gate (PRs) | Parallelizable? |
|-------|-----------|--------|------|-----------|-----------------|
| 1 | C1 + C3 pipeline + queue | **L** | **high** | 1 module PR + 4 per-subsystem PRs + 1 agent-rewire/cleanup PR (≈6) | No — anchor; subsystems serialize on the shared module |
| 2 | C2 webhook intake | **M** | **med** | 1 module PR + 4 per-webhook PRs (≈5) | Could run in a 2nd worktree after Phase-1 module PR lands, but webhooks call C1 dispatchers — prefer sequential |
| 3 | C6 mount-order test + doc | **S** | **low** | 1 PR | Yes — independent, any time |
| 4 | C4 DAL split | **S** | **low** | 1 PR | Yes — but LAST (avoid churning `dal.ts` during C1/C2) |
| — | C5 protocol union | — | — | **DROPPED** — premise false (`notification` already typed; Zod sub-unions already exist) | — |

**Recommended commit order:** Phase 1 (all sub-PRs) → Phase 2 → Phase 3 → Phase 4. Phase 3 may be pulled forward and landed first as a cheap safety net (it tests the *current* ordering, protecting Phases 1-2). Strangler-fig everywhere: introduce the deep module, migrate one subsystem/webhook per PR, delete the copies in the final PR of each phase. `hub/test/scheduler.test.ts` stays green at every single step — it is the contract.

### Bottom line
- **Anchor = C1+C3.** Real depth, deletion test passes hard, fixes the genuine grace/queue/finalize triplication.
- **C2 = real but scoped down** to the ~50-LOC auth core (not whole files); biggest *security* upside (invariants enforced once).
- **C6 = test + doc, not a registry.**
- **C4 = optional trailing cleanup.**
- **C5 = drop.**
