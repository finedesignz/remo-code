# BSA-03-repo-allowlist — SUMMARY

orchestrator_autospawn_allowlist table (idempotent DDL, no backfill) + isRepoAutospawnAllowed (empty=>false, fail-closed) / addRepoToAutospawnAllowlist in orchestrator-rows-dal.ts. Tests: orchestrator-autospawn-allowlist.test.ts.

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
