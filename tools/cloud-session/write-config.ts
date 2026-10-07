// Write supervisor.json for a Claude Code cloud session from env vars.
// Called by tools/cloud-session/setup.sh. See docs/cloud-session-supervisor.md.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { getConfigPath } from '../../supervisor/src/config'

export function buildCloudConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const apiKey = (env.REMO_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('REMO_API_KEY is not set')
  const roots = (env.REMO_ROOTS ?? '/home/user').split(':').map((r) => r.trim()).filter(Boolean)
  const maxConcurrent = Number.parseInt(env.REMO_MAX_CONCURRENT ?? '', 10)
  return {
    hub_url: (env.REMO_HUB_URL ?? '').trim() || 'https://app.remo-code.com',
    api_key: apiKey,
    roots,
    max_concurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2,
    allow_dangerous_skip_permissions: env.REMO_ALLOW_DANGEROUS === '1',
    require_git_repo: false,
    // Headless container: no tray, no autostart, no hotkey.
    autostart: false,
    // Same operator override prod runs with (CLAUDE.md: REMO_PTY_INTERACTIVE):
    // the human surface is the genuine interactive `claude` TUI on this host's
    // own Claude login — no API key.
    default_human_backend: 'claude',
    claude_interactive_confirmed: true,
  }
}

if (import.meta.main) {
  const path = getConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(buildCloudConfig(process.env), null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log(`[remo-cloud] wrote ${path}`)
}
