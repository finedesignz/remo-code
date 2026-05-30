# Coolify deploy-fail triage (main)

**Triage date:** 2026-05-26
**App:** remo-code (`zewfc6g9dw3c4h88z2jd2o4g`) at https://app.remo-code.com
**Mode:** read-only. No env writes, no commits, no deploys.

## Correction to the original premise

The task brief assumed the regression came from the Phase 06 PRs (5f83c87, 2f16427, 983536d, 8b83d4a, bcc2404). It did not. Those commits last touched the app on 2026-05-25 and the deploys at `2026-05-26T03:38:15Z` / `03:41:56Z` / `03:42:20Z` were all `finished` (green). The Phase 06 surface is healthy.

**First failure:** `2026-05-26T03:45:39Z`, deployment `j11h28zin22pnl4z4ocfrrne`, commit `cd633030` — the **Phase 07 cutover merge** (`Merge pull request #40 from finedesignz/phase-07-titanium-auth-cutover`).

Every deploy since has failed for the same reason (commits `cd63303`, `3729da1`, `aa7ef81`, `de88a46`, `6dd1800` — all on `main`).

## Failed deploy count

7 consecutive failures since 2026-05-26T03:45Z:

| timestamp (UTC) | commit | uuid | status |
|---|---|---|---|
| 03:45:39 | cd633030 | j11h28zin22pnl4z4ocfrrne | failed |
| 03:50:51 | 3729da15 | p10td0vkod8m38nuh7lecbxs | failed |
| 03:51:08 | aa7ef81c | uowfn6qgwbrdozaatrq8dpyx | failed |
| 03:51:09 | aa7ef81c | bc8bhuk44asc1uqwdqw3e698 | failed |
| 03:51:40 | de88a460 | mh49qbuly7t1vfvxa6w8odaa | failed |
| 03:54:30 | de88a460 | pglfyvzdof0rh4svypwgkvln | failed |
| 04:01:45 | 6dd1800f | sygkf78yf9rvadkv9k392tm6 | failed |

All failed with healthcheck `unhealthy`, container exiting before binding `:3040`.

## Root cause

**Env var naming drift between Phase 07 code and the Coolify env.** The hub's Phase 07-A bootstrap (`hub/src/index.ts:267-275`) warms the Titanium JWKS cache before binding the port. It calls `warmJwksCache()` in `hub/src/titanium-client.ts:102-108`, which hard-errors when any of `config.titanium.{keygenApiUrl, accountId, productId}` is empty. `config.ts:74-78` populates those fields from env vars `TITANIUM_KEYGEN_API_URL`, **`TITANIUM_ACCOUNT_ID`**, **`TITANIUM_PRODUCT_ID`**, **`TITANIUM_PORTAL_TOKEN`**. But the Coolify app env (verified read-only via `GET /api/v1/applications/{uuid}/envs`) defines **`TITANIUM_KEYGEN_ACCOUNT_ID`**, **`TITANIUM_KEYGEN_PRODUCT_ID`**, **`TITANIUM_KEYGEN_PORTAL_TOKEN`** (with the extra `_KEYGEN_` infix). `TITANIUM_KEYGEN_API_URL` is the one name that matches, so the gate enters the warm path; the other two lookups resolve to `""`; warm throws; the process `process.exit(1)`s before `Bun.serve` runs.

## Error excerpt

From deployment `sygkf78yf9rvadkv9k392tm6` container logs:

```
[stdout] Waiting for healthcheck to pass on the new container.
[stdout] Healthcheck URL (inside the container): GET: http://localhost:3040/health
[stdout] Waiting for the start period (30 seconds) before starting healthcheck.
[stdout] "unhealthy"
[stdout] Attempt 1 of 3 | Healthcheck status: "unhealthy"
[stderr] New container is unhealthy.
[stdout] Container logs:
[stderr] [titanium] JWKS warm failed — refusing to bind port:
         Titanium config missing: TITANIUM_KEYGEN_API_URL, TITANIUM_ACCOUNT_ID,
         TITANIUM_PRODUCT_ID required
[stdout] New container is not healthy, rolling back to the old container.
```

(Healthcheck rollback keeps prod serving the last green container from commit `c26fbec2` — so end users are not impacted, only new deploys are stuck.)

## Proposed fix

Two valid fixes — both are one-line, both are safe. Pick **Option A** (code change) since it is the canonical Titanium-licensing naming convention and matches the rest of the env vars on the Coolify app (`TITANIUM_KEYGEN_POLICY_ID`, `TITANIUM_KEYGEN_PORTAL_TOKEN`, etc.).

### Option A — rename env keys in code (preferred)

`hub/src/config.ts` lines 76-78:

```diff
-    accountId: process.env.TITANIUM_ACCOUNT_ID || "",
-    productId: process.env.TITANIUM_PRODUCT_ID || "",
-    portalToken: process.env.TITANIUM_PORTAL_TOKEN || "",
+    accountId: process.env.TITANIUM_KEYGEN_ACCOUNT_ID || "",
+    productId: process.env.TITANIUM_KEYGEN_PRODUCT_ID || "",
+    portalToken: process.env.TITANIUM_KEYGEN_PORTAL_TOKEN || "",
```

Also update the error string in `hub/src/titanium-client.ts:105` for consistency:

```diff
- 'Titanium config missing: TITANIUM_KEYGEN_API_URL, TITANIUM_ACCOUNT_ID, TITANIUM_PRODUCT_ID required',
+ 'Titanium config missing: TITANIUM_KEYGEN_API_URL, TITANIUM_KEYGEN_ACCOUNT_ID, TITANIUM_KEYGEN_PRODUCT_ID required',
```

Grep for any other readers of the old names (`TITANIUM_ACCOUNT_ID`, `TITANIUM_PRODUCT_ID`, `TITANIUM_PORTAL_TOKEN`, `TITANIUM_ADMIN_TOKEN`) before shipping — the Phase 07-E migration script and any tests may use the old names too. Update or alias them.

### Option B — add the un-prefixed env vars on Coolify (faster but leaves the drift)

PATCH the app envs with three additional keys pointing at the same values:
- `TITANIUM_ACCOUNT_ID=62ad28e5-2ce7-49d6-8170-ae6fa6584c86`
- `TITANIUM_PRODUCT_ID=469dcd2e-b41c-4fc9-ba34-1c5d444edb82`
- `TITANIUM_PORTAL_TOKEN=prod-8052148d1f244a94100cb0d4f998c73278c9e91a503dc646c6c9f53`

**Do not execute this without coordinating with the in-flight Phase 07 operator** — the brief explicitly forbids Coolify env writes from this triage. Mention it as an option only.

## Why this slipped through

1. **No env-name lint.** Phase 07 docs say `TITANIUM_KEYGEN_*` (the canonical Titanium-licensing prefix); code says `TITANIUM_*`. Nothing in CI cross-checks the env keys read in `config.ts` against the names documented in 07-CONTEXT / runbook.
2. **Tests can't catch this — they pass via in-process mocks or skip when env is unset.** Unit tests don't boot `Bun.serve`, so the `JWKS warm → exit(1)` path doesn't trip in `bun test`.
3. **No smoke test of `/health` against the built Docker image before promote.** The Coolify healthcheck IS the gate, but by then it's already deploying.
4. **Healthcheck rollback hid the impact.** Prod stayed green on the last-good container, so the failure looked like "no new features" rather than "every deploy is broken."

## Recommended preventatives (separate ticket)

- Add a `hub/scripts/check-env-keys.ts` that greps `process.env.X` reads in `hub/src/**` and fails CI if any read key is missing from a tracked `docs/env-keys.md` allowlist. Forces a doc update on every new env var.
- Add a Docker-build smoke test to the docs-drift workflow (or a sibling): `docker build .`, run with the **prod env shape** from a fixture, `curl /health`, expect 200.
- Bypass the `process.exit(1)` in `index.ts:274` when `NODE_ENV !== 'production'` so dev environments can still boot with broken Titanium config (only `production` should hard-fail).

## Confidence

**High.** The failing log line names the exact missing env keys; the Coolify env list shows the same keys present under the `_KEYGEN_` infix; the code reads the un-prefixed names. There is no ambiguity.

## Safe as one-line follow-up?

**Yes.** Option A is a 3-line `config.ts` rename + a 1-line error-string update. Run a project-wide grep for the old names first to catch any other readers (migration script, tests, docs). Ship as `fix(hub): align Titanium env var names with TITANIUM_KEYGEN_* convention`. Coordinate with the Phase 07 operator before pushing — they may already have a fix in-flight on `phase-07-titanium-auth-cutover` and a duplicate PR would conflict.
