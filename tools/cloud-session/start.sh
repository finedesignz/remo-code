#!/bin/bash
# Start the Remo supervisor in the background if it isn't already running.
# Idempotent — called by setup.sh and by the SessionStart hook it installs.
# Always exits 0 and prints at most one line (hook output lands in context).

REMO_HOME="${REMO_HOME:-$HOME/.remo-code}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/remo-code-supervisor"
PIDFILE="$STATE_DIR/cloud.pid"
export PATH="$HOME/.bun/bin:$PATH"

mkdir -p "$STATE_DIR"
# Alive = the pid exists AND is still our supervisor (a restored container can
# hand a stale pidfile's pid to an unrelated process).
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE")"
  if [ -n "$pid" ] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "src/index.ts run"; then
    exit 0
  fi
fi
if [ ! -f "$REMO_HOME/supervisor/src/index.ts" ]; then
  echo "[remo-cloud] supervisor not installed at $REMO_HOME (setup script not run?)"
  exit 0
fi

cd "$REMO_HOME/supervisor" || exit 0
# setsid + nohup: detach from the hook's process group so the supervisor
# outlives the hook. It writes its own log under $STATE_DIR.
setsid nohup bun src/index.ts run >>"$STATE_DIR/cloud-stdout.log" 2>&1 </dev/null &
echo $! >"$PIDFILE"
echo "[remo-cloud] supervisor started (pid $!)"
exit 0
