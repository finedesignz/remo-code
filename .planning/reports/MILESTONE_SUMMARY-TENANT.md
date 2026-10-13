# Milestone Summary: TENANT (Real Multi-Tenancy)

Status: PLANNED (item 5 in PROJECT.md Planned Milestones). Artifacts thin: one-line scope only.

## 1. Overview

Retire `TITANIUM_BYPASS`, make magic-link work, add per-user supervisor pairing, and prove tenant isolation.

## 2. Architecture (planned)

Current state per PROJECT.md memory and CLAUDE.md: `TITANIUM_BYPASS` is `true` in prod, prod login is legacy bcrypt (magic-link 503s under bypass), one real account. All queries are already scoped by `user_id`. `/ws/agent` is keyed by `api_keys`, not licenses.

## 3. Phases

None defined.

## 4. Decisions

None recorded.

## 5. Requirements

None on disk. Reference: `docs/auth.md`.

## 6. Tech Debt / Risks

Isolation has never been proven with more than one real tenant (inferred from "only account" in memory index).

## 7. Getting Started

Read `docs/auth.md` and the legacy phase 07 `titanium-auth-cutover` ROLLOUT / TEST-MATRIX docs under `milestones/legacy-phases/`.
