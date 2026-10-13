# Milestone Summary: ASK (Session-Ask API)

Status: SHIPPED (PR #366 merged 2026-07-14; supervisor v0.14.0 #369; QC fixes #385 2026-07-21). Artifacts thin: `docs/session-ask.md` and `.planning/architecture/SESSION-ASK-API-SPEC.md` exist but were not read; summarized from CLAUDE.md + PR titles. Not listed in PROJECT.md.

## 1. Overview

External agent surface `/api/ext` so other agents (for example Claude Desktop scheduled tasks) can read a session's transcript tail and memory for free, and pay-ask a session a question.

## 2. Architecture

api_key auth with additive nullable `api_keys.scopes` (`ext:read`, `ext:ask`). FREE reads use read-only supervisor commands `session_transcript_tail` / `session_memory`. PAID `POST /api/ext/sessions/:id/ask` runs a stream-json ask-session on the target `project_dir`; the human PTY is never written to. Tables `session_asks` plus reaper (`REMO_ASK_MAX_MS`, 15 min). MCP server in `mcp/`.

## 3. Phases

Not recoverable. PRs: #366, #369, #371 (one-time-task integration), #373 (explicit scope), #377 (Docker build fix for the new `mcp` workspace), #385 (8 cross-model QC findings).

## 4. Decisions

- Gates: threshold, cost cap, token cap, human-only-PTY, `askRateGate` (default 10/hr).
- `api-keys` minting is cookie-auth only; an api key can never mint a key.
- Phase 4 (PTY-native ask) is owner-gated and not shipped.

## 5. Requirements

Not on disk in the files read.

## 6. Tech Debt

- Needs a new signed supervisor release for read commands.
- Docs still reference `humanOnlyPtyGate` as history after the PTYCAP-03 rename (cosmetic, per PTYCAP-03 verification).

## 7. Getting Started

`docs/session-ask.md`; tests around the ask parser and ext scope auth.
