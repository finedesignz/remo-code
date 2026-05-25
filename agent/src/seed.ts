// Phase 05 seed-file writer: receives instruction blobs from hub via auth_ok
// and writes them to disk ONLY IF the local file does not already exist.
// Never overwrites. On sha mismatch, logs a drift warning and leaves the file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { dirname, resolve } from 'path'

// MUST MATCH hub/src/ws/protocol.ts auth_ok.seed_files entry shape
export type SeedFile = {
  path: string // may start with ~
  content: string
  sha256: string
  mode: 'create_if_absent' | 'sync_if_unchanged'
}

function expand(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}
function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function writeSeedFiles(files: SeedFile[] | undefined, log: (msg: string) => void): void {
  if (!files || files.length === 0) return
  for (const f of files) {
    try {
      const abs = expand(f.path)
      if (!existsSync(abs)) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, f.content, { encoding: 'utf8' })
        log(`Seeded ${f.path} from hub (${f.content.length} bytes)`)
        continue
      }
      // File exists — never overwrite. Compare sha and warn on drift.
      const localSha = sha(readFileSync(abs, 'utf8'))
      if (localSha !== f.sha256) {
        log(`Local ${f.path} differs from hub version — keeping local. Reconcile in Settings → Instructions.`)
      }
      // else: identical, silent no-op
    } catch (e: any) {
      log(`Failed to seed ${f.path}: ${e?.message ?? String(e)}`)
    }
  }
}
