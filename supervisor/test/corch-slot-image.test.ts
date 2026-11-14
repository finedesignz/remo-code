/**
 * CORCH-10 (R4.6, R4.7): static lint of the per-slot supervisor image. No docker needed.
 * Asserts: non-root, no secret in ARG/ENV/layers, no Tauri/ConPTY, build-only pipeline, runbook present.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const dockerfile = read('Dockerfile.slot')
const lines = dockerfile.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'))
const code = lines.join('\n')

describe('Dockerfile.slot', () => {
  test('final stage runs as a non-root user', () => {
    const users = lines.filter((l) => /^\s*USER\s+/i.test(l))
    expect(users.length).toBeGreaterThan(0)
    const last = users[users.length - 1]!.trim().split(/\s+/)[1]!
    expect(['root', '0']).not.toContain(last)
  })

  test('no ARG and no ENV carries a secret or credential value', () => {
    expect(code).not.toMatch(/^\s*ARG\s/im)
    const envParts: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*ENV\s/i.test(lines[i]!)) continue
      let stmt = lines[i]!
      while (stmt.trimEnd().endsWith('\\') && i + 1 < lines.length) stmt += '\n' + lines[++i]!
      envParts.push(stmt)
    }
    const envText = envParts.join('\n')
    expect(envText).toContain('REMO_ROOTS')
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'REMO_API_KEY', 'REMO_ACCOUNT_SLOT', 'REMO_HUB_URL', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      expect(envText).not.toContain(name)
    }
    expect(envText).not.toMatch(/token|secret|password|api_key/i)
  })

  test('no Tauri, ConPTY or Rust pty host in the image', () => {
    expect(code.replaceAll('supervisor/tauri/src-tauri/tauri.conf.json', '').replace(/^.*-deletes*$/m, '')).not.toMatch(/tauri|pty_host|conpty|cargo|rustup|\.msi|\.exe/i)
    // Only the version manifest may come from supervisor/tauri; never the whole dir, never `COPY supervisor/ ...`.
    expect(code).not.toMatch(/COPY\s+supervisor\/(tauri\/(?!src-tauri\/tauri\.conf\.json\s)|\s)/)
  })

  test('deps stage strips Windows ConPTY/winpty binaries shipped inside node-pty', () => {
    expect(code).toMatch(/find node_modules -type f[^\n]*\*\.exe[^\n]*\*\.dll[^\n]*winpty[^\n]*conpty[^\n]*-delete/)
  })

  test('uses an exec-form entrypoint via the slot entrypoint script', () => {
    expect(code).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/remo-slot-entrypoint"\]/)
  })
})

describe('image import closure', () => {
  test('every import escaping supervisor/src is COPY-ed into the image', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { resolve, relative, dirname } = require('node:path') as typeof import('node:path')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
    const srcDir = join(root, 'supervisor', 'src')
    const escaping = new Set<string>()
    for (const f of walk(srcDir).filter((p) => /\.(ts|mjs)$/.test(p))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)[^'"\n]*?from\s+'(\.[^']+)'/gm)) {
        const target = resolve(dirname(f), m[1]!)
        if (relative(srcDir, target).startsWith('..')) escaping.add(relative(root, target).replace(/\\/g, '/'))
      }
    }
    expect(escaping.size).toBeGreaterThan(0)
    const copies = [...dockerfile.matchAll(/^COPY\s+(?:--\S+\s+)?(\S+)\s/gm)].map((m) => m[1]!)
    for (const e of escaping) {
      const ok = copies.some((c) => e === c || c.startsWith(e + '.') || e.startsWith(c.replace(/\/$/, '') + '/'))
      expect({ e, ok }).toEqual({ e, ok: true })
    }
  })
  test('git credential helper is host-scoped', () => {
    expect(read('tools/slot-image/entrypoint.sh')).toMatch(/credential\.https:\/\/\$\{GIT_HOST\}\.helper/)
  })
})

describe('slot entrypoint', () => {
  const ep = read('tools/slot-image/entrypoint.sh')
  test('requires every runtime secret and never echoes a value', () => {
    for (const n of ['REMO_ACCOUNT_SLOT', 'REMO_HUB_URL', 'REMO_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(ep).toContain(`need ${n}`)
    expect(ep).not.toMatch(/echo[^\n]*\$\{?(CLAUDE_CODE_OAUTH_TOKEN|REMO_API_KEY)/)
    expect(ep).not.toMatch(/ANTHROPIC_API_KEY/)
  })
  test('execs the Bun supervisor source', () => {
    expect(ep).toMatch(/exec bun src\/index\.ts run/)
  })
})

describe('slot-image pipeline and runbook', () => {
  const wp = read('.woodpecker/slot-image.yaml')
  test('builds linux/amd64 on pull_request, never pushes', () => {
    expect(wp).toMatch(/event: pull_request/)
    expect(wp).toMatch(/platform: linux\/amd64/)
    expect(wp).toMatch(/dry_run: true/)
    expect(wp).not.toMatch(/username|password|from_secret|coolify/i)
  })
  test('docs/corch-linux-slots.md exists and names the required sections', () => {
    expect(existsSync(join(root, 'docs/corch-linux-slots.md'))).toBe(true)
    const d = read('docs/corch-linux-slots.md')
    for (const h of ['One app per slot', 'Runtime secrets', 'Volumes', 'Update path', 'Registration check']) expect(d).toContain(h)
  })
})
