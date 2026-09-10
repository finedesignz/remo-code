# BSA-08-docs-and-gated-flip-runbook — SUMMARY

docs/auto-dev-orchestrator.md BSA section, CLAUDE.md env knobs + token-cap invariant, new docs/orchestrator-autospawn-runbook.md (owner GO/NO-GO flip: allowlist->dev task->token caps->flip REMO_ORCHESTRATOR_AUTOSPAWN=1->monitor routine_run_log/pr_url->rollback). docs:sync: no drift.

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
