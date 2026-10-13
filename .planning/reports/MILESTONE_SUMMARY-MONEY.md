# Milestone Summary: MONEY (Billing, Plans, Entitlements)

Status: PLANNED (item 6 in PROJECT.md Planned Milestones). Artifacts thin: one-line scope only.

## 1. Overview

Titanium Licensing billing, plans, entitlements, and the paid tier.

## 2. Architecture (planned)

Auth + billing for all owner apps is meant to run through Titanium Licensing (root CLAUDE.md routing). Hub already mirrors Titanium `license_status` on `users`.

## 3. Phases

None defined.

## 4. Decisions

Pricing hypothesis (PROJECT.md): team tier about $99-200/seat for fleet ops and governance; open-core line defined under GOV.

## 5. Requirements

None on disk.

## 6. Tech Debt / Risks

Demand is unvalidated. PROJECT.md says run the waitlist test before building MONEY.

## 7. Getting Started

Run the demand test first; then scope entitlements against the GOV paid-feature list.
