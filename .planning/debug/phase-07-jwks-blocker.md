# Phase 07 cutover BLOCKED — Keygen CE has no JWKS endpoint

**Recorded:** 2026-05-26 by Phase 07 cutover operator.

## Symptom

`GET https://keygen.titaniumlabs.us/v1/accounts/62ad28e5-2ce7-49d6-8170-ae6fa6584c86/.well-known/jwks.json` → **404 NOT_FOUND**.

## Root cause

Keygen CE (commercial-edition open-source build, running as Docker image `keygen/api:latest`, container `zdknaz3bm51m3gnz7i125qyn-010456871398` on Coolify host `46.224.61.233`) does **NOT** ship a JWKS endpoint. Verified via:

```ruby
Rails.application.routes.routes.map { |r| r.path.spec.to_s }.grep(/jwks|well.known|openid/i)
# => []
```

The hub's `hub/src/titanium-client.ts` was written against a planning-doc assumption that Keygen exposes JWKS at the Auth0/Cognito-style path `/{account}/.well-known/jwks.json`. That assumption is false.

## What Keygen CE actually provides

- `GET /v1/accounts/:account_id` — returns `attributes.ed25519PublicKey` (64-char hex). **Requires authentication** (TOKEN_MISSING with `Accept: application/vnd.api+json` and no Authorization header).
- `accounts.ed25519_public_key` and `accounts.ed25519_private_key` columns hold the raw 32-byte Ed25519 keypair, hex-encoded.
- Keypair regeneration: `Account#generate_ed25519_keys!` is a **private** before_create callback. Invoke via Rails runner: `a.send(:generate_ed25519_keys!); a.save!(validate: false)`.

## What was completed in this session

1. **Keypair regenerated** on prod Keygen for account `62ad28e5-2ce7-49d6-8170-ae6fa6584c86`. New public key first 40 chars: `8eb5121238b5432c227285992d813ca688136785`. Persisted via `Account#send(:generate_ed25519_keys!) + save!(validate: false)`.
2. **PR #71** opened — `fix(hub): drop legacy TITANIUM_* env aliases, keep only TITANIUM_KEYGEN_*`. Surgical fix, 13 tests pass, ready to merge independently of the JWKS pivot.
3. **Phase 08 PLAN.md addendum** committed on `titanium-licensing` `feat/app-onboarding` branch — corrects the planner's wrong assumption about `POST /v1/accounts/:id/keys` and documents the actual Keygen CE keypair lifecycle. See `C:\Users\artic\GitHub\titanium-licensing-feat-app-onboarding\.planning\phases\08-app-onboarding\PLAN.md` "Addendum 2026-05-26".

## What is NOT done (cutover blocked)

- **Step 4 (Coolify env set):** skipped. The four env vars (`TITANIUM_KEYGEN_ADMIN_TOKEN`, `E4A_*`, `REMO_PUBLIC_URL`) can still be added once the hub can actually verify Titanium JWTs.
- **Step 5 (redeploy):** skipped. Redeploying now would not help — `titanium-client.ts` would still fail to warm JWKS.
- **Step 6 (dry-run migration):** skipped. The migration script presumes a working Titanium identity round-trip on the hub side.
- **Step 7 (apply migration):** skipped.
- **Step 8 (D14 trigger):** skipped. No soak window starts until cutover lands.

## Path forward (NOT YET EXECUTED — needs design + user go-ahead)

Two valid pivots. Pick before any code lands.

### Option 1 — Rewrite `titanium-client.ts` to single-key verification

- At boot: `GET ${TITANIUM_KEYGEN_API_URL}/v1/accounts/${ACCOUNT_ID}` with `Authorization: Bearer ${TITANIUM_KEYGEN_PORTAL_TOKEN}` and `Accept: application/vnd.api+json`. Extract `attributes.ed25519PublicKey`, hex-decode to 32 raw bytes, build a `KeyObject` (Node `crypto.createPublicKey` with `{ key, format: 'jwk', type: 'OKP', crv: 'Ed25519', x: base64url(rawBytes) }`).
- Verify JWTs against that one public key (no `kid` lookup, no JWKS cache).
- Add a refresh job (e.g. every 5 min) to re-fetch in case operator rotates.
- Drop `jwks-rsa` (or equivalent) dependency.

**LOC estimate:** ~120 LOC across `titanium-client.ts` + test rewrite. Above the 30-LOC threshold in CLAUDE.md rule #11.

**Risk:** rotation handling — if the operator regenerates the keypair while the hub is up, JWTs minted by Keygen with the new key will fail until the hub's refresh job runs. Acceptable for now (rotation is rare, manual).

### Option 2 — Add a JWKS endpoint to Keygen CE (upstream fork)

- Patch the Keygen Rails app to expose `/v1/accounts/:account_id/.well-known/jwks.json` derived from `accounts.ed25519_public_key`. JSON shape: `{ keys: [{ kty: "OKP", crv: "Ed25519", kid: <derive from key fingerprint>, x: base64url(rawBytes), alg: "EdDSA", use: "sig" }] }`.
- Rebuild + redeploy the `keygen/api` container.
- `titanium-client.ts` stays as-is.

**LOC estimate:** ~40 LOC of Ruby in a new controller + a route. Plus container rebuild + deploy.

**Risk:** maintaining a Keygen fork across upstream updates. Probably worth it long-term since titanium-licensing is the user's own platform.

## Recommendation

**Option 2** for the long term. **Option 1** as a stop-gap if Phase 07 needs to ship this week. User has explicitly chosen manual verification before cutover, so there is no time pressure — recommend going straight to Option 2.

## Files implicated

- `C:\Users\artic\GitHub\remo-code\hub\src\titanium-client.ts` — needs full rewrite (Option 1) or stays (Option 2).
- `C:\Users\artic\GitHub\remo-code\hub\test\titanium-client.test.ts` — test seam `setJwksResolverForTest` would need rename or removal (Option 1).
- `C:\Users\artic\GitHub\remo-code\.planning\phases\07-titanium-auth-cutover\07-CONTEXT.md` — multiple references to the JWKS URL pattern need correcting.

## Confidence

**HIGH** that the JWKS endpoint genuinely does not exist (verified via routes table dump on prod). **HIGH** that the Account-resource fallback works (route table confirms `GET /v1/accounts/:account_id` exists). **MEDIUM** on the exact public-key serialization shape — Keygen CE may expose the public key as raw hex, PEM, or base64; need a quick authenticated probe to confirm the exact field name and encoding before writing Option 1 code.
