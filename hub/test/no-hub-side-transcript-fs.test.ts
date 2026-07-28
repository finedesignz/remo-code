/**
 * PTYCAP Phase 1, plan 03 — Pitfall-1 guard canary (01-RESEARCH.md).
 *
 * The hub runs in a Coolify container with no `~/.claude/projects` — a hub-side
 * home-directory-derived filesystem read works perfectly in local dev and
 * silently does NOTHING in prod (the exact failure shape `REMO_TELEGRAM_TRANSCRIPT_TAIL`
 * is documented "keep OFF in Coolify" for; see CLAUDE.md). PTYCAP Phase 1 puts
 * ALL new transcript-tail filesystem access in `supervisor/src/usage/` — this
 * canary is the structural guarantee that stays true going forward: any FUTURE
 * `hub/src/**` module that calls Node's home-directory resolver is a production
 * defect, caught here instead of silently in Coolify.
 *
 * Style mirrors `supervisor/test/no-legacy-agent-spawn.test.ts` — a grep-based
 * static canary, comment-insensitive in both directions (a prose comment
 * mentioning the pattern neither trips nor satisfies the check).
 *
 * The ONE pre-existing, allowlisted offender is `hub/src/telegram/transcript/`
 * (Phase 20's Telegram transcript-tail, already flag-gated OFF in Coolify via
 * `REMO_TELEGRAM_TRANSCRIPT_TAIL`). Growing this allowlist is a deliberate,
 * visible act — its size is asserted separately.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// import.meta.dir is hub/test — up two levels to the actual repo root.
const REPO_ROOT = join(import.meta.dir, '..', '..')
const HUB_SRC = join(REPO_ROOT, 'hub', 'src')

/** Repo-relative path PREFIXES allowed to reference the home-directory resolver. */
const ALLOWLIST_PREFIXES = ['hub/src/telegram/transcript/']

interface Finding { file: string; line: number; preview: string }

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.git') continue
      walkTsFiles(full, out)
    } else if (s.isFile() && name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Strip `/* *\/` block comments then `//` line comments, so prose can never
 *  trip or satisfy the match — only live code is scanned. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((line) => {
      // Naive `//` strip — good enough here since none of the matched code
      // paths involve URLs or string literals containing `//` around `homedir`.
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

const HOMEDIR_IDENTIFIER = /\bhomedir\b/

function scanFile(absPath: string): Finding[] {
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf-8')
  } catch {
    return []
  }
  const code = stripComments(raw)
  const lines = code.split('\n')
  const findings: Finding[] = []
  for (let i = 0; i < lines.length; i++) {
    if (HOMEDIR_IDENTIFIER.test(lines[i])) {
      findings.push({
        file: relative(REPO_ROOT, absPath).replace(/\\/g, '/'),
        line: i + 1,
        preview: lines[i].trim().slice(0, 160),
      })
    }
  }
  return findings
}

function collectAllOffenders(): Finding[] {
  const files = walkTsFiles(HUB_SRC)
  const findings: Finding[] = []
  for (const f of files) findings.push(...scanFile(f))
  return findings
}

describe('Pitfall-1 guard canary — no NEW hub-side home-directory transcript read', () => {
  test('matcher is non-vacuous: the pre-filter offender set finds the two known telegram/transcript adapters', () => {
    const all = collectAllOffenders()
    expect(all.length).toBeGreaterThan(0)
    const files = new Set(all.map((f) => f.file))
    expect(files.has('hub/src/telegram/transcript/claude-adapter.ts')).toBe(true)
    expect(files.has('hub/src/telegram/transcript/codex-adapter.ts')).toBe(true)
  })

  test('every offender outside the single allowlisted prefix is a hard failure', () => {
    const all = collectAllOffenders()
    const offenders = all.filter((f) => !ALLOWLIST_PREFIXES.some((prefix) => f.file.startsWith(prefix)))
    if (offenders.length > 0) {
      const msg = [
        '',
        'Pitfall-1 guard FAILED — a hub/src/** module reads a home-directory-derived path:',
        ...offenders.map((f) => `  ${f.file}:${f.line}  ${f.preview}`),
        '',
        'The hub runs in a Coolify container with no such path. This read will work',
        'perfectly in local dev and silently do NOTHING in production — exactly the',
        'reason REMO_TELEGRAM_TRANSCRIPT_TAIL is documented "keep OFF in Coolify".',
        'PTYCAP Phase 1 moved ALL new transcript-tail filesystem access to',
        'supervisor/src/usage/ for this exact reason. If this is a deliberate,',
        'reviewed exception, add its path prefix to ALLOWLIST_PREFIXES in this test',
        'with a comment explaining why.',
      ].join('\n')
      throw new Error(msg)
    }
    expect(offenders.length).toBe(0)
  })

  test('the allowlist has exactly one entry — growing it is a deliberate, visible act', () => {
    expect(ALLOWLIST_PREFIXES.length).toBe(1)
    expect(ALLOWLIST_PREFIXES[0]).toBe('hub/src/telegram/transcript/')
  })

  test('a comment mentioning the pattern neither trips nor satisfies the check (comment-insensitive both ways)', () => {
    const withComment = stripComments('// this mentions homedir() in prose only\nconst x = 1')
    expect(HOMEDIR_IDENTIFIER.test(withComment)).toBe(false)
    const withBlockComment = stripComments('/* homedir() appears here too */\nconst y = 2')
    expect(HOMEDIR_IDENTIFIER.test(withBlockComment)).toBe(false)
  })
})
