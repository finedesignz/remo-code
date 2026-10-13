# Milestone Summary: ONBOARD (Self-Serve Onboarding)

Status: PLANNED (item 7 in PROJECT.md Planned Milestones). Artifacts thin: one-line scope only.

## 1. Overview

A stranger self-serves: signup, install the MSI, pair, first session, first scheduled task.

## 2. Architecture (planned)

Depends on TENANT (per-user supervisor pairing). Existing pieces: Tauri first-run wizard writing `%APPDATA%\remo-code\supervisor.json`, per-user NSIS installer with auto-update, repo scan roots editor.

## 3. Phases

None defined.

## 4. Decisions

None recorded.

## 5. Requirements

None on disk.

## 6. Tech Debt / Risks

Memory notes past installer pitfalls (stale sidecar not overwritten, UTF-8 BOM in `supervisor.json` causing a silent crash-loop); onboarding must not regress these.

## 7. Getting Started

Read `supervisor/tauri/UPDATER-SETUP.md` and the supervisor wizard code under `supervisor/tauri/`.
