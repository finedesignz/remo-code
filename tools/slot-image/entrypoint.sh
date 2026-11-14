#!/bin/sh
# CORCH-10: per-slot supervisor entrypoint. Reads runtime env only; writes nothing secret into the image.
set -eu

need() { eval "v=\${$1:-}"; [ -n "$v" ] || { echo "[remo-slot] $1 is required" >&2; exit 64; }; }
need REMO_ACCOUNT_SLOT
need REMO_HUB_URL
need REMO_API_KEY
need CLAUDE_CODE_OAUTH_TOKEN

# supervisor.json (0600) from env, reusing the cloud-session writer.
bun /opt/remo/tools/cloud-session/write-config.ts >/dev/null

# Per-slot Claude settings.json permission allowlist (CORCH A8); never overwrite an operator-edited file.
SETTINGS="${REMO_SLOT_CLAUDE_CONFIG_DIR:-/data/claude}/settings.json"
if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  cat >"$SETTINGS" <<'JSON'
{
  "permissions": {
    "allow": ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "Bash(bun:*)", "Bash(npm:*)", "Bash(gh:*)"],
    "deny": ["Bash(sudo:*)"]
  }
}
JSON
fi

# Optional git credentials from runtime env (never persisted to a file).
if [ -n "${REMO_GIT_TOKEN:-}" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$REMO_GIT_TOKEN"; }; f'
fi

exec bun src/index.ts run
