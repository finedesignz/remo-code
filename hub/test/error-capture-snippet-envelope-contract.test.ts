/**
 * CONCERNS item 12 (residual) — snippet ↔ envelope wire contract.
 *
 * `error-capture/setup/snippet.ts` emits a hand-rolled, dependency-free Sentry
 * envelope reporter (node:https / urllib). It is NOT broken — but it is a bespoke
 * wire-format client coupled to `error-capture/envelope.ts`. If the intake's
 * accepted envelope shape ever drifts, every installed app silently stops
 * reporting, with no error anywhere.
 *
 * So: take the payload the snippet ACTUALLY emits, feed it through the REAL
 * `parseEnvelope`, and apply the REAL intake discrimination
 * (`hub/src/api/sentry-intake.ts`: first `type:'event'` item → `exception.values[0]`,
 * else `ignored: 'non_exception'`). Drift now fails the build.
 */
import { describe, test, expect } from 'bun:test'
import { getSnippet } from '../src/error-capture/setup/snippet.ts'
import { parseEnvelope } from '../src/error-capture/envelope.ts'

const DSN = 'https://abc123key@hub.example.com/6f1e8c2a-0000-4000-8000-000000000001'

/**
 * Execute the generated node reporter with fake `require`/`process` so the
 * uncaughtException handler it installs fires against a stub https client, and
 * return the exact envelope body it would POST to the intake.
 */
function captureNodeEnvelope(err: Error): { body: string; url: string; headers: Record<string, string> } {
  const source = getSnippet('node-express', DSN).entry_prepend

  let captured: { body: string; url: string; headers: Record<string, string> } | null = null
  const fakeHttps = {
    request(url: string, opts: any, cb: (res: any) => void) {
      void cb
      return {
        on() {},
        destroy() {},
        end(body: string) {
          captured = { body, url, headers: opts.headers }
        },
      }
    },
  }

  const handlers: Record<string, (arg: any) => void> = {}
  const fakeProcess = {
    env: {} as Record<string, string>, // no SENTRY_DSN ⇒ snippet falls back to the baked DSN
    on(event: string, fn: (arg: any) => void) {
      handlers[event] = fn
    },
  }

  const realRequire = (id: string) => {
    if (id === 'node:https') return fakeHttps
    if (id === 'node:url') return require('node:url')
    if (id === 'node:crypto') return require('node:crypto')
    throw new Error(`unexpected require(${id})`)
  }

  // eslint-disable-next-line no-new-func
  new Function('require', 'process', source)(realRequire, fakeProcess)

  expect(typeof handlers['uncaughtException']).toBe('function')
  handlers['uncaughtException'](err)

  expect(captured).not.toBeNull()
  return captured!
}

describe('snippet → intake envelope contract', () => {
  test('the node reporter POSTs to the intake route the hub actually mounts', () => {
    const { url, headers } = captureNodeEnvelope(new Error('boom'))
    expect(url).toBe(
      'https://hub.example.com/api/sentry/6f1e8c2a-0000-4000-8000-000000000001/envelope/?sentry_key=abc123key',
    )
    expect(headers['content-type']).toBe('application/x-sentry-envelope')
  })

  test('the emitted payload parses with the REAL envelope parser and classifies as an exception', async () => {
    const err = new Error('kaboom from the installed app')
    const { body } = captureNodeEnvelope(err)

    // Identity encoding (no content-encoding header) — exactly what the reporter sends.
    const parsed = await parseEnvelope(Buffer.from(body, 'utf8'), {})

    expect(typeof parsed.header.event_id).toBe('string')

    // ── the intake's own discrimination (sentry-intake.ts) ──
    const eventItem = parsed.items.find((it) => it.header?.type === 'event')
    expect(eventItem).toBeDefined()
    const event = eventItem!.payload as any
    const firstExc = event?.exception?.values?.[0]
    expect(firstExc).toBeDefined() // ⇐ NOT `ignored: 'non_exception'`

    expect(firstExc.type).toBe('Error')
    expect(firstExc.value).toBe('kaboom from the installed app')
    expect(Array.isArray(firstExc.stacktrace?.frames)).toBe(true)
    expect(firstExc.stacktrace.frames.length).toBeGreaterThan(0)

    // Frames must carry the fields the fingerprint stack input reads.
    const frame = firstExc.stacktrace.frames[firstExc.stacktrace.frames.length - 1]
    expect(typeof frame.filename).toBe('string')
    expect(typeof frame.function).toBe('string')
    expect(typeof frame.lineno).toBe('number')
  })

  test('a non-Error rejection reason is still reported AS an exception', async () => {
    const { body } = captureNodeEnvelope('plain string rejection' as any)
    const parsed = await parseEnvelope(Buffer.from(body, 'utf8'), {})
    const event = parsed.items.find((it) => it.header?.type === 'event')!.payload as any
    expect(event.exception.values[0].value).toBe('plain string rejection')
  })
})
