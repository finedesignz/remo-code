---
phase: 09-connections-overhaul
verified: 2026-05-30T00:00:00Z
status: passed
score: 5/5 goals verified
verdict: SHIP
build_gates:
  build_web: pass
  grep_indigo_web_src: 0
  supervisor_ui_tsc: clean
  cargo_check: deferred (toolchain absent in sandbox)
---

# Phase 09 — Connections Overhaul — Verification Report

**Goal:** Settings/Connections overhaul — remove root-paths card, fold orchestrator into
a pinned repo row, single responsive repo table, InfoTip descriptions, supervisor first-run
wizard (hub URL + key + ≥1 root).
**Verified:** 2026-05-30 (independent QC, no code edits)
**Verdict:** SHIP

## Goal Verification (R-CONN-01..05 + PLAN Phase 2)

| # | Goal | Status | Evidence |
|---|------|--------|----------|
| 1 | Root-paths card REMOVED (no RootsEditor) | PASS | `web/src/pages/settings/ConnectionsTab.tsx` — entire file is SupervisorPage + RevanoteLink only; no `RootsEditor`. Grep `RootsEditor` across `web/src` = 0 matches. |
| 2 | Orchestrator tab DELETED + relocated; `/api/orchestrator` kept | PASS | `OrchestratorTab.tsx` GONE (absent from `web/src/pages/settings/`). `SettingsPage.tsx:28` enum `"connections"|"credentials"|"prompts"|"usage"|"profile"` — no `orchestrator`. `readSettingsTab()` (:30-41) returns `connections` for unknown/`orchestrator`. `handleTabChange` (:70-76) same fallback. Orchestrator now pinned FIRST row: `SupervisorPage.tsx:613-619` `<OrchestratorRow .../>` before `rows.map`. Controls wired to `/api/orchestrator` GET (`useOrchestrator` :762), PUT enable/disable (:787), `/start` (:788), `/stop` (:789). `hub/src/api/orchestrator.ts` EXISTS (not deleted). |
| 3 | Single responsive repo renderer + filters/icons retained | PASS | Single `RepoRow` (:706-744) — no duplicated desktop-grid/mobile-card blocks, no `md:` dual-block. Consolidated metadata cell (:719-735: name+icon, branch·status·last-seen, truncated path subline w/ tooltip). Icon-only `IconBtn` actions w/ `title`+`aria-label` tooltips (:679-687, RowActions :689-702). `divide-y divide-[var(--border-color)]/40` (:613). No mobile row-wrap (truncate/`md:hidden` inline fold, :732). Folder/GitHub icons (:722-724), All/Repos/Folders type filter (:573-581), All/Running/Idle filter (:562-570) retained. |
| 4 | Inline descriptions → ui/InfoTip in Connections | PASS | `ConnectionsTab.tsx:10` imports `InfoTip`; Revanote description rendered via `<InfoTip content=.../>` (:33). No leftover helper `<p>` description / native `title=` where InfoTip fits in Connections. (Note: `title=` retained on icon buttons/status dots in SupervisorPage = correct tooltip usage, not inline descriptions.) |
| 5 | Supervisor first-run wizard + set_hub_url Rust cmd | PASS | `OnboardingPage.tsx`: editable hub URL input default `https://app.remo-code.com` (:24,:127-139), API key input (:148-157), ≥1 root via `add_root` (:82-94). `canFinish = hubUrlValid && apiKeySet && roots.length > 0` (:97); "Finish setup" `disabled={!canFinish||busy}` (:201). `App.tsx` gates: `needsOnboarding = !s.api_key_set || roots.length===0` (:29), renders `<OnboardingPage>` when true (:46-47). `set_hub_url` in `runtime_cmds.rs:291` — validates http(s) scheme + non-empty host (:298-308), mirrors `set_api_key` read-modify-write (:314-318), restarts sidecar (:321). Registered in `lib.rs:88` invoke_handler. |

## Build Gates

| Gate | Result | Evidence |
|------|--------|----------|
| `bun run build:web` (worktree root) | PASS | tsc -b + vite build clean; 393 modules, built in 2.08s (only the pre-existing >500kB chunk-size advisory). |
| `grep -rn indigo web/src` | PASS (0) | Grep count = 0 across `web/src`. |
| supervisor ui `tsc -b` | PASS | `./node_modules/.bin/tsc -b` exit 0, no diagnostics. |
| `cargo check` (Rust) | DEFERRED | Toolchain absent in sandbox. `set_hub_url` verified by reading: mirrors `set_api_key`, validates http(s)+host, registered in `invoke_handler`. Defer compile to release-time `cargo check` — NOT a blocker. |

## Anti-Patterns

None blocking. Only the pre-existing vite chunk-size advisory (informational).

## Ship Verdict

**SHIP.** web build passes, indigo=0, supervisor ui tsc clean, all 5 goals met. Rust compile
deferred to release-time `cargo check` per sandbox constraint (code reads correct).

---
_Verified: 2026-05-30 · Verifier: Claude (gsd-verifier, independent QC)_
