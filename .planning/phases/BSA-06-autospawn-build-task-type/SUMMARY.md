# BSA-06-autospawn-build-task-type — SUMMARY

Confirmed BSA-02 wires isBuild=macro_task_type==='dev' end-to-end; +2 regression tests (dev=>autospawn-eligible, non-dev=>none). Operator one-shot hub/scripts/create-autospawn-build-task.ts (idempotent, --dry-run, allowlists a repo + marks a session's task dev; enables NO gate; prints flip steps).

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
