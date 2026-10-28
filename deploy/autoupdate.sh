#!/usr/bin/env bash
# [DOC: oracle-autoupdate]
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
chmod +x "$REPO/deploy/update.sh"
sed "s|{user}|$USER|; s|{repo}|$REPO|" "$REPO/deploy/rounds-update.service" | sudo tee /etc/systemd/system/rounds-update.service >/dev/null
sudo cp "$REPO/deploy/rounds-update.timer" /etc/systemd/system/rounds-update.timer
sudo systemctl daemon-reload
sudo systemctl enable --now rounds-update.timer
