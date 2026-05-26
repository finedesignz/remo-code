---
status: investigating
trigger: "I cannot connect new servers"
created: 2026-05-25
updated: 2026-05-25
---

## Current Focus

hypothesis: PR #35 (commit 57ab969) regressed connect-new-servers UX by promoting `npx remo-code-supervisor install` as the primary command. That command requires the user to manually download nssm.exe before it succeeds — modal does not mention this prereq → users get stuck.
test: ran `npx remo-code-supervisor install --api-key X --roots Y` on a fresh machine → reproducibly stops at "[install] NSSM not found ... Please download NSSM from https://nssm.cc/..."
expecting: ConnectModal needs updating; supervisor install should ideally auto-download NSSM
next_action: write surgical fix — restore the working command as primary OR call out NSSM requirement; alternative best-fix is to make nssm-installer.ts auto-download

## Evidence

- 2026-05-25: Coolify hub logs (400 lines) show ZERO supervisor auth attempts in window. Only `[agent] authenticated ... cli=claude reused=true` from an existing session. Users not reaching WS auth = stuck client-side.
- 2026-05-25: `npx remo-code-supervisor install ...` on clean dir reproduces NSSM-missing wall. Service does not install.
- 2026-05-25: ConnectModal.tsx:18 (post-#35) primary command = `npx remo-code-supervisor install ...`. Pre-#35 (git show 57ab969^) primary = `npx remo-code-agent ...` which works out-of-the-box.
- 2026-05-25: hub/src/ws/agent.ts:112-120 has `AgentInbound.safeParse` with `console.warn` on reject — no such warnings in logs → not a schema-reject issue. (cli_kind is optional via `(msg as any).cli_kind ?? 'claude'` at line 169 — verified permissive.)
- 2026-05-25: hub/src/db/supervisor-dal.ts:5-23 — supervisor capability check is permissive ("Treat unknown/empty caps as legacy") — not gating real users.

## Resolution

root_cause: PR #35 promoted `npx remo-code-supervisor install` to primary connect command, but that command has an undocumented prereq (manual NSSM download) the modal doesn't surface. Users hit the wall and conclude the service is broken.
fix: TBD — pending implementation
files_changed: []
verification: TBD

## Symptoms

expected: user can connect a new agent/supervisor to the hub via "connect new server" flow
actual: connection fails
errors: unknown — need to pull logs
reproduction: user attempts to connect a fresh server
started: recent (post Phase 04/05/06 merges)

## Eliminated

## Evidence

## Resolution

root_cause:
fix:
files_changed: []
verification:
