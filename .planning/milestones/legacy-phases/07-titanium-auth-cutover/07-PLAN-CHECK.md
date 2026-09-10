# 07-PLAN-CHECK: plan-checker verdict

**Run:** 2026-05-25
**Iteration:** 1 of 3 (no revisions triggered)
**Plans reviewed:** A, B, C, D, E, F, G, H, I, J

## Quality gates

| Gate | Verdict | Notes |
|---|---|---|
| Every plan has `<read_first>` | ✅ | All 10 plans include the section. |
| Every task has `<acceptance_criteria>` | ✅ | All tasks include concrete, verifiable criteria. |
| Wave assignment correct | ✅ | W1: A, B (independent). W2: C (needs A+B), D (needs A+B; parallel with C). W3: E, F, G (parallel after C/D). W4: H, I, J (sequenced after C–G). |
| Requirements coverage | ✅ | R-AUTH-01 → A, G; R-AUTH-02 → B; R-AUTH-03 → E; R-AUTH-04 → C, D (gated path), I; R-AUTH-05 → H; R-AUTH-06 → A (blocklist), D (cache), G (audit); R-AUTH-07 → H; R-AUTH-08 → B, C, G; R-AUTH-09 → C. All 9 mapped. |
| Karpathy rule #11 (smallest diff) | ✅ | Anti-patterns section in PATTERNS.md + PLAN-H explicit "DO NOT in this phase" list. No drive-by refactor of `hub/src/ws/agent.ts` or unrelated middleware. |
| 10-stage architect-template alignment | ✅ | A–J shape matches `~/.claude/plans/cheeky-watching-crystal.md` verbatim. Adapter notes for Bun/TS embedded. |
| TDD where applicable | ✅ | A (golden vectors first), B (DAL tests gated on REMO_E2E_DB_URL), C/D/G (Hono mock-context tests), E (script test), F (light — UI), H (regression-light). |
| Atomic-commit discipline | ✅ | One commit per stage in this planning phase; execute-phase will do likewise per task per CONTEXT.md instruction. |
| Naming-collision fix (`sessions` → `auth_sessions`) | ✅ | Caught during research; CONTEXT.md amended; carried through B and all downstream plans. |
| Load-bearing invariants documented | ✅ | Agent `api_keys` untouched (asserted in CONTEXT, RESEARCH, PATTERNS, PLAN-I row 12), sentry-intake / coolify-webhook / supervisor unchanged, exclusion list copy-paste consistent across all plans. |

## Open items the planner left for the user (NOT revisions — open questions)

1. Keygen Product ID for remo-code — must exist before E.1 `--apply` run.
2. License model (per-user vs per-tenant Group) — affects D.1 query shape.
3. Webhook availability for `license.changed` — gates D.3 from inert to active.
4. Cookie name (`__Host-remo_sid` proposed) — confirm no collision with future apps on `app.remo-code.com`.

## Recommendation
Plans are ready for `/gsd-execute-phase`. No revisions required. The 4 open questions above can be answered during execution as long as they're resolved before:
- Q1 → before PLAN-E I.3 prod migration
- Q2 → before PLAN-D execution
- Q3 → before PLAN-D.3 execution (otherwise route ships inert)
- Q4 → before PLAN-C.1 implementation

Iteration cap (3) not reached. Single-pass plan accepted.
