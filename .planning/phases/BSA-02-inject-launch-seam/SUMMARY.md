# BSA-02-inject-launch-seam — SUMMARY

inject.ts maybeAutospawnOffline: gated AND-chain (orchestrator+autospawn ON, isBuild dev, allowlisted, supervisor online, !over token cap, !over launch cap) reuses launchSessionForUser + parks macro prompt in grace; any miss => unchanged no_session (4 no-op tests). dailyTokenCapGate added ALONGSIDE cost cap in the inject gate list. Tests: orchestrator-autospawn-inject.test.ts.

All OFF-by-default + inert until owner arms (allowlist + REMO_ORCHESTRATOR_AUTOSPAWN flip). Cost cap untouched; no API key on human PTY path.
