# Milestone Summary: WORK (Inbound-Email Work, remo_work)

Status: SHIPPED (PR #368 merged 2026-07-14). Artifacts thin: `docs/remo-work.md` exists but was not read; summarized from CLAUDE.md + PR titles. Not listed in PROJECT.md.

## 1. Overview

`POST /api/ext/work`: an inbound client email drives a repo's agent session to propose a change to a live client website, with a hub-controlled QC and gated publish. Principle: the agent proposes, the hub disposes.

## 2. Architecture

Agent authority ends at a pushed `work/<nonce>` branch (no deploy credentials in its env, `scrubDeployCredentials`). The hub verifies the diff stays under `work_sites.site_dir`, runs the build, probes HTTPS, and performs merge + Coolify deploy itself (`hub/src/work/publish.ts`, `mayPublish`). Audit table `work_runs`.

## 3. Phases

Not recoverable. PRs: #368, #371 (one-time tasks), #373 (`ext:work` needs explicit scope), #385 (QC fixes).

## 4. Decisions

- Every gate is code, not prompt: default-empty `work_repo_allowlist`, `client_emails` sender allowlist, hub-verified diff scope/build/HTTPS, `auto_publish` default FALSE.
- `published=true` only on a hub-performed deploy.

## 5. Requirements

Not on disk in the files read.

## 6. Tech Debt

New supervisor MSI required (`work_diff_scope`, `work_build`, `work_publish`). Client-email class of work is also governed by the owner's outbound rules.

## 7. Getting Started

`docs/remo-work.md` section 1 (code-enforced vs advisory gates).
