# Autonomous Auto-Dev System — Design Spec

**Status:** DESIGN (no implementation). READ-ONLY analysis + recommended path.
**Author:** Backend Architect agent · 2026-05-30
**Scope:** A periodic + reactive system that drives an app's development from the ground up:
intelligent Continue-Dev, periodic 3-agent QC-and-fix, Coolify-error→fix→redeploy loop,
scheduling windows + bounds, and the conceptual reframe of "tasks → routines/agent-workflows".

---

## 0. Executive summary

The remo-code scheduler **already contains 80% of the machinery** this vision needs. The
sophisticated `dev_plan → dev_execute → dev_ship` prompt templates
(`hub/src/scheduler/prompts/dev/{plan,execute,ship}.md`) exist and are Karpathy-aligned, but
they are **chained workflow steps that the user's bare `dev` tasks never reach** — `buildContent()`
in `hub/src/scheduler/senders/agent.ts:79` short-circuits a `dev` task to
`payload.prompt || task.prompt || 'Continue where you left off.'` and the rich plan/execute/ship
templates only fire when the UI auto-creates three pre-chained rows (`workflows.ts`,
`stepsForWorkflow`). The reactive Coolify loop (`hub/src/api/coolify-webhook.ts`, Phase 06) and the
error-capture loop (`docs/error-capture.md`, PR #17) already route inbound events into the
repo-bound session and let the agent commit→push→auto-deploy. The shared dispatch pipeline
(`hub/src/dispatch/`), the non-bypassable cost cap (`dispatch/gates.ts` `dailyCostCapGate`),
chain-depth cap (`dispatcher.ts` `MAX_CHAIN_DEPTH = 5`), and idempotency primitives
(`github_issue_idempotency`, error `fingerprint.ts`) are all reusable.

**Recommendation in one line:** do NOT build a parallel "routine engine". Add a thin
**state-gate + controller prompt** in front of the existing dev chain, **extend `ScheduleRule`
additively** for windows/bounds, and **close the redeploy-verify loop** on the existing triage
path. Net-new surface is small; most of the work is wiring + prompts + one DB column.

---

## 1. Conceptual model: Task vs Routine / Agent-Workflow

### The user's intuition is correct

A "scheduled task" today is already, structurally, **a trigger + a goal + a workflow + guardrails**:

| Routine concept | Existing substrate | file:line |
|---|---|---|
| **Trigger** (cron/window/event) | `cron_expr` + `schedule_rules` (periodic); `coolify-webhook.ts` + error envelope (event) | `schedule-rules.ts`, `api/coolify-webhook.ts` |
| **Goal** | `payload.prompt` / `payload.notes` | `senders/agent.ts:79`, `scheduled-tasks-dal.ts` |
| **Workflow** (ordered/branching steps) | `WORKFLOWS` map + `post_run_actions: chain_task` edges | `workflows.ts`, `post-run/chain.ts` |
| **State inputs** | `buildRuntimeContext()` + last run `output_snippet` / `runtime_context_snapshot` | `context/runtime-context.ts`, `scheduled-tasks-dal.ts` |
| **Guardrails** | `dailyCostCapGate`, `max_concurrent`, `MAX_CHAIN_DEPTH`, dedupe window | `dispatch/gates.ts`, `dispatcher.ts`, `registry.ts` |

So a **Routine = a `scheduled_tasks` row whose `task_type` selects a workflow, whose
trigger may be cron OR an event, and whose first step is state-aware.** The only things missing
from the "routine" framing are: (a) the *bare root* never enters its workflow, (b) triggers can't
express time-of-day windows or end-bounds, (c) there is no state-gate that decides
*build-next-step vs propose-roadmap*.

### Recommendation: **least-new-machinery — reuse `task_type` + `chain_task`, add ONE gating step**

Do **not** introduce a new `routines` table or a new abstraction layer. Instead:

1. **Reframe in the UI/docs only:** present `dev`, `qc`, and the reactive responders as
   **"Routines"** (a vocabulary change), each backed by a `task_type` + an ordered workflow in
   `WORKFLOWS`. No schema migration for the rename.
2. **Make the workflow root self-bootstrapping:** add an `auto_dev` controller step (§2) as the
   *first* step of the `dev` workflow so a bare `dev` routine actually plans/executes instead of
   sending the dumb default.
3. **Treat event responders as routines with an event trigger** instead of a cron trigger — they
   already are (`triage` task_type, `ensureInternalTriageTask`), they just lack the "routine" label
   and the post-fix verify edge.

This keeps the single dispatch pipeline, single cost cap, single chain mechanism. A net-new
"routine engine" would fork all three and re-introduce the Round-2 collapse the codebase just
finished removing ("Don't hand-roll per-subsystem dispatch/queue/grace" — CLAUDE.md invariant).

---

## 2. Intelligent Continue-Dev

### Problem

`buildContent()` (`senders/agent.ts:79`) sends `'Continue where you left off.'` for a bare `dev`
task. That is state-blind: it can't bootstrap an empty repo, can't tell "plan exists with unfinished
steps" from "nothing planned", and never proposes a roadmap.

### Design: a `dev` **controller** step that gates on repo state

Insert a new **first** step in the `dev` workflow:

```
WORKFLOWS.dev = ['dev_controller', 'dev_plan', 'dev_execute', 'dev_ship']   // dev_controller = NEW
```

`dev_controller` is a single agent turn whose prompt is a **decision tree**, not an implementation
task. The agent itself reads the repo state (it already has filesystem + git + `gh` access in the
session), classifies the situation, and **emits a structured decision** the hub parses (reuse the
existing `parseTriageOutput` / `Summary:` convention in `triage-schema.ts`). The hub then chains the
appropriate next step via `post_run_actions` — exactly like triage already routes to `github_issue`.

**State the controller reads** (all available to the in-session agent; hub pre-injects what it
cheaply can via `buildRuntimeContext`):
- `.planning/` plans — specifically `.planning/auto/dev-plan-*.md` (the execute step's own format)
  and any `.planning/**/PLAN.md`; count unchecked steps.
- `git log --oneline -10`, `git branch --show-current`, working-tree dirty state.
- Open PRs via `gh pr list` (the session has gateway GitHub creds, same path as
  `post-run/github-issue.ts` `loadGithubToken`).
- `TODO`/`FIXME` markers (ripgrep) and presence/absence of README/CLAUDE.md (empty-repo signal).
- **Last run output** — inject `scheduled_task_runs.output_snippet` + `runtime_context_snapshot`
  from the previous run of this task (new: `buildRuntimeContext` should also fetch the prior run's
  snippet; today it only fetches repo/email).

**Decision logic (the controller's branches):**

| Repo state | Decision | Chained next step |
|---|---|---|
| Empty/near-empty repo (no src, no README) | **Bootstrap** | `dev_plan` with a "scaffold from goal" directive |
| `dev-plan-*.md` exists with unchecked steps | **Continue building** | `dev_execute` (resumes the existing plan) |
| Plan fully checked, branch unmerged | **Ship** | `dev_ship` |
| No plan, but a stated goal in `payload.notes`/README | **Plan** | `dev_plan` |
| No plan AND no clear goal | **Propose** (human-in-loop) | NO chain — post suggestions to chat (§2.2) |

### 2.1 The controller prompt (concrete artifact)

Create `hub/src/scheduler/prompts/dev/controller.md`:

```markdown
## ROLE
You are the **Controller** for an autonomous development routine. You run BEFORE any
code is written. Your ONLY job is to read the current state of {{repo}} and decide what
should happen next. You do NOT implement anything in this turn.

## RUNTIME CONTEXT
(injected by hub — do not edit)
- repo: {{repo}}
- branch: {{branch}}
- last_commit_sha: {{last_commit_sha}}
- current_version: {{current_version}}
- mode: {{mode}}
- user_global_rules_digest: {{user_global_rules_digest}}

## INPUTS
- user_goal: {{user_prompt}}            <!-- payload.notes / payload.prompt; may be empty -->
- prior_run_summary: {{prior_step_output}}   <!-- last run's Summary line + snippet -->

## TASK — read-only scan, then decide
1. Determine repo emptiness: is there source code, a README, a package manifest?
2. Find plans: list `.planning/auto/dev-plan-*.md` and `.planning/**/PLAN.md`. For the
   newest, count steps and how many are unchecked.
3. Check git: `git branch --show-current`, `git log --oneline -10`, dirty working tree?
4. Check open PRs: `gh pr list --state open` (skip silently if gh unavailable).
5. Scan for TODO/FIXME density (ripgrep, capped).
DO NOT modify any file. DO NOT commit. This is reconnaissance only.

## DECISION — emit exactly one block at the end
Emit a single fenced block:
<<DECISION
action: bootstrap | continue | ship | plan | propose
reason: <one sentence>
next_goal: <what the next step should accomplish, one sentence>
roadmap: <ONLY when action=propose: 3-6 suggested features, newline-separated>
DECISION

Then a `Summary:` line: `Controller: <action> — <reason>`.

## RULES
- Prefer `continue`/`ship` over re-planning when an actionable plan already exists.
- `propose` ONLY when there is no plan AND no clear goal — never invent scope silently.
- Never start coding in this turn. Respect global rules #11 (smallest diff) and #19 (branch).
```

**Hub-side wiring (parser + router):** parse the `<<DECISION ... DECISION>>` block (mirror
`triage-schema.ts` `parseTriageOutput`). Map `action → chained task_id`:
- `bootstrap`/`plan` → chain `dev_plan`
- `continue` → chain `dev_execute`
- `ship` → chain `dev_ship`
- `propose` → **no chain**; run the §2.2 chat-suggestion path.

This reuses `post-run/chain.ts` `executeChain` (already honors `MAX_CHAIN_DEPTH`). The controller
is a normal agent run; only the *post-run routing* is new logic.

### 2.2 Surfacing suggestions to the user in chat

When `action=propose`, the controller's full turn (including the `roadmap`) is **already an
assistant message persisted to the session** (`assistant_message` → `insertMessage`,
`senders/agent.ts`). To make it a clear, actionable prompt rather than a buried run output:
- Post-run action `notify` (existing `OnCompleteAction { type:'notify' }`) emails the roadmap via
  emails4agents (reuse `error-capture/notify.ts` throttling pattern).
- Optionally a Telegram nudge through the existing bridge (`docs/telegram-bridge.md`) so the user
  sees "Routine X proposes: [roadmap]. Reply to approve." — the orchestrator session is the natural
  recipient.
- **Human-in-the-loop checkpoint:** `propose` NEVER auto-chains to build. The user must reply
  (in chat / Telegram) to convert a roadmap item into the routine's `payload.notes`, after which
  the next tick's controller will choose `plan`.

### 2.3 Decision: new `auto_dev` task_type vs gate the existing chain

**Recommendation: gate the existing chain. Do NOT add an `auto_dev` task_type.** Add
`dev_controller` as a chained step kind (extend the `TaskType` union + DB CHECK constraint, same
pattern as the Phase-11 step kinds in `scheduled-tasks-dal.ts`) and prepend it to `WORKFLOWS.dev`.
Then change `buildContent()` so a bare `dev` root renders the controller template instead of the
`'Continue where you left off.'` literal. This makes **every existing `dev` routine intelligent for
free** with no data migration, and reuses the plan/execute/ship templates that already exist but
never fire. A separate `auto_dev` type would duplicate the dev workflow and orphan current rows.

---

## 3. Periodic QC-and-fix routine

### Design: a `qc` workflow mirroring the `dev`/`security` shape

Add a third user-pickable root `qc` with an ordered workflow:

```
WORKFLOWS.qc = ['qc_review', 'qc_fix', 'qc_verify']
```

- **`qc_review`** — run the existing `triple-qc` / `/code-review` harness over the whole repo
  (3-agent review: correctness, reuse/simplification, security). Output: a structured findings
  list (severity, file:line, root cause, suggested fix) using the **same `<<JSON>>`/`parseTriageOutput`
  shape** already parsed by the triage path. Findings persist in `output_snippet`.
- **`qc_fix`** — chained ONLY when `qc_review` found ≥1 actionable bug. Reuses the `dev_execute`
  discipline (smallest diff, tests in same commit, commit-don't-push). One fix dispatch per finding
  batch, capped.
- **`qc_verify`** — run tests / `bun run check-baseline`; if green, commit; **open a PR rather than
  auto-merge** (default — see §8 open questions). If red after 2 attempts, emit
  `Summary: BLOCKED` and stop.

### How findings become fix dispatches

`qc_review`'s parsed findings are written to `output_snippet`; the post-run router (same place that
parses the controller decision in §2.1) decides: **findings present → chain `qc_fix`**, else
finalize clean (no chain, optional "QC clean" notify). The fix step reads the findings from the
prior step's `output_snippet` via the existing `prior_step_output` template var.

### Guards against infinite fix loops + cost (CRITICAL)

- **Re-use `MAX_CHAIN_DEPTH = 5`** (`dispatcher.ts`) — `review→fix→verify` is depth 3, well under.
- **No re-review on the same tick.** `qc_verify` does NOT chain back to `qc_review`; the *next
  scheduled tick* re-reviews. This bounds the loop to one fix-batch per fire.
- **Finding-hash idempotency** (mirror `github_issue_idempotency` / error `fingerprint.ts`):
  hash `(repo, file, finding_type, top-line)`; skip a finding already "fixed-and-verified" within
  24h to stop oscillation on a finding the agent can't actually resolve.
- **`dailyCostCapGate` is non-bypassable** (CLAUDE.md invariant) — every fix dispatch flows through
  it; a runaway QC routine self-throttles.
- **`max_concurrent = 1`** per routine prevents overlapping QC fires from racing the same tree.

---

## 4. Coolify / error → fix → redeploy loop

### Already wired (Phase 06 + error-capture)

- `coolify-webhook.ts`: `deployment.failed` → `ensureInternalTriageTask` → fire-and-forget triage
  dispatch → `pickSessionTarget` routes to a session → optional `github_issue` post-run action.
- `error-capture`: Sentry envelope → fingerprint → dedupe/rate-limit/cap gates → `user_message` into
  the repo-bound session → agent fixes, commits, pushes → **Coolify auto-deploys on push** (the
  redeploy already closes via git push, per `docs/error-capture.md`).

### The gaps to close

1. **Routing to the RIGHT repo session.** Triage uses `pickSessionTarget` (capacity-based), not
   repo-keyed. Add repo-keyed routing: match the webhook's `git_repository` / `application_uuid`
   against `sessions.repo_key` (the column `buildRuntimeContext` already reads) so the fix lands in
   the session actually bound to that repo. Fall back to `pickSessionTarget` only when no repo match.
2. **Explicit redeploy + verify after the fix** (vs relying on push-auto-deploy alone). After the
   fix commit lands, chain a **`deploy_verify`** post-run action that: triggers Coolify redeploy
   (`POST /api/v1/deploy?uuid=<app-uuid>` — the agent already has `COOLIFY_TOKEN`/Coolify access per
   global rule 22 + `docs/reference_prod_ops_access.md`), polls `/health` then probes the real
   routes (global rule 14.4 — *not* `/health` alone), and reports pass/fail to chat. This makes the
   loop *verified-closed*, not *hopefully-closed*.
3. **Dedupe error storms.** Error-capture already has fingerprint dedupe; the Coolify path does NOT.
   Add a `(user, application_uuid, deploy_failure_fingerprint)` dedupe window (reuse
   `github_issue_idempotency` table pattern) so 50 failed deploys in a row produce ONE fix dispatch,
   not 50.

### Reuse vs net-new
- **Reuse:** triage dispatch, `parseTriageOutput`, `github_issue` idempotency, the agent's Coolify
  deploy access, error-capture's fingerprint/dedupe primitives.
- **Net-new:** repo-keyed target resolver, the `deploy_verify` post-run action (a probe script per
  global rule 14.4), and a Coolify-path dedupe window.

---

## 5. Scheduling windows + bounds (additive `ScheduleRule` extension)

### Current shape (backward-compat baseline)

`ScheduleRule = { interval:int>=1, unit:'hours'|'days'|'weeks', start_at:ISO }`
(`schedule-rules.ts`). `ruleToCron` builds a 5-field cron; `shouldSkipFire` gates future `start_at`
and weekly-interval cadence; `registry.ts` calls `shouldSkipFire` before each `fire`.

### Proposed additive fields (all OPTIONAL — old rules stay valid)

```ts
interface ScheduleRule {
  interval: number
  unit: 'hours' | 'days' | 'weeks'
  start_at: string                         // unchanged
  // NEW — all optional, absence = today's behavior
  active_window?: { from: string; to: string }   // "HH:MM" wall-clock in task tz; overnight wrap allowed (22:00→06:00)
  until?: string                                  // ISO end bound — no fire at/after this instant
  max_runs?: number                               // stop after N successful fires
  for?: { count: number; unit: 'hours'|'days'|'weeks'|'months' }  // derived end bound = start_at + count·unit
}
```

`until`, `max_runs`, `for` are **mutually-exclusive end bounds** (validate: at most one set).
`for` is resolved to an absolute instant at validation time and stored alongside (or recomputed in
`shouldSkipFire`).

### Where each lands

- **`validateRule`** (`schedule-rules.ts`): accept + range-check the new fields; enforce
  ≤1 end-bound; `active_window` times must be `HH:MM`. Mirror in `web/src/lib/schedule-rules.ts`
  (the intentional tiny duplicate).
- **`ruleToCron`**: leave the *coarse* cron broad (still fires across the day); the window is
  enforced at fire-time, not in cron (cron can express a window via `H1-H2` in the hour field, but
  overnight wrap `22-6` is awkward — better to keep cron permissive and gate in `shouldSkipFire`).
  *Optionally* tighten the hour field when `active_window` is set and non-wrapping, as an
  optimization; not required for correctness.
- **`shouldSkipFire`** (the single enforcement point, already called by `registry.ts`): add, in
  order — (a) `now < start_at` → skip (existing); (b) end-bound exceeded (`until`/derived-`for`/
  `max_runs` reached) → skip **and signal completion**; (c) `active_window` set and `now`'s
  wall-clock (in task tz, via the existing `extractWallClock`) outside window → skip. Overnight
  wrap: window is "inside" if `from<=to ? from<=t<to : t>=from || t<to`.
- **`max_runs` counting:** needs a successful-fire count. Reuse `scheduled_task_runs` —
  `COUNT(*) WHERE task_id=? AND status='success'`. Pass into `shouldSkipFire` (or compute in the
  registry before the call).
- **Auto-disable / complete on bound hit:** when `shouldSkipFire` returns "completed" (not merely
  "skip this fire"), the registry sets `enabled=false` (new helper) and emits a
  `scheduled_task_completed` WS event so the UI shows "Completed" not "Disabled". A routine that hit
  its bound is *done*, not paused.

### UI (`ScheduleRulesBuilder` / `ScheduleEditor`)

Add to the per-rule editor: an optional **"Active hours"** time-range (from/to, with an overnight
hint), and an **"End"** selector — `Never` (default) | `On date` (`until`) | `After N runs`
(`max_runs`) | `For N {hours/days/weeks/months}` (`for`). `humanizeRule` extends to
`"Every 2 hours between 22:00–06:00, for the next 3 days"`. All optional → existing rules render
unchanged.

### Backward-compat guarantee

Absence of every new field == today's behavior byte-for-byte. `validateRules` still accepts the
3-field shape. No migration of existing `schedule_rules` JSONB rows required (additive optional
keys on a JSONB column).

---

## 6. The composed auto-dev loop

Per-repo, three routines compose under the existing scheduler + orchestrator:

```
                 ┌─────────────────────────── orchestrator session (conductor, 1/user) ──────────────────────────┐
                 │                                                                                                 │
  [cron+window]  │   dev routine ──> dev_controller ──decision──> {bootstrap|plan|execute|ship}  or  propose→chat │
  (overnight)    │                                                                                                 │
  [cron+window]  │   qc routine  ──> qc_review ──findings?──> qc_fix ──> qc_verify ──> PR (no auto-merge default)  │
                 │                                                                                                 │
  [event]        │   error responder ── coolify.failed / sentry envelope ──> repo-keyed session ──> fix ──>        │
                 │                       deploy_verify (redeploy + probe real routes) ──> report                   │
                 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Conductor:** the auto-launched orchestrator session (one per user,
  `idx_sessions_orchestrator_unique`) is the natural recipient for `propose` roadmaps, QC summaries,
  and verify reports — it already coordinates the root folder. It does NOT need to *dispatch*; the
  scheduler does that. It's the **human-facing surface** for routine output.
- **Human-in-the-loop checkpoints:** (1) `propose` never auto-builds — roadmap → chat → user
  approves → becomes `payload.notes`. (2) QC fixes open a PR by default, not auto-merge. (3) Coolify
  fixes commit→push→verify but the user sees the verify report.
- **Safety rails (all reuse):** `dailyCostCapGate` (non-bypassable), `max_concurrent=1` per routine,
  `MAX_CHAIN_DEPTH=5`, the new **overnight `active_window`** so auto-dev runs 10pm–6am only, branch
  hygiene (controller/plan templates already enforce global rule #19 "branch off main"), and the
  no-force-push / no-reset rules baked into the `dev_execute`/`dev_ship` templates' STOP CONDITIONS.

---

## 7. Phasing (5 shippable PRs, dependency order)

Each PR ends with a QC gate (per-file `bun run check-baseline`) + an independent verifier
(`VERIFICATION.md`, global rule 13a).

| PR | Goal | Reuse vs net-new | Risk |
|---|---|---|---|
| **P1 — Schedule windows + bounds** | Additive `active_window`/`until`/`max_runs`/`for` on `ScheduleRule`; enforce in `shouldSkipFire`; auto-complete on bound; UI in `ScheduleRulesBuilder`. | Reuse `extractWallClock`, `registry` gate. Net-new: end-bound + window logic, `max_runs` count query, `scheduled_task_completed` event. | **LOW** — self-contained, fully backward-compat. Ship FIRST so overnight bounding exists before autonomy widens. |
| **P2 — Intelligent Continue-Dev controller** | `dev_controller` step + `controller.md` prompt + `<<DECISION>>` parser + post-run router; `buildContent()` renders controller for bare `dev`; inject prior-run `output_snippet` into `buildRuntimeContext`. | Reuse plan/execute/ship templates, `chain.ts`, `parseTriageOutput` pattern. Net-new: controller prompt, decision parser, router. | **MED** — touches the hot dispatch path + `TaskType` enum + DB CHECK. Riskiest: parser robustness + ensuring bare-`dev` rows migrate cleanly. |
| **P3 — Propose-to-chat + HITL** | `propose` action → notify (email/Telegram) + roadmap surfacing; user-reply → `payload.notes`. | Reuse `notify.ts` throttle, telegram bridge, `OnCompleteAction notify`. Net-new: roadmap formatter, reply→notes capture. | **LOW–MED** — mostly glue; HITL reply capture is the fuzzy bit. |
| **P4 — QC-and-fix routine** | `qc` workflow (`qc_review→qc_fix→qc_verify`) wrapping `triple-qc`/`/code-review`; findings→fix chain; finding-hash idempotency; PR-not-merge default. | Reuse triage parse shape, `dev_execute` discipline, idempotency table pattern, cost cap. Net-new: qc prompts, findings parser, finding-hash dedupe. | **MED** — loop-safety is the crux; the §3 guards must be airtight. |
| **P5 — Coolify error→fix→redeploy verify** | Repo-keyed target resolver; `deploy_verify` post-run action (redeploy + probe real routes); Coolify-path storm dedupe. | Reuse triage dispatch, Coolify deploy access, error-capture fingerprint. Net-new: repo-keyed resolver, verify probe action, dedupe window. | **MED–HIGH** — touches prod deploy; the verify probe must follow rule 14.4 (probe real routes, not `/health`). |

**Riskiest decisions flagged:** (a) modifying `buildContent()` on the hot path (P2) — must not
regress existing `dev` rows; gate behind the controller cleanly. (b) QC loop safety (P4) — a
mis-tuned dedupe could either oscillate or suppress real fixes. (c) Auto-redeploy in P5 touching
prod — keep the verify probe mandatory and the dedupe tight.

---

## 8. Open questions for the user

1. **Auto-merge aggressiveness:** Should QC-fixes and Continue-Dev ship steps **auto-merge** (full
   autonomy, global rule 14) or **open a PR for review** (default proposed here)? Recommend
   PR-by-default for `qc`, auto-merge allowed for `dev_ship` since its template already gates on
   code-review.
2. **Default overnight window:** Adopt a default `active_window` of **22:00–06:00 local** for
   auto-dev/QC routines so unattended work runs while the user is away — or leave windows fully
   opt-in?
3. **Propose vs build threshold:** When a repo has *no plan and no goal*, should the controller
   **always `propose` to chat** (conservative, proposed here) or be allowed to **auto-bootstrap a
   roadmap from the repo's README/goals** without waiting for a reply? Affects how "from the ground
   up" an empty repo gets driven autonomously.
