# Self-Heal Integration

The external **claude-code-self-heal** service (port 9114 per global CLAUDE.md) launches a fresh Claude Code session whenever it detects a crash. Phase 04 plan 008 introduces a thin HTTP contract so self-heal no longer needs to know where Claude runs — the hub picks a target supervisor deterministically and dispatches the session for it.

Self-heal is **the consumer** of this endpoint. This document is the contract.

---

## Endpoint

```
POST https://app.remo-code.com/api/sessions/heal
```

JWT-authenticated (same JWT the web app uses — `Authorization: Bearer <jwt>`).

### Request body

```json
{
  "repo": "/abs/path/to/repo",      // required
  "branch": "main",                  // required
  "prompt": "Resume the work...",   // required, the initial Claude prompt
  "model": "claude-opus-4-7",       // optional
  "exclude_supervisor_ids": ["sup_abc"]  // optional, see Retry semantics below
}
```

All four required fields must be non-empty. `repo` ≤ 500 chars, `branch` ≤ 200 chars, `prompt` ≤ 20 000 chars.

### Response — success (202)

```json
{
  "session_id": "run_xxx",
  "target_kind": "supervisor",          // or "local_agent"
  "supervisor_id": "sup_xxx",           // only present when target_kind === "supervisor"
  "url": "/s/run_xxx"
}
```

`url` is a hub-relative path the caller can open / link the user to (`${REMO_PUBLIC_URL}${url}`).

### Response — error

| Code | `error` value             | Cause                                                                                |
| ---- | ------------------------- | ------------------------------------------------------------------------------------ |
| 400  | `invalid_input`           | Zod body validation failed. `detail` contains the first issue message.               |
| 401  | (auth middleware)         | Missing / invalid / expired JWT.                                                     |
| 503  | `no_target_available`     | No supervisor with capacity, no local agent connected. Caller should back off & retry. |
| 503  | `no_target_available` + `reason: "all_dispatches_failed"` | Every supervisor we tried failed at the WebSocket write step (≤3 hops). |

The hub itself does internal retry-with-exclude on WS dispatch failure (up to 3 hops), so callers do not need to re-call with `exclude_supervisor_ids` for transient dispatch errors — only when they have an independent reason to avoid a specific supervisor.

---

## Resolution order

The hub picks a target in this exact order (matches `ARCHITECTURE-REVIEW.md` §6):

1. The user's `preferred_supervisor_id` if it is online (in-memory WS registry **and** `last_seen_at` within 90s) **and** has capacity (`reserveSessionSlot` returns ok).
2. Otherwise, the first online supervisor ordered by `last_seen_at ASC` (deterministic — oldest-connection first) where `reserveSessionSlot` returns ok.
3. Otherwise, the first locally-connected agent for the user (any `/ws/agent` channel currently registered for `userId`).
4. Otherwise, **503 `no_target_available`**.

The slot reservation in steps 1 and 2 is **atomic** with the selection itself — two concurrent heal calls competing for the last slot will see exactly one 202 and one 503. No double-spend possible.

---

## Retry semantics

If the hub picks supervisor X and the WebSocket write fails (e.g. the supervisor disconnected mid-call), the hub:

1. Ends the partially-created `session_runs` row with `exit_reason: dispatch_failed: <err>`.
2. Releases the reserved slot.
3. Adds X to its internal exclude list.
4. Re-runs `pickSessionTarget`, up to `HEAL_MAX_HOPS = 3` total attempts.
5. If still no success after 3 hops, returns **503 `no_target_available`** with `reason: "all_dispatches_failed"`.

Callers MAY also pass `exclude_supervisor_ids` in the request body to force-skip specific supervisors — useful when self-heal has independent telemetry that a supervisor is unhealthy.

---

## Example

```bash
curl -X POST https://app.remo-code.com/api/sessions/heal \
  -H "Authorization: Bearer $REMO_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "/srv/repos/finedesignz/kh-hub",
    "branch": "main",
    "prompt": "Resume the failing build investigation."
  }'
```

Successful response:

```json
{
  "session_id": "run_01HX3...",
  "target_kind": "supervisor",
  "supervisor_id": "sup_01HX2...",
  "url": "/s/run_01HX3..."
}
```

---

## Local-fallback proving period (DO NOT migrate yet)

Per `ARCHITECTURE-REVIEW.md` "Do NOT" list: self-heal continues to fall back to the existing local-agent path during a **2-week proving period** after this endpoint ships. Concretely:

- Self-heal SHOULD continue to use its current local launch path as the primary code path for the first two weeks after the supervisor stack is deployed.
- After two weeks of stable supervisor operation in production, self-heal can flip its primary call site to `POST /api/sessions/heal` and treat the local launcher as the fallback.
- Do **not** rip out the local launcher before the proving period closes — it is the rollback path if the supervisor stack misbehaves.

Coordinate the cut-over with the user before flipping primary/fallback.

---

## See also

- `docs/coolify-supervisor.md` — supervisor-side setup (Coolify deployment, API key, host_resources reporting).
- `.planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md` §6 — the design rationale.
- `hub/src/sessions/routing.ts` — the `pickSessionTarget` implementation; this endpoint is one of two callers (the other being the scheduler dispatcher, plan 04-003).
- `hub/test/self-heal-routing.test.ts` — contract tests (race, fallthrough, exclude, capacity).
