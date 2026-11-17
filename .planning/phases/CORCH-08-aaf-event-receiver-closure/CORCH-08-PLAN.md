# CORCH-08 PLAN - aaf-event-receiver-closure

Repo remo-code, branch phase-corch-08-aaf-event-receiver, PR base phase-corch-04-gsd-console-ingestion (stacked).
REQ-IDs: CORCH-R5.5 (receiver), CORCH-R5.6 (closure transitions), CORCH-R5.7 (provision on enrollment).
Goal: a merged PR closes its work item, a closed or failed PR blocks it, and only AAF-provisioned projects dispatch.
Everything ships flag-OFF / env-unset = unchanged behavior; additive DDL only.

## Locked decisions (from the roadmap, panel verdict and the AAF sender/provision contracts, read-only)

1. Receiver `POST /api/corch-events/aaf` via the shared `runIntake`, mounted before the `/api/*` catch-all, skip lists
   (auth, license gate, CSRF allowlist) updated, `mount-order.test.ts` extended. The signature is the credential, so the
   "presented credential" slot is the configured secret (compare vacuous by construction); the HMAC layer verifies
   `sha256=HMAC(secret, ts + "." + rawBody)` (sender: agentautofix `signedPost` timestamped mode) with a 5 minute skew.
   Secret unset => 503, nothing read or recorded. Body cap 16 KiB. Event-Id header, when present, must equal the signed id.
2. `corch_events` (unique `event_id`) holds parsed fields only, never the raw body. Dedupe + resolve + transition happen
   in ONE transaction (`store.applyAafEvent`), so a concurrent duplicate applies once.
3. Item resolution: repo (`github://<repo>` lowercased) AND head ref `corch/<uuid>` AND `branch` column equality.
4. Transitions: merged => done (from any non-terminal); closed => blocked (`pr_closed`); failed => blocked (`pr_failed`)
   + one notification (telegram + email, same durable channels as the CORCH-04 outage notice); done/cancelled/unknown/
   already-blocked => 200 `ignored`, audited. Event fields are untrusted: lookup keys only, never echoed or notified.
5. "Stays blocked after a reconciler pass": `endRunAndRequeue` / `endRunMarkPrOpen` only touch an item still `running`
   (`itemUntouched` flag; dispatcher does not re-notify). Without this a live run ending after the event would requeue.
6. Provision: `aaf-provision.ts` calls AAF `POST /api/projects/provision` (`{repo_slugs, installation_id}`, bearer
   `projects:write`). `installation_id` is required by the AAF contract, so one additional env var
   `REMO_CORCH_AAF_INSTALLATION_ID` is introduced. Failure / unset env => `aaf_unprovisioned`, never throws, never blocks
   enrollment. Hook in projects POST and PATCH re-enable; flag OFF => no call, no write. Already provisioned => left alone.
7. Dispatch gate (fail closed): `claimNext`, `usersWithDueItems`, `earliestFutureNotBefore` require
   `aaf_provision_status = 'provisioned'`. Column default is `aaf_unprovisioned`. CORCH-01/02 e2e fixtures updated
   deliberately to seed `provisioned`.
8. Backfill: `hub/scripts/corch-provision-existing.ts`, idempotent (provisioned rows skipped).
9. Shared signature vector committed byte-identical (`hub/test/fixtures/corch-event-signature-vector.json`) and verified.

## Success criteria and evidence
1. Receiver tests (good, bad sig, skew, replay, secret unset 503, vector): `test/corch-aaf-events.test.ts`.
2. mount-order pin: `test/mount-order.test.ts`.
3. Transition tests incl. reconciler pass, race, notification count: `test/e2e/corch-aaf.e2e.test.ts` (real Postgres).
4. Provision tests + idempotent script: `test/corch-aaf-provision.test.ts`, e2e backfill case.
5. schema-lint, migration-verify, schema-double-apply e2e, docs:sync, guards, check-baseline.

## Out of scope
AAF code, `pr.opened`, flipping any flag, prod deploys.
