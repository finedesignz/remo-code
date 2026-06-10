/**
 * Error-capture SDK auto-install snippet tests.
 *
 * Regression guard for the fleet-crashing bug (pilot 2026-06-10): the snippet
 * used to inject the OFFICIAL Sentry SDK init (`sentry_sdk.init` / `@sentry/*`),
 * which raises `BadDsn: Invalid project in DSN` on the hub's UUID project ids
 * and crash-loops every app it's installed into.
 *
 * These tests assert that for ALL 4 stacks the emitted snippet is the
 * DEPENDENCY-FREE reporter (UUID-DSN parse → Sentry envelope POST to the
 * `/api/sentry/<uuid>/envelope/?sentry_key=<key>` intake, fail-open, hooks
 * unhandled exceptions) and that NO official-SDK init/dependency is emitted.
 */
import { describe, test, expect } from 'bun:test'
import {
  getSnippet,
  addSentryDep,
  addPythonSentryRequirement,
  injectSnippet,
  REPORTER_MARKER,
} from '../src/error-capture/setup/snippet.ts'
import type { Stack } from '../src/error-capture/setup/detect.ts'
import { parseEnvelope } from '../src/error-capture/envelope.ts'

const UUID = '550e8400-e29b-41d4-a716-446655440000'
const KEY = 'abc123def456'
const HOST = 'app.remo-code.com'
const DSN = `https://${KEY}@${HOST}/${UUID}`

const STACKS: Stack[] = ['node-express', 'node-nextjs', 'python-django', 'python-fastapi']

describe('snippet: dependency-free reporter for all 4 stacks', () => {
  for (const stack of STACKS) {
    test(`${stack} emits the reporter, not the official SDK`, () => {
      const { entry_prepend } = getSnippet(stack, DSN)

      // Reporter marker present.
      expect(entry_prepend).toContain(REPORTER_MARKER)

      // NO official Sentry SDK init / import — the crash-looping pattern.
      expect(entry_prepend).not.toContain('@sentry/node')
      expect(entry_prepend).not.toContain('@sentry/nextjs')
      expect(entry_prepend).not.toContain('sentry_sdk.init')
      expect(entry_prepend).not.toContain('import sentry_sdk')
      expect(entry_prepend).not.toContain('Sentry.init')

      // Reads the DSN from SENTRY_DSN env at runtime.
      expect(entry_prepend).toContain('SENTRY_DSN')

      // Posts to the UUID envelope endpoint with sentry_key auth.
      expect(entry_prepend).toContain('/api/sentry/')
      expect(entry_prepend).toContain('/envelope/?sentry_key=')

      // Captures unhandled exceptions.
      if (stack.startsWith('node')) {
        expect(entry_prepend).toContain('uncaughtException')
        expect(entry_prepend).toContain('unhandledRejection')
        // Built-in https only — no third-party http client.
        expect(entry_prepend).toContain('node:https')
      } else {
        expect(entry_prepend).toContain('excepthook')
        // stdlib urllib only — no httpx/requests/sentry-sdk dependency.
        expect(entry_prepend).toContain('urllib.request')
        expect(entry_prepend).not.toContain('import httpx')
      }
    })
  }
})

describe('snippet: emitted endpoint uses UUID project id + envelope path', () => {
  test('node snippet bakes the UUID DSN fallback and envelope path', () => {
    const { entry_prepend } = getSnippet('node-express', DSN)
    expect(entry_prepend).toContain(UUID)
    expect(entry_prepend).toContain(`'/api/sentry/' + _projectId + '/envelope/?sentry_key=' + _key`)
  })

  test('python snippet bakes the UUID DSN fallback and envelope path', () => {
    const { entry_prepend } = getSnippet('python-fastapi', DSN)
    expect(entry_prepend).toContain(UUID)
    expect(entry_prepend).toContain('/api/sentry/%s/envelope/?sentry_key=%s')
  })
})

describe('snippet: emitted envelope round-trips through the hub parser', () => {
  // Reconstruct the exact envelope body the injected reporter builds and feed
  // it to the REAL hub parseEnvelope to prove it classifies as an exception
  // (so the intake dispatches it, not `non_exception`).
  test('reporter envelope parses to an event item with an exception', async () => {
    const eventId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const event = {
      event_id: eventId,
      platform: 'python',
      exception: {
        values: [{ type: 'ValueError', value: 'boom', stacktrace: { frames: [] } }],
      },
    }
    const envelope =
      JSON.stringify({ event_id: eventId }) +
      '\n' +
      JSON.stringify({ type: 'event' }) +
      '\n' +
      JSON.stringify(event) +
      '\n'

    const parsed = await parseEnvelope(Buffer.from(envelope, 'utf8'), {})
    const eventItem = parsed.items.find((it) => it.header?.type === 'event')
    expect(eventItem).toBeDefined()
    const firstExc = (eventItem!.payload as any)?.exception?.values?.[0]
    expect(firstExc).toBeDefined()
    expect(firstExc.type).toBe('ValueError')
    expect(firstExc.value).toBe('boom')
  })
})

describe('snippet: no third-party dependency is added to manifests', () => {
  test('addSentryDep is a no-op (no @sentry/* added)', () => {
    const pkg = JSON.stringify({ name: 'x', dependencies: { express: '^4' } }, null, 2)
    const res = addSentryDep(pkg, 'node-express')
    expect(res.alreadyConfigured).toBe(true)
    expect(res.content).toBe(pkg)
    expect(res.content).not.toContain('@sentry')
  })

  test('addPythonSentryRequirement is a no-op (no sentry-sdk added)', () => {
    const reqs = 'fastapi>=0.100\nuvicorn>=0.20\n'
    const res = addPythonSentryRequirement(reqs)
    expect(res.alreadyConfigured).toBe(true)
    expect(res.content).toBe(reqs)
    expect(res.content.toLowerCase()).not.toContain('sentry-sdk')
    expect(res.content.toLowerCase()).not.toContain('sentry_sdk')
  })
})

describe('snippet: injection is idempotent', () => {
  test('re-injecting the reporter is a no-op', () => {
    const { entry_prepend } = getSnippet('python-fastapi', DSN)
    const src = 'from fastapi import FastAPI\napp = FastAPI()\n'
    const first = injectSnippet(src, entry_prepend)
    expect(first.alreadyConfigured).toBe(false)
    const second = injectSnippet(first.content, entry_prepend)
    expect(second.alreadyConfigured).toBe(true)
    expect(second.content).toBe(first.content)
  })

  test('a legacy official-SDK install is treated as already configured', () => {
    const { entry_prepend } = getSnippet('node-express', DSN)
    const legacy = `import * as Sentry from '@sentry/node';\nSentry.init({});\n`
    const res = injectSnippet(legacy, entry_prepend)
    expect(res.alreadyConfigured).toBe(true)
    expect(res.content).toBe(legacy)
  })

  test('shebang is preserved when injecting', () => {
    const { entry_prepend } = getSnippet('python-django', DSN)
    const src = '#!/usr/bin/env python\nimport os\n'
    const res = injectSnippet(src, entry_prepend)
    expect(res.alreadyConfigured).toBe(false)
    expect(res.content.startsWith('#!/usr/bin/env python\n')).toBe(true)
    expect(res.content).toContain(REPORTER_MARKER)
  })
})
