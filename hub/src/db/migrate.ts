import { readFileSync } from 'fs'
import { resolve } from 'path'
import { sql } from './postgres.ts'

const SCHEMA_CANDIDATES = [
  './hub/src/db/schema.sql',
  '../db/schema.sql',
  resolve(import.meta.dir, 'schema.sql'),
]

/**
 * Split a SQL script into individual statements on top-level `;`, while
 * respecting PostgreSQL syntax that contains semicolons that are NOT
 * statement terminators:
 *   - dollar-quoted strings: $$ ... $$ and the tagged variant $tag$ ... $tag$
 *   - single-quoted strings with '' escape
 *   - double-quoted identifiers with "" escape
 *   - line comments (-- to newline)
 *   - block comments (slash-star ... star-slash), nesting supported per Postgres
 *
 * Returns trimmed, non-empty statements.
 */
export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = []
  let buf = ''
  let i = 0
  const n = sqlText.length

  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let blockCommentDepth = 0
  let dollarTag: string | null = null

  while (i < n) {
    const c = sqlText[i]
    const c2 = sqlText[i + 1]

    if (inLineComment) {
      buf += c
      if (c === '\n') inLineComment = false
      i++
      continue
    }

    if (blockCommentDepth > 0) {
      buf += c
      if (c === '/' && c2 === '*') {
        blockCommentDepth++
        buf += c2
        i += 2
        continue
      }
      if (c === '*' && c2 === '/') {
        blockCommentDepth--
        buf += c2
        i += 2
        continue
      }
      i++
      continue
    }

    if (dollarTag !== null) {
      if (c === '$' && sqlText.startsWith(dollarTag, i)) {
        buf += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      buf += c
      i++
      continue
    }

    if (inSingle) {
      buf += c
      if (c === "'") {
        if (c2 === "'") {
          buf += c2
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }

    if (inDouble) {
      buf += c
      if (c === '"') {
        if (c2 === '"') {
          buf += c2
          i += 2
          continue
        }
        inDouble = false
      }
      i++
      continue
    }

    if (c === '-' && c2 === '-') {
      inLineComment = true
      buf += c
      buf += c2
      i += 2
      continue
    }

    if (c === '/' && c2 === '*') {
      blockCommentDepth = 1
      buf += c
      buf += c2
      i += 2
      continue
    }

    if (c === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sqlText.slice(i))
      if (tagMatch) {
        dollarTag = tagMatch[0]
        buf += dollarTag
        i += dollarTag.length
        continue
      }
      buf += c
      i++
      continue
    }

    if (c === "'") {
      inSingle = true
      buf += c
      i++
      continue
    }

    if (c === '"') {
      inDouble = true
      buf += c
      i++
      continue
    }

    if (c === ';') {
      const trimmed = buf.trim()
      if (trimmed.length > 0) statements.push(trimmed)
      buf = ''
      i++
      continue
    }

    buf += c
    i++
  }

  const tail = buf.trim()
  if (tail.length > 0) statements.push(tail)
  return statements
}

export async function runMigrations() {
  const path = SCHEMA_CANDIDATES.find((p) => {
    try { readFileSync(p, 'utf-8'); return true } catch { return false }
  })
  if (!path) {
    console.warn('[migrate] schema.sql not found, skipping')
    return
  }
  const ddl = readFileSync(path, 'utf-8')
  const statements = splitSqlStatements(ddl)

  let applied = 0
  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt)
      applied++
    } catch (err: any) {
      console.error(`[migrate] failed: ${stmt.slice(0, 80)}... — ${err.message}`)
    }
  }
  console.log(`[migrate] applied ${applied}/${statements.length} statements from ${path}`)
}
