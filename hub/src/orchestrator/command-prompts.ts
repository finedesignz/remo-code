// hub/src/orchestrator/command-prompts.ts
// Phase 25 (auto-dev-orchestrator) — the gsd-command → templated-prompt registry.
//
// Locked decision D6: the hub does NOT re-implement orchestration. It injects a
// TEMPLATED PROMPT into the bound session agent (Claude Code, which holds the gsd
// skills); the agent runs the corresponding gsd skill, spawns its OWN Task
// subagents for parallel work, opens a PR on a per-command branch, dispatches a
// reviewer subagent to check that PR, and reports the PR url + reviewer verdict
// back in a parseable `<<UNIT ... UNIT>>` block. The hub only ships text — it
// NEVER shells `gh`, git, or merge.
//
// Reqs:
//   R-ADO-13 — each non-propose unit MUST finish → create a PR → dispatch a
//              reviewer; the verdict is captured to routine_run_log.
//
// SCOPE: this module is PURE (no DB, no network, no clock). It maps a command
// string (+ optional micro-prompt free text) to the prompt string the seam
// injects. ship / complete-milestone / tag are PROPOSE-tier (D5 / Phase 28) and
// are deliberately ABSENT from the executable registry — those route through
// `proposeToChat` (Phase 28), never executeCommand, so they need no template here.

import { agentForDimension, isGapDimension, type GapDimension } from './gap-rotation.ts'

/** The command key(s) that drive the Phase-26 gap-scan rotation. */
const GAP_SCAN_COMMANDS: ReadonlySet<string> = new Set(['gap-scan', 'gsd-gap-scan'])

/** True iff `command` is a gap-scan rotation command. */
export function isGapScanCommand(command: string): boolean {
  return GAP_SCAN_COMMANDS.has((command ?? '').trim())
}

// ── Command → gsd skill name ─────────────────────────────────────────────────
/**
 * The DUE-row `command` strings map to the gsd skill the agent should run.
 *
 * NOTE on naming: the orchestrator wave planner (`waves.ts`) uses SHORT command
 * keys (`plan`, `execute`, `audit-fix`, `gap-scan`, `code-review`, ...) for its
 * dependency topology, while the user-facing default ROWS (SPEC §3) are the full
 * `gsd-*` slugs. We accept BOTH spellings here (short → canonical) so a unit
 * carrying either form resolves to the same skill invocation.
 */
const COMMAND_TO_SKILL: Readonly<Record<string, string>> = Object.freeze({
  // full gsd-* slugs (SPEC §3 default rows)
  'gsd-plan-phase': 'gsd-plan-phase',
  'gsd-execute-phase': 'gsd-execute-phase',
  'gsd-audit-fix': 'gsd-audit-fix',
  'gap-scan': 'gsd-review', // gap-scan rotation runs the review skill (specialist lens, Phase 26)
  'gsd-code-review': 'gsd-code-review',
  'gsd-verify-work': 'gsd-verify-work',
  // short topology keys (waves.ts) → same skills
  plan: 'gsd-plan-phase',
  execute: 'gsd-execute-phase',
  'audit-fix': 'gsd-audit-fix',
  'code-review': 'gsd-code-review',
  'verify-work': 'gsd-verify-work',
})

/** Propose-tier commands (D5 / Phase 28) — NOT executable here. */
export const PROPOSE_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ship',
  'gsd-ship',
  'complete-milestone',
  'gsd-complete-milestone',
  'tag',
])

/** Sentinel command for a free-text micro-prompt (custom) row. */
export const MICRO_PROMPT_COMMAND = 'micro-prompt'

// ── The finish → PR → reviewer → report envelope (R-ADO-13) ──────────────────
/**
 * The shared instruction envelope appended to EVERY non-propose command prompt.
 * It is the R-ADO-13 contract the agent must honour inside its own turn:
 *   1. complete the work,
 *   2. `gh pr create` on a per-command branch (NEVER merge to main — that is the
 *      off-hours Phase-29 command),
 *   3. dispatch a reviewer subagent to verify that PR,
 *   4. report the PR url + reviewer verdict back in a parseable `<<UNIT>>` block
 *      so the hub can reconcile pr_url/verdict into routine_run_log on a later tick.
 *
 * `{command}` is substituted with the resolved command name for the branch slug.
 */
function envelope(command: string): string {
  const branch = `auto-dev/${command}`
  return [
    '',
    '---',
    'When the work above is complete, you MUST (this is the orchestrator contract):',
    `1. Create a PR with \`gh pr create\` on a per-command branch (e.g. \`${branch}/<short-slug>\`).`,
    '   Do NOT merge to main — merging to main is the off-hours command, never here.',
    '2. Dispatch a reviewer subagent (gsd-code-review or an equivalent reviewer) to check that PR.',
    '3. Report the result back as a SINGLE parseable block at the very end of your reply:',
    '<<UNIT',
    `command: ${command}`,
    'pr_url: <the PR url, or empty if none was opened>',
    'reviewer_verdict: <PASS|FAIL|UNCERTAIN, or empty>',
    'UNIT',
    '',
    'Respect the daily cost cap and chain-depth — they are non-bypassable.',
  ].join('\n')
}

// ── Prompt composition ────────────────────────────────────────────────────────
export interface ComposeInput {
  /** The DUE-row command string (short topology key or full gsd-* slug). */
  command: string
  /** Free-text for a custom MICRO-PROMPT row (nullable). */
  microPrompt?: string | null
  /**
   * Phase-26 gap-scan rotation: the dimension this gap-scan tick should analyse
   * (chosen by `nextGapDimensions` from the run log). Ignored for non-gap commands.
   */
  gapDimension?: GapDimension | string | null
}

export interface ComposedPrompt {
  /** The resolved canonical command name (used for branch slug + run-log key). */
  command: string
  /** The full prompt text the seam injects into the bound session. */
  prompt: string
  /** The gsd skill the prompt instructs the agent to run (null for micro-prompt). */
  skill: string | null
  /**
   * Phase-26: the gap dimension embedded in this prompt (gap-scan only), echoed so the
   * seam can persist it to `routine_run_log.gap_dimension`. Null for non-gap commands.
   */
  gapDimension: GapDimension | string | null
}

/**
 * Compose the templated prompt for a command row.
 *
 * - A KNOWN gsd command → "run the <skill> gsd skill for <repo>" + the finish→PR→
 *   reviewer→report envelope.
 * - A MICRO-PROMPT row (command === MICRO_PROMPT_COMMAND, or any unknown command
 *   carrying `microPrompt` text) → the user's free text wrapped in the SAME
 *   envelope (so custom commands still finish → PR → reviewer → report).
 *
 * Returns `null` for a PROPOSE-only command (ship/complete-milestone/tag) — those
 * must route through proposeToChat, never here — and for an unknown command with
 * no micro-prompt (nothing to run).
 */
export function composeCommandPrompt(input: ComposeInput): ComposedPrompt | null {
  const command = (input.command ?? '').trim()
  if (!command) return null
  if (PROPOSE_ONLY_COMMANDS.has(command)) return null // routed via proposeToChat (Phase 28)

  const micro = (input.microPrompt ?? '').trim()

  // Micro-prompt row (explicit sentinel OR an unknown command carrying free text).
  const skill = COMMAND_TO_SKILL[command] ?? null
  if (command === MICRO_PROMPT_COMMAND || (skill == null && micro.length > 0)) {
    if (micro.length === 0) return null // a micro-prompt row with no text is a no-op
    const prompt = [
      'You are running a custom orchestrator command for this repo. Do the following:',
      '',
      micro,
      envelope(command === MICRO_PROMPT_COMMAND ? 'micro-prompt' : command),
    ].join('\n')
    return { command, prompt, skill: null, gapDimension: null }
  }

  if (skill == null) return null // unknown command, no micro-prompt → nothing to run

  // Phase-26 gap-scan rotation: when a dimension is supplied, focus this gap-scan on it
  // and route the analysis through the mapped specialist subagent (R-ADO-17/18).
  let gapLine = ''
  let gapDimension: GapDimension | string | null = null
  if (isGapScanCommand(command)) {
    const dim = (input.gapDimension ?? '').toString().trim()
    if (isGapDimension(dim)) {
      gapDimension = dim
      const agent = agentForDimension(dim)
      gapLine = [
        `\nThis is a ROTATING gap-scan. Run a **${dim}** gap analysis for this repo`,
        `using the **${agent}** specialist subagent. Focus only on the ${dim} dimension.`,
        `Record the dimension you scanned as \`gap_dimension: ${dim}\` in the report block below`,
        'so the next gap-scan tick rotates to a different dimension.',
      ].join(' ')
    }
  }

  const prompt = [
    `Run the \`${skill}\` gsd skill for this repo as the orchestrator's scheduled "${command}" command.`,
    'Plan the work, then execute it. If the work is parallelizable, spawn your own Task subagents.',
    gapLine,
    micro.length > 0 ? `\nAdditional instruction for this run: ${micro}` : '',
    envelope(command),
  ]
    .filter(Boolean)
    .join('\n')
  return { command, prompt, skill, gapDimension }
}

/** True when a command would be EXECUTED (not proposed, not a no-op) given input. */
export function isExecutableCommand(input: ComposeInput): boolean {
  return composeCommandPrompt(input) != null
}
