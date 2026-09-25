#!/bin/bash
# Remo Code supervisor for Claude Code cloud sessions (claude.ai/code).
#
# Paste into the cloud environment's "Setup script" box:
#
#   #!/bin/bash
#   curl -fsSL https://raw.githubusercontent.com/finedesignz/remo-code/main/tools/cloud-session/setup.sh | bash
#
# Environment variables (cloud environment settings → Environment variables):
#   REMO_API_KEY            required. An agent-scoped "Additional host" key
#                           (web: Settings → Credentials → Create key → agent
#                           + Additional host). Without it this script is a no-op.
#   REMO_HUB_URL            default https://app.remo-code.com
#   REMO_ROOTS              colon-separated scan roots, default /home/user
#   REMO_MAX_CONCURRENT     default 2
#   REMO_ALLOW_DANGEROUS    1 ⇒ allow --dangerously-skip-permissions, default 0
#   REMO_CODE_REF           git ref of the supervisor source, default main
#
# Network access must allow app.remo-code.com (Full, or a custom allowlist).
# Full walkthrough: docs/cloud-session-supervisor.md.
#
# Never fails the session: every error is logged and the script exits 0.

set -u
log() { echo "[remo-cloud] $*"; }

if [ -z "${REMO_API_KEY:-}" ]; then
  log "REMO_API_KEY not set — skipping Remo supervisor setup"
  exit 0
fi

REMO_HOME="${REMO_HOME:-$HOME/.remo-code}"
REMO_CODE_REF="${REMO_CODE_REF:-main}"
REPO_URL="https://github.com/finedesignz/remo-code"

main() {
  # 1. Toolchain. The default cloud image ships bun + node; install bun if not.
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    log "installing bun"
    curl -fsSL https://bun.sh/install | bash || return 1
  fi
  command -v node >/dev/null 2>&1 || { log "node not found (needed for the PTY host)"; return 1; }
  command -v claude >/dev/null 2>&1 || log "warning: claude CLI not on PATH"

  # 2. Supervisor source (public repo, shallow).
  if [ -d "$REMO_HOME/.git" ]; then
    git -C "$REMO_HOME" fetch --depth 1 origin "$REMO_CODE_REF" && git -C "$REMO_HOME" checkout -q FETCH_HEAD || return 1
  else
    git clone -q --depth 1 --branch "$REMO_CODE_REF" "$REPO_URL" "$REMO_HOME" || return 1
  fi

  # 3. Supervisor deps only (node-pty builds from source on linux).
  (cd "$REMO_HOME/supervisor" && bun install --no-save) || return 1

  # 4. supervisor.json (XDG path the supervisor reads on linux).
  bun "$REMO_HOME/tools/cloud-session/write-config.ts" || return 1

  # 5. Keep it running: a user-level SessionStart hook restarts it on every
  #    session start/resume (the container can be reclaimed and resumed).
  bun "$REMO_HOME/tools/cloud-session/install-hook.ts" "$REMO_HOME/tools/cloud-session/start.sh" || return 1

  # 6. Start now too (no-op if already running).
  bash "$REMO_HOME/tools/cloud-session/start.sh"
}

if main; then
  log "done"
else
  log "setup failed — session continues without the Remo supervisor"
fi
exit 0
