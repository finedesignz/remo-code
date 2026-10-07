# Cloud sessions

Chat with a **claude.ai cloud session** (`cse_…`) from remo-code while the session keeps running in
the cloud. Nothing is teleported. The session stays on Anthropic's VM; remo sends messages into it
and receives its replies.

## Why it's built this way (verified 2026-09-27, CLI 2.1.283)

| Need | What the CLI offers |
|---|---|
| Send a message | `claude -p --cloud <id> --output-format json` (message on stdin) queues it and exits: `{ok, session_id, url}` or `{ok:false, error}` ([docs](https://code.claude.com/docs/en/claude-code-on-the-web#send-follow-ups-from-the-cli)) |
| Stream replies back | **Not available.** `--output-format stream-json` with `--cloud <id>` fails: `--cloud <session_id> does not support --output-format stream-json`. No public API or WebSocket reads a cloud session. |
| Run code at the end of each turn | Stop hooks run inside cloud sessions, and the hook env has `CLAUDE_CODE_REMOTE_SESSION_ID=cse_…` |

So the return path is a **Stop hook inside the cloud session** that POSTs each finished turn to the hub.

## Flow

```
web send_message ──► hub (client.ts, cloud branch)
                       │ daily cost cap + token cap   (hub/src/cloud/send.ts)
                       ▼
                     supervisor  cloud_session.send ─► claude -p --cloud <id>  (stdin = message)
                       ▲ cloud_session.send_ack {ok, error}
                                                        │ queued
                                                        ▼
                                              claude.ai cloud session runs the turn
                                                        │ Stop hook
                                                        ▼
hub POST /api/cloud-hook/reply ◄── tools/cloud-hook/remo-cloud-stop-hook.mjs
  → assistant message + broadcast + usage (token_usage.runner_type='cloud')
```

## Pieces

| Piece | Where |
|---|---|
| Link column | `sessions.cloud_session_id` (nullable; partial unique on `(user_id, cloud_session_id)`). Non-NULL ⇒ cloud session |
| Link route | `POST /api/sessions/cloud {cloud_session_id, name?}`, which takes an id or a claude.ai/code URL. Idempotent |
| Send | `hub/src/ws/client.ts` cloud branch → `hub/src/cloud/send.ts` → supervisor `cloud_session.send` → `supervisor/src/commands/cloud-send.ts` |
| Receive | `POST /api/cloud-hook/reply` (`hub/src/api/cloud-hook.ts` → `hub/src/cloud/ingest.ts`) |
| Hook | `tools/cloud-hook/remo-cloud-stop-hook.mjs` + `tools/cloud-hook/settings.example.json` |
| Web | Cloud sessions always use the chat surface (no PTY); header links to claude.ai; sidebar "Link cloud session" |

## Setup

1. **Mint a hook key.** Settings → Credentials, new key with **only** the `cloud:hook` scope.
2. **Cloud environment** (claude.ai → your environment's settings):
   - Env vars: `REMO_HUB_URL=https://app.remo-code.com` and `REMO_CLOUD_HOOK_KEY=<the key>`.
   - Network access must allow `app.remo-code.com` (Custom access; it is not on the Trusted default list).
3. **Repo**: copy `tools/cloud-hook/remo-cloud-stop-hook.mjs` into the repo (same path) and merge
   `tools/cloud-hook/settings.example.json` into the repo's `.claude/settings.json`. Commit and push.
   The hook is a no-op locally (no `CLAUDE_CODE_REMOTE_SESSION_ID`) or when the env vars are unset.
4. **Supervisor host** must be signed in with a claude.ai account (`claude auth login`). An API key
   can't use `--cloud`. The org's `allow_remote_sessions` policy must be on.
5. Link a session in the web UI, or just let the cloud session finish a turn. An unknown
   `cloud_session_id` is **auto-linked** to a new remo session named `Cloud <id suffix>`.

## Behaviour and limits

- **Whole turns only**: no streaming, thinking or tool events. The reply lands when the turn ends.
- **Text only**: images and attachments are refused (`cloud_text_only`).
- **Caps**: every send runs `dailyCostCapGate` + `dailyTokenCapGate` first. The hook's reported usage
  (summed once per message id) is recorded as `runner_type='cloud'`, so cloud turns count against the
  same caps. Cost is a list-price estimate.
- **Supervisor choice**: any online supervisor of the user can send. Offline or timeout falls through
  to the next one; a CLI rejection (archived session, policy off, not found) is returned to the sender
  as `send_refused`. **Needs a new supervisor build**: an old supervisor has no handler and times out.
- **Resumed turns**: another Stop hook (e.g. the cloud git check) may block and resume a turn, so the
  hook can fire twice. A per-session watermark (`$TMPDIR/remo-cloud-hook-<id>.json`) makes each
  firing post only new messages.
- **Session status**: sends set `thinking`, a reply sets `online`. Cloud sessions are always listed as
  active (no supervisor-hosted runner backs them).

## Trust

- The hook key has one power: post replies for its owner. `cloud:hook` is **explicit-only**
  (`hasExplicitScope`); a legacy NULL-scopes key (including the supervisor's own) is refused.
- The posted text comes from inside the cloud VM. It is stored and shown as an assistant message
  (data) and is never executed or routed as an instruction. A forged post can only put text into the
  key owner's own sessions and count tokens against the owner's own caps.
- The message goes to the CLI on **stdin**, never argv, so a message starting with `-` can't become a
  flag. The spawn env goes through `sanitizeSpawnEnv` (no provider key, no deploy credential).
