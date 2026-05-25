import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runErrorSetupProbe } from '../src/commands/error-setup-probe'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'probe-'))
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('error_setup_probe', () => {
  test('reads existing files; skips missing silently', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
    writeFileSync(join(dir, 'manage.py'), 'print(1)')
    const r = await runErrorSetupProbe([dir, 'package.json', 'manage.py', 'next.config.js'])
    expect(r.ok).toBe(true)
    const paths = (r.files || []).map((f) => f.path).sort()
    expect(paths).toEqual(['manage.py', 'package.json'])
    const pkg = r.files!.find((f) => f.path === 'package.json')!
    expect(pkg.content).toBe('{"name":"x"}')
  })

  test('expands top-level *.py glob', async () => {
    writeFileSync(join(dir, 'a.py'), '1')
    writeFileSync(join(dir, 'b.py'), '2')
    writeFileSync(join(dir, 'c.txt'), '3')
    const r = await runErrorSetupProbe([dir, '*.py'])
    expect(r.ok).toBe(true)
    const paths = (r.files || []).map((f) => f.path).sort()
    expect(paths).toEqual(['a.py', 'b.py'])
  })

  test('returns repo_not_found for missing path', async () => {
    const r = await runErrorSetupProbe([join(dir, 'nope'), 'package.json'])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('repo_not_found')
  })

  test('returns repo_not_found for relative path', async () => {
    const r = await runErrorSetupProbe(['./relative', 'package.json'])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('repo_not_found')
  })

  test('returns probe_too_large when total > 1MB', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 'x').toString('utf-8')
    writeFileSync(join(dir, 'big.txt'), big)
    const r = await runErrorSetupProbe([dir, 'big.txt'])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('probe_too_large')
  })

  test('refuses path traversal entries', async () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    const r = await runErrorSetupProbe([dir, '../etc/passwd', 'package.json'])
    expect(r.ok).toBe(true)
    expect((r.files || []).map((f) => f.path)).toEqual(['package.json'])
  })

  test('handles empty probe list', async () => {
    const r = await runErrorSetupProbe([dir])
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([])
  })

  test('returns read_error with no args', async () => {
    const r = await runErrorSetupProbe([])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('read_error')
  })

  test('reads nested file paths', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {}')
    const r = await runErrorSetupProbe([dir, 'src/index.ts'])
    expect(r.ok).toBe(true)
    expect(r.files![0].path).toBe('src/index.ts')
    expect(r.files![0].content).toBe('export {}')
  })
})
