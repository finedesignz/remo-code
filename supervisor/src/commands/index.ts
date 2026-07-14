/**
 * Supervisor-native command registry.
 *
 * These commands are NOT user-defined slash commands — they're built-in
 * RPCs that the hub invokes over WS via `run_command`. The supervisor
 * advertises them in `supervisor.commands_sync` so the hub can route
 * scheduled tasks / API endpoints (e.g. `/api/error-setup`) to them.
 */
import type { ScannedCommand } from '../commands-scanner'
import { runErrorSetupProbe } from './error-setup-probe'
import { runErrorSetupApply } from './error-setup-apply'
import { runTeabRun, runTeabStatus } from './teab-run'
import { runSessionTranscriptTail, runSessionMemory } from './session-read'
import { runWorkPushBranch, runWorkDiffScope, runWorkBuild, runWorkPublish } from './work-git'

export interface CommandResult {
  exit_code: number
  snippet?: string
  error?: string
}

export type CommandHandler = (args: string[]) => Promise<CommandResult>

const HANDLERS: Record<string, CommandHandler> = {
  error_setup_probe: async (args) => {
    const r = await runErrorSetupProbe(args)
    if (!r.ok) return { exit_code: 1, error: r.error || 'probe_failed' }
    return { exit_code: 0, snippet: JSON.stringify({ files: r.files ?? [] }) }
  },
  error_setup_apply: async (args) => {
    const r = await runErrorSetupApply(args)
    if (!r.ok) return { exit_code: 1, error: r.error || 'apply_failed' }
    if (r.nothing_to_commit) {
      return { exit_code: 0, snippet: JSON.stringify({ nothing_to_commit: true }) }
    }
    return {
      exit_code: 0,
      snippet: JSON.stringify({
        commit_sha: r.commit_sha,
        branch: r.branch,
        pushed: r.pushed,
      }),
    }
  },
  teab_run: (args) => runTeabRun(args),
  teab_status: (args) => runTeabStatus(args),
  // Milestone ASK Phase 1 — READ-ONLY. Derive the CLI's own transcript/memory dir
  // from the session's project_dir; never read an arbitrary hub-supplied path.
  session_transcript_tail: (args) => runSessionTranscriptTail(args),
  session_memory: (args) => runSessionMemory(args),
  // Milestone WORK — HUB-driven verification + publish of an agent's work branch.
  // The AGENT never invokes these: they are hub→supervisor RPCs. `work_diff_scope` is
  // a pure read; `work_build` runs the OPERATOR's build cmd with deploy credentials
  // scrubbed; `work_publish` is the only path that merges + runs the operator's publish
  // cmd, and the hub calls it only after all of its own checks pass.
  work_push_branch: (args) => runWorkPushBranch(args),
  work_diff_scope: (args) => runWorkDiffScope(args),
  work_build: (args) => runWorkBuild(args),
  work_publish: (args) => runWorkPublish(args),
}

export function getHandler(name: string): CommandHandler | null {
  return HANDLERS[name] ?? null
}

/** Supervisor-native commands advertised in `supervisor.commands_sync`. */
const NATIVE: Array<{ name: string; description: string }> = [
  { name: 'error_setup_probe', description: 'Read project files for error-tracking SDK detection' },
  { name: 'error_setup_apply', description: 'Install error-tracking SDK files into a repo + commit + push' },
  { name: 'teab_run', description: 'Background-spawn Titanium Edge AutoBuilder (teab run --repo <repo>) detached; returns a started run id' },
  { name: 'teab_status', description: 'Report state + recent events tail for a teab_run run id' },
  { name: 'session_transcript_tail', description: 'READ-ONLY: last N turns of the CLI transcript for a project_dir' },
  { name: 'session_memory', description: 'READ-ONLY: project memory files (~/.claude/projects/<slug>/memory/*.md)' },
  { name: 'work_push_branch', description: 'Push the agent-committed local work/<id> branch to origin (agent has no push credential)' },
  { name: 'work_diff_scope', description: 'READ-ONLY: file list + head sha of a work/<id> branch vs the default branch' },
  { name: 'work_build', description: 'Run the operator-configured build cmd against a work/<id> branch (deploy creds scrubbed)' },
  { name: 'work_publish', description: 'HUB-ONLY: ff-only merge a work/<id> branch into the default branch + run the operator publish cmd' },
]

export function nativeSupervisorCommands(): ScannedCommand[] {
  return NATIVE.map((c) => ({
    kind: 'command' as const,
    name: c.name,
    description: c.description,
    source: 'supervisor',
    path: '',
  }))
}
