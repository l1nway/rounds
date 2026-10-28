#!/usr/bin/env bash
# [DOC: oracle-autoupdate]
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
git fetch --quiet origin main
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)
[ "$OLD" = "$NEW" ] && exit 0
git merge --ff-only origin/main
if ! git diff --quiet "$OLD" "$NEW" -- backend; then
  "$HOME/.local/bin/uv" sync --project backend --no-dev
  sudo systemctl restart rounds-free
fi
echo "updated $OLD -> $NEW"
