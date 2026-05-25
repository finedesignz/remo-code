# Phase 04 — Coolify Dev Supervisor — Architecture Review

**Reviewer:** Backend Architect
**Date:** 2026-05-25
**Status:** Opinionated. Incorporate before planning.

## TL;DR

- **Multi-session model:** Path (A) — **one agent container, N child Claude processes**, with per-session git worktrees. Reuse the existing `claude-runner.ts` per child. Coolify-per-session (B) is the wrong shape: it inflates idle RAM 5–10x, hides crashes from the hub, and duplicates auth state across containers.
- **The agent we deploy to Coolify is the existing supervisor role**, not a new artifact. It already auths with `role: 'supervisor'`, already reports `agent_info` (cpu_cores, total_mem_bytes), already spawns child agents on demand. The new work is: containerize it, make it report a live concurrency budget, and gate session creation against that budget at the hub.
- **Hub is authoritative on concurrency.** Web UI shows the budget; hub enforces it. Per-supervisor counter, broadcast on change.
- **Auth:** `ANTHROPIC_API_KEY` env in the container is the only sane default. Mounted `~/.claude` from a host login works but bricks on token refresh. Document the trade-off; ship API key.
- **Self-heal routing:** add a per-user `preferred_supervisor_id` setting on the hub, fall back to "first online supervisor" if unset, last resort local.
- **Cost cap:** lift the scheduler's daily-cost-cap into a hub-wide per-user cap that covers ALL sessions (interactive + scheduled + self-heal). The scheduler keeps its own check but reads the same counter.

---

## 1. Multi-Session Model — Recommendation: Path (A)

### The fork
- **(A) One supervisor container, N children.** Supervisor multiplexes. Spawns a child agent process per session, each with its own persistent `claude` subprocess and its own git worktree.
- **(B) N agent containers via Coolify.** Each container is a one-Claude-per-project_dir worker. Coolify orchestrates.

### Recommendation: **(A)** — and it's almost already built.

The supervisor role (`supervisor-protocol.ts`, `role: 'supervisor'`) was shipped May 22 specifically to spawn child agents and stream their state back to the hub. The `--initial-prompt` flag exists. The hub already routes per-session messages. **This is path (A) by another name.** The new work is: containerize it, expose a host-resource budget, and run it on Coolify.

### Why (A) over (B)

| Concern | (A) one container, N children | (B) N containers |
|---|---|---|
| Code reuse | High — child = current `claude-runner.ts`, supervisor = current spawner | Medium — needs Coolify API plumbing |
| Idle RAM per session | ~80–150 MB (one bun + one claude) | ~400–600 MB (full container) |
| Cold start | <2s (fork process) | 10–30s (image pull + container start + WS auth) |
| Crash blast radius | One child dies, supervisor reports + respawns | Whole container dies, Coolify restarts (slower) |
| Repo collision | Solved by per-session worktree | Solved by per-container volume (more disk) |
| Observability | Single supervisor WS → hub sees everything | N WS connections, harder to aggregate budget |
| Concurrency control | In-process counter, instant | Hub asks Coolify "how many containers running?" — eventually consistent |
| Anthropic auth | One `ANTHROPIC_API_KEY` env, shared by all children | Same key duplicated into N containers |
| Worktree isolation | `git worktree add` per session, shared `.git` | Full clone per container (3–10x disk) |

**The one case for (B):** if a child Claude can wedge the host (runaway memory, fork bomb), container isolation matters. Mitigation in (A): per-child `ulimit` / cgroup via `systemd-run --scope` or `bwrap`. Not perfect, but the user is the only tenant — they own the blast radius.

### Concrete (A) shape

```
[Coolify Container: remo-supervisor]
  ├─ Bun process: supervisor (current agent/src/index.ts with role='supervisor')
  │    ├─ WS to hub:/ws/agent  (single connection, reports budget)
  │    ├─ Spawns: bun agent/src/index.ts --project-dir /workspaces/<session>/wt --role child
  │    │     └─ Spawns: claude --input-format stream-json ...
  │    ├─ Spawns: bun agent/src/index.ts --project-dir /workspaces/<session2>/wt --role child
  │    │     └─ Spawns: claude ...
  │    └─ (N total, where N ≤ concurrency_budget)
  └─ Mounted volume: /workspaces  (persistent across deploys)
        ├─ <repo-cache>/.git  (bare clone, shared origin)
        ├─ session-<uuid>/wt  (git worktree, branch checked out)
        └─ session-<uuid2>/wt
```

Each child still authenticates to the hub independently with its own session — the supervisor doesn't proxy WS traffic, it just lifecycles the child. This preserves the existing `/ws/agent` protocol unchanged.

---

## 2. Resource Budget Reporting

### Where to read
- **CPU:** `os.cpus().length` (logical cores) on boot. Read once. Don't poll — child Claude processes are I/O bound on the API, not CPU bound.
- **RAM:** `os.totalmem()` on boot, `os.freemem()` every 10s. Inside a container, `os.totalmem()` reflects the cgroup limit on modern Bun/Node — verify in the container with a smoke test, fall back to reading `/sys/fs/cgroup/memory.max` if `os.totalmem()` reports the host's total.
- **Per-child estimate:** assume each child Claude session costs **~250 MB working set** (claude CLI + bun runner). Budget = `floor((total_mem - 512MB reserved) / 250MB)`, capped by `cpu_cores * 2`, capped by a hard env override `REMO_MAX_CONCURRENT_SESSIONS`.

### Refresh cadence
- Boot snapshot → send immediately in `auth` payload (already supported as `agent_info`).
- Live counters (`active_sessions`, `free_mem_bytes`) → push to hub every 10s when changed, every 60s heartbeat regardless.

### Data flow

```
Supervisor             Hub                       DB                Web
  │                     │                         │                 │
  │── auth + agent_info ────────────────────────►│                 │
  │   (cpu_cores, total_mem_bytes)               │                 │
  │                     │── UPSERT supervisor_resources ──►│        │
  │                     │                         │                 │
  │── supervisor_budget ────────────────────────►│── broadcast ────►│
  │   {max_concurrent: 6,                        │   (subscribed    │
  │    in_use: 2,                                │    clients)      │
  │    free_mem_bytes: 4.2GB}                    │                 │
```

New WS message types (additive, both sides):
- `agent → hub`: `supervisor_resources` (extends current `agent_info`) with live counters.
- `hub → web`: `supervisor_budget_update` broadcast on change.

New DB table:
```sql
CREATE TABLE supervisor_resources (
  user_id TEXT NOT NULL REFERENCES users(id),
  supervisor_id TEXT NOT NULL,           -- the agent's session_id at role='supervisor'
  cpu_cores INT NOT NULL,
  total_mem_bytes BIGINT NOT NULL,
  max_concurrent INT NOT NULL,           -- computed budget
  in_use INT NOT NULL DEFAULT 0,         -- live counter, hub-authoritative
  free_mem_bytes BIGINT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, supervisor_id)
);
```

---

## 3. Concurrency Enforcement — Hub is Authoritative

The web UI is a **soft display**. The hub is the **hard cap**.

### Why
- A single user with two browser tabs and a phone can race past a UI-only cap.
- Scheduled tasks and self-heal create sessions WITHOUT a browser in the loop. UI cap doesn't see them.
- The supervisor itself can't reject — by the time a child is spawned, RAM is already committed.

### Where
In `hub/src/api/sessions.ts` (and wherever sessions are created — scheduler dispatcher, self-heal endpoint), call a single gate:

```ts
async function reserveSessionSlot(userId: string, supervisorId: string): Promise<{ok: true} | {ok: false, reason: string}> {
  // atomic: SELECT ... FOR UPDATE, check in_use < max_concurrent, increment, commit
  // returns failure with "at capacity, N in use of M" if full
}
```

Release on session close (`session_status: 'idle'` final / WS disconnect / explicit terminate).

### User override
Allow the user to set `manual_max_concurrent` per supervisor in the web UI. Hub uses `min(computed_budget, manual_override)`. Override never raises above computed budget — that's a safety rail.

---

## 4. Claude Code CLI Auth Inside the Container

### Pragmatic default: **`ANTHROPIC_API_KEY` env var**

```dockerfile
# In the supervisor container
ENV ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

Set via Coolify env. The Claude CLI honors `ANTHROPIC_API_KEY` for non-interactive use. This is the only auth model that survives container restarts cleanly.

### Why not mounted `~/.claude`
- **Subscription login (Pro/Max) tokens refresh.** A baked `~/.claude` volume will work for hours-to-days, then silently expire. Recovery requires the user to SSH/exec into the container and re-login interactively. Hard fail in a self-heal context.
- **OAuth state is single-device tied** in some Claude releases. Copying credentials risks invalidating the host's login.
- No non-interactive subscription login exists today (May 2026). Confirmed: API key is the only headless path.

### Risk callout
- API key billing is **separate from a Max subscription**. The user pays Anthropic per-token directly, not through their subscription. Surface this in the Coolify env setup docs.
- Rotate via Coolify env update + container restart. Document the procedure.
- Consider proxying through the user's gateway pair (per global rule #18) so the API key lives in one place — but only if the gateway supports Anthropic; otherwise direct env is fine for a single-user box.

---

## 5. Git / Workspace Isolation

### Layout (persistent Coolify volume mounted at `/workspaces`)

```
/workspaces/
├── repos/                                    # shared bare clones (deduped origin storage)
│   ├── github.com-finedesignz-remo-code.git/
│   └── github.com-finedesignz-effortr.git/
├── sessions/
│   ├── <session-uuid>/
│   │   ├── wt/                               # git worktree, checked out branch
│   │   └── .agent-state.json                 # last sync hash, branch ref
│   └── <session-uuid2>/...
└── .ssh/                                     # mounted RO from Coolify secret
    └── id_ed25519
```

### Worktrees over clones
- `git worktree add /workspaces/sessions/<uuid>/wt feature/foo` — instant, shares `.git`.
- Disk: ~5–50 MB per session vs 500MB+ for a fresh clone of a large repo.
- Per-session isolation: two sessions on different branches of the same repo can't stomp each other.
- **Caveat:** worktrees on the same branch conflict. Hub-side gate: refuse a new session if `(repo, branch)` is already checked out in another active session. Force user to pick a different branch.

### Auth to GitHub
- **GitHub PAT** (fine-grained, per-user, scoped to specific repos) injected as `GITHUB_TOKEN` env, used by a git credential helper.
- **Not** SSH keys: PATs are easier to rotate, scope, and revoke via the GitHub UI. SSH key on a multi-tenant box is over-privileged.
- For private orgs requiring SSO/SAML: PAT must be SSO-authorized. Document.

### "Don't do this"
- Do NOT clone into ephemeral container storage. The volume MUST persist or every restart re-clones every repo.
- Do NOT share a single worktree across sessions. Race conditions on `git checkout` will corrupt state.
- Do NOT let two sessions write to the same branch simultaneously without explicit user opt-in.

---

## 6. Self-Heal Routing

### Current state (assumed — verify)
`claude-code-self-heal` runs on port 9114 globally on the user's host. It's a separate service. It presumably spawns Claude Code locally on the host today.

### Proposed config surface
Per-user setting in the hub (`users.preferred_supervisor_id`):

```sql
ALTER TABLE users ADD COLUMN preferred_supervisor_id TEXT NULL;
```

Resolution order when self-heal (or any "create me a new session" call) fires:
1. If `preferred_supervisor_id` set AND that supervisor is online + has capacity → use it.
2. Else, first online supervisor with capacity (deterministic order: oldest connection first).
3. Else, if a local agent is connected → use it.
4. Else, return 503 "no agent available."

Expose this in the web UI Settings page: dropdown of connected supervisors + "Local agent" + "Auto."

Self-heal becomes a thin client: HTTP POST to hub `/api/sessions/heal` with `{ repo, branch, prompt }`. Hub picks the target via the resolution order above. Self-heal no longer needs to know where Claude runs.

---

## 7. Cost Containment

### Recommendation: Lift the daily-cost-cap to a hub-wide per-user cap, not just scheduler.

The scheduler's cost-cap lives in `hub/src/scheduler/dispatcher.ts`. Today it only counts scheduled-task tokens. With a remote supervisor firing N parallel sessions, the user can burn $50+/day on **interactive** sessions and self-heal alone.

### Shape
- One counter table, keyed by `(user_id, day_utc)`, incremented on every Claude API result (`usage.input_tokens`, `usage.output_tokens`) from any source.
- Hub computes cost in USD using a configurable price table (Opus / Sonnet / Haiku).
- Cap check on **session creation** AND on **next-turn submission** (mid-session messages also count). Refuse with a friendly error.
- Scheduler keeps its own per-task cap (already exists, narrower scope) — it queries the same counter.

### User control
- Daily cap (default $20, override per-user in settings).
- Soft warning at 50%, 80%; hard stop at 100%.
- Web UI shows today's spend in the header (we already have a budget HUD pattern).

### Don't
- Do NOT cap on tokens (denominations vary by model). Cap on $.
- Do NOT trust agent-side accounting — hub MUST count from the Claude API result messages, which the agent already relays.

---

## 8. What's Missing from Your Mental Model

### Security
- **The supervisor container is a remote code execution endpoint by design.** Anyone with the API key can run arbitrary Claude prompts → arbitrary shell. Treat the API key like a root password. Rotate quarterly. Bind WS auth to source IP if you want belt-and-suspenders (the hub already does per-IP connection limits — extend to per-API-key origin pinning).
- **Mounted secrets:** `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, SSH keys → Coolify secrets, never in repo, never in image layers.
- **No public ingress to the supervisor.** Supervisor is WS client of the hub, not a server. Coolify container should have NO exposed ports.

### Observability
- Log every child spawn/exit to the hub (it already streams `agent_log` — make sure the supervisor emits structured spawn events).
- Expose a `/healthz` HTTP endpoint on the supervisor (Coolify health checks). 200 if WS to hub is connected, 503 otherwise.
- Resource events should be queryable in the hub DB for "why was a session refused at 10:42am" debugging.

### Recovery
- Supervisor crash → Coolify restarts container → on reboot, supervisor must **reconcile sessions** with the hub: hub sends current session list, supervisor reports which children survived (most won't — they're child processes of the dead supervisor). Hub marks orphan sessions as `crashed`, allows user to restart them on the rebooted supervisor.
- Volume corruption → cron `git gc` weekly + alert if any session's `.git` integrity check fails.

### Upgrades
- New supervisor image deploy = all in-flight sessions die. Coolify zero-downtime won't help — child processes are tied to the bun parent. Strategy: **drain before deploy.** Hub sends `shutdown {reason: 'upgrade'}` to supervisor, supervisor refuses new sessions, lets active ones run to completion or 10-min timeout, then exits. Coolify pulls new image. Document this as planned-downtime, ~10 min worst case.

### Multi-user
- Phase 04 spec says single-user. **Code it single-user, don't pretend it's multi-tenant.** The supervisor container has one `ANTHROPIC_API_KEY`, one `GITHUB_TOKEN` — sharing across users is a billing and security disaster. If true multi-tenant comes later, every supervisor will be 1:1 with a user.

### Networking / WS reliability
- Container → hub WS over public internet. Auto-reconnect already exists (`hub-client.ts`). Add exponential backoff cap at 60s. Heartbeat every 30s (already there).
- Coolify outbound: confirm no egress filtering blocks `wss://app.remo-code.com`.

---

## Happy Path — Sequence (Self-Heal Triggers a Remote Session)

```
1. User browser opens app.remo-code.com — shows "Supervisor: connected, 6 slots free of 8"
2. Supervisor container boots on Coolify:
   - reads ANTHROPIC_API_KEY, GITHUB_TOKEN, REMO_API_KEY, REMO_HUB_URL from env
   - opens WS to wss://app.remo-code.com/ws/agent
   - sends { type:'auth', api_key, role:'supervisor', agent_info:{cpu_cores:8, total_mem_bytes:16GB, ...} }
3. Hub validates API key, marks supervisor online, UPSERTs supervisor_resources
   (max_concurrent=8, in_use=0). Broadcasts supervisor_budget_update to user's subscribed clients.
4. Self-heal service (port 9114) detects a failing Coolify deploy.
   POST https://app.remo-code.com/api/sessions/heal
     { repo: "owner/repo", branch: "fix-deploy-2026-05-25", prompt: "Investigate failing deploy logs..." }
   Authorization: Bearer <hub JWT>
5. Hub:
   a. Resolves target: user.preferred_supervisor_id → online + has capacity → pick it.
   b. reserveSessionSlot(user, supervisor) — atomic INC of in_use, returns ok.
   c. Sends 'create_child_session' WS message to supervisor with { session_id, repo, branch, initial_prompt }
   d. Returns 202 { session_id, url: "/s/<session_id>" } to self-heal.
6. Supervisor:
   a. Ensures bare clone exists at /workspaces/repos/<repo>.git (fetch if stale).
   b. git worktree add /workspaces/sessions/<session_id>/wt <branch>
   c. Spawns: bun agent/src/index.ts --project-dir /workspaces/sessions/<session_id>/wt
              --hub-url wss://... --api-key <child-key> --initial-prompt "..."
   d. Child WS-auths to hub as a normal agent with this session_id.
7. Child agent spawns claude CLI, sends initial prompt. Activity events stream
   to hub → web UI in real time (same path as today).
8. On session close (Claude exits or hub sends shutdown):
   a. Child process exits, supervisor reaps, decrements in_use locally.
   b. Hub releases slot (releaseSessionSlot).
   c. Hub broadcasts supervisor_budget_update — UI shows 7 slots free of 8.
   d. Supervisor optionally garbage-collects the worktree after a grace period
      (configurable, default 7d, so user can come back and rerun).
```

---

## Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Anthropic API key leak (env exposed, image layer baked) | **CRITICAL** | Coolify secret, never in Dockerfile, never logged, rotate quarterly |
| 2 | Child Claude wedges, eats all RAM, OOM-kills supervisor | HIGH | Per-child cgroup memory limit; supervisor monitors child RSS, SIGTERMs over-budget children |
| 3 | Two sessions check out same branch → git corruption | HIGH | Hub-side gate: refuse (repo,branch) collision |
| 4 | Volume corruption / disk full → all sessions die | HIGH | Volume size alert at 80%, weekly `git gc`, sessions GC after 7d idle |
| 5 | Hub WS drops mid-session → child orphaned, billing continues | MEDIUM | Supervisor monitors hub WS; on disconnect >2min, SIGTERM all children (configurable) |
| 6 | Cost runaway (parallel sessions all on Opus) | MEDIUM | Hub-wide daily $ cap, hard stop at 100% |
| 7 | Upgrade kills in-flight work | MEDIUM | Drain-before-deploy protocol with `shutdown {reason:'upgrade'}` |
| 8 | GitHub PAT scoped too broadly | MEDIUM | Document fine-grained PAT setup; refuse to start without `GITHUB_TOKEN` env |
| 9 | Self-heal stampede creates 50 sessions before budget gate noticed | LOW | Atomic reserveSlot with SELECT FOR UPDATE; rate-limit /api/sessions/heal per user |
| 10 | Two browser tabs subscribe to same session_id, double-render | LOW | Already handled by existing WS subscription model |
| 11 | User runs supervisor on Coolify shared box, container affects neighbors | LOW (single-user box) | If shared later: enforce container CPU/RAM limits via Coolify resource specs |
| 12 | Subscription auth (~/.claude) silently expires hours after deploy | N/A | We're not using it — API key only. Documented. |

---

## Do NOT Do (Explicit Callouts)

- **Do NOT spawn one Coolify container per session.** Idle RAM, cold start, and Coolify API rate limits make this an operational nightmare. Use child processes inside one container.
- **Do NOT mount `~/.claude` from the user's host into the container.** Tokens refresh and break. API key only.
- **Do NOT proxy Claude WS through the supervisor.** Children open their own hub WS — same protocol as the local agent today. Don't invent a new channel.
- **Do NOT cap concurrency in the web UI only.** Hub-authoritative or it's not a cap.
- **Do NOT share a single git worktree across sessions.** Worktree per session, period.
- **Do NOT clone repos into ephemeral container storage.** Persistent volume mandatory.
- **Do NOT bake API keys into the Docker image.** Coolify env only.
- **Do NOT expose any port on the supervisor container.** It's a WS client of the hub, not a server. (Exception: `/healthz` on localhost for Coolify health check, if needed.)
- **Do NOT skip the cost cap.** Parallel sessions on Opus will hit $100/day faster than you think.
- **Do NOT trust agent-reported budgets blindly.** Hub recomputes from `cpu_cores * 2` and `free_mem / 250MB` — agent could lie or be wrong.
- **Do NOT add per-Anthropic-key env vars per app (rule #18 spirit).** Use one supervisor key managed via Coolify secret, not duplicated across child env.
- **Do NOT migrate self-heal away from local before the remote path is proven.** Self-heal stays able to target local as a fallback (resolution order step 3) until you've shipped two weeks of stable remote operation.

---

## Concrete Next Steps for the Planner

1. **Dockerfile.supervisor** — multi-stage, non-root, installs `git`, `claude` CLI, `bun`, copies built `agent/` package. Entrypoint: `bun agent/src/index.ts --role supervisor`.
2. **Extend `agent_info`** in `hub/src/ws/agent-protocol.ts` with `live_resources` sub-object (`free_mem_bytes`, `in_use`, `max_concurrent`). Already permissive (`.passthrough()`).
3. **New hub WS messages:** `create_child_session`, `child_session_started`, `child_session_exited`, `supervisor_budget_update`.
4. **DB migration:** `supervisor_resources` table + `users.preferred_supervisor_id` column + `daily_cost_usage` table (or extend existing scheduler counter).
5. **Hub gate:** `reserveSessionSlot` + `releaseSessionSlot` in `hub/src/sessions/budget.ts`. Wire into session creation paths (API, scheduler dispatcher, self-heal).
6. **Self-heal HTTP endpoint:** `POST /api/sessions/heal`. Document the resolution order.
7. **Web UI:** budget HUD in header, supervisor picker in Settings, capacity-refused error toast.
8. **Coolify setup doc:** secrets list, volume mount, env vars, `claude-remote-supervisor` resource layout, drain-before-deploy procedure.

---

**End of review.**
