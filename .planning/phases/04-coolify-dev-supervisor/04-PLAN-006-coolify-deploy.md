---
plan_id: 04-PLAN-006-coolify-deploy
wave: 3
depends_on: [04-PLAN-005-supervisor-dockerfile, 04-PLAN-001-budget-reporting, 04-PLAN-002-schema-and-migration]
files_modified:
  - docs/coolify-supervisor.md
  - scripts/coolify-provision-supervisor.ts
autonomous: false
requirements: [REQ-DEPLOY-01]
---

# Plan 04-006 — Provision the supervisor on Coolify

Stand up the actual Coolify resource that runs the supervisor image from Plan 005: env vars, persistent volumes, resource limits, no exposed ports, healthcheck. Includes a provisioning script (uses Coolify API per the global rule) plus a runbook for manual fallback. Checkpoint at the end so a human verifies the container actually connects to the hub and reports `host_resources`.

<tasks>

<task id="T1">
<action>Create `scripts/coolify-provision-supervisor.ts`. Reads `COOLIFY_TOKEN` from `~/.claude/secrets/services.json` (per global secrets rule). Calls the Coolify REST API to: (a) create a new "Docker Image" resource named `remo-supervisor`, image `ghcr.io/<owner>/remo-supervisor:latest`, on the existing 46.224.61.233 server; (b) attach two persistent volumes — `/workspace` (50 GB, repos + worktrees) and `/root/.claude` (1 GB, CLI state cache); (c) set env vars: `REMO_HUB_URL=wss://app.remo-code.com/ws/agent`, `REMO_API_KEY=<placeholder — operator fills>`, `ANTHROPIC_API_KEY=<placeholder>`, `GITHUB_TOKEN=<placeholder>`, `GIT_USER_NAME=remo-supervisor`, `GIT_USER_EMAIL=ops@remo-code.com`, `NODE_ENV=production`; (d) set resource limits: 4 vCPU, 8 GB RAM (initial — Plan 004 measurement may tune); (e) configure restart policy: `unless-stopped`; (f) no exposed ports. Idempotent: if resource named `remo-supervisor` already exists, PATCH instead of POST. Print the resource UUID + dashboard URL on success.</action>
<read_first>
- ~/.claude/CLAUDE.md (Coolify Deployments section — credentials source, API base URL)
- Any existing Coolify provisioning scripts in the repo (search via `grep -rn coolify scripts/`)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §5 (volume layout, persistence requirement)
</read_first>
<acceptance_criteria>
- Script is idempotent — running twice does NOT create two resources
- All 4 secret env vars are set with placeholder values that the operator can fill via the Coolify UI (the script does NOT bake actual secrets into source)
- Volumes are created with the exact mount paths `/workspace` and `/root/.claude`
- No exposed ports in the created resource (verified by re-reading the resource after creation)
- Dry-run mode (`--dry-run`) prints the planned API calls without making them
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `docs/coolify-supervisor.md`. Sections: (1) Overview — what this container does, single-user model; (2) One-time setup — generate `ANTHROPIC_API_KEY` (note: separate from MAX subscription billing per ARCH-REVIEW §4), generate fine-grained `GITHUB_TOKEN` scoped to the repos the user wants the supervisor to touch, generate a supervisor-capability `REMO_API_KEY` via the existing API-key flow; (3) Provisioning — `bun scripts/coolify-provision-supervisor.ts`, fill secret values in Coolify UI, deploy; (4) Verification — `docker logs` should show WS connect + a `host_resources` send, hub log should show the supervisor registering, web UI should show the supervisor in the supervisors list with the reported CPU/RAM; (5) Rotation — how to rotate each secret (Coolify env update + container restart); (6) Drain-before-deploy — when pushing a new supervisor image, send `shutdown {reason:'upgrade'}` via the existing supervisor command channel, wait for in-flight sessions to drain (or 10 min timeout), then redeploy; (7) Backup — the `/workspace` volume contains git repos with possibly uncommitted work; weekly Coolify volume snapshot recommended.</action>
<read_first>
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md (entire — most sections feed into this doc)
- .planning/phases/04-coolify-dev-supervisor/RESEARCH.md (Security Domain section)
</read_first>
<acceptance_criteria>
- Doc covers all 7 sections
- Each secret has a documented source (where to generate) and a documented rotation procedure
- Drain-before-deploy procedure references the actual shutdown command shape (cross-reference Plan 008 or supervisor protocol)
- Markdown renders cleanly (no broken links)
</acceptance_criteria>
</task>

<task id="T3" type="checkpoint:human-verify">
<what-built>Coolify resource provisioned + deployed; supervisor image running.</what-built>
<how-to-verify>
1. Run `bun scripts/coolify-provision-supervisor.ts` (or PATCH existing resource if rerun)
2. Open Coolify dashboard → `remo-supervisor` resource → Environment Variables → fill `REMO_API_KEY` (from `/api/api-keys` flow, supervisor capability), `ANTHROPIC_API_KEY` (from Anthropic console), `GITHUB_TOKEN` (fine-grained PAT)
3. Click "Deploy". Watch logs.
4. Expected log lines (in order): "validating env", "connecting to wss://app.remo-code.com/ws/agent", "authenticated as supervisor <id>", "host_resources sent: cpu_cores=4 total_mem_mb=8192 concurrency_budget=<N> source=cgroup_v2"
5. In hub logs (Coolify → hub resource): expect a "supervisor <id> connected" line followed by the persistence UPDATE from Plan 002
6. In web UI: the supervisor appears in the supervisors list with the reported CPU/RAM chip
7. Run `docker exec <container> claude --version` — should print the pinned version
</how-to-verify>
<resume-signal>Paste the supervisor ID + the reported `concurrency_budget` value. I'll proceed to wire self-heal routing (Plan 008) and budget measurement (Plan 004).</resume-signal>
</task>

</tasks>

must_haves:
- Coolify resource `remo-supervisor` exists with image from Plan 005, persistent `/workspace` + `/root/.claude` volumes, no exposed ports, restart policy `unless-stopped`
- All secrets are filled via Coolify UI, not committed to repo
- `docs/coolify-supervisor.md` documents setup, verification, rotation, drain-before-deploy, and backup
- A live deploy successfully registers with the hub and reports `host_resources`

rollback_plan:
- Delete the Coolify resource (script idempotent so it can be recreated). Volumes detach but persist — manual delete in Coolify UI if you want a clean slate.

risks:
- 8 GB RAM initial allocation may be wrong by 2x in either direction — Plan 004 measurement will inform a resize.
- Provisioning via API depends on Coolify API stability; document the manual-UI fallback procedure in the doc.
- Anthropic API key is now a recurring spend item — surface this in the doc explicitly.
