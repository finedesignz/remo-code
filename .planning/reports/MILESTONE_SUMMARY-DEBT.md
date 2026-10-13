# Milestone Summary: DEBT (Retire Half-Live Flags)

Status: PLANNED (item 9 in PROJECT.md Planned Milestones). Artifacts thin: one-line scope only. Some listed items may already be done (see below).

## 1. Overview

Retire half-live flags: legacy waves, ChatSurface / cutover gate, TEAB MSI, mobile.

## 2. Architecture (planned)

No design. Inventory from PROJECT.md and CLAUDE.md.

## 3. Phases

None defined.

## 4. Decisions

None recorded.

## 5. Requirements

None on disk.

## 6. Tech Debt / Risks

Evidence conflict: PROJECT.md BLEED entry says `REMO_ORCHESTRATOR_LEGACY_WAVES` is already fully deleted (zero references in `hub/src`), so the "legacy waves" item is probably done. Remaining: ChatSurface deletion gated on `tools/cutover-deletion-gate.mjs` attestations; TEAB needs a signed MSI; mobile Tauri client paused since 2026-05-28.

## 7. Getting Started

`docs/cutover-gate-june15.md`, `docs/phase-12-pause-state.md`, `docs/teab-tasks.md`.
