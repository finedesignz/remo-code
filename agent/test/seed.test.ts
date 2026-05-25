import { describe, expect, test } from 'bun:test'
import { writeSeedFiles, type SeedFile } from '../src/seed'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'

function sha(s: string) {
  return createHash('sha256').update(s).digest('hex')
}

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'remo-seed-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('writeSeedFiles', () => {
  test('writes when local file absent', () => {
    withTempDir((dir) => {
      const path = join(dir, 'nested', 'CLAUDE.md')
      const content = 'hello'
      const logs: string[] = []
      const files: SeedFile[] = [{ path, content, sha256: sha(content), mode: 'create_if_absent' }]
      writeSeedFiles(files, (m) => logs.push(m))
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(content)
      expect(logs[0]).toMatch(/^Seeded /)
    })
  })

  test('NEVER overwrites when local file exists with same sha', () => {
    withTempDir((dir) => {
      const path = join(dir, 'CLAUDE.md')
      writeFileSync(path, 'local-content')
      const logs: string[] = []
      const files: SeedFile[] = [{
        path, content: 'local-content', sha256: sha('local-content'),
        mode: 'create_if_absent',
      }]
      writeSeedFiles(files, (m) => logs.push(m))
      expect(readFileSync(path, 'utf8')).toBe('local-content')
      expect(logs).toEqual([])
    })
  })

  test('NEVER overwrites on sha drift, emits warning', () => {
    withTempDir((dir) => {
      const path = join(dir, 'CLAUDE.md')
      writeFileSync(path, 'local-content')
      const logs: string[] = []
      const files: SeedFile[] = [{
        path, content: 'hub-content', sha256: sha('hub-content'),
        mode: 'create_if_absent',
      }]
      writeSeedFiles(files, (m) => logs.push(m))
      expect(readFileSync(path, 'utf8')).toBe('local-content')
      expect(logs[0]).toMatch(/differs from hub version/)
    })
  })

  test('per-file errors do not abort the loop', () => {
    withTempDir((dir) => {
      const goodPath = join(dir, 'good.md')
      const badPath = '\0/illegal/null/byte'
      const logs: string[] = []
      const files: SeedFile[] = [
        { path: badPath, content: 'x', sha256: sha('x'), mode: 'create_if_absent' },
        { path: goodPath, content: 'y', sha256: sha('y'), mode: 'create_if_absent' },
      ]
      writeSeedFiles(files, (m) => logs.push(m))
      expect(existsSync(goodPath)).toBe(true)
      expect(logs.some((l) => l.startsWith('Failed to seed'))).toBe(true)
    })
  })

  test('undefined / empty input is a silent no-op', () => {
    const logs: string[] = []
    writeSeedFiles(undefined, (m) => logs.push(m))
    writeSeedFiles([], (m) => logs.push(m))
    expect(logs).toEqual([])
  })
})
