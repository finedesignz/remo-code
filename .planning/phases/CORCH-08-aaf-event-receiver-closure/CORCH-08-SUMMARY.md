# CORCH-08 SUMMARY - aaf-event-receiver-closure

Repo remo-code, branch phase-corch-08-aaf-event-receiver, PR base phase-corch-04-gsd-console-ingestion (stacked).
REQ-IDs: CORCH-R5.5, CORCH-R5.6, CORCH-R5.7. Flags OFF: nothing changes until the cutover items below.

## Delivered
- `POST /api/corch-events/aaf` (hub/src/corch/aaf-events.ts): runIntake, timestamped HMAC `${ts}.${rawBody}`, 5 min skew,
  uniform 401, 503 when `REMO_CORCH_AAF_EVENT_SECRET` unset, 16 KiB cap, mounted before the auth catch-all (skip lists for
  auth, license gate, CSRF), `mount-order` pinned. Shared CORCH-06 vector committed byte-identical (same git blob id as
  agentautofix) and verified through the receiver at the vector timestamp.
- `corch_events` (unique `event_id`, parsed fields only) + `corch_projects.aaf_project_id` / `aaf_provision_status`
  (additive). Dedupe + resolve + transition in one transaction (`applyAafEvent`).
- Transitions: merged => done; closed => blocked (not requeued, survives reconciler passes); failed => blocked + one
  durable notification (persisted intent, atomic fenced claim, 503 retry, at-least-once, see QC-ADJUDICATION);
  unknown/terminal/already-blocked => 200 ignored, audited. A closure ends the item's live run in the same transaction,
  cancels the in-process send guard and releases the pipeline slot. Global lock order item then runs.
- Provision on enrollment (POST and PATCH re-enable), fail closed; dispatch gate in `claimNext`, `usersWithDueItems`,
  `earliestFutureNotBefore`; `hub/scripts/corch-provision-existing.ts` idempotent backfill.
- docs/corch.md, CLAUDE.md, openapi/api.md regenerated.

## Evidence
- New tests: corch-aaf-events 20, corch-aaf-provision 9, e2e/corch-aaf (real Postgres) 18, mount-order +4.
- Existing CORCH-01/02 e2e fixtures updated to seed `provisioned` (corch-dispatcher 28, corch-quota 20, corch-gsdc 2 green).
- schema-lint OK, migration-verify OK (clean DB), schema-double-apply e2e 9/9, docs:sync no drift, all named guards green
  (each its own process), check-baseline (DATABASE_URL = REMO_E2E_DB_URL = one scratch PG 17.6 db): pass=4174 fail=0.
- QC: Codex (external seat) R1-R4 QC-FAIL with real findings, all fixed; R5 QC-PASS. Records QC-R1..R5, QC-ADJUDICATION.

## Env introduced (all default OFF / unset = unchanged)
`REMO_CORCH_AAF_EVENT_SECRET`, `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN`, `REMO_CORCH_AAF_INSTALLATION_ID`
(the last one is required by AAF's provision contract `installation_id`; not in the roadmap env list).

## Cutover items (owner/orchestrator, not done here)
1. Set `REMO_CORCH_AAF_EVENT_SECRET` on the hub to the same value as AAF's `CORCH_EVENT_SECRET`; AAF `CORCH_EVENT_URL`
   to `https://<hub>/api/corch-events/aaf`.
2. Set `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN` (projects:write), `REMO_CORCH_AAF_INSTALLATION_ID`.
3. Run `bun hub/scripts/corch-provision-existing.ts` once (enrollments made while the flag was OFF are not provisioned).
4. Until step 3, enrolled projects are `aaf_unprovisioned` and will not dispatch even with `REMO_CORCH_ENABLED` on.

## Deliberate behavior notes
- Provision on enrollment is skipped while `REMO_CORCH_ENABLED` is OFF (true no-op); backfill covers it.
- A merged event moves a `blocked` item to `done` (merge is ground truth); closed/failed never moves a done item.
