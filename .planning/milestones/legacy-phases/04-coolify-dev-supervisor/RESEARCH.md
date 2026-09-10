# Phase 04: coolify-dev-supervisor — Research

**Researched:** 2026-05-25
**Domain:** Remote dev container hosting Claude Code CLI + remo-code supervisor; resource budget reporting to hub; concurrency-aware UI
**Confidence:** MEDIUM-HIGH (codebase HIGH, Claude CLI headless docs MEDIUM, resource heuristics LOW)

## Summary

The repo **already has the multi-process building block** required by this phase — `supervisor/src/process-manager.ts` runs **N concurrent `claude-agent` child processes** (one per `run_id`), each spawning its own Claude CLI in its own repo path. The local agent at `agent/src/index.ts` is **single-Claude-per-process** (one persistent CLI, one `project_dir`). Therefore the right shape for a Coolify-hosted dev box is a **supervisor container, not an agent container** — the multi-session design is already done, we just need to containerize it, add a resources-report message, and surface budget in the UI.

Claude Code CLI runs headless via `ANTHROPIC_API_KEY` env var + `--dangerously-skip-permissions` ([Anthropic CI/CD guidance][1], [Docker docs][2]). `stream-json` works headless — no TTY required. Git in the container needs a fine-grained PAT or deploy key, mounted via Coolify env vars / secrets.

**Primary recommendation:** Containerize the **supervisor** (not the agent) as a new `supervisor/Dockerfile` target. Add a `supervisor.resources` WS message (CPU/RAM detected from cgroup v2). Hub persists per-supervisor budget; web shows `running/budget` chip + override slider hard-capped at `budget × 2`. The existing `ProcessManager` is the concurrency mechanism — no fork in the design needed.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Spawn N Claude CLI processes | Supervisor container (Coolify) | — | `ProcessManager` already does this |
| Headless Claude auth | Supervisor container env | — | `ANTHROPIC_API_KEY` per Anthropic docs |
| Repo clones / git ops | Supervisor container `/workspace` volume | — | Same pattern as local supervisor |
| Resource detection (cgroup) | Supervisor (boot + periodic) | — | Only the supervisor knows its own host limits |
| Budget enforcement (soft) | Hub (reject session.start at cap) | Web (greyed-out CTA) | Authoritative state lives where dispatch happens |
| User override | Web slider → Hub persisted | — | Per-supervisor override, survives restarts |
| Routing self-heal to dev box | Hub (preferred-supervisor config) | — | Hub picks target; supervisor doesn't know it's "preferred" |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-code` | pin to current (e.g. `1.0.x`) | Claude CLI inside container | Required runtime; pin for reproducible builds [CITED: amux headless guide] |
| `oven/bun:1` | latest stable | Container base | Matches existing `Dockerfile` base |
| Node 20 (bundled with Bun) | 20.x | CLI host runtime | Anthropic minimum [ASSUMED] |
| `git` 2.40+ | apt package | Repo clones in container | Standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tini` or Bun's built-in signal handling | — | PID 1 reaping when supervisor spawns N children | If zombie processes appear in testing |

**Installation (Dockerfile additions):**
```bash
apt-get install -y --no-install-recommends git curl ca-certificates
bun add -g @anthropic-ai/claude-code@<pinned-version>
```

**Version verification:** `npm view @anthropic-ai/claude-code version` — run at planning time, pin exact version in Dockerfile. [ASSUMED — verify at plan time]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@anthropic-ai/claude-code` | npm | first-party Anthropic | high | github.com/anthropics/claude-code | [ASSUMED OK] | Approved |

slopcheck not run in this session — `@anthropic-ai/claude-code` is the only new package and it's first-party Anthropic. Planner should still run `npm view @anthropic-ai/claude-code` to confirm publisher.

## Architecture Patterns

### System Architecture Diagram

```
                            Coolify (46.224.61.233)
                            ┌─────────────────────────────────────┐
                            │  supervisor container (NEW)          │
                            │  ┌──────────────────────────────┐   │
                            │  │ supervisor/src/index.ts      │   │
                            │  │  ↳ ProcessManager (N runs)   │   │
                            │  │     ├─ claude-agent #1 → CLI │   │
                            │  │     ├─ claude-agent #2 → CLI │   │
                            │  │     └─ claude-agent #N → CLI │   │
                            │  └──────────────────────────────┘   │
                            │  /workspace (volume) — repos        │
                            │  /root/.claude (volume) — CLI state │
                            │  env: ANTHROPIC_API_KEY,            │
                            │       REMO_API_KEY, GIT_PAT         │
                            └────────────┬────────────────────────┘
                                         │ WSS /ws/agent (role=supervisor)
                                         ▼
                            app.remo-code.com (hub)
                            ┌─────────────────────────────────────┐
                            │  /ws/agent  ↔  supervisor-registry   │
                            │  budget per supervisor (NEW col)     │
                            │  override per supervisor (NEW col)   │
                            └────────────┬────────────────────────┘
                                         │ broadcastToUser
                                         ▼
                            web (browser)
                            ┌─────────────────────────────────────┐
                            │  Compute chip: "3/5 running"        │
                            │  Override slider (max=budget×2)     │
                            └─────────────────────────────────────┘
```

### Recommended Project Structure
```
supervisor/
├── Dockerfile           # NEW — multi-stage, Node+Bun+git+claude CLI
├── src/
│   ├── index.ts         # existing — add resources reporter on boot
│   ├── resources.ts     # NEW — cgroup-aware host detection
│   ├── process-manager.ts  # existing — already does N-concurrent runs
│   └── hub-client.ts    # existing — extend message types
hub/src/
├── ws/
│   ├── agent.ts                 # add handler for supervisor.resources
│   ├── supervisor-protocol.ts   # add SupervisorResources schema
│   └── supervisor-registry.ts   # add budget/override accessors
├── db/
│   └── migrations/0XX_supervisor_budget.sql   # NEW
web/src/
└── components/SupervisorCompute.tsx           # NEW
```

### Pattern 1: cgroup v2 resource detection inside Coolify container
**What:** Read `/sys/fs/cgroup/memory.max` and `/sys/fs/cgroup/cpu.max`; fall back to `os.cpus().length` / `os.totalmem()` if unset (`max`).
**When to use:** Supervisor boot + every 5 min for refresh.
**Example:**
```ts
// supervisor/src/resources.ts
import { readFileSync } from 'fs'
import os from 'os'

export function detectBudget() {
  const cpuCores = readCpuMax() ?? os.cpus().length
  const memBytes = readMemMax() ?? os.totalmem()
  const memMb = Math.floor(memBytes / (1024 * 1024))
  // ~800 MB per Claude session is the working estimate — refine after measuring
  const maxParallel = Math.max(1, Math.min(
    Math.floor(cpuCores * 0.75),
    Math.floor(memMb / 800),
  ))
  return { cpuCores, memMb, maxParallel }
}

function readCpuMax(): number | null {
  try {
    const raw = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
    const [quota, period] = raw.split(' ')
    if (quota === 'max') return null
    return Number(quota) / Number(period)
  } catch { return null }
}

function readMemMax(): number | null {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (raw === 'max') return null
    return Number(raw)
  } catch { return null }
}
```

### Pattern 2: Headless Claude CLI auth in container
**What:** API-key auth via `ANTHROPIC_API_KEY` env var. Mount `/root/.claude` as a volume so OAuth caches (if used) survive restarts.
**Why:** Interactive `claude auth login` is impossible in a headless container; API key is the only first-class non-interactive path. [CITED: github.com/anthropics/claude-code/issues/7100, amux headless guide]
**Caveat:** MAX-subscription auth requires the OAuth flow and is **not viable** for a headless container today. The Coolify supervisor must use a billed API key — surface this in the discuss-phase output.

### Anti-Patterns to Avoid
- **Don't bake the API key into the image** — runtime env only (Coolify secrets), never build args
- **Don't share one `/workspace/repo` across concurrent sessions** — file lock collisions. Either one repo per run, or git worktrees per run
- **Don't put `--dangerously-skip-permissions` on without a sandboxed FS** — the container itself IS the sandbox; that's fine. But document it
- **Don't run as root** — non-root user like the hub Dockerfile does (`appuser`)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Multi-process Claude orchestration | A new "agent that spawns N agents" | Existing `ProcessManager` | It already exists and is tested |
| Resource detection across platforms | `top`/`free` parsing | `os` module + `/sys/fs/cgroup/*` reads | Bun has these natively |
| Cron-based budget refresh | Setting up node-cron | `setInterval(refresh, 5 * 60_000)` | Boot + interval is enough |
| Container lifecycle | systemd-in-container | Coolify's native restart policy | Coolify already does it |

**Key insight:** This phase is **mostly containerization + a small protocol extension**, not a new subsystem. The temptation to "design something new" is the trap.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `session_runs` table holds run_id state per supervisor — no change needed | none |
| Live service config | Coolify app (NEW resource, not yet provisioned) | create resource at deploy time |
| OS-registered state | None — Coolify container is ephemeral | none |
| Secrets/env vars | `ANTHROPIC_API_KEY` (NEW), `REMO_API_KEY` with supervisor capability (NEW or reuse), `GIT_PAT` for clones (NEW), `REMO_HUB_URL=wss://app.remo-code.com` | provision via Coolify env |
| Build artifacts | `supervisor/Dockerfile` (NEW), Coolify image rebuild on push to main | wire CI |

## Common Pitfalls

### Pitfall 1: cgroup v1 vs v2 path differences
**What goes wrong:** Coolify hosts on a kernel that may use cgroup v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`) or v2 (`/sys/fs/cgroup/memory.max`). Code reading only one path silently falls back to host totals.
**How to avoid:** Try v2 path first, then v1, then `os.totalmem()`. Log which path won.
**Warning signs:** Reported budget = host RAM (huge number) on a container that's actually capped at 4 GB.

### Pitfall 2: Claude CLI subprocess RSS estimate is a guess
**What goes wrong:** The 800 MB-per-session heuristic is unmeasured. Real footprint could be 300 MB idle, 1.5 GB during a big tool turn.
**How to avoid:** Add a measurement task in the plan — run 3 concurrent sessions, sample RSS at 30 s intervals for 10 min. Adjust constant before shipping.
**Warning signs:** OOM-kill on the container, sessions vanishing mid-turn.

### Pitfall 3: Concurrent sessions writing to the same repo
**What goes wrong:** Two self-heal runs targeting the same repo step on each other's `git status`, branch checkouts, file edits.
**How to avoid:** Per-run git worktree (`git worktree add /workspace/wt-<run_id>`). Cheaper than full clones. Tear down on run completion.
**Warning signs:** Random "your local changes would be overwritten" errors, branch state thrash.

### Pitfall 4: Hub doesn't know to route to the Coolify supervisor
**What goes wrong:** Self-heal feature ([phase merge-self-heal](../merge-self-heal/RESEARCH.md)) doesn't exist yet in main. When it lands, default targets are the user's local supervisor — not the new remote one.
**How to avoid:** Add `users.preferred_supervisor_id` (or `workspaces.preferred_supervisor_id` per the post-merge entity model) BEFORE self-heal lands; document the contract.
**Warning signs:** Self-heal phase ships, fires runs at local box, user wonders why the Coolify box is idle.

### Pitfall 5: Cost cap doesn't cover ad-hoc remote runs
**What goes wrong:** Daily cost cap in `hub/src/scheduler/dispatcher.ts` covers scheduled tasks only. A remote dev box that can fire N parallel sessions racks up API spend with no ceiling.
**How to avoid:** Extend the cap to also gate `session.start` on a remote supervisor when `total_cost_usd` (already tracked from `CliResultEvent`) crosses a threshold for the day.
**Warning signs:** Surprise Anthropic bill.

## Code Examples

### supervisor.resources WS message (NEW)
```ts
// hub/src/ws/supervisor-protocol.ts — add
export const SupervisorResources = z.object({
  type: z.literal('supervisor.resources'),
  cpu_cores: z.number(),                   // detected (cgroup or host)
  mem_mb: z.number(),                      // detected
  max_parallel: z.number().int().min(1),   // computed budget
  source: z.enum(['cgroup_v2', 'cgroup_v1', 'host_fallback']),
})
```

### Hub-side budget enforcement (NEW logic in supervisor session.start path)
```ts
// in handleSupervisorMessage or wherever session.start is dispatched
const sup = getSupervisor(supervisorId)
const running = countRunningRuns(supervisorId)
const cap = sup.override ?? sup.budget?.max_parallel ?? 1
if (running >= cap) {
  ws.send(JSON.stringify({ type: 'session.reject', reason: 'at_capacity' }))
  return
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Mount `~/.claude` to share login from host into container | API-key env var | always preferred for headless | Cleaner, no host coupling |
| `--input-format stream-json` requires TTY | Works in piped subprocess | n/a — works headless out of the box | Container support is straightforward [CITED: Anthropic CI/CD docs] |
| Run claude as root in container | Non-root user + writable HOME | always | Security; matches hub Dockerfile pattern |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | 800 MB per Claude session is a reasonable starting heuristic | Common Pitfalls #2 | OOM kills or under-utilization — must be measured |
| A2 | Coolify host uses cgroup v2 | Patterns | Detection falls back to host totals; need v1 path too |
| A3 | `@anthropic-ai/claude-code` headless works with API key in current version | Stack | Falls back to mounted-credentials — heavier ops story |
| A4 | MAX-subscription auth is NOT viable headless | Pitfalls | If it IS viable now, billing model changes; check current docs |
| A5 | Self-heal phase hasn't landed yet in main | Pitfalls #4 | If it has, planner must check actual integration point not the assumed one |
| A6 | Hub daily cost cap is scheduled-only | Pitfalls #5 | If already covers ad-hoc, no action; verify in `hub/src/scheduler/dispatcher.ts` |
| A7 | One Coolify resource = one supervisor container = N parallel Claude processes | Architecture | If user wants N containers, design changes (orchestrator → multiple supervisors) |

## Open Questions

1. **Per-run isolation: clone-per-run vs worktree-per-run vs single-clone-with-lock?**
   - What we know: ProcessManager already runs N concurrent. Repos cloned via git-ops.ts.
   - What's unclear: current behavior under concurrent runs on same repo.
   - Recommendation: git worktrees — fast, native, isolated. Confirm with architect during planning.

2. **Where does the budget/override live in DB?**
   - `supervisors` table already exists (used by `upsertSupervisor`). Add `budget_jsonb` + `override_max_parallel` columns.
   - Recommendation: extend schema in this phase; add migration `00X_supervisor_budget.sql`.

3. **Self-heal "preferred supervisor" — design now or wait?**
   - Self-heal phase is still in research. We can ship the Coolify supervisor and add a `users.preferred_supervisor_id` column (or workspace-scoped equivalent) without coupling.
   - Recommendation: add the column in this phase, leave it nullable, document the contract for self-heal to consume.

4. **API key model for the remote supervisor — shared with user's local supervisor or distinct?**
   - The existing supervisor capability is bound to a single API key. Reusing it means the Coolify box presents itself as the same supervisor identity (hostname differs, supervisor_id will differ).
   - Recommendation: distinct API key with `supervisor` capability per supervisor host. Simpler audit, simpler revocation.

5. **Will Anthropic's `--input-format stream-json` work the same headlessly as it does in the local agent?**
   - HIGH confidence YES (stream-json is pipe-based, no TTY needed). [CITED: Anthropic CI/CD docs] Still — add a smoke test in Wave 0.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Coolify account | deploy target | ✓ | — | none — required |
| `@anthropic-ai/claude-code` on npm | container image | ✓ | latest | none |
| Anthropic API key with billing | runtime | needs provisioning | — | none |
| Git PAT for private repos | git ops | needs provisioning | — | public repos only |
| cgroup v2 on Coolify host | resource detection | unverified | — | host-totals fallback + v1 path |

**Missing dependencies with no fallback:**
- Anthropic API key — billing implication, surface to user during discuss-phase

**Missing dependencies with fallback:**
- Git PAT — public-repo-only mode possible for initial deploy

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Bun's built-in test runner (matches repo convention — `hub/test/*.test.ts`) |
| Config file | none — Bun zero-config |
| Quick run command | `bun test supervisor/test/resources.test.ts` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-RES-01 | `detectBudget()` reads cgroup v2 when present | unit | `bun test supervisor/test/resources.test.ts -t "cgroup v2"` | Wave 0 |
| REQ-RES-02 | `detectBudget()` falls back to host when cgroup is `max` | unit | same file | Wave 0 |
| REQ-PROTO-01 | `SupervisorResources` schema accepts valid payload, rejects bad | unit | `bun test hub/test/supervisor-protocol.test.ts` | Wave 0 |
| REQ-HUB-01 | Hub rejects session.start when supervisor at cap | integration | `bun test hub/test/supervisor-budget.test.ts` | Wave 0 |
| REQ-HUB-02 | Hub honors override when set | integration | same file | Wave 0 |
| REQ-DOCKER-01 | `supervisor/Dockerfile` builds | smoke | `docker build -f supervisor/Dockerfile .` | Wave 0 |
| REQ-CLAUDE-01 | Containerized claude CLI responds to `claude --version` | smoke | `docker run --rm img claude --version` | Wave 0 |
| REQ-E2E-01 | End-to-end: supervisor on Coolify accepts a session and runs Claude | manual | manual smoke run after deploy | manual-only |

### Sampling Rate
- **Per task commit:** `bun test <affected-file>`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green + manual Coolify deploy smoke before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `supervisor/test/resources.test.ts` — covers REQ-RES-01, REQ-RES-02
- [ ] `hub/test/supervisor-protocol.test.ts` — REQ-PROTO-01
- [ ] `hub/test/supervisor-budget.test.ts` — REQ-HUB-01, REQ-HUB-02
- [ ] `supervisor/Dockerfile` skeleton

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | existing API-key hash (SHA-256, timing-safe); supervisor capability check |
| V3 Session Management | no | WS auth handled by existing layer |
| V4 Access Control | yes | budget enforcement = a per-supervisor authz boundary |
| V5 Input Validation | yes | Zod schemas on new `supervisor.resources` |
| V6 Cryptography | no | no new crypto |
| V7 Error Handling | yes | container OOM, cgroup read failures must not crash supervisor |
| V8 Data Protection | yes | `ANTHROPIC_API_KEY` and `GIT_PAT` are secrets — Coolify secrets only, never logged |

### Known Threat Patterns for {Coolify supervisor + Claude CLI}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| API key exfiltration via log capture | Information Disclosure | redact env in supervisor.log emissions; don't echo on boot |
| Unbounded parallel sessions → cost explosion | DoS (self-inflicted) | budget cap + daily cost cap covers ad-hoc runs (Pitfall #5) |
| Container escape via tool call | Elevation of Privilege | non-root user; `--dangerously-skip-permissions` confined to container FS |
| Git PAT scope too broad | Information Disclosure | fine-grained PAT, read+write only on selected repos |
| Supervisor impersonation | Spoofing | distinct API key per supervisor host (Open Question #4) |

## Sources

### Primary (HIGH confidence — repo code)
- `agent/src/index.ts`, `agent/src/config.ts`, `agent/src/types.ts`
- `supervisor/src/process-manager.ts` (multi-process Claude orchestration already exists)
- `hub/src/ws/agent.ts`, `hub/src/ws/agent-protocol.ts`, `hub/src/ws/supervisor-protocol.ts`
- `hub/src/ws/registry.ts`
- `Dockerfile` (existing hub container pattern)
- `.planning/phases/merge-self-heal/RESEARCH.md`

### Secondary (MEDIUM confidence — Anthropic + Docker docs)
- [Anthropic Claude Code headless / CI-CD][1]
- [Docker docs — Claude Code sandbox][2]
- [Anthropic devcontainer docs][3]
- [GitHub issue #7100 — headless auth gap][4]

### Tertiary (LOW — community guides, marked for validation)
- [amux: Claude Code Headless Self-Hosting Guide][5]
- [DEV.to: Claude Code in Docker with Web UI][6]

[1]: https://institute.sfeir.com/en/claude-code/claude-code-headless-mode-and-ci-cd/faq/
[2]: https://docs.docker.com/ai/sandboxes/agents/claude-code/
[3]: https://code.claude.com/docs/en/devcontainer
[4]: https://github.com/anthropics/claude-code/issues/7100
[5]: https://amux.io/guides/claude-code-headless/
[6]: https://dev.to/coderluii/how-i-run-claude-code-in-docker-with-a-web-ui-and-headless-browser-5dko

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions reusable from existing repo + Anthropic first-party CLI
- Architecture: HIGH — existing `ProcessManager` does the hardest part already
- Pitfalls: MEDIUM — cost cap and self-heal integration depend on phases not yet merged
- Resource heuristics: LOW — 800 MB/session is a guess; must be measured

**Research date:** 2026-05-25
**Valid until:** 2026-06-25 (Claude CLI moves quickly; re-verify headless auth path in 30 days)

---

## CRITICAL DESIGN FORK — Resolved

The orchestrator brief flagged: *"does the design need to change to multi-process, or does 'parallel sessions' already map to 'multiple agent instances / project_dirs'?"*

**Resolution:** Neither — and that's the point. The repo already has **a supervisor that spawns N child `claude-agent` subprocesses, each with its own Claude CLI**. The plan should ship a Coolify container running THAT supervisor (`supervisor/src/index.ts`), not the single-Claude agent (`agent/src/index.ts`).

**The agent (`agent/src/`) is a single-Claude-per-process tool intended for the user's interactive desktop. The supervisor (`supervisor/src/`) is the multi-process orchestrator. Coolify wants the supervisor.**

This drops a large chunk of speculative design work from the plan.
