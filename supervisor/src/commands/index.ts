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
