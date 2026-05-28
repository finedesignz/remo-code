import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  stashSecrets,
  restoreStash,
  withStashedSecrets,
  assertNoPriorStash,
  RevanoteStashAbortError,
  _internals,
} from '../src/revanote/local-path-stash'

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'revanote-stash-test-'))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('looksLikeSecret', () => {
  test('catches top-level secret names', () => {
    expect(_internals.looksLikeSecret('.env')).toBe(true)
    expect(_internals.looksLikeSecret('.env.local')).toBe(true)
    expect(_internals.looksLikeSecret('.env.production')).toBe(true)
    expect(_internals.looksLikeSecret('secrets')).toBe(true)
    expect(_internals.looksLikeSecret('.aws')).toBe(true)
    expect(_internals.looksLikeSecret('.ssh')).toBe(true)
  })

  test('ignores ordinary files', () => {
    expect(_internals.looksLikeSecret('src')).toBe(false)
    expect(_internals.looksLikeSecret('package.json')).toBe(false)
    expect(_internals.looksLikeSecret('readme.env')).toBe(false)
  })
})

describe('stashSecrets / restoreStash', () => {
  test('stashes .env files and restores them', async () => {
    await writeFile(join(repoRoot, '.env'), 'SECRET=top')
    await writeFile(join(repoRoot, '.env.local'), 'SECRET=local')
    await writeFile(join(repoRoot, 'package.json'), '{}')

    const handle = await stashSecrets(repoRoot, 'runabc')
    expect(handle.entries.length).toBe(2)

    const after = await readdir(repoRoot)
    expect(after.find((n) => n === '.env')).toBeUndefined()
    expect(after.find((n) => n === '.env.local')).toBeUndefined()
    expect(after.some((n) => n.startsWith('.env.revanote-sandbox-stash-runabc') || n.startsWith('.env.local.revanote-sandbox-stash-'))).toBe(true)
    // package.json untouched
    expect(after.includes('package.json')).toBe(true)

    await restoreStash(handle)
    const restored = await readdir(repoRoot)
    expect(restored.includes('.env')).toBe(true)
    expect(restored.includes('.env.local')).toBe(true)
    expect(restored.some((n) => n.includes('revanote-sandbox-stash-'))).toBe(false)
  })

  test('stashes directories (secrets/, .aws/, .ssh/)', async () => {
    await mkdir(join(repoRoot, 'secrets'))
    await writeFile(join(repoRoot, 'secrets/key'), 'x')
    await mkdir(join(repoRoot, '.aws'))
    await writeFile(join(repoRoot, '.aws/credentials'), 'x')

    const handle = await stashSecrets(repoRoot, 'r1')
    expect(handle.entries.length).toBe(2)

    const after = await readdir(repoRoot)
    expect(after.includes('secrets')).toBe(false)
    expect(after.includes('.aws')).toBe(false)

    await restoreStash(handle)
    const r = await readdir(repoRoot)
    expect(r.includes('secrets')).toBe(true)
    expect(r.includes('.aws')).toBe(true)
    const inner = await readdir(join(repoRoot, 'secrets'))
    expect(inner).toContain('key')
  })

  test('aborts when a prior stash marker is already present', async () => {
    await writeFile(join(repoRoot, '.env.revanote-sandbox-stash-oldrun'), 'leftover')
    await expect(stashSecrets(repoRoot, 'newrun')).rejects.toThrow(RevanoteStashAbortError)
  })

  test('assertNoPriorStash flags hits', async () => {
    await writeFile(join(repoRoot, 'whatever.revanote-sandbox-stash-x'), '')
    await expect(assertNoPriorStash(repoRoot)).rejects.toThrow(RevanoteStashAbortError)
  })

  test('restore is idempotent', async () => {
    await writeFile(join(repoRoot, '.env'), 'A=1')
    const h = await stashSecrets(repoRoot, 'r')
    await restoreStash(h)
    await restoreStash(h) // no throw
  })

  test('withStashedSecrets restores even on inner throw', async () => {
    await writeFile(join(repoRoot, '.env'), 'A=1')
    let ran = false
    await expect(
      withStashedSecrets(repoRoot, 'r', async () => {
        ran = true
        const mid = await readdir(repoRoot)
        // .env not visible inside the wrapped fn
        expect(mid.includes('.env')).toBe(false)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(ran).toBe(true)
    // .env restored
    const after = await readdir(repoRoot)
    expect(after.includes('.env')).toBe(true)
  })

  test('no secrets present → no-op handle', async () => {
    await writeFile(join(repoRoot, 'main.ts'), 'x')
    const h = await stashSecrets(repoRoot, 'r')
    expect(h.entries.length).toBe(0)
    await restoreStash(h)
  })
})
