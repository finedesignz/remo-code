# 07-PLAN-A: Titanium client foundation

**Stage:** A (architect template)
**Wave:** 1 (parallelizable with PLAN-B)
**Mode:** standard
**TDD:** yes (golden-vector fixtures written first)
**Requirements:** R-AUTH-01, R-AUTH-06

<read_first>
- `.planning/phases/07-titanium-auth-cutover/07-CONTEXT.md` (all sections — LOCKED)
- `.planning/phases/07-titanium-auth-cutover/07-RESEARCH.md` §2, §3
- `.planning/phases/07-titanium-auth-cutover/07-PATTERNS.md` rows for `titanium-client.ts`, golden-vector tests
- `hub/src/auth/jwt.ts` — module-load-time validation pattern
- `hub/src/api/github.ts` — external-service client structure
- `hub/src/scheduler/post-run/github-issue.ts` — gateway-credential load pattern
- `~/.claude/plans/cheeky-watching-crystal.md` Stage A (Python original, for behavioral parity)
- `jose` docs for `createRemoteJWKSet` + `jwtVerify` (planner verifies API shape via `npm view jose` before writing code)
</read_first>

<tasks>

### A.1 Add deps (`jose`, `ioredis`) to `hub/package.json`
- Run `bun add jose ioredis` and `bun add -d @types/ioredis` if needed.
- Verify both install cleanly. Commit `package.json` + `bun.lockb` separately for clean diff.
<acceptance_criteria>
`jose` and `ioredis` appear in `hub/package.json` dependencies; `bun install` succeeds; `import { jwtVerify, createRemoteJWKSet } from 'jose'` and `import Redis from 'ioredis'` resolve at TypeScript compile time.
</acceptance_criteria>

### A.2 Extend `hub/src/config.ts` with new env vars
- Add: `TITANIUM_KEYGEN_API_URL`, `TITANIUM_ACCOUNT_ID`, `TITANIUM_PRODUCT_ID`, `TITANIUM_PORTAL_TOKEN`, `TITANIUM_ADMIN_TOKEN` (optional — only required when migration script runs), `TITANIUM_REDIS_URL`, `TITANIUM_LICENSE_CACHE_TTL_SECONDS` (default `300`), `MAGIC_LINK_SECRET`, `SESSION_SECRET`, `ALLOW_LEGACY_LOGIN` (default `true`).
- Validate at load: each `*_SECRET` ≥ 32 chars (match `jwt.ts` pattern). `TITANIUM_KEYGEN_API_URL` is a valid URL. `TITANIUM_LICENSE_CACHE_TTL_SECONDS` is a positive int.
- `ALLOW_LEGACY_LOGIN` parses `'true'|'false'|'1'|'0'`.
<acceptance_criteria>
Booting hub WITHOUT the new vars fails fast with a clear error message naming the missing var. Booting WITH valid vars succeeds. `config.titanium.*`, `config.magicLinkSecret`, `config.sessionSecret`, `config.allowLegacyLogin` are typed and accessible.
</acceptance_criteria>

### A.3 Write golden-vector fixtures `hub/test/fixtures/titanium-vectors.json`
- Generate (or hand-craft) ≥ 10 test JWTs covering: valid EdDSA token, expired token, wrong `iss`, wrong `aud`, `nbf` in future, tampered signature, `alg: none`, `alg: HS256` masquerading as Titanium, `kid` unknown, post-rotation `kid` matched.
- Each fixture: `{ name, jwt, jwks, expected: 'valid' | { error: '...' }, now: <iso-timestamp-for-deterministic-verify> }`.
- Commit fixtures BEFORE implementing the verifier (TDD).
<acceptance_criteria>
File exists with ≥ 10 vectors. Each can be loaded and parsed in test setup. Vectors documented inline (header comment) listing what each covers.
</acceptance_criteria>

### A.4 Write `hub/test/titanium-client.test.ts` against fixtures
- One test per fixture, asserting expected outcome.
- Stub `createRemoteJWKSet` with a local resolver that returns the fixture's `jwks`.
- Mock `Date.now()` to fixture's `now`.
- Tests FAIL before A.5 ships (red).
<acceptance_criteria>
`bun test hub/test/titanium-client.test.ts` reports failures because the implementation doesn't exist yet. Test count ≥ 10.
</acceptance_criteria>

### A.5 Implement `hub/src/titanium-client.ts`
- Exports:
  - `verifyLicenseJwt(token: string): Promise<TitaniumClaims>` — uses `jose` `jwtVerify` with `algorithms: ['EdDSA']`, `issuer`, `audience`, `clockTolerance: 30`. Calls `assertNotBlocked(claims.sub)` before returning.
  - `assertNotBlocked(subject: string): Promise<void>` — `redis.sismember('titanium:blocklist', subject)`; throws `BlockedSubjectError` if true.
  - `validateLicenseKey(key: string): Promise<{ token: string; claims: TitaniumClaims }>` — POSTs to `/v1/accounts/:id/licenses/actions/validate-key` body `{ meta: { key, scope: { product: PRODUCT_ID } } }`, returns `meta.token` + verified claims.
  - `keygenAdmin.findUserByEmail(email): Promise<KeygenUser | null>` — admin-token call.
  - `keygenAdmin.createUser({ email, metadata }): Promise<KeygenUser>` — admin-token call.
- Warm-cache: export `warmJwksCache(): Promise<void>` that pre-fetches the JWKS. Called from `bootstrap()` BEFORE port bind.
- Single shared `Redis` client instance (lazy-init on first call).
- All HTTP via `fetch` with 5s timeout + structured `TitaniumApiError` on non-2xx.
- TypeScript strict: explicit `TitaniumClaims` interface with `sub`, `iss`, `aud`, `exp`, `iat`, `email`, optional license fields.
<acceptance_criteria>
All A.4 tests pass green. `bun run build` succeeds. `warmJwksCache()` can be called without an actual network request when JWKS is mocked. No `any` types in the public API.
</acceptance_criteria>

### A.6 Wire `warmJwksCache()` into `hub/src/index.ts` `bootstrap()`
- Locate the existing bootstrap function (or `main()` if that's the pattern). Add `await warmJwksCache()` BEFORE `Bun.serve(...)`.
- On failure: log error and exit non-zero. This is intentional — hub MUST NOT serve traffic without JWKS available.
<acceptance_criteria>
Booting hub with valid Titanium config succeeds and logs "[titanium] JWKS warmed (N keys)". Booting with `TITANIUM_KEYGEN_API_URL` set to a non-reachable URL exits non-zero with a clear log line. Verified by manual smoke against a mock JWKS server.
</acceptance_criteria>

</tasks>

**Outputs at end of Stage A:** new module `hub/src/titanium-client.ts`, 10+ green golden-vector tests, deps added, env vars validated, warm-cache wired. NO behavior change to existing auth yet.

**Verification checkpoint:** `bun test hub/test/titanium-client.test.ts` green; `bun run build` succeeds; manual smoke of `bun run dev:hub` with mock Titanium env vars boots cleanly.
