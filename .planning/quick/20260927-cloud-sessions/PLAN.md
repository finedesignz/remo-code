---
slug: cloud-sessions
created: 2026-09-27
mode: quick
branch: claude/happy-rubin-m4mr90
---

# Quick: chat with a claude.ai cloud session from remo-code (session stays in the cloud)

## Verified facts (CLI 2.1.283, 2026-09-27)
- `claude -p "<msg>" --cloud <cse_id> --output-format json` queues ONE message and exits → `{ok, session_id, url}`.
- `--output-format stream-json` with `--cloud <id>` is rejected: `Error: --cloud <session_id> does not support --output-format stream-json`.
- No public API streams a cloud session's replies. Stop hooks DO run inside cloud sessions, and the hook
  env carries `CLAUDE_CODE_REMOTE_SESSION_ID=cse_…`.

## Design
Send = supervisor spawns `claude -p … --cloud <id>`. Receive = a Stop hook in the cloud session POSTs
each finished turn to a hub webhook, which injects it as an assistant message.

## Tasks (one atomic commit each)
1. **Hub data + webhook** — `sessions.cloud_session_id` (idempotent DDL + partial unique index);
   `token_usage.runner_type` accepts `'cloud'`; new explicit-only scope `cloud:hook`;
   `POST /api/cloud-hook/reply` (public, Bearer key, zod, auto-link unknown session, assistant-message
   fan-out, usage → `token_usage`); `POST /api/sessions/cloud` link route; mount/skip lists; tests.
2. **Send path** — hub `send_message` branch for cloud sessions (cost + token cap, supervisor
   `cloud_session.send` req/ack, status thinking); supervisor handler (argv array, id regex,
   sanitized env, timeout); protocol schemas in BOTH `SupervisorInboundV2` and `AgentInbound`; tests.
3. **Hook script** — `tools/cloud-hook/remo-cloud-stop-hook.mjs` (no deps, always exit 0) +
   `settings.example.json`; unit test for transcript parsing.
4. **Web** — cloud sessions render the chat surface even when PTY is on; "Open on claude.ai" link;
   `cloud:hook` scope in Credentials.
5. **Docs** — `docs/cloud-sessions.md`, CLAUDE.md docs-map row, `bun run docs:sync`.

## Out of scope
- Creating new cloud sessions from remo-code (can't verify `--cloud "task"` output without creating a real one).
- The pre-existing `run_*` frames missing from `AgentInbound` bug (report only).
