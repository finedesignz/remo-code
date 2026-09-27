---
slug: cloud-sessions
status: complete
completed: 2026-09-27
commits: [4f9b35b, 5eafb22, bfc1933, 65009f6, 83abd55]
---

# Summary: chat with claude.ai cloud sessions from remo-code

Built all 5 planned tasks. Remo can now chat with a claude.ai cloud session while it stays in the cloud.

## What shipped
1. **Hub data + webhook** (`4f9b35b`): `sessions.cloud_session_id`, `token_usage.runner_type` accepts
   `'cloud'`, the explicit-only `cloud:hook` scope, `POST /api/cloud-hook/reply` (auto-links unknown
   ids) and `POST /api/sessions/cloud`.
2. **Send path** (`5eafb22`): the `send_message` cloud branch runs the cost + token caps, then
   `cloud_session.send` → supervisor `claude -p --cloud <id> --output-format json` with the message
   on stdin. The ack schema is in both `SupervisorInboundV2` and `AgentInbound`.
3. **Stop hook** (`bfc1933`): `tools/cloud-hook/remo-cloud-stop-hook.mjs` sends only the last turn,
   counts usage once per message id, uses a watermark so a resumed turn isn't posted twice, and
   always exits 0.
4. **Web** (`65009f6`): cloud sessions always use the chat surface, the header links to claude.ai,
   the sidebar has "Link cloud session", and Credentials can mint a `cloud:hook` key.
5. **Docs** (`83abd55`): `docs/cloud-sessions.md`, a CLAUDE.md docs-map row, and OpenAPI via `docs:sync`.

## Verification
- **CLI 2.1.283:** `--cloud <id> --output-format stream-json` is rejected. The stdin form of
  `-p --cloud` returns JSON `{ok:false,…}` and exits 1, which matches the parser.
- **New tests:** 38 across 4 files (cloud-hook 11, cloud-send hub 7, cloud-stop-hook 9, supervisor
  cloud-send 13). mount-order, api-keys-scopes and token-cap-coverage pass.
- **check-baseline:** 0 failures. The skip total (259 > 256) is identical on the pre-change commit,
  so it comes from the environment (no DB).
- **Real Postgres 16:**
  - The old schema upgrades to the new one, and a re-run is idempotent.
  - The constraint was widened.
  - A 4-way concurrent link produced 1 row.
  - Ingest wrote the message and a `runner_type='cloud'` usage row.
  - A soft-deleted link can be re-created.
- The hook script was run end-to-end against a mock hub: it posted once, and a second firing posted nothing.
- **Build and types:** the web build (`tsc -b` + vite) passes. The hub tsc error count went from 430
  to 428 (no new errors).

## Not done / follow-ups
- **Creating new cloud sessions from remo:** not built, because checking the output of
  `--cloud "task"` would need a real session.
- **Needs a signed supervisor MSI** for `cloud_session.send`.
- **Pre-existing bug (not fixed):** `run_started`/`run_output`/`run_finished` are missing from
  `AgentInbound`, so `/ws/agent` drops them (`runSupervisorReadCommand` and the TEAB replies time out).
