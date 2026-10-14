/**
 * PTYCAP-08 plan 04, TQC-04 static guard: no UPDATE scheduled_tasks template
 * anywhere under hub/src/task-qc may mention the on/off switch column, and the
 * set of UPDATE column lists is exactly the three allowlisted fixes (plus the
 * audit column). Scans string/template LITERALS (comments stripped), so the
 * legitimate SELECT that reads the column cannot trip it. The extractor is proven
 * non-vacuous against a deliberately violating fixture.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src', 'task-qc')

/** Static text of every template / quoted string literal in source, comments dropped. */
export function extractLiterals(src: string): string[] {
  const out: string[] = []
  let i = 0
  const n = src.length
  const readTemplate = (): string => {
    // src[i] is the opening backtick
    i++
    let text = ''
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        text += src[i + 1] ?? ''
        i += 2
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const c = src[i]!
          if (c === '`') out.push(readTemplate())
          else if (c === '{') (depth++, i++)
          else if (c === '}') (depth--, i++)
          else if (c === "'" || c === '"') readQuoted(c)
          else i++
        }
        text += '?'
      } else text += src[i++]
    }
    i++
    return text
  }
  const readQuoted = (q: string): string => {
    i++
    let text = ''
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        text += src[i + 1] ?? ''
        i += 2
      } else text += src[i++]
    }
    i++
    return text
  }
  while (i < n) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === '`') out.push(readTemplate())
    else if (c === "'" || c === '"') out.push(readQuoted(c))
    else i++
  }
  return out
}

const UPDATE_TASKS = /\bUPDATE\s+scheduled_tasks\b/i

export function updateTemplates(src: string): string[] {
  return extractLiterals(src)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => UPDATE_TASKS.test(s))
}

export function violatesTqc04(template: string): boolean {
  return /\benabled\b/i.test(template)
}

/** The unique column names assigned in the SET clause, bounded by WHERE. */
function setColumns(template: string): string[] {
  const m = /\bSET\s+(.*?)\s+WHERE\b/i.exec(template)
  if (!m) return []
  return [...new Set([...m[1]!.matchAll(/\b([a-z_]+)\s*=/gi)].map((x) => x[1]!.toLowerCase()))].sort()
}

const files = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, src: readFileSync(join(SRC, f), 'utf8') }))

describe('TQC-04 static guard', () => {
  test('the extractor catches a violating fixture (non-vacuous)', () => {
    const bad = 'const q = `UPDATE scheduled_tasks SET enabled = false WHERE id = ${id}`'
    const found = updateTemplates(bad)
    expect(found.length).toBe(1)
    expect(violatesTqc04(found[0]!)).toBe(true)
    const viaQuotes = updateTemplates(`const q = "update scheduled_tasks set Enabled = true where id = 1"`)
    expect(viaQuotes.length).toBe(1)
    expect(violatesTqc04(viaQuotes[0]!)).toBe(true)
    // a comment mentioning the statement is not a literal
    expect(updateTemplates('// UPDATE scheduled_tasks SET enabled = false\nconst x = 1')).toEqual([])
    // the SELECT path legitimately reads the column and is not an UPDATE template
    expect(updateTemplates('const q = `SELECT enabled FROM scheduled_tasks WHERE id = ${id} FOR UPDATE`')).toEqual([])
  })

  test('no UPDATE scheduled_tasks template under hub/src/task-qc mentions the on/off column', () => {
    const all = files.flatMap(({ f, src }) => updateTemplates(src).map((t) => ({ f, t })))
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(all.filter(({ t }) => violatesTqc04(t))).toEqual([])
  })

  test('every UPDATE scheduled_tasks template is one of exactly the three allowlisted column lists', () => {
    const lists = new Set(files.flatMap(({ src }) => updateTemplates(src).map((t) => setColumns(t).join(','))))
    // writer templates carry updated_at; rollback text does not. Union is exactly these sets:
    const normalised = [...lists].map((l) => l.split(',').filter((c) => c !== 'updated_at').join(',')).sort()
    expect([...new Set(normalised)]).toEqual(['payload', 'session_id,target_id', 'timezone'])
  })

  test('only safe-fixes.ts contains an UPDATE scheduled_tasks literal', () => {
    const owners = files.filter(({ src }) => updateTemplates(src).length > 0).map(({ f }) => f)
    expect(owners).toEqual(['safe-fixes.ts'])
  })

  test('safe-fixes.ts imports no registry, dispatcher, dispatch pipeline or sender', () => {
    const src = files.find((x) => x.f === 'safe-fixes.ts')!.src
    const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!).sort()
    expect(imports).toEqual(['../scheduler/cron.ts', './detectors.ts', './findings.ts', './types.ts', 'node:crypto'])
    const code = extractLiterals(src).join('\n')
    expect(code).not.toMatch(/registry|dispatch\(|injectOrchestratorPrompt/)
  })
})
