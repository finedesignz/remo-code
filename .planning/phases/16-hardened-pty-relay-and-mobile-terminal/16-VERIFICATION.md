---
verdict: PARTIAL
render_fidelity: FAIL
mobile_reattach: FAIL
automated_suite:
  result: PASS
  command: "bun run check-baseline"
  summary: "pass=1181 skip=130 fail=0 total=1311"
  run_at: "2026-06-01T15:19:48.545Z"
term_relay_auth:
  result: PASS
  tests: [term-relay-auth, term-relay-human-guard, term-agent-inventory-auth, term-frame-direction-allowlist, term-ws-origin-guard, pty-runner-resume-identity]
  run_at: "2026-06-01T15:19:48.545Z"
manual_attestation:
  render_fidelity: { by: "", at: "", device_build: "" }
  mobile_reattach: { by: "", at: "", device_build: "" }
---

# Phase 16 — Ship Verdict (machine-emitted; do NOT hand-edit)

This artifact is EMITTED by `tools/emit-phase16-verdict.mjs`. The two automated
signals are bound to real `bun run check-baseline` / named-test exit codes; the two
manual signals require an operator attestation triplet (by + ISO-8601 at + device/build).
The Phase-17 `cutover-deletion-gate.mjs` consumes THIS file via the shared schema.
