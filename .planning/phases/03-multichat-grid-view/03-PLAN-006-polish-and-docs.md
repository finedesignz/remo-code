---
plan_id: 03-PLAN-006-polish-and-docs
wave: 4
depends_on: [03-PLAN-004-desktop-grid-page, 03-PLAN-005-mobile-accordion]
files_modified:
  - README.md
  - CLAUDE.md
  - docs/grid-view.md
  - hub/test/grid-perf.test.ts
autonomous: true
requirements: [R12, R13]
---

# Plan 03-006 — Polish, performance verification, and docs

<tasks>

<task id="T1">
<action>Update `README.md`: add a "Grid View" feature blurb under the existing feature list (or create one if absent), with a brief description matching the Phase 03 goal in `.planning/ROADMAP.md`. Include a placeholder for a screenshot (`<!-- screenshot: docs/img/grid-view.png -->`) — actual image is out of scope, the placeholder marks the slot. Mention `#/grid` as the route.</action>
<read_first>
- README.md (whole file)
- .planning/ROADMAP.md (Phase 03 goal)
</read_first>
<acceptance_criteria>
- README mentions Grid View, the `#/grid` route, mobile accordion, and per-user tab persistence
- Screenshot placeholder comment is present
- No broken links
</acceptance_criteria>
</task>

<task id="T2">
<action>Update `CLAUDE.md` (project): add callouts for the new files — `web/src/components/ChatSurface.tsx`, `GridPage.tsx`, `MobileAccordion.tsx`. Document the WS subscribe overload (single `session_id` OR `session_ids` array, cap 12). Document the new tables `chat_tabs` and `chat_tab_sessions`. Document the new endpoint `GET /api/sessions/messages?ids=...&limit=30`. Add `@tanstack/react-virtual` to a "Dependencies of note" section (or create one). Add `docs/grid-view.md` to the docs list.</action>
<read_first>
- CLAUDE.md (whole file)
</read_first>
<acceptance_criteria>
- The three new components are mentioned with one-line descriptions
- The WS overload is explained with a snippet showing both shapes
- `@tanstack/react-virtual` is documented as the only new web dep
- `docs/grid-view.md` is referenced
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `docs/grid-view.md`. Sections: Overview, Architecture (browser → multi-subscribe → hub → per-connection set → broadcast), Persistence schema (`chat_tabs`, `chat_tab_sessions` — copy the column list from PLAN-001), WS subscribe overload (back-compat note, 12-cap, `subscribe_error` shape), Initial-history endpoint (`GET /api/sessions/messages`), Breakpoint behavior (`md:` 768px, mobile accordion, `dvh` rationale), Performance design (RAF coalescing, `@tanstack/react-virtual`, why no hub-side throttling), Active-cell tracking (sessionStorage, paste/drop scoping), Scheduled-task queue badge (link to `docs/scheduled-tasks.md`), Deferred items (copy from CONTEXT `<deferred>` block).</action>
<read_first>
- docs/scheduled-tasks.md (style and section structure to mirror)
- .planning/phases/03-multichat-grid-view/03-CONTEXT.md (source of truth)
</read_first>
<acceptance_criteria>
- File is at `docs/grid-view.md`
- All 9 sections present
- Cross-links to `docs/scheduled-tasks.md` and back to `CLAUDE.md` work
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `hub/test/grid-perf.test.ts` — a perf smoke for R13. Stand up the hub against `REMO_E2E_DB_URL`, create 12 sessions for one user, open one client WS connection, subscribe to all 12 ids, then synthesize 5 activity events/second/session for 10 seconds (600 events total) — assert (a) every event was received by the client, (b) p95 client-receive latency from server-send is under 200ms (measured by including a `ts` field server-side), (c) no `subscribe_error` was emitted. Skip cleanly without `REMO_E2E_DB_URL`. This is a hub-side measurement — it does NOT test the React rendering throughput (that's a manual smoke).</action>
<read_first>
- hub/test/ws-multi-subscribe.test.ts (after PLAN-002 T4 — reuse the WS client harness)
- hub/test/scheduler.test.ts (timing assertion patterns)
</read_first>
<acceptance_criteria>
- Test passes with `REMO_E2E_DB_URL` set; runs in under 15s wall-clock
- Drops are reported (count of expected − received) and the test fails if > 0
- p95 latency assertion is explicit, with the computed value printed on failure
</acceptance_criteria>
</task>

<task id="T5">
<action>Visual + behavioral regression check on `#/chat` (R12). Manual smoke checklist that the executing agent runs and reports on: (a) open `#/chat`, verify Sidebar still renders the same way, (b) select a session, verify message history loads, (c) send a message, verify streaming response, (d) paste an image, verify it attaches and submits, (e) open Settings tab, verify it still renders, (f) open Schedules, verify it still renders, (g) check theme toggle still works, (h) check the Sidebar tooltip portal (recently fixed in commit 5ebf689) still works on hover. Document each check pass/fail in the PR body.</action>
<read_first>
- .planning/phases/03-multichat-grid-view/03-CONTEXT.md (R12 wording)
</read_first>
<acceptance_criteria>
- All 8 checks pass and are explicitly listed pass/pass/pass/... in the PR body
- Any fail blocks merge until fixed
</acceptance_criteria>
</task>

<task id="T6">
<action>Final build + lint + test sweep. Run `bun install` at repo root, `bun run build:web`, `bun test` in `hub/` (with `REMO_E2E_DB_URL` set on a disposable DB). All must be green. Then update `.planning/ROADMAP.md` Phase 03 status from `Pending` to `Complete` with `Completed: <today>`.</action>
<read_first>
- .planning/ROADMAP.md
</read_first>
<acceptance_criteria>
- `bun run build:web` emits the dist with no TS errors
- `bun test` is green for all hub test files
- ROADMAP.md Phase 03 status updated to Complete with the completion date
</acceptance_criteria>
</task>

</tasks>

must_haves:
- README, CLAUDE.md, and `docs/grid-view.md` reflect the shipped behavior
- `@tanstack/react-virtual` is documented as the only new web dep
- Performance test exists, runs in <15s, asserts zero drops + p95 latency under 200ms server-to-client
- `#/chat` regression checklist run and recorded
- ROADMAP.md Phase 03 marked Complete
