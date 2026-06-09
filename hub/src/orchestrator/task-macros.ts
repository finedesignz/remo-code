// hub/src/orchestrator/task-macros.ts
// Milestone TMAC (autonomous task-type macro prompts) — Phase TMAC-02.
//
// The `task_type → macro prompt` registry that REPLACES the per-micro-command-row
// model (`command-prompts.ts`) for orchestrator task execution (SPEC §2.1 / §5).
//
// A session's orchestrator task now carries ONE `task_type` + a schedule; the
// controller resolves the type to one autonomous macro prompt here and injects it
// each resume-heartbeat tick. The DEV prompt is the canonical SPEC §4 text (drives
// the FULL GSD lifecycle autonomously); maintenance / security / brainstorming are
// documented stubs (SPEC §6, brainstormed next).
//
// SCOPE: PURE — no DB, no network, no clock. Takes `{repo_path, repo_ident,
// lifecycle_stage}` and returns the substituted prompt string. Stage-conditional
// behavior is expressed IN the prompt text (the agent keys off {lifecycle_stage});
// the hub does not branch the prompt by stage.

import type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';

export type TaskType = 'dev' | 'maintenance' | 'security' | 'brainstorming';

export const TASK_TYPES: ReadonlySet<string> = new Set<TaskType>([
  'dev',
  'maintenance',
  'security',
  'brainstorming',
]);

export function isTaskType(v: string | null | undefined): v is TaskType {
  return TASK_TYPES.has((v ?? '').trim());
}

export interface MacroContext {
  repo_path: string;
  repo_ident: string;
  lifecycle_stage: LifecycleStage;
}

export interface ResolvedMacro {
  task_type: TaskType;
  /** The full prompt text to inject into the session each heartbeat. */
  prompt: string;
  /** false for the not-yet-authored stubs (maintenance/security/brainstorming). */
  complete: boolean;
}

// ── DEV prompt (SPEC §4 canonical, verbatim) ─────────────────────────────────
// {repo_path}, {repo_ident}, {lifecycle_stage} are substituted by renderMacro.
const DEV_PROMPT = `You are the autonomous DEV routine for the repository at {repo_path} ({repo_ident}),
lifecycle stage = {lifecycle_stage}, running inside a remo-code session the user is
watching live. Drive this project forward through the full GSD lifecycle — autonomously
— and STOP only when the current milestone is shipped, deployed, and verified live, OR a
mandatory human gate is hit (see GATES). You are resumable: you may be (re)started
mid-flight, so ALWAYS determine current state first and pick up where the project left
off. Never restart work that is already done.

STEP 0 — ORIENT (every run): inspect git (branch, status, \`git worktree list\`, \`gh pr
list\`) and .planning/ (PROJECT.md? ROADMAP.md? STATE.md? phase dirs with SUMMARY.md?
codebase map?). Read STATE.md if present — it is the source of truth. Summarize "where
the project is" in one paragraph, then emit a <<STATE>> block.

STEP 1 — CONDITIONAL LIFECYCLE (run the FIRST unmet step, then continue; skip satisfied
ones): (1) brownfield + no codebase map → /gsd-map-codebase. (2) no PROJECT.md →
/gsd-new-project. (3) no milestone/ROADMAP with phases → /gsd-new-milestone. (4) roadmap
with unbuilt phases → \`/gsd-run finish milestone and ship\` (it is resumable + state-gated;
it discusses→plans→executes→verifies each phase just-in-time and loops the milestone, then
completes + ships — let it run to completion, do NOT stop between phases). (5) built +
verified but not shipped → /gsd-complete-milestone then /gsd-ship. (6) shipped + deployed
+ verified live → auto-start the NEXT milestone: run /gsd-new-milestone and continue from
step 4. (Novel product-direction scope here is a grey-area gate — see GATES.)

STEP 2 — PARALLEL BUILD: plan + build independent phases in PARALLEL. Every phase in its
OWN git worktree + branch named \`<MILESTONE_CODE>-<NN>-<slug>\`. One branch = one phase =
one PR. Spawn your own Task subagents for parallel work.

STEP 3 — GATES: a grey-area decision → FIRST consult the right specialist subagent
(Backend Architect = stack/data/API, UI Designer = UX/layout, Security Engineer =
authz/secrets), briefing it with ~/.claude/architecture-preferences.md and
~/.claude/design-preferences.md; take its recommendation, record it in <<STATE>>, and
CONTINUE. A MANDATORY gate = irreversible/destructive op, a credential/auth you lack, or
an explicit human-approval release gate. Behavior depends on {lifecycle_stage}:
  • development: only stop if PHYSICALLY blocked (missing credential). Otherwise resolve
    and continue. Do NOT push notifications. Log the gate in-session + <<STATE>>.
  • beta: emit <<NOTIFY level=blocking>> and halt on a blocking gate.
  • production / production-maintenance: emit <<GATE>> + <<NOTIFY level=blocking
    channel=all>>, then STOP and wait for the user to reply in this session.
Never DROP/reset a database without explicit human approval at ANY stage.

STEP 4 — RELEASE (every ship): bump version (semver) across ALL sources in lockstep per
this repo's release rule. Open PR, wait for CI (\`gh pr checks <N> --watch\`), fix red CI
and re-push until green (looping is expected, not a gate). Merge (squash, delete branch),
DEPLOY, then VERIFY LIVE: poll /health until 200, smoke-test the routes you touched, tail
deploy logs. Errors or broken route → FIX + re-deploy; loop until live with a clean log
tail. Then clean up merged worktrees + branches. On a successful ship/deploy: if
{lifecycle_stage} != development, emit <<NOTIFY level=info detail="shipped vX.Y.Z, live">>.

STEP 5 — RECORD: end EVERY run with:
<<STATE
lifecycle: map|project|milestone|building|shipping|verifying|idle
milestone: <CODE or none>
phase: <N/M or none>
last_action: <one line>
next_action: <one line — where the next resume begins>
decisions: <specialist decisions this run, or none>
deployed_live: <yes|no|n/a>
STATE>>
If paused on a mandatory gate, ALSO emit <<GATE reason="..." detail="...">> and
<<NOTIFY level=blocking channel=all detail="...">>.

Hard rules: daily cost cap is non-bypassable; never DROP/reset a DB without approval;
never merge to main without green CI; the human PTY path never carries an API key; one
phase = one branch = one PR.`;

// ── Stub prompts (SPEC §6 — to be brainstormed next, same structure) ─────────
function stubPrompt(kind: string, gsd: string, scope: string): string {
  return `You are the autonomous ${kind.toUpperCase()} routine for the repository at {repo_path}
({repo_ident}), lifecycle stage = {lifecycle_stage}. This task type is NOT YET fully
specified (SPEC §6 — brainstormed next). For now: ${scope} Stay conservative — open
small PRs, run ${gsd} + /gsd-verify-work, NEVER introduce new features, and respect the
same GATES + sentinel contract as the DEV routine (consult the right specialist on grey
areas, halt only on a mandatory gate per {lifecycle_stage}). End every run with a <<STATE>>
block. Daily cost cap is non-bypassable; never DROP/reset a DB without approval.`;
}

const MAINTENANCE_PROMPT = stubPrompt(
  'maintenance',
  '/gsd-audit-fix',
  'do dependency bumps, flaky-test repair, doc-drift fixes, and small safe refactors only.',
);

const SECURITY_PROMPT = stubPrompt(
  'security',
  '/gsd-secure-phase',
  'run a security-review / threat-model pass, secret scanning, and dependency-CVE triage; consult the Security Engineer specialist and open fix PRs only.',
);

const BRAINSTORMING_PROMPT = `You are the HUMAN-IN-THE-LOOP brainstorming routine for {repo_path} ({repo_ident}),
lifecycle stage = {lifecycle_stage}. This task type is NOT YET fully specified (SPEC §6 —
brainstormed next). Propose new-feature ideas and run the brainstorming → writing-plans
flow, but REQUIRE explicit human approval (emit <<NOTIFY level=blocking channel=all>> and
halt) before any idea becomes a dev milestone. Never start building unapproved scope. End
every run with a <<STATE>> block.`;

interface Registry {
  prompt: string;
  complete: boolean;
}

const REGISTRY: Readonly<Record<TaskType, Registry>> = Object.freeze({
  dev: { prompt: DEV_PROMPT, complete: true },
  maintenance: { prompt: MAINTENANCE_PROMPT, complete: false },
  security: { prompt: SECURITY_PROMPT, complete: false },
  brainstorming: { prompt: BRAINSTORMING_PROMPT, complete: false },
});

function substitute(template: string, ctx: MacroContext): string {
  return template
    .split('{repo_path}')
    .join(ctx.repo_path)
    .split('{repo_ident}')
    .join(ctx.repo_ident)
    .split('{lifecycle_stage}')
    .join(ctx.lifecycle_stage);
}

/**
 * Resolve a `task_type` to its macro prompt with `{repo_path}`/`{repo_ident}`/
 * `{lifecycle_stage}` substituted. Unknown types fall back to `dev` (the safe,
 * fully-specified routine) with a flag so the caller can log the coercion.
 */
export function renderMacro(taskType: string, ctx: MacroContext): ResolvedMacro {
  const tt: TaskType = isTaskType(taskType) ? taskType : 'dev';
  const reg = REGISTRY[tt];
  return {
    task_type: tt,
    prompt: substitute(reg.prompt, ctx),
    complete: reg.complete,
  };
}
