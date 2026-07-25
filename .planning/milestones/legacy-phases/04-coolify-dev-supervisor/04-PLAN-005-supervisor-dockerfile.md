---
plan_id: 04-PLAN-005-supervisor-dockerfile
wave: 2
depends_on: []
files_modified:
  - supervisor/Dockerfile
  - supervisor/.dockerignore
  - supervisor/docker-entrypoint.sh
  - .github/workflows/supervisor-image.yml
autonomous: true
requirements: [REQ-DOCKER-01, REQ-CLAUDE-01]
---

# Plan 04-005 — Containerize the supervisor for Coolify

Build a multi-stage `supervisor/Dockerfile` that bakes Bun + Node + git + a pinned `@anthropic-ai/claude-code` CLI, copies the supervisor source, runs as non-root, and respects Coolify env-driven config. Image entrypoint runs the supervisor with `--role supervisor` against the hub URL from env. No ports exposed (supervisor is a WS client of the hub per ARCHITECTURE-REVIEW §8).

<tasks>

<task id="T1">
<action>Create `supervisor/Dockerfile` (multi-stage). Stage 1 `deps`: `FROM oven/bun:1` (match existing root `Dockerfile`), `WORKDIR /app`, copy `package.json`, `bun.lock`, `supervisor/package.json`, `agent/package.json`, run `bun install --frozen-lockfile`. Stage 2 `runtime`: `FROM oven/bun:1`, install via apt `git ca-certificates curl tini` (`apt-get update && apt-get install -y --no-install-recommends ... && rm -rf /var/lib/apt/lists/*`), install `@anthropic-ai/claude-code` globally at the version pinned in `package.json` (lookup version via `bun pm view @anthropic-ai/claude-code version` at build time and pin in the Dockerfile as an ARG with a documented default), copy `node_modules` + source from `deps`, create non-root user `appuser` (UID 1000) + group `appgroup`, `chown -R appuser:appgroup /app`, `USER appuser`, set `WORKDIR /app`, `ENTRYPOINT ["/usr/bin/tini","--","/app/supervisor/docker-entrypoint.sh"]`. Document the build arg: `ARG CLAUDE_CLI_VERSION=<pinned>`.</action>
<read_first>
- Dockerfile (root hub Dockerfile — match the multi-stage + non-root pattern)
- supervisor/package.json + agent/package.json (workspace structure)
- .planning/phases/04-coolify-dev-supervisor/RESEARCH.md (Standard Stack + Don't Hand-Roll)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §8 (no exposed ports, non-root)
</read_first>
<acceptance_criteria>
- `docker build -f supervisor/Dockerfile .` succeeds from a clean checkout
- Final image runs as `appuser` (verify via `docker run --rm --entrypoint id img` → uid=1000)
- `docker run --rm --entrypoint claude img --version` prints the pinned version
- No `EXPOSE` directive in the Dockerfile (supervisor is a WS client only)
- API keys / secrets are NOT present in any image layer (`docker history` review)
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `supervisor/docker-entrypoint.sh` (chmod +x in the Dockerfile via `RUN chmod +x ...`). Validates required env: `REMO_HUB_URL`, `REMO_API_KEY`, `ANTHROPIC_API_KEY`. If any missing, print a clear error to stderr and exit 1. If `GIT_USER_NAME` / `GIT_USER_EMAIL` set, run `git config --global user.name/email`. If `GITHUB_TOKEN` set, configure git credential helper to inject it for github.com (write `~/.git-credentials` + `git config --global credential.helper store`). Finally `exec bun /app/supervisor/src/index.ts --role supervisor`. The `exec` is important so signals reach the supervisor process directly (tini handles PID 1 reaping for any grandchildren).</action>
<read_first>
- supervisor/src/index.ts (CLI args + env precedence — verify `--role supervisor` is the right flag, or note the actual flag)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §5 (GITHUB_TOKEN via credential helper, not SSH)
</read_first>
<acceptance_criteria>
- Running the container without `REMO_API_KEY` exits with a clear stderr message and exit code 1
- With all required env set, the supervisor process starts and logs the WS connect attempt
- `git config --global --list` inside the running container shows `user.name`, `user.email`, and credential helper when those env vars are provided
- `~/.git-credentials` (if created) has mode 0600 (`chmod 600` after writing)
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `supervisor/.dockerignore`. Exclude: `node_modules`, `.git`, `web/dist`, `web/node_modules`, `hub/test`, `supervisor/test`, `*.md`, `.planning`, `.env*`, `docs`, `out` (measurement output dirs from Plan 004), `coverage`, `*.log`. Keep `package.json`, `bun.lock`, `supervisor/src/**`, `agent/src/**` (supervisor depends on agent code per ARCHITECTURE-REVIEW §1).</action>
<read_first>
- Existing root `.dockerignore` if present (match style)
- supervisor/src/* imports (to verify which other workspace packages must be included)
</read_first>
<acceptance_criteria>
- `docker build -f supervisor/Dockerfile .` build context size is < 50 MB (verify with `docker build --progress=plain` output)
- Image does NOT contain `.planning/`, `docs/`, or any test files (verify with `docker run --rm img find /app -name '*.test.ts'` → empty)
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `.github/workflows/supervisor-image.yml`. Trigger: push to `main` that touches `supervisor/**`, `agent/**`, `package.json`, or `bun.lock`. Steps: checkout, set up Docker Buildx, login to GHCR using `${{ secrets.GITHUB_TOKEN }}`, build with `-f supervisor/Dockerfile` and `--build-arg CLAUDE_CLI_VERSION=<pinned>`, tag as `ghcr.io/<owner>/remo-supervisor:latest` and `ghcr.io/<owner>/remo-supervisor:sha-${{ github.sha }}`, push both. Use `actions/cache` for Bun + apt layers.</action>
<read_first>
- .github/workflows/* (existing CI patterns, image registry conventions if any)
- supervisor/Dockerfile (the file just created)
</read_first>
<acceptance_criteria>
- Workflow file passes `actionlint` (or `yq eval` parses cleanly)
- Trigger paths cover supervisor + agent + lockfile changes only — not unrelated commits
- Image is tagged both `:latest` and `:sha-<sha>` so Coolify can pin
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `supervisor/Dockerfile` builds a runnable image with Bun + Node + git + pinned `@anthropic-ai/claude-code`
- Image runs as a non-root user, exposes no ports, uses tini for PID 1 reaping
- Secrets are env-only — never baked into image layers
- Entrypoint validates required env and configures git from env without prompting
- CI publishes the image to GHCR on every relevant push to main

rollback_plan:
- Delete the Dockerfile + workflow; production hub container is unaffected.

risks:
- The pinned Claude CLI version drifts. Document in CLAUDE.md the rerun command to bump (`bun pm view ...` + bump ARG default + commit).
- `apt` package versions are not pinned — minor reproducibility risk. Acceptable for this phase.
