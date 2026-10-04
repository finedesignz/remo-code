#!/usr/bin/env bash
# install-gsd.sh: install GSD for one routine run. Owner directive 2026-10-04.
#
# Run from the root of the repo checkout, first thing every run:
#   git fetch origin routine/state
#   git show origin/routine/state:.planning/routine/install-gsd.sh | bash
#
# 1. gsd-core (public npm, @opengsd/gsd-core): every gsd-* skill, agent and hook,
#    installed globally for Claude Code. Non-interactive, about 15 seconds.
# 2. gsd-cloud-kit (private, finedesignz/gsd-cloud-kit), only if this session can
#    clone it: adds gsd-gate-panel and the references it needs into the project's
#    .claude/. Copies only files that are missing and git-excludes them, so they are
#    never committed. Skipped quietly when the repo is out of this session's scope.
#
# Idempotent and never fatal: always exits 0 and ends with one
# "install-gsd: ..." summary line for STATE.md.
set -uo pipefail

GSD_CORE_VERSION="${GSD_CORE_VERSION:-latest}"   # pin with e.g. GSD_CORE_VERSION=1.15.0
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
log() { echo "[install-gsd] $*"; }
core="skipped"
kit="skipped"

# 1. gsd-core
if command -v npx >/dev/null 2>&1; then
	if timeout 300 npx -y "@opengsd/gsd-core@${GSD_CORE_VERSION}" --claude --global </dev/null >/tmp/install-gsd-core.log 2>&1; then
		n=$(find "$CFG/skills" -maxdepth 1 -type d -name 'gsd-*' 2>/dev/null | wc -l)
		core="ok (${n} gsd skills in $CFG/skills)"
	else
		core="FAILED (see /tmp/install-gsd-core.log)"
		tail -5 /tmp/install-gsd-core.log | sed 's/^/[install-gsd]   /'
	fi
else
	core="skipped (no npx; install Node.js)"
fi
log "gsd-core: $core"

# 2. gsd-cloud-kit extras (gsd-gate-panel and friends), project-scoped
if git rev-parse --show-toplevel >/dev/null 2>&1; then
	ROOT="$(git rev-parse --show-toplevel)"
	KIT="$(mktemp -d)"
	if timeout 120 git clone -q --depth 1 https://github.com/finedesignz/gsd-cloud-kit "$KIT/kit" >/dev/null 2>&1; then
		added=0
		for sub in skills gsd-core agents; do
			[ -d "$KIT/kit/$sub" ] || continue
			while IFS= read -r -d '' f; do
				rel="${f#"$KIT/kit/$sub"/}"
				dest="$ROOT/.claude/$sub/$rel"
				if [ ! -e "$dest" ]; then
					mkdir -p "$(dirname "$dest")"
					cp "$f" "$dest"
					added=$((added + 1))
					# Never let a routine commit vendored kit files.
					ex="/.claude/$sub/$rel"
					grep -qxF "$ex" "$ROOT/.git/info/exclude" 2>/dev/null || echo "$ex" >>"$ROOT/.git/info/exclude"
				fi
			done < <(find "$KIT/kit/$sub" -type f -print0)
		done
		kit="ok (${added} files added under .claude/, git-excluded)"
	else
		kit="skipped (finedesignz/gsd-cloud-kit not reachable from this session; gsd-gate-panel unavailable, use the directive's subagent-panel fallback)"
	fi
	rm -rf "$KIT"
else
	kit="skipped (not inside a git checkout)"
fi
log "gsd-cloud-kit: $kit"

echo "install-gsd: gsd-core ${core}; cloud-kit ${kit}"
exit 0
