# Local Agent

The `remo-code-agent` package (`agent/`) runs on the developer's machine and
streams Claude Code / Codex activity to the hub. See `CLAUDE.md` for the
architecture overview.

## Subscription quota polling

On startup AND every 5 minutes the agent polls Anthropic's Claude subscription
quota endpoint and reports the result to the hub:

```
GET https://api.anthropic.com/api/oauth/usage
Headers:
  Authorization: Bearer <accessToken from ~/.claude/.credentials.json>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-code/2.0.15
  Accept: application/json, text/plain, */*
  Content-Type: application/json
```

Response shape (Zod-validated on both sides):

```ts
{
  five_hour: { utilization: number, resets_at: string },
  seven_day: { utilization: number, resets_at: string },
  seven_day_opus?: { utilization: number, resets_at: string } | null,
  seven_day_oauth_apps?: { utilization: number, resets_at: string } | null
}
```

The access token is **re-read from `~/.claude/.credentials.json` on every
tick** — Claude Code refreshes it on its own and we never cache. Failures
(missing file, 401, network, malformed JSON, schema mismatch) are logged at
WARN level and the next tick retries; the agent never crashes on a poll
failure.

On a successful poll the agent sends:

```ts
{ type: 'usage_report', usage: { ...above... } }
```

The hub:

1. Validates against `AgentUsageReport` in `hub/src/ws/agent-protocol.ts`.
2. Stores the latest snapshot per `user_id` in an in-memory map
   (`hub/src/usage/store.ts`) — cleared on hub restart, re-converges within
   5 minutes.
3. Broadcasts `subscription_usage` to all of that user's connected web
   clients via `broadcastToUser`.
4. On a new client WS auth, sends the current snapshot once (if any).

The web UI subscribes via `useSubscriptionUsage` (`web/src/hooks/`) and
renders the inline 5h+7d strip in `Layout.tsx` (`UsageStrip.tsx`). While no
snapshot has arrived yet (e.g. first 5 minutes after agent connect) the
strip shows a subtle `—` placeholder rather than stale data.

The legacy `GET /api/profile/cost-today` endpoint is unchanged — it still
powers the per-user daily cost cap visible in Settings. Only the visual
strip in the header was replaced.

## Implementation files

- `agent/src/usage-poller.ts` — fetch + Zod-equivalent runtime validation +
  interval handle. Wired in `agent/src/index.ts`.
- `agent/test/usage-poller.test.ts` — unit tests with mocked fetch.
- `hub/src/usage/store.ts` — per-user in-memory snapshot store.
- `hub/test/usage-store.test.ts` — unit tests.
- `hub/src/ws/agent-protocol.ts` — `AgentUsageReport` Zod schema.
- `hub/src/ws/agent.ts` — `usage_report` handler.
- `hub/src/ws/client.ts` — sends current snapshot on client auth.
- `hub/src/ws/protocol.ts` — `subscription_usage` outbound type.
- `web/src/hooks/useSubscriptionUsage.ts` — WS subscriber hook.
- `web/src/components/UsageStrip.tsx` — replaces the old cost-today strip.
