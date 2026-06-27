# 15-01 SUMMARY — PTY spawn + canary (Plan 01)

**Status:** COMPLETE. Commit `feat(supervisor): Phase 15 Plan 01`.

## Built
- `supervisor/src/runners/claude-pty-runner.ts` — raw-bytes-only interactive `claude` PTY runner.
  Injectable host-spawn (`ptySpawn`) seam (test-only `__setHostSpawnForTest`); idempotent `kill()`;
  strips `ANTHROPIC_API_KEY`; empty argv; NO RunnerEvent/agent-protocol/session-bridge/credentials import.
- `supervisor/src/runners/pty-host.mjs` — Node ConPTY host (required because node-pty can't run under Bun
  on Windows — see SPIKE-FINDINGS). Frame protocol over stdio; deletes `ANTHROPIC_API_KEY`; dead-man's-
  switch (stdin-end + parent-PID poll).
- `node-pty ^1.1.0` declared in `supervisor/package.json` (prebuilt win32-x64 ConPTY; no compile).

## Tests (all green)
- `no-api-key-no-streamjson-pty.test.ts` — grep canary (secondary), constraints 1+5.
- `pty-runner-env.test.ts` — env-strip unit.
- `pty-spawn-interception.test.ts` — **behavioral** harness (H6/R-PTY-26): intercepts real
  `{file,argv,env}`, asserts file=`claude`, empty argv, no API key even when `process.env` sets it.
- `pty-orphan-teardown.test.ts` — kill reaps host+child; parent-PID dead-man's-switch reaps on parent death.

## Key finding
node-pty LOADS under Bun on Windows but PTY I/O throws `ERR_SOCKET_CLOSED` (node:net named-pipe socket
unsupported). Same binary works under Node → helper-process model (approach b). Full record in SPIKE-FINDINGS.
