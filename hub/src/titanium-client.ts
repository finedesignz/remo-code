/**
 * Phase 07-A: Titanium Licensing client foundation.
 *
 * Local-only license-JWT verification + Redis blocklist + admin slice for
 * the migration job. Per CONTEXT.md (LOCKED):
 *
 *   - EdDSA only. `alg: none`, `alg: HS*`, `alg: RS*`, `alg: ES*` are
 *     rejected outright at the JWT layer.
 *   - JWKS fetched from `${TITANIUM_KEYGEN_API_URL}/v1/accounts/{ACCOUNT_ID}/.well-known/jwks.json`
 *     via jose's `createRemoteJWKSet` (in-memory cache + single-flight +
 *     refetch on `kid` miss). Warmed during hub bootstrap BEFORE port bind.
 *   - Claims pinned: `iss == TITANIUM_KEYGEN_API_URL`, `aud` includes
 *     `TITANIUM_PRODUCT_ID`, `exp/nbf/iat` (±30s skew).
 *   - Revocation: Redis SISMEMBER on `titanium:blocklist` — checked on every
 *     verify. Real-time. No cache.
 *
 * Test seams:
 *   - `__setJwksResolverForTesting` — replaces the JWKS key resolver so
 *     fixtures supply keys directly (no network).
 *   - `__setBlocklistCheckerForTesting` — bypasses Redis.
 *   - `__resetForTesting` — clears module-local singletons between suites.
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
  type KeyObject,
  type CryptoKey,
} from 'jose'
import Redis from 'ioredis'
import { config } from './config'

// ── Types ──────────────────────────────────────────────────────────────────

export interface TitaniumClaims extends JWTPayload {
  sub: string
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  email?: string
  // License fields are best-effort; not all Keygen tokens carry them.
  license?: {
    id?: string
    status?: string
  }
}

export interface KeygenUser {
  id: string
  email: string
  metadata?: Record<string, unknown>
  /**
   * Whether the email is verified inside Keygen. Optional — Keygen CE returns
   * this as `emailVerified` (camelCase) in user `attributes`; older snapshots
   * use `email_verified`. Migration script (Plan E) uses this to gate the
   * pending-verify branch per CONTEXT email-collision policy.
   */
  emailVerified?: boolean | null
}

export type ErrorKind =
  | 'expired'
  | 'claim'
  | 'signature'
  | 'alg'
  | 'kid'
  | 'malformed'
  | 'blocked'
  | 'network'
  | 'config'

export class TitaniumVerifyError extends Error {
  readonly kind: ErrorKind
  constructor(kind: ErrorKind, message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'TitaniumVerifyError'
    this.kind = kind
  }
}

export class BlockedSubjectError extends TitaniumVerifyError {
  constructor(subject: string) {
    super('blocked', `Titanium subject is blocked: ${subject}`)
    this.name = 'BlockedSubjectError'
  }
}

export class TitaniumApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message)
    this.name = 'TitaniumApiError'
  }
}

// ── Configuration helpers ──────────────────────────────────────────────────

function assertTitaniumConfigured(): void {
  if (!config.titanium.keygenApiUrl || !config.titanium.accountId || !config.titanium.productId) {
    throw new TitaniumVerifyError(
      'config',
      'Titanium config missing: TITANIUM_KEYGEN_API_URL, TITANIUM_ACCOUNT_ID, TITANIUM_PRODUCT_ID required',
    )
  }
}

function jwksUrl(): string {
  return `${config.titanium.keygenApiUrl}/v1/accounts/${config.titanium.accountId}/.well-known/jwks.json`
}

// ── JWKS resolver (with test seam) ─────────────────────────────────────────

type JwksResolver = (
  protectedHeader: JWSHeaderParameters,
  token: FlattenedJWSInput,
) => Promise<CryptoKey | KeyObject | Uint8Array>

let _jwksResolver: JwksResolver | null = null
let _jwksWarmed = false

function getJwksResolver(): JwksResolver {
  if (_jwksResolver) return _jwksResolver
  assertTitaniumConfigured()
  _jwksResolver = createRemoteJWKSet(new URL(jwksUrl())) as unknown as JwksResolver
  return _jwksResolver
}

/**
 * Warm the JWKS cache during hub bootstrap, BEFORE binding the port.
 * Returns the number of keys fetched. Throws on any network/parse failure —
 * the hub MUST NOT serve traffic without JWKS available.
 */
export async function warmJwksCache(): Promise<number> {
  assertTitaniumConfigured()
  const url = jwksUrl()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new TitaniumVerifyError('network', `JWKS fetch failed: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { keys?: unknown[] }
    if (!body || !Array.isArray(body.keys)) {
      throw new TitaniumVerifyError('malformed', 'JWKS response missing "keys" array')
    }
    // Force resolver init so subsequent verifies hit the warmed in-memory set.
    getJwksResolver()
    _jwksWarmed = true
    return body.keys.length
  } catch (e) {
    if (e instanceof TitaniumVerifyError) throw e
    throw new TitaniumVerifyError('network', `JWKS warm failed: ${(e as Error).message}`, e)
  } finally {
    clearTimeout(timeout)
  }
}

// ── Blocklist (Redis) ──────────────────────────────────────────────────────

let _redis: Redis | null = null
let _blocklistChecker: ((subject: string) => Promise<boolean>) | null = null

function getRedis(): Redis {
  if (_redis) return _redis
  if (!config.titanium.redisUrl) {
    throw new TitaniumVerifyError('config', 'TITANIUM_REDIS_URL not configured')
  }
  _redis = new Redis(config.titanium.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  })
  return _redis
}

/**
 * Throws BlockedSubjectError if the subject is on the Redis blocklist.
 */
export async function assertNotBlocked(subject: string): Promise<void> {
  if (_blocklistChecker) {
    if (await _blocklistChecker(subject)) throw new BlockedSubjectError(subject)
    return
  }
  const r = getRedis()
  const blocked = await r.sismember('titanium:blocklist', subject)
  if (blocked === 1) throw new BlockedSubjectError(subject)
}

// ── Verify (the hot path) ──────────────────────────────────────────────────

/**
 * Verify a Titanium license JWT.
 *
 * Steps:
 *   1. jwtVerify with algorithms=['EdDSA'], issuer, audience, clockTolerance=30s
 *   2. Map jose error classes → TitaniumVerifyError.kind
 *   3. Assert subject not on Redis blocklist
 *   4. Return typed claims
 */
export async function verifyLicenseJwt(token: string): Promise<TitaniumClaims> {
  assertTitaniumConfigured()
  const resolver = getJwksResolver()

  let payload: JWTPayload
  try {
    const result = await jwtVerify(token, resolver as any, {
      algorithms: ['EdDSA'],
      issuer: config.titanium.keygenApiUrl,
      audience: config.titanium.productId,
      clockTolerance: 30, // seconds
    })
    payload = result.payload
  } catch (e: any) {
    throw mapJoseError(e)
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new TitaniumVerifyError('claim', 'JWT missing "sub" claim')
  }

  await assertNotBlocked(payload.sub)

  return payload as TitaniumClaims
}

function mapJoseError(e: any): TitaniumVerifyError {
  // EdDSA pinning + alg:none rejection both surface as JOSEAlgNotAllowed.
  if (e instanceof joseErrors.JOSEAlgNotAllowed || e?.code === 'ERR_JOSE_ALG_NOT_ALLOWED') {
    return new TitaniumVerifyError('alg', `Algorithm not allowed: ${e.message}`, e)
  }
  // jwtVerify in algorithm-pinned mode also throws JWSInvalid for some bad
  // alg headers (e.g. hand-crafted alg:none with empty signature segment).
  if (e instanceof joseErrors.JWSInvalid || e?.code === 'ERR_JWS_INVALID') {
    return new TitaniumVerifyError('alg', `JWS invalid: ${e.message}`, e)
  }
  if (e instanceof joseErrors.JWTExpired || e?.code === 'ERR_JWT_EXPIRED') {
    return new TitaniumVerifyError('expired', 'JWT expired', e)
  }
  if (e instanceof joseErrors.JWTClaimValidationFailed || e?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    return new TitaniumVerifyError('claim', `Claim invalid: ${e.message}`, e)
  }
  if (e instanceof joseErrors.JWSSignatureVerificationFailed || e?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
    return new TitaniumVerifyError('signature', 'Signature verification failed', e)
  }
  if (
    e instanceof joseErrors.JWKSNoMatchingKey ||
    e?.code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    e instanceof joseErrors.JWKSMultipleMatchingKeys ||
    e?.code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
  ) {
    return new TitaniumVerifyError('kid', `kid not resolvable: ${e.message}`, e)
  }
  if (e instanceof joseErrors.JWTInvalid || e?.code === 'ERR_JWT_INVALID') {
    return new TitaniumVerifyError('malformed', `JWT invalid: ${e.message}`, e)
  }
  return new TitaniumVerifyError('malformed', `Unknown verify error: ${e?.message ?? String(e)}`, e)
}

// ── Keygen admin slice (license-key + user CRUD) ───────────────────────────

async function titaniumFetch(path: string, init: RequestInit & { admin?: boolean } = {}): Promise<any> {
  assertTitaniumConfigured()
  const url = `${config.titanium.keygenApiUrl}${path}`
  const token = init.admin ? config.titanium.adminToken : config.titanium.portalToken
  if (!token) {
    throw new TitaniumApiError(0, `Missing ${init.admin ? 'admin' : 'portal'} token for ${path}`)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (!res.ok) {
      throw new TitaniumApiError(res.status, `Titanium API ${res.status} at ${path}`, body)
    }
    return body
  } catch (e) {
    if (e instanceof TitaniumApiError) throw e
    throw new TitaniumApiError(0, `Titanium fetch failed at ${path}: ${(e as Error).message}`)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Validate a license key against Titanium. Returns the issued license JWT
 * + verified claims.
 *
 * POST /v1/accounts/:id/licenses/actions/validate-key
 *   { meta: { key, scope: { product: PRODUCT_ID } } }
 */
export async function validateLicenseKey(key: string): Promise<{ token: string; claims: TitaniumClaims }> {
  assertTitaniumConfigured()
  const body = await titaniumFetch(
    `/v1/accounts/${config.titanium.accountId}/licenses/actions/validate-key`,
    {
      method: 'POST',
      body: JSON.stringify({ meta: { key, scope: { product: config.titanium.productId } } }),
    },
  )
  const token: string | undefined = body?.meta?.token
  if (!token || typeof token !== 'string') {
    throw new TitaniumApiError(0, 'validate-key response missing meta.token', body)
  }
  const claims = await verifyLicenseJwt(token)
  return { token, claims }
}

export const keygenAdmin = {
  async findUserByEmail(email: string): Promise<KeygenUser | null> {
    const body = await titaniumFetch(
      `/v1/accounts/${config.titanium.accountId}/users?filter[email]=${encodeURIComponent(email)}`,
      { method: 'GET', admin: true },
    )
    const data = body?.data
    if (!Array.isArray(data) || data.length === 0) return null
    const u = data[0]
    const attrs = u.attributes ?? {}
    const emailVerified =
      typeof attrs.emailVerified === 'boolean'
        ? attrs.emailVerified
        : typeof attrs.email_verified === 'boolean'
        ? attrs.email_verified
        : null
    return { id: u.id, email: attrs.email ?? email, metadata: attrs.metadata, emailVerified }
  },

  async createUser(input: { email: string; metadata?: Record<string, unknown> }): Promise<KeygenUser> {
    const body = await titaniumFetch(
      `/v1/accounts/${config.titanium.accountId}/users`,
      {
        method: 'POST',
        admin: true,
        body: JSON.stringify({
          data: {
            type: 'users',
            attributes: { email: input.email, metadata: input.metadata ?? {} },
          },
        }),
      },
    )
    const u = body?.data
    if (!u?.id) throw new TitaniumApiError(0, 'createUser response missing data.id', body)
    return { id: u.id, email: u.attributes?.email ?? input.email, metadata: u.attributes?.metadata }
  },
}

// ── Test seams (NOT exported via barrel; underscore-prefixed) ──────────────

export function __setJwksResolverForTesting(resolver: JwksResolver | null): void {
  _jwksResolver = resolver
}

export function __setBlocklistCheckerForTesting(checker: ((subject: string) => Promise<boolean>) | null): void {
  _blocklistChecker = checker
}

export function __resetForTesting(): void {
  _jwksResolver = null
  _blocklistChecker = null
  _jwksWarmed = false
  if (_redis) {
    try { _redis.disconnect() } catch {}
    _redis = null
  }
}

export function __isJwksWarmed(): boolean {
  return _jwksWarmed
}
