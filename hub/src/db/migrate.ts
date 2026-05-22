import { readFileSync } from 'fs'
import { resolve } from 'path'
import { sql } from './postgres.ts'

const SCHEMA_CANDIDATES = [
  './hub/src/db/schema.sql',
  '../db/schema.sql',
  resolve(import.meta.dir, 'schema.sql'),
]

export async function runMigrations() {
  const path = SCHEMA_CANDIDATES.find((p) => {
    try { readFileSync(p, 'utf-8'); return true } catch { return false }
  })
  if (!path) {
    console.warn('[migrate] schema.sql not found, skipping')
    return
  }
  const ddl = readFileSync(path, 'utf-8')
  const statements = ddl
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))

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
