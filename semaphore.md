# Semaphore UI — Ansible web interface on gateways

Self-hosted [Semaphore UI](https://semaphoreui.com) (v2.18) on both
gateways (nbg-1 + vie-1) for running Ansible playbooks against the fleet
from a browser, behind Authelia 2FA.

Deployed 2026-10-13.

## Access

| Gateway | URL |
|---|---|
| nbg-1 | `https://semaphore.gw-1-nbg-1-de-netcup.rwnix.net` |
| vie-1 | `https://semaphore.gw-1-vie-1-at-netcup.rwnix.net` |

Both go through NPM (port 443) → Authelia 2FA → Semaphore login.
SSL: existing wildcard Let's Encrypt cert (DNS-01 via Cloudflare).

**Semaphore admin credentials** (host-local `.env`, `chmod 600`):
- nbg-1: `/home/ubuntu/docker/semaphore/.env`
- vie-1: `/home/ubuntu/docker/semaphore/.env`
- User: `admin`
- Password: see `.env` → `SEMAPHORE_ADMIN_PASSWORD`

## Architecture

- **Image**: `semaphoreui/semaphore:latest` (Go binary, ~320 MB)
- **Network**: `host` mode (shares host network — needed for SSH to the
  host itself at `127.0.0.1:22` and for WireGuard mesh reachability)
- **Port**: 3002 (host mode, `SEMAPHORE_PORT=3002`)
- **DB**: SQLite (`SEMAPHORE_DB_DIALECT=sqlite`), volume
  `semaphore-data` → `/var/lib/semaphore` (the DB lives at
  `/var/lib/semaphore/database.sqlite` inside the container)
- **Playbooks**: bind-mount `./playbooks` → `/home/playbooks` (local git
  repo; Semaphore pulls on each task run)
- **SSH key**: `/home/ubuntu/.ssh` mounted read-only at
  `/home/runner/.ssh` (fallback; Semaphore's own credential store is
  primary)
- **extra_hosts**: full mesh alias set (same as `mesh-test-hosts.txt`),
  so Ansible can resolve `pve103`, `vm104`, `owrt011`, etc. by name
  without a DNS lookup

## NPM proxy host

Inserted directly into the NPM SQLite DB (not via API):
- nbg-1: proxy_host id **48**, conf at `data/nginx/proxy_host/48.conf`
- vie-1: proxy_host id **60**, conf at `data/nginx/proxy_host/60.conf`

Both use the existing wildcard cert (`npm-6` / `npm-24`), HTTP→HTTPS
force, Authelia gate via global `server_proxy.conf` include.

Authelia domain added to the `two_factor` rule list in
`authelia/config/configuration.yml` on both gateways.

## Playbooks

Local git repo at `/home/ubuntu/docker/semaphore/playbooks/` (nbg-1).
Repo in Semaphore: name `playbooks`, type Git, URL `/home/playbooks`,
branch `main`.

| File | Purpose |
|---|---|
| `ping.yml` | `ping` + `hostnamectl` on all inventory hosts |
| `install-mc.yml` | `apt install mc` (become: true) |

To add a playbook: edit in the repo dir on the host, `git add` +
`git commit`, re-run the template. Mirror new files into
`hosts/nbg-1/semaphore/playbooks/` in this repo.

## Inventories (Semaphore UI)

Use **mesh IPs**, not public IPs (ufw blocks the Docker bridge and
container IPs from reaching the host's port 22):

- Self (same gateway) → `127.0.0.1`
- Peer gateway → WireGuard mesh IP (`10.1.1.17` / `10.2.1.17`)
- PVE/VMs → private LAN IPs (routed via the mesh)
- OpenWrt gateways → `10.1.1.x` (from nbg-1) / `10.2.1.x` (from vie-1)

SSH credential in Semaphore: `kandev` (the `~/.ssh/kandev` key).

## Compose files

- `hosts/nbg-1/semaphore/docker-compose.yml`
- `hosts/vie-1/semaphore/docker-compose.yml`
- `.env.example` in each dir (no secrets in repo)

## Known gotchas

- **DB path**: Semaphore writes to `/var/lib/semaphore/database.sqlite`
  (not `/etc/semaphore/`). The volume **must** mount `/var/lib/semaphore`
  or the DB (and admin user) is lost on every container recreate.
- **Network mode**: must be `host`. Bridge mode + ufw = SSH to
  `127.0.0.1` (the container's own loopback) fails, and the Docker
  bridge gateway IP is firewalled.
- **Port 3000** is taken by Grafana on both gateways → Semaphore uses
  3002.
- **NPM config files** (`48.conf`, `60.conf`) are hand-written. If NPM
  regenerates them (cert renewal, UI save), re-add through the NPM UI:
  Domain `semaphore.gw-1-*`, Forward `127.0.0.1:3002`, SSL on (wildcard
  cert), Authelia via the global `server_proxy.conf`.
