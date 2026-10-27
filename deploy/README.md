# deploy

The free tier's server: an Oracle Cloud Always Free VM (Ampere A1, 4 OCPU, 24 GB, Ubuntu 24.04, arm64) running `rounds.free` (`backend/rounds/README.md`, Free server) behind Caddy. `setup.sh` installs everything; `Caddyfile` and `rounds-free.service` are templates it fills in. `.gitattributes` keeps them LF: a CRLF checkout on Windows breaks bash and systemd.

## Oracle setup

`setup.sh <host>` on the VM, from a clone of the repo, as the default `ubuntu` user:

- FFmpeg: the BtbN `linuxarm64-gpl` build of the same autobuild as the Modal image (`backend/rounds/app.py`, `FFMPEG`), so both tiers encode with the same libsvtav1 / libx265 / libvpx.
- DeepFilterNet3: `deep-filter-0.5.6-aarch64-unknown-linux-gnu` to `/usr/local/bin/deep-filter` (`config.DEEP_FILTER`); both release assets were found on GitHub on 2026-10-27, not yet run on A1.
- uv, `uv sync --no-dev` of `backend/`, and `/data/jobs` (the same `DATA_DIR` as the Modal Volume mount, so `config.py` is unchanged).
- The service runs `uv run --no-dev --with uvicorn uvicorn rounds.free:app` on 127.0.0.1:8000. `--with` keeps uvicorn out of the project: Modal brings its own ASGI server, only this host needs one. The environment comes from `<repo>/.env`, a copy of the root `.env` (systemd `EnvironmentFile`).
- Host name: Let's Encrypt needs a name, not a bare IP, so `<ip-with-dashes>.sslip.io` (a free wildcard DNS that resolves to the IP inside the name). Caddy gets and renews the certificate itself.
- Update: `git pull && uv sync --project backend --no-dev && sudo systemctl restart rounds-free`. Logs: `journalctl -u rounds-free -f`.

## Oracle firewall

Two firewalls must open 80 (the ACME challenge) and 443: the VCN security list (console: Networking → Virtual cloud networks → the subnet → Security list → Ingress rules, source `0.0.0.0/0`, TCP 80 and 443) and the Ubuntu image's own iptables, whose `INPUT` chain rejects everything but SSH. `setup.sh` inserts the two ACCEPT rules before the REJECT and saves them with `netfilter-persistent`.

## Idle reclaim

Oracle reclaims an Always Free VM whose 95th percentile of CPU, network and memory stays under 20 % for 7 days (docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm, read 2026-10-27). A quiet bot hits that. The same page scopes the rule to Always Free accounts; an upgrade to Pay As You Go, where Always Free resources stay free, is the usual way out (not verified here beyond that page). Do not add a fake load loop instead.
