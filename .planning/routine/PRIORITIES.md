# Priorities — finedesignz/remo-code

**Status:** Scored for real 2026-09-28 (run 2) per DIRECTIVE §3.3
(`Impact × Reach × Urgency × Confidence ÷ Effort + age bonus`). P0 scan run first (§3.2): prod
`/health` → `{"ok":true}`, no exposed secret found, no runaway cost signal accessible from this
sandbox (no prod DB/log access — noted as a real gap, not a clean bill of health). No P0 found.

## Done this iteration (moved out of the active list)
- ~~Reconcile stale planning docs~~ — PR #492 (docs-only, open), BLEED confirmed shipped, milestone
  pointer advanced to PTYCAP. See SCORECARD.md / STATE.md.
- ~~PTYCAP Phase 2 (PTY pre-flight gate)~~ — PR #493 (draft, CI pending), full scope shipped, all 3
  ROADMAP success criteria met. See LEDGER.md for evidence. PTYCAP Phase 3 stays blocked until #493
  merges (ROADMAP.md forbids parallelizing Phase 3 ahead of Phase 2).

## Active candidates, scored

### 1. Hono dependency security triage
`bun audit`: 12 high / 33 moderate / 2 low vulnerabilities, the large majority against
`hono@4.12.8` — **hub's actual runtime web framework** (`hub/src/index.ts` and effectively every
route), not a dev-only or build-time dependency. Impact 8 (authenticated-only-reachable web
framework CVEs, several look pre-auth per advisory titles — e.g. CORS wildcard-credential
reflection, JWT Bearer-scheme bypass — needs per-CVE confirmation against 4.12.8 before trusting
the "8"), Reach 9 (every hub request), Urgency 2, Confidence 0.6 (untriaged — could resolve to "all
already patched in 4.12.8, bun audit is flagging historical range" just as easily as "genuinely
exploitable today"), Effort 2 (bump `hono` to latest 4.x if a patch release exists, re-run the full
`hub/test` suite + `hub/test/mount-order.test.ts` + auth tests, since Hono underlies routing/auth
middleware). **Priority ≈ (8×9×2×0.6)/2 = 43.2.** Top-ranked. Route: `gsd-audit-fix` / `gsd-quick`.

### 2. Hub typecheck error count (427 errors, from TS 5.9→7.0.2 bump)
Impact 4 (code-health debt, currently ungated by CI, but 427 is large enough to be actively hiding
real type errors behind noise — CONCERNS.md's own warning: "unknown is not comforting" applies
here too), Reach 6 (touches `hub/test/*` broadly per the error list — `TS18046`/`TS2769`/`TS2571`
patterns cluster in test files doing `await res.json()` without narrowing), Urgency 1, Confidence
0.7, Effort 3 (likely a systematic fix — a shared `expectJson<T>()` test helper or narrower
`tsconfig` lib target — rather than 427 one-off annotations; needs investigation to confirm it's
one root cause, not 427 distinct ones. **Split further before executing** if investigation shows
multiple root causes). **Priority ≈ (4×6×1×0.7)/3 = 5.6.** Route: `gsd-quick` after a short
investigation spike to find the common root cause(s).

### 3. PTYCAP Phase 3+ (Governed-Automation Guard, Lifetime Counter/Kill Switch, Throwaway-Repo Proof)
Impact 9 (Core Value — the actual "governor" the product sells), Reach 10, Urgency 2, Confidence
0.6 (depends entirely on Phase 2 landing clean first — DIRECTIVE roadmap makes each phase depend on
the last), Effort 5 each (all three remaining phases before the roadmap's "proof" milestone are
individually Effort ≥3, several explicitly gated on Phase 4's lifetime counter existing before
Phase 3's automation guard can safely go even flag-gated-OFF). **Not schedulable yet** — blocked on
Phase 2 landing and CI-verified; re-score once that PR merges. Do not start Phase 3 work in
parallel with Phase 2 (same `hub/src/dispatch/gates.ts` surface, sequential dependency per
ROADMAP.md, would create merge conflicts and defeats the "prove it in order" design intent).

### 4. Open dependabot PRs
- #481 `@hono/zod-openapi` 0.18→0.19 (Impact 3, Reach 4, Urgency 1, Confidence 0.8, Effort 1 —
  low-risk minor/patch bump, but touches `hub/src/api/_openapi.ts` risk surface per its own
  changelog notes; verify CI, don't rubber-stamp given item #1's Hono-family findings above).
  **Priority ≈ (3×4×1×0.8)/1 = 9.6.**
- #486 Tauri Rust minor/patch group bump (Impact 2, Reach 3, Urgency 1, Confidence 0.8, Effort 1,
  Windows/Rust-only via GHA `supervisor-build`). **Priority ≈ (2×3×1×0.8)/1 = 4.8.**
Both are cheap and low-risk; worth clearing opportunistically (e.g. as a quick side-task alongside
item #1's Hono work) rather than as this iteration's headline item.

### 5. God-files (`dal.ts` ~2304 LOC, `agent.ts` ~1286, `telegram-webhook.ts` ~1197)
Impact 2 (CONCERNS.md's own disposition: "ACCEPT, split opportunistically... do NOT schedule a
refactor phase while higher items are open"), Reach 5, Urgency 1, Confidence 0.7, Effort 4+ (a real
split is multi-file and merge-conflict-prone by the files' own nature as the repo's contention
point). **Priority ≈ (2×5×1×0.7)/4 = 1.75.** Not scheduled; revisit opportunistically only when
already touching one of these files for an unrelated fix.

### 6. UI scan (never run under this DIRECTIVE yet)
Impact unscored (UX/UI dimension itself is unscored — no signal), Reach unscored. Due per §5's
cadence once any iteration touches `web/`; none has yet under this DIRECTIVE. Not urgent enough to
manufacture a UI-touching task just to trigger the scan — fold it into the next iteration that
naturally touches `web/`, or force one within `ui_full_scan_every` (3) iterations if none has by
then (this is iteration 2 of the counter; 1 to go before it's forced).

### 7. Coolify/prod log visibility gap
Not a scored item, a **capability gap**: this session had no Coolify MCP access exercised and no
prod DB/log access, so Reliability/Cost dimension scores above are partly "no bad signal found"
rather than "actively verified healthy." Impact of *closing this gap* (e.g. confirming Coolify MCP
lazy-launcher actually works from a routine session) would raise Confidence on several other scored
items. Flag for the next run to attempt the Coolify MCP connection early and report whether it
works at all — if it doesn't, that itself is worth a memlog request or a note here, not silent
acceptance.

## Not a priority (explicitly out of scope per DIRECTIVE hard lines)
- Any new milestone not on `.planning/PROJECT.md`'s Planned Milestones list.
- Flipping any of the flags/allowlists named in DIRECTIVE §10.
- Cutting a new supervisor release / pushing a `supervisor-v*` tag.
- Building the scheduled prompt's "fixed-core upgrade to v3.6" self-merge-policy proposal — see
  STATE.md's Governance note. Revisit only once issue #488 gets an owner response.
