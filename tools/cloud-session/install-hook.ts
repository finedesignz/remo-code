// Register a user-level Claude Code SessionStart hook that (re)starts the Remo
// supervisor on every session start/resume. Merges into ~/.claude/settings.json
// without touching anything else; idempotent. Called by setup.sh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function withStartHook(settings: any, command: string): any {
  const out = settings && typeof settings === 'object' ? { ...settings } : {}
  out.hooks = out.hooks && typeof out.hooks === 'object' ? { ...out.hooks } : {}
  const groups: any[] = Array.isArray(out.hooks.SessionStart) ? [...out.hooks.SessionStart] : []
  const present = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => h?.command === command))
  if (!present) groups.push({ hooks: [{ type: 'command', command }] })
  out.hooks.SessionStart = groups
  return out
}

if (import.meta.main) {
  const startScript = process.argv[2]
  if (!startScript) throw new Error('usage: install-hook.ts <start.sh>')
  const dir = join(homedir(), '.claude')
  const path = join(dir, 'settings.json')
  mkdirSync(dir, { recursive: true })
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  writeFileSync(path, JSON.stringify(withStartHook(current, `bash ${startScript}`), null, 2) + '\n')
  console.log(`[remo-cloud] SessionStart hook registered in ${path}`)
}
