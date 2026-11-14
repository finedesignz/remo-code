# CORCH-04 PLAN - gsd-console ingestion

REQ: CORCH-R1.14, R1.15, R1.16. Depends on CORCH-01 (stacked on CORCH-02 branch).

## Research (verified against gsd-console origin/main 803c2e1, 2026-11-13)

- `GET /api/board/stream` (hosted/routes/board.js): credentials session|token, scope `board:read`; SSE events
  `snapshot` (data `{projects: Summary[]}`), `project` (data `Summary`), `stream-error` (`{code, message}`), comment
  lines as keepalive; stream closed after 10 minutes; max 10 streams per account (429 `stream_limit`); 401/402/403.
- `Summary` = fleet entry (+ `board_version`): `id, slug, position, snapshot_state, stale, divergent, active_runs, ...`.
- `GET /api/board/projects/{id}`: `columns {done,current,backlog,pending}` of phases `{number,name,goal,plans}`,
  `position.milestone {version, heading}`, `snapshot {state, stale}`. A phase is `done` when plan_count>0 and
  summary_count==plan_count; `current` = state's current phase; `backlog` = number starts with 999; else `pending`
  (hosted/board/read.js toColumns). Phases carry no milestone field: milestone comes from `position.milestone`.
- Auth: `Authorization: Bearer gsdc_...` only (hosted/auth/credentials.js).
- Slug is `owner/name`; hub join is `github://owner/name` (hub idents are lowercase; compare lowercased).
- Decision: `active_runs`/`stale`/`divergent` are read from the stream Summary (not the detail), and a skipped project
  is not read at all and writes nothing (no upsert, no cancel).

## Design (locked, no panel needed: single module, additive, no schema change)

- `gsdc-derive.ts`: pure `deriveCandidate(slug, summary, board)` + zod shapes.
- `gsdc-ingest.ts`: `createGsdcIngest(deps)`; SSE parser; per-event all-or-nothing apply; outage state; backoff 1s..5min;
  idle timeout 3 min; timers only via injected `CorchTimers` (`REAL_TIMERS` exported from dispatcher.ts).
- `gsdc-boot.ts`: wiring (`startGsdcIngest`), called from `startCorch` after the reconciler; true no-op when flag OFF or
  URL+token unset.
- Store (additive, no DDL): `listEnabledProjects()`, `cancelQueuedBySourceRefs(projectId, source, refs)`.
- Flag: `gsdcConfig()` (off | partial | on). Token read only to build the Authorization header.
- Guard change (deliberate): `corch-no-polling-guard` now allows `setTimeout(` in `gsdc-ingest.ts` and pins that every
  occurrence is `timers.setTimeout(` (the injected seam), no `setInterval`, and exactly one stream open + one board read.

## Definition of done

1. Fake-SSE tests: snapshot/project re-read only enrolled; end => reconnect + fresh snapshot; backoff capped 5 min; flag OFF no connection.
2. Table-driven derivation: current, lowest pending, backlog ignored, skip active_runs/stale/divergent/not-ready, cancel-on-done, idempotent source_ref.
3. Each failure mode: zero upserts, zero cancellations, one notification per outage.
4. `corch-no-polling-guard` green; hostile console text only inside fences.
5. check-baseline, schema-lint, migration-verify, schema-double-apply, docs:sync (no diff), guards green; real-Postgres e2e.
