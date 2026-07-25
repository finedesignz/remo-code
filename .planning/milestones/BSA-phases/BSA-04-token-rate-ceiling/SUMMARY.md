# BSA-04-token-rate-ceiling — SUMMARY

Non-bypassable dailyTokenCapGate in gates.ts (real token_usage, tz-day boundary like the cost cap; default REMO_ORCHESTRATOR_DAILY_TOKEN_CAP=50M) + per-day launch-count cap (REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES=20). ADDED ALONGSIDE cost cap (never replaces). getTodayTokenTotal in token-usage-dal.ts. Closes the Max-subscription dollar-cap gap. Tests: orchestrator-token-cap.test.ts.

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
