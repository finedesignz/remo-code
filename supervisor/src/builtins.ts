// Built-in Claude Code slash commands.
//
// These are NOT discoverable via CLI introspection — they live inside the
// claude binary itself. List sourced from the official docs:
//   https://docs.claude.com/en/docs/claude-code/slash-commands
//
// Keep this list in sync manually when Claude Code adds/removes built-ins.

import type { ScannedCommand } from './commands-scanner'

interface Builtin { name: string; description: string }

const BUILTINS: Builtin[] = [
  { name: 'add-dir',         description: 'Add additional working directories to the session' },
  { name: 'agents',          description: 'Manage custom AI subagents for specialized tasks' },
  { name: 'bashes',          description: 'List and manage background bash shells' },
  { name: 'bug',             description: 'Report a bug (sends conversation to Anthropic)' },
  { name: 'clear',           description: 'Clear conversation history and free up context' },
  { name: 'compact',         description: 'Compact the conversation, optionally with focus instructions' },
  { name: 'config',          description: 'View or modify Claude Code configuration' },
  { name: 'cost',            description: 'Show token usage statistics and session cost' },
  { name: 'doctor',          description: 'Check the health of your Claude Code installation' },
  { name: 'exit',            description: 'Exit the REPL' },
  { name: 'export',          description: 'Export current conversation to a file or clipboard' },
  { name: 'help',            description: 'Show help and usage information' },
  { name: 'hooks',           description: 'Manage hook configurations for tool events' },
  { name: 'init',            description: 'Initialize project with a CLAUDE.md guide for the codebase' },
  { name: 'login',           description: 'Switch Anthropic accounts' },
  { name: 'logout',          description: 'Sign out from your Anthropic account' },
  { name: 'mcp',             description: 'Manage MCP server connections and OAuth authentication' },
  { name: 'memory',          description: 'Edit CLAUDE.md memory files' },
  { name: 'model',           description: 'Select or change the AI model' },
  { name: 'output-style',    description: 'Switch output style or view current style' },
  { name: 'output-style:new', description: 'Create a new custom output style' },
  { name: 'permissions',     description: 'View or update tool permissions' },
  { name: 'plugins',         description: 'Browse, install, and manage Claude Code plugins' },
  { name: 'pr_comments',     description: 'View pull request comments' },
  { name: 'release-notes',   description: 'View release notes for the current Claude Code version' },
  { name: 'resume',          description: 'Resume a previous conversation' },
  { name: 'review',          description: 'Request a code review' },
  { name: 'rewind',          description: 'Rewind the conversation and/or code to an earlier point' },
  { name: 'security-review', description: 'Run a security review of pending changes' },
  { name: 'status',          description: 'View account, system, and connectivity status' },
  { name: 'terminal-setup',  description: 'Install Shift+Enter key binding for newlines' },
  { name: 'todos',           description: 'View the current todo list' },
  { name: 'usage',           description: 'Show plan usage limits and rate-limit windows' },
  { name: 'vim',             description: 'Enter vim mode for alternating insert and command modes' },
]

export function builtinCommands(): ScannedCommand[] {
  return BUILTINS.map((b) => ({
    kind: 'command',
    name: b.name,
    description: b.description,
    source: 'builtin',
    path: '', // built-ins have no file path
  }))
}
