/**
 * One-shot generator for hub/test/fixtures/titanium-vectors.json.
 *
 * Run:  bun run hub/test/fixtures/gen-titanium-vectors.ts
 *
 * Regenerates the deterministic-shape (random-key-material) golden-vector
 * fixtures used by `hub/test/titanium-client.test.ts`. The generator and the
 * fixture file are both committed: regenerating produces semantically
 * equivalent fixtures (new key material, same outcomes), and the test relies
 * only on the embedded JWKS — never on a hard-coded key.
 *
 * Adding a new vector: append below, then rerun this script.
 */
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ISSUER = 'https://keygen.titaniumlabs.us'
const ACCOUNT_ID = 'acct_test_0000000000'
const PRODUCT_ID = 'prod_test_remo'
const NOW = 1748000000 // 2025-05-23T13:33:20Z

async function makeKid(label: string) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true, crv: 'Ed25519' })
  const jwk = await exportJWK(publicKey)
  ;(jwk as any).kid = label
  ;(jwk as any).alg = 'EdDSA'
  ;(jwk as any).use = 'sig'
  return { jwk, privateKey }
}

const k1 = await makeKid('key-1')
const k2 = await makeKid('key-2-rotated')
const kRogue = await makeKid('key-rogue')

const jwksDefault = { keys: [k1.jwk] }
const jwksAfterRotation = { keys: [k1.jwk, k2.jwk] }

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user_abc123',
    email: 'jane@example.com',
    iss: ISSUER,
    aud: PRODUCT_ID,
    iat: NOW - 60,
    nbf: NOW - 60,
    exp: NOW + 3600,
    ...overrides,
  }
}

async function signEd(privateKey: CryptoKey, kid: string, claims: any, alg: string = 'EdDSA') {
  return await new SignJWT(claims).setProtectedHeader({ alg, kid }).sign(privateKey)
}

function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

const vectors: any[] = []

vectors.push({
  name: 'valid_eddsa_fresh',
  description: 'Valid EdDSA-signed token, all claims correct, kid matches JWKS',
  jwt: await signEd(k1.privateKey, 'key-1', baseClaims()),
  jwks: jwksDefault,
  now: NOW,
  expected: 'valid',
})

vectors.push({
  name: 'expired',
  description: 'exp 60 seconds before now (beyond 30s clockTolerance)',
  jwt: await signEd(k1.privateKey, 'key-1', baseClaims({ exp: NOW - 60 })),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'expired' },
})

vectors.push({
  name: 'wrong_iss',
  description: 'iss does not match TITANIUM_KEYGEN_API_URL',
  jwt: await signEd(k1.privateKey, 'key-1', baseClaims({ iss: 'https://evil.example.com' })),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'claim' },
})

vectors.push({
  name: 'wrong_aud',
  description: 'aud does not include PRODUCT_ID',
  jwt: await signEd(k1.privateKey, 'key-1', baseClaims({ aud: 'prod_other' })),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'claim' },
})

vectors.push({
  name: 'nbf_future',
  description: 'nbf 5 minutes ahead — beyond 30s tolerance',
  jwt: await signEd(k1.privateKey, 'key-1', baseClaims({ nbf: NOW + 300, iat: NOW + 300 })),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'claim' },
})

const valid6 = await signEd(k1.privateKey, 'key-1', baseClaims())
const parts6 = valid6.split('.')
const sig6 = parts6[2]!
const tampered6 = `${parts6[0]}.${parts6[1]}.${sig6.slice(0, -1)}${sig6.slice(-1) === 'A' ? 'B' : 'A'}`
vectors.push({
  name: 'tampered_signature',
  description: 'Last byte of signature flipped',
  jwt: tampered6,
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'signature' },
})

const algNoneJwt = `${b64url({ alg: 'none', kid: 'key-1' })}.${b64url(baseClaims())}.`
vectors.push({
  name: 'alg_none',
  description: 'alg: none MUST be rejected (load-bearing security invariant)',
  jwt: algNoneJwt,
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'alg' },
})

const hsToken = await new SignJWT(baseClaims())
  .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
  .sign(new TextEncoder().encode('this-is-a-symmetric-secret-not-eddsa-32chars'))
vectors.push({
  name: 'alg_hs256_masquerade',
  description: 'HS256 must be rejected — only EdDSA accepted (load-bearing)',
  jwt: hsToken,
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'alg' },
})

vectors.push({
  name: 'kid_unknown',
  description: 'kid not present in JWKS — verifier rejects',
  jwt: await signEd(k1.privateKey, 'key-unknown', baseClaims()),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'kid' },
})

vectors.push({
  name: 'post_rotation_kid_matched',
  description: 'Token signed by rotated key-2; JWKS includes both key-1 and key-2',
  jwt: await signEd(k2.privateKey, 'key-2-rotated', baseClaims()),
  jwks: jwksAfterRotation,
  now: NOW,
  expected: 'valid',
})

vectors.push({
  name: 'wrong_key_for_kid',
  description: 'Token claims kid key-1 but is signed by a different private key',
  jwt: await signEd(kRogue.privateKey, 'key-1', baseClaims()),
  jwks: jwksDefault,
  now: NOW,
  expected: { error: 'signature' },
})

const out = {
  $generated: 'hub/test/fixtures/titanium-vectors.json — Phase 07-A golden-vector tests',
  $issuer: ISSUER,
  $account_id: ACCOUNT_ID,
  $product_id: PRODUCT_ID,
  $coverage: vectors.map(v => `${v.name} — ${v.description}`),
  vectors,
}

const outPath = join(import.meta.dir, 'titanium-vectors.json')
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`wrote ${vectors.length} vectors to ${outPath}`)
