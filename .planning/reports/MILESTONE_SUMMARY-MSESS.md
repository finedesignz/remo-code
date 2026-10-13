# Milestone Summary: MSESS (Multiple Sessions per Repo / Worktree / Branch)

Status: PLANNED (scoped only, queued after PTYCAP, no phase work started). Artifacts: good for scope (`milestones/MSESS-REQUIREMENTS.md`, `MSESS-ROADMAP.md`, both dated 2026-07-13).

## 1. Overview

Owner request: N concurrent, independent sessions against the same repo, like N terminal tabs. Today session identity IS the directory: two hub unique indexes (`idx_sessions_user_project_unique`, `idx_sessions_user_repo_key`) and one supervisor dedupe collapse every start for a repo onto one row and one runner. MSESS moves identity from directory to session and adds caps that must exist before a spend amplifier ships. Gated on PTYCAP because N sessions multiply concurrent PTYs.

## 2. Architecture (planned)

Per-session handle in the `/ws/agent` protocol, supervisor hosting N runners per path, independent resume/teardown/reaping, per-repo and per-user caps, PTY token accounting across N PTYs, worktree-per-session default, explicit shared-tree risk acceptance (automation never drives a shared tree).

## 3. Phases (planned, 11)

01 identity-schema (hub-only); 02 agent-handle-protocol (hub-only); 03 supervisor-multi-runner (NEW MSI); 04 resume-and-liveness (NEW MSI); 05 caps-and-budget (hub-only); 06 pty-token-accounting (NEW MSI, depends on PTYCAP); 07 worktree-lifecycle; 08 shared-tree-risk; 09 ui-sessions-per-repo; 10 out-of-band-addressing; 11 prove-out-and-release. Phases 03, 04, 06 form one MSI release train.

## 4. Decisions (scoped)

- Three cases: A worktree-per-session (encourage), B same dir different branch (must be REFUSED, one HEAD), C same dir same branch N sessions (allow with eyes open).
- Ship caps (05, 06) before the UI "+" affordance (09); keep "+" behind a flag until they are live.
- Migrations use `msess_NNNN_slug` ids; `idx_sessions_orchestrator_unique` untouched.

## 5. Requirements

IDENT-01..07, MIGR-01..02, CAP-05 and others in `MSESS-REQUIREMENTS.md` (not exhaustively read).

## 6. Tech Debt / Risks

Biggest scope fork: whether worktree creation needs a new supervisor command (`git_worktree_add`), which would add Phase 07 to the MSI train. Decide in 07's discuss step.

## 7. Getting Started

Read both MSESS files; do not start Phase 06 before PTYCAP is green.
