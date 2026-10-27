#!/usr/bin/env bash
# [DOC: oracle-setup]
set -euo pipefail

HOST=${1:?usage: setup.sh <host, e.g. 129-146-1-2.sslip.io>}
REPO=$(cd "$(dirname "$0")/.." && pwd)
FFMPEG=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-linuxarm64-gpl-9.0.tar.xz
VOICE=https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-aarch64-unknown-linux-gnu

sudo apt-get update
sudo apt-get install -y curl xz-utils debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG"
sudo tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ff*'
rm /tmp/ffmpeg.tar.xz
sudo curl -fsSL -o /usr/local/bin/deep-filter "$VOICE" && sudo chmod +x /usr/local/bin/deep-filter
ffmpeg -hide_banner -version | head -1 && deep-filter --version

command -v uv || curl -LsSf https://astral.sh/uv/install.sh | sh
"$HOME/.local/bin/uv" sync --project "$REPO/backend" --no-dev

sudo mkdir -p /data/jobs && sudo chown "$USER" /data /data/jobs
# [DOC: oracle-firewall]
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport $port -j ACCEPT
done
sudo netfilter-persistent save

sed "s|{host}|$HOST|" "$REPO/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sed "s|{user}|$USER|; s|{repo}|$REPO|; s|{uv}|$HOME/.local/bin/uv|" "$REPO/deploy/rounds-free.service" \
  | sudo tee /etc/systemd/system/rounds-free.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now rounds-free
sudo systemctl reload caddy
echo "Ready: https://$HOST (put the .env at $REPO/.env, then: sudo systemctl restart rounds-free)"
