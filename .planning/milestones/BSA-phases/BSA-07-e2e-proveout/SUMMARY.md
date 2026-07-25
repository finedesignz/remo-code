# BSA-07-e2e-proveout — SUMMARY

hub/test/e2e/orchestrator-autospawn.e2e.test.ts (REMO_E2E_DB_URL-gated): happy path (launch fired, autospawn-launch ledger row, parked, drain delivers, pr_url populated) + 5 gate no-ops. Reuses the existing InjectDeps DI seam; no production seam added.

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
