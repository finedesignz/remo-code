import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join, basename, sep } from 'path'
import { homedir } from 'os'
import { builtinCommands } from './builtins'

export interface ScannedCommand {
  kind: 'command' | 'skill'
  name: string
  description: string | null
  source: string         // e.g. 'user' | 'plugin:hookify'
  path: string           // absolute file path
}

const CLAUDE_DIR = join(homedir(), '.claude')

function readFrontmatter(filePath: string): { name?: string; description?: string; body: string } {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
    if (!m) return { body: raw }
    const fmRaw = m[1]
    const body = m[2]
    const out: { name?: string; description?: string; body: string } = { body }
    for (const line of fmRaw.split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/)
      if (!kv) continue
      let v = kv[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (kv[1] === 'name') out.name = v
      else if (kv[1] === 'description') out.description = v
    }
    return out
  } catch { return { body: '' } }
}

function isDir(p: string): boolean { try { return statSync(p).isDirectory() } catch { return false } }
function walkMd(dir: string, depth = 0): string[] {
  if (depth > 4 || !isDir(dir)) return []
  const out: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (isDir(path)) out.push(...walkMd(path, depth + 1))
      else if (entry.endsWith('.md')) out.push(path)
    }
  } catch {}
  return out
}

function commandFromFile(path: string, source: string): ScannedCommand | null {
  const fm = readFrontmatter(path)
  const name = fm.name || basename(path, '.md')
  if (!name) return null
  return {
    kind: 'command',
    name,
    description: fm.description ?? null,
    source,
    path: path.replace(/\\/g, '/'),
  }
}

function skillFromFile(path: string, source: string): ScannedCommand | null {
  const fm = readFrontmatter(path)
  // For a SKILL.md, the skill name is the parent directory unless frontmatter says otherwise
  const parent = path.split(/[\\/]/).slice(-2, -1)[0] || 'skill'
  const name = fm.name || parent
  return {
    kind: 'skill',
    name,
    description: fm.description ?? null,
    source,
    path: path.replace(/\\/g, '/'),
  }
}

export function scanAllCommands(): ScannedCommand[] {
  const out: ScannedCommand[] = []
  const seen = new Set<string>()

  const push = (c: ScannedCommand | null) => {
    if (!c) return
    const key = `${c.kind}:${c.name}:${c.source}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  // 0. Built-in Claude Code commands (baked in, not file-scanned)
  for (const b of builtinCommands()) push(b)

  // 1. User commands: ~/.claude/commands/**/*.md
  const userCmdDir = join(CLAUDE_DIR, 'commands')
  for (const p of walkMd(userCmdDir)) push(commandFromFile(p, 'user'))

  // 2. User skills: ~/.claude/skills/*/SKILL.md
  const userSkillDir = join(CLAUDE_DIR, 'skills')
  if (isDir(userSkillDir)) {
    for (const entry of readdirSync(userSkillDir)) {
      const skillFile = join(userSkillDir, entry, 'SKILL.md')
      if (existsSync(skillFile)) push(skillFromFile(skillFile, 'user'))
    }
  }

  // 3. Plugin commands + skills: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{commands,skills}
  const pluginCache = join(CLAUDE_DIR, 'plugins', 'cache')
  if (isDir(pluginCache)) {
    for (const market of readdirSync(pluginCache)) {
      const marketDir = join(pluginCache, market)
      if (!isDir(marketDir)) continue
      for (const plugin of readdirSync(marketDir)) {
        const pluginDir = join(marketDir, plugin)
        if (!isDir(pluginDir)) continue
        // version subdirs (or direct content)
        const versions = readdirSync(pluginDir).filter((v) => isDir(join(pluginDir, v)))
        for (const v of versions) {
          const base = join(pluginDir, v)
          const cmdsDir = join(base, 'commands')
          for (const p of walkMd(cmdsDir)) push(commandFromFile(p, `plugin:${plugin}`))
          const skillsRoot = join(base, 'skills')
          if (isDir(skillsRoot)) {
            for (const sk of readdirSync(skillsRoot)) {
              const skf = join(skillsRoot, sk, 'SKILL.md')
              if (existsSync(skf)) push(skillFromFile(skf, `plugin:${plugin}`))
            }
          }
        }
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}
