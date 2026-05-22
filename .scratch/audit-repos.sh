#!/usr/bin/env bash
set -u
ROOT="/c/Users/artic/GitHub"
no_remote=()
no_git=()
ok=()
for dir in "$ROOT"/*/; do
  name=$(basename "$dir")
  if [ ! -d "$dir/.git" ]; then
    no_git+=("$name")
    continue
  fi
  remote=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
  if [ -z "$remote" ]; then
    no_remote+=("$name")
  else
    ok+=("$name | $remote")
  fi
done
echo "=== No .git folder (${#no_git[@]}) ==="
printf '  %s\n' "${no_git[@]}"
echo
echo "=== Has .git, no origin (${#no_remote[@]}) ==="
printf '  %s\n' "${no_remote[@]}"
echo
echo "=== Has origin (${#ok[@]}) ==="
printf '  %s\n' "${ok[@]}" | head -5
echo "  ... and $((${#ok[@]} - 5)) more"
