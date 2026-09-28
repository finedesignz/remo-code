# Scorecard — finedesignz/remo-code

**Status:** Baselined for real 2026-09-28 (run 2), against `main` @ `b69a6f9` (before PR #492 /
PTYCAP-02 land). Evidence-based per DIRECTIVE §3.1, not the placeholder guesses from run 0/1.
`/roast` has NOT been run yet this run (budget; do it next milestone boundary or at `roast_every`).

| Dimension | Score (0–10) | Evidence | Last verified |
|---|---|---|---|
| Security | 5 | `bun audit`: 47 vulnerabilities (12 high, 33 moderate, 2 low). Most are `hono@4.12.8` (hub's actual runtime web framework, not a dev-only dep) plus `browserslist`/`autoprefixer` (web build-time, high but lower real exposure). Not yet triaged for which CVEs actually apply to the resolved version vs. require a newer patch. All the load-bearing invariants (scoped-query/IDOR pattern, webhook HMAC+raw-body, API key scopes, human-only-PTY no-API-key guards) were spot-checked via CLAUDE.md's own guard-test references, not independently re-audited this pass. | 2026-09-28 |
| Reliability/bugs | 8 | All four BLEED CRITICAL/HIGH fixers confirmed shipped and verified in code this run (NULL-run-leak fix + absolute-age reaper, half-open circuit breaker, hostname-required ghost fix, green baseline). `check-baseline`: `pass=2157 fail=0`. Prod `/health` → `{"ok":true}`. Not yet checked: live Coolify hub logs for `at_capacity`/`circuit_open`/`ghost_reaped` rates (no Coolify MCP access exercised this run). | 2026-09-28 |
| Data integrity | 7 | `schema.sql` CI-fenced (per CLAUDE.md/CONCERNS.md #7 disposition "ACCEPT + fence", not independently re-verified this pass). NULL-run-leak class fixed (see Reliability). `bun run schema-lint` / `migration-verify` not run this pass (no local Postgres in this sandbox) — deferred, noted as a gap. | 2026-09-28 |
| Performance | unscored | Not run this pass: `bun run smoke -- https://app.remo-code.com`, bundle size (`web/dist/assets`), Coolify CPU/mem. No signal either way. | unbaselined |
| Cost | 7 | Token cap architecture is sound per CLAUDE.md (all 7 dispatch paths gated, fails closed, `token-cap-coverage.test.ts` + `token-cap-gate-fires.test.ts` proven against real Postgres per CI). `REMO_ORCHESTRATOR_ENABLED` reported live in prod in "monitoring mode" per stale `.planning/STATE.md` note (2026-06-26) — not reconfirmed this pass; worth a follow-up check of the actual current flag state and daily token totals, which this sandbox has no access to verify (no prod DB/log access). PTYCAP Phase 2 (this iteration's own top-scored item) is precisely about closing the remaining PTY-path gap. | 2026-09-28 |
| User value | 6 | Roadmap is coherent and prioritized (`PROJECT.md`'s Planned Milestones, PTYCAP correctly identified as the current blocker). No user feedback sources checked this pass (AgentAutofix widget comments, GitHub issues beyond #488, `.planning/routine/feedback/`) — deferred to next iteration's §3.4 pass. | 2026-09-28 |
| UX/UI | unscored | No UI scan run this pass (DIRECTIVE §5) — this iteration's work was backend/docs only, no UI-touching PR. Do the no-auth-surface scan next iteration that touches `web/`. | unbaselined |
| Code health/tests | 5 | Hub typecheck: **427 errors** on `origin/main` right now (`bunx tsc --noEmit -p hub/tsconfig.json`), traced to the `typescript` 5.9.3→7.0.2 major bump (#447, merged 2026-09-14) — not a fresh regression from this run, but a real, sizeable, currently-ungated debt (CI reports, doesn't gate per DIRECTIVE §8). God-files unchanged since CONCERNS.md's 2026-07-12 count (not re-measured this pass): `dal.ts` ~2304 LOC, `agent.ts` ~1286, `telegram-webhook.ts` ~1197. Regression baseline itself is healthy (see Reliability). | 2026-09-28 |
| Observability/docs | 6 | `/health` → `{"ok":true}`. Docs-drift not run this pass (no route changes this iteration). Planning-doc staleness (the dimension's own biggest finding) is the subject of this iteration's PR #492 — was a real, ~2.5-month gap between `CLAUDE.md` and `.planning/{PROJECT,STATE}.md`/`CONCERNS.md`; now reconciled pending merge. | 2026-09-28 |

## Notes
- Weakest scored dimensions this pass: **Security** (untriaged hono CVEs against a runtime dep)
  and **Code health** (427 hub typecheck errors, ungated). Per DIRECTIVE §3.3 tiebreak rule ("the
  dimension with the lowest scorecard score wins"), the *next* iteration's default tiebreak lean is
  Security (hono triage) unless something scores higher outright.
  - **Reasoning for not acting on the hono CVEs THIS iteration:** discovered late in the session
    (after PTYCAP-02 was already delegated and in flight); triaging 47 advisories against an exact
    pinned version properly (which are real vs. false-positive-on-4.12.8, which are reachable from
    remo-code's actual usage of hono, whether a patch bump alone fixes them or needs breaking-change
    handling) is itself an Effort 2-3 item that deserves its own iteration's full attention, not a
    rushed tail-end pass.
- `/roast` not run this pass — do it at the next milestone boundary (PTYCAP Phase 2 landing) or
  when `roast_every` (5 iterations) is hit, whichever comes first.
- Performance and UX/UI are unscored (no signal gathered this pass) rather than guessed at 0 or 5 —
  don't treat "unscored" as "bad," it means "unknown, go measure it."
