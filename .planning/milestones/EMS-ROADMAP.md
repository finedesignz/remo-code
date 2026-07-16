<!-- updated: 2026-07-16 -->
# Roadmap — Milestone EMS (ext/mcp "Second-Witness" Connector Ship)

**Requirements:** [EMS-REQUIREMENTS.md](EMS-REQUIREMENTS.md)
**Phase dirs:** `.planning/phases/EMS-NN-slug/` — the `EMS-` prefix is **mandatory**; a bare
`NN-slug` collides with concurrent milestones (`PTYCAP`, `MSESS`, `OBSRV`, `OEE`) when
`.planning/` merges.
**Status:** scoped only. Not in flight. Worktree `remo-code-ext-mcp-ship`, branch
`feat/ext-mcp-ship`, off `main`. Sequencing relative to `PTYCAP`/other milestones: independent —
EMS ships an isolated `/api/ext` surface and does not touch the PTY dispatch path.

## Risk / gating summary

| Ships how | Phases | Consequence |
|---|---|---|
| **Worktree-only** (no external effect) | 01, 02, 03, 04 | Safe to iterate freely. |
| **OUTWARD-FACING / IRREVERSIBLE — needs explicit owner go-ahead before executing** | **05, 06** | 05 merges to `main` + redeploys the live hub at `app.remo-code.com`. 06 either publishes a package to public npm or pins a long-lived invocation string — both are hard to fully undo. **Do not execute past 04 without the owner's explicit go.** |
| **Touches infra outside this repo** | 07, 08 | 07 creates a live API key against the deployed hub. 08 edits `C:\Users\artic\Claude\Scheduled\` (the TLP sweep config), not `remo-code`. |
| **Live proof run** | 09 | Executes a real (non-dry-run) TLP verify-close sweep. |

**Hard ordering constraints**
1. **01 before everything.** Nothing else is meaningful until the branch is a clean, buildable
   consolidation of exactly the 8-commit core.
2. **02–04 (QC) before 05 (merge/deploy).** Never merge a branch that hasn't proven hub build,
   mcp binary, and scope enforcement independently.
3. **05 before 06 is NOT required** (npm publish doesn't depend on the hub being live), but **06
   before 07 IS required** (the API key's consuming invocation must be decided before it's wired
   into a config that names it). **05 before 07 IS required** (the key must be created against the
   live, post-deploy hub, not a stale one).
4. **07 before 08 before 09** — key must exist before it's registered, registration must exist
   before the sweep can use it.
5. **Do not touch** `fix/dockerfile-mcp-workspace`, `fix/update-reap-sidecar`,
   `fix/mobile-tap-focus`, `fix/terminal-focus-latch`, `fix/extwork-scope-explicit`, `feat/roots-ui`.
   Phase 01 reads them (`git log`/`show`/`diff`) and cherry-picks INTO `feat/ext-mcp-ship`; it never
   checks them out or modifies them. A sibling session may be live on `fix/update-reap-sidecar` —
   check `active-sessions.md` before any git operation that could collide.

## Phases

- [ ] **EMS-01: Consolidate the ext/mcp core** — cherry-pick the 8-commit core onto a clean branch, untangled from 10 unrelated commits.
- [ ] **EMS-02: QC — hub builds clean** — hub typechecks, full existing test suite green, no regression from the cherry-pick.
- [ ] **EMS-03: QC — mcp package + binary** — `mcp/` builds; `remo-code-mcp` starts and lists its 5 tools over the MCP protocol.
- [ ] **EMS-04: QC — ext API scope enforcement** — `ext-api-key-middleware` proven: 401 unauth, 403 wrong-scope, 2xx correct-scope; legacy/NULL keys locked out of `ext:work`.
- [ ] **EMS-05: Ship hub (GATED)** — merge to main, deploy to Coolify, verify `/api/ext` live; docs/openapi updated.
- [ ] **EMS-06: Publish/wire mcp client (GATED)** — decide npm-publish vs pinned invocation; prove the chosen invocation actually starts the server and lists tools.
- [ ] **EMS-07: Provision the API key** — create a scoped `ext:read`+`ext:ask` key in Settings → Credentials against the live hub.
- [ ] **EMS-08: Register the connector in the TLP sweep** — wire the key + invocation into the scheduled verify-close skill's connector config (outside this repo).
- [ ] **EMS-09: End-to-end second-witness proof** — a real sweep run loads the 5 tools and reconciles a verdict against a remo-owned session.

## Phase Details

### EMS-01: Consolidate the ext/mcp core
**Goal**: A clean, buildable `feat/ext-mcp-ship` carrying exactly the 8-commit ext/mcp core, in
order, with zero unrelated commits.
**Depends on**: Nothing (first phase).
**Requirements**: CONS-01, CONS-02, CONS-03
**Success Criteria** (what must be TRUE):
  1. `git log main..feat/ext-mcp-ship` shows exactly the 8 core commits (`617e8e5`, `1f596a7`,
     `e4938b9`, `d546607`, `d794663`, `1b4efb2`, `357ba2f`, `fca3393`), in original chronological
     order — no mobile/terminal/autostart/revanote/Connections-UI/PTYCAP-planning commits present.
  2. No cherry-pick conflict markers remain anywhere in the tree.
  3. `mcp/package.json`, `mcp/src/index.ts`, `mcp/src/client.ts` exist on the branch and the root
     bun workspace install resolves `mcp/` as a member.
  4. The 6 source branches (`fix/dockerfile-mcp-workspace` et al.) are untouched — verified by
     `git log` on each showing no new commits since this phase started.
**Plans**: TBD

### EMS-02: QC — hub builds clean
**Goal**: The consolidated branch's hub side is proven to build and pass its existing tests with
zero regression from the cherry-pick.
**Depends on**: EMS-01.
**Requirements**: QC-01
**Success Criteria**:
  1. `hub/` typechecks with zero errors on the consolidated branch.
  2. The full existing `hub/test/` suite passes, including `hub/test/mount-order.test.ts`
     (`/api/ext` still mounts before the cookie/JWT catch-all).
  3. `bun run check-baseline` (the project's per-file test-isolation gate) passes.
**Plans**: TBD

### EMS-03: QC — mcp package + binary
**Goal**: `@remo-code/mcp` is proven to actually run and expose its 5 tools.
**Depends on**: EMS-01.
**Requirements**: QC-02
**Success Criteria**:
  1. `mcp/` builds (`bunx tsc --noEmit` clean).
  2. Running the `remo-code-mcp` bin starts an MCP server process that responds to the standard
     MCP `tools/list` request.
  3. The tool list returned is exactly `remo_list_sessions`, `remo_read_memory`,
     `remo_read_transcript`, `remo_ask`, `remo_get_ask` — no more, no fewer.
**Plans**: TBD

### EMS-04: QC — ext API scope enforcement
**Goal**: The `/api/ext` auth surface is proven correct under adversarial and legacy-key inputs,
not merely inspected.
**Depends on**: EMS-01.
**Requirements**: QC-03, QC-04
**Success Criteria**:
  1. A request to any `/api/ext/*` route with no `api_key` returns 401.
  2. A key scoped `ext:read` only, hitting an `ext:ask`-scoped route, returns 403.
  3. A key carrying both scopes succeeds (2xx) on both read and ask routes.
  4. A legacy or NULL-scope key attempting `ext:work` is rejected — covered by a passing automated
     test (`357ba2f`'s guarantee), not just present in the diff.
**Plans**: TBD

### EMS-05: Ship hub (GATED — outward-facing, needs owner go-ahead)
**Goal**: The proven branch is live on `app.remo-code.com`.
**Depends on**: EMS-02, EMS-03, EMS-04 (all QC phases green). **Explicit owner go-ahead required
before executing — this merges to `main` and redeploys the live hub.**
**Requirements**: SHIP-01, SHIP-02, SHIP-03
**Success Criteria**:
  1. PR merged to `main` (squash, admin, CI green) and the branch deleted per standard flow.
  2. Coolify redeploy completes; `/health` returns 200 AND a direct `/api/ext/*` probe returns 401
     unauthenticated / 2xx with a valid scoped key against the LIVE hub (not staging, not `/health`
     alone).
  3. `/openapi.json` lists the `/api/ext` routes; `docs/api.md` is regenerated and committed with
     no `TODO: document` markers.
**Plans**: TBD

### EMS-06: Publish/wire mcp client (GATED — outward-facing/hard-to-reverse, needs owner go-ahead)
**Goal**: `remo-code-mcp` resolves via one canonical, documented invocation.
**Depends on**: EMS-03 (proven locally first). Independent of EMS-05. **Explicit owner decision
required: npm-publish vs pinned local/tarball invocation — do not default silently.**
**Requirements**: PUB-01, PUB-02
**Success Criteria**:
  1. Exactly one invocation method is chosen and written down verbatim in `mcp/README.md` (or
     equivalent) — either `bunx remo-code-mcp`/`npx -y @remo-code/mcp` post-npm-publish, or a
     pinned absolute-path/tarball-URL invocation.
  2. Running that exact invocation string from a clean shell (stating any documented prerequisite)
     starts the server and lists its 5 tools — proven by a real run.
**Plans**: TBD

### EMS-07: Provision the API key
**Goal**: A working, correctly-scoped credential exists against the live hub.
**Depends on**: EMS-05 (key must be created against the deployed hub, not a stale build).
**Requirements**: PROV-01
**Success Criteria**:
  1. An API key named distinctly (e.g. `tlp-verify-close-sweep`) exists in Settings → Credentials
     on the live hub, carrying both `ext:read` and `ext:ask` scopes.
  2. The secret is captured out-of-band (not committed to any repo) for EMS-08.
**Plans**: TBD

### EMS-08: Register the connector in the TLP sweep
**Goal**: The TLP scheduled verify-close sweep's Claude config knows how to reach the connector.
**Depends on**: EMS-06 (invocation decided), EMS-07 (key exists).
**Requirements**: PROV-02
**Success Criteria**:
  1. `C:\Users\artic\Claude\Scheduled\`'s verify-close skill Appendix B connector block is updated
     with the EMS-06 invocation string plus `REMO_HUB_URL=https://app.remo-code.com` and
     `REMO_API_KEY=<EMS-07 secret>`.
  2. This edit lands outside the `remo-code` repo; EMS-08's phase record documents the exact block
     added (redacting the secret) rather than committing it here.
**Plans**: TBD

### EMS-09: End-to-end second-witness proof
**Goal**: The whole chain is proven live, once, not merely wired.
**Depends on**: EMS-08.
**Requirements**: E2E-01, E2E-02
**Success Criteria**:
  1. A real (non-dry-run) TLP verify-close sweep run shows all 5 `remo_*` tools loaded and
     callable in that run's log/transcript.
  2. For a task whose implementation work was done by a remo-code-owned session, the sweep calls
     `remo_read_transcript` and/or `remo_ask` against that session and produces a reconciled
     second-witness verdict (agreement, or a surfaced discrepancy) — captured as evidence.
**Plans**: TBD

## Coverage validation — 100%

16 requirements, each mapped to **exactly one** phase.

| Phase | REQ-IDs | Count |
|---|---|---|
| EMS-01 | CONS-01, CONS-02, CONS-03 | 3 |
| EMS-02 | QC-01 | 1 |
| EMS-03 | QC-02 | 1 |
| EMS-04 | QC-03, QC-04 | 2 |
| EMS-05 | SHIP-01, SHIP-02, SHIP-03 | 3 |
| EMS-06 | PUB-01, PUB-02 | 2 |
| EMS-07 | PROV-01 | 1 |
| EMS-08 | PROV-02 | 1 |
| EMS-09 | E2E-01, E2E-02 | 2 |
| **Total** | | **16 / 16** |

No requirement is unmapped; no requirement appears in two phases.
