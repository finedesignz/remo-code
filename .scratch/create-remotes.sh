#!/usr/bin/env bash
set -u
ACCOUNT=finedesignz
REPOS=(aiscreenrecorder effortr google-admin-mcp-server heictopng.com hyperframes tlp-services)
for name in "${REPOS[@]}"; do
  echo "=== $name ==="
  dir="/c/Users/artic/GitHub/$name"
  cd "$dir" || { echo "  skip: no dir"; continue; }
  # Check if remote repo already exists on GitHub (idempotent)
  if gh repo view "$ACCOUNT/$name" >/dev/null 2>&1; then
    echo "  remote $ACCOUNT/$name already exists; setting origin"
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/$ACCOUNT/$name.git"
  else
    echo "  creating $ACCOUNT/$name (private)"
    if ! gh repo create "$ACCOUNT/$name" --private --source=. --remote=origin 2>&1 | tail -3; then
      echo "  FAILED to create"
      continue
    fi
  fi
  # Push the default branch (don't touch dirty working tree)
  branch=$(git rev-parse --abbrev-ref HEAD)
  echo "  pushing $branch..."
  if git push -u origin "$branch" 2>&1 | tail -3; then
    echo "  OK"
  else
    echo "  PUSH FAILED"
  fi
done
