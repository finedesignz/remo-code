/**
 * Phase 07-A: titanium-client golden-vector tests.
 *
 * Drives `verifyLicenseJwt` against `fixtures/titanium-vectors.json`. Each
 * vector pins one of:
 *   - 'valid'  → verify resolves with claims matching the JWT payload
 *   - { error: 'expired' | 'claim' | 'signature' | 'alg' | 'kid' }
 *     → verify rejects; we assert the categorical error kind.
 *
 * The fixture file embeds its OWN JWKS — tests inject a local resolver via
 * `__setJwksResolverForTesting` so we never hit the network. Blocklist check
 * is stubbed out via `__setBlocklistCheckerForTesting`.
 *
 * Date.now is overridden per-vector to make exp/nbf deterministic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { importJWK } from 'jose'

// Env MUST be set before importing titanium-client / config — config.ts
// reads process.env at module-load.
const ISSUER = 'https://keygen.titaniumlabs.us'
const PRODUCT_ID = 'prod_test_remo'
process.env.TITANIUM_KEYGEN_API_URL = ISSUER
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = PRODUCT_ID

const {
  verifyLicenseJwt,
  __setJwksResolverForTesting,
  __setBlocklistCheckerForTesting,
  __resetForTesting,
} = await import('../src/titanium-client')

interface Vector {
  name: string
  description: string
  jwt: string
  jwks: { keys: any[] }
  now: number // unix seconds
  expected: 'valid' | { error: string }
}

const fixturePath = join(import.meta.dir, 'fixtures', 'titanium-vectors.json')
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as { vectors: Vector[] }

const realDateNow = Date.now
const RealDate = Date

function pinDate(unixSeconds: number): void {
  const ms = unixSeconds * 1000
  Date.now = () => ms
  // jose uses `new Date()` internally — override the constructor to return
  // the pinned instant when called with no args. Other usages (parsing,
  // formatting) pass through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).Date = class extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(ms)
      else super(...(args as []))
    }
    static now() { return ms }
  } as any
}

function restoreDate(): void {
  ;(globalThis as any).Date = RealDate
  Date.now = realDateNow
}

beforeAll(() => {
  // Blocklist always returns "not blocked" in these tests — blocklist logic
  // has its own dedicated test surface (Plan C / D).
  __setBlocklistCheckerForTesting(async () => false)
})

afterAll(() => {
  restoreDate()
  __resetForTesting()
})

describe('verifyLicenseJwt — golden vectors', () => {
  for (const v of fixtures.vectors) {
    it(v.name, async () => {
      // Pin Date (jose internals call `new Date()`, not `Date.now()`).
      pinDate(v.now)

      // Local JWKS resolver: returns the embedded keys, matched by kid.
      // No network. jose's `createRemoteJWKSet` is bypassed entirely.
      __setJwksResolverForTesting(async (protectedHeader: any) => {
        const kid = protectedHeader?.kid
        const match = v.jwks.keys.find((k: any) => k.kid === kid)
        if (!match) {
          // jose's JWKS resolver throws JWKSNoMatchingKey when no key matches.
          // We mirror that taxonomy so the verifier maps it to error: 'kid'.
          const err: any = new Error('no matching key')
          err.code = 'ERR_JWKS_NO_MATCHING_KEY'
          throw err
        }
        return await importJWK(match, 'EdDSA')
      })

      if (v.expected === 'valid') {
        const claims = await verifyLicenseJwt(v.jwt)
        expect(claims.iss).toBe(ISSUER)
        expect(claims.aud === PRODUCT_ID || (Array.isArray(claims.aud) && claims.aud.includes(PRODUCT_ID))).toBe(true)
        return
      }

      // Error path — assert the categorical error kind.
      let caught: any
      try {
        await verifyLicenseJwt(v.jwt)
      } catch (e) {
        caught = e
      }
      expect(caught, `expected vector ${v.name} to throw, got success`).toBeDefined()
      expect(caught.kind, `expected error.kind for vector ${v.name}`).toBe((v.expected as { error: string }).error)
    })
  }
})
