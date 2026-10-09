# Docker VM inventory

All Proxmox VE hosts that run a Docker VM, plus the Docker containers running on
each. The adjacent [`pve-hosts.md`](pve-hosts.md) covers the PVE hosts
themselves (hardware, versions, OpenWrt gateways) and the mesh-test procedure.

Inventory compiled 2026-10-09 by logging into every PVE host and every
reachable Docker VM (see [Access notes](#access-notes) below).

---

## Table of contents

1. [Public PVE hosts — Docker VMs](#public-pve-hosts--docker-vms)
2. [Internal PVE hosts — Docker VMs](#internal-pve-hosts--docker-vms)
3. [Standard Docker hosts (gateways + GPU VMs)](#standard-docker-hosts-gateways--gpu-vms)
4. [Wine + MetaTrader 5 containers](#wine--metatrader-5-containers)
5. [Agent DVR containers (Hetzner)](#agent-dvr-containers-hetzner)
6. [Undeployed / stopped Wine configs](#undeployed--stopped-wine-configs)
7. [Access notes](#access-notes)

---

## Public PVE hosts — Docker VMs

| PVE host | Docker VM name | IP | OS | RAM | Disk | SSH user | Auth |
|---|---|---|---|---|---|---|---|
| `fsn-1` (144.76.14.155, Hetzner) | `docker-1-pve-211-dc10-fsn1-de-hetzner` | 192.168.111.111 | Ubuntu 26 | 20 GB | 256 GB | `ubuntu` | `ubuntu` |
| `hel-1` (65.109.122.228, Hetzner) | `docker-1-pve-212-dc5-hel1-fi-hetzner` | 192.168.112.111 | Ubuntu 26 | 51 GB | 256 GB | `ubuntu` | `ubuntu` |
| `gra-1` (5.196.93.234, OVH FR) | `docker-1-pve-1-gra-1-fr-ovh` | 192.168.116.11 | Ubuntu 26 | 12 GB | 300 GB | `ubuntu` | `ubuntu` |
| `lim-1` (51.75.145.232, OVH DE) | `docker-1-pve-1-lim-1-de-ovh` | 192.168.115.11 | Ubuntu 26 | 12 GB | 300 GB | `ubuntu` | `ubuntu` |
| `eri-1` (51.89.192.92, OVH UK) | `docker-1-pve-1-eri-1-uk-ovh` | 192.168.113.11 | Ubuntu 26 | 14 GB | 256 GB | `ubuntu` | `ubuntu` |
| `eri-1` | `docker-2-pve-1-eri-1-uk-ovh` | 192.168.113.12 | Ubuntu 26 | 14 GB | 256 GB | `ubuntu` | `*$Toor2003*$` |
| `waw-1` (51.83.220.93, OVH PL) | `docker-1-pve-1-waw-1-pl-ovh` | 192.168.114.11 | Ubuntu 26 | 14 GB | 256 GB | `ubuntu` | `ubuntu` |
| `waw-1` | `docker-2-pve-1-waw-1-pl-ovh` | 192.168.114.12 | Ubuntu 26 | 14 GB | 256 GB | `ubuntu` | `*$Toor2003*$` |

### fsn-1 docker (192.168.111.111)

| Container | Image | Ports | Status |
|---|---|---|---|
| `agent-dvr-1-docker-1-pve-211-dc10-fsn1-de-hetzner` | `doitandbedone/ispyagentdvr:latest` | 8090/tcp, 3478/udp, 50000-50010/udp | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 8 days |

### hel-1 docker (192.168.112.111)

| Container | Image | Ports | Status |
|---|---|---|---|
| `agent-dvr-1-docker-1-pve-212-dc5-hel1-fi-hetzner` | `doitandbedone/ispyagentdvr:latest` | 8090/tcp, 3478/udp, 50000-50010/udp | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 8 days |

### gra-1 docker (192.168.116.11)

| Container | Image | Status |
|---|---|---|
| `victoriametrics` | `victoriametrics/victoria-metrics` | Up 8 days |
| `grafana` | `grafana/grafana:latest` | Up 8 days |
| `kandev-3` | `kandev:custom` | Up 8 days |
| `nginx-proxy-manager` | `jc21/nginx-proxy-manager:2.15.1` | Up 8 days |
| `wetty` | `ghcr.io/butlerx/wetty` | Up 8 days |
| `vscode` | `lscr.io/linuxserver/vscode:latest` | Up 8 days |
| `glances` | `nicolargo/glances:latest-full` | Up 8 days |
| `glance` | `nginx:1.27-alpine` | Up 8 days |
| `portainer` | `portainer/portainer-ce` | Up 8 days |
| `kandev` | `74186cdc1590` | **Exited** (6 weeks ago) |
| `telegraf` | `telegraf:latest` | **Exited** (7 weeks ago) |
| `mosquitto` | `eclipse-mosquitto:2` | **Exited** (7 weeks ago) |

### lim-1 docker (192.168.115.11)

| Container | Image | Status |
|---|---|---|
| `victoriametrics` | `victoriametrics/victoria-metrics` | Up 8 days |
| `grafana` | `grafana/grafana:latest` | Up 8 days |
| `kandev-4` | `kandev:custom` | Up 8 days |
| `nginx-proxy-manager` | `jc21/nginx-proxy-manager:2.15.1` | Up 8 days |
| `wetty` | `ghcr.io/butlerx/wetty` | Up 8 days |
| `vscode` | `lscr.io/linuxserver/vscode:latest` | Up 8 days |
| `glances` | `nicolargo/glances:latest-full` | Up 8 days |
| `glance` | `nginx:1.27-alpine` | Up 8 days |
| `portainer` | `portainer/portainer-ce` | Up 8 days |
| `telegraf` | `telegraf:latest` | Up 8 days |
| `mosquitto` | `eclipse-mosquitto:2` | Up 8 days |
| `kandev` | `74186cdc1590` | **Exited** (6 weeks ago) |

### eri-1 docker-1 (192.168.113.11) — Wine/MT5 host

| Container | Image | Ports | Status |
|---|---|---|---|
| `mt5-1-activtrades-1` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | **10101** → 3001 | Up 8 days |
| `mt5-1-fxpro-1` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | **20101** → 3001 | Up 8 days |
| `mt5-1-xm-1` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | **30101** → 3001 | Up 8 days |
| `mt5-socket-api-bridge-1` | `mt5-socket-api-bridge:latest` | 5555 | Up 8 days |
| `mariadb-1` | `mariadb:11.5` | 3306 | Up 8 days |
| `phpmyadmin-1` | `phpmyadmin/phpmyadmin:latest` | 8080 → 80 | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 8 days |

### eri-1 docker-2 (192.168.113.12) — Wine/MT5 host

| Container | Image | Ports | Status |
|---|---|---|---|
| `mt5-1-fxpro-1` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | **20101** → 3001 | Up 8 days |
| `mt5-socket-api-bridge-1` | `mt5-socket-api-bridge:latest` | 5555 | Up 8 days |
| `mariadb-1` | `mariadb:11.5` | 3306 | Up 8 days |
| `phpmyadmin-1` | `phpmyadmin/phpmyadmin:latest` | 8080 → 80 | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 8 days |

### waw-1 docker-1 (192.168.114.11) — Wine/MT5 host

| Container | Image | Ports | Status |
|---|---|---|---|
| `mt5-1-activtrades-1` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | **10101** → 3001 | Up 8 days |
| `mt5-socket-api-bridge-1` | `mt5-socket-api-bridge:latest` | 5555 | Up 8 days |
| `mariadb-1` | `mariadb:11.5` | 3306 | Up 8 days |
| `phpmyadmin-1` | `phpmyadmin/phpmyadmin:latest` | 8080 → 80 | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 8 days |

### waw-1 docker-2 (192.168.114.12)

| Container | Image | Status |
|---|---|---|
| `mariadb-1` | `mariadb:11.5` | Up 8 days |
| `phpmyadmin-1` | `phpmyadmin/phpmyadmin:latest` | Up 8 days |
| `mt5-socket-api-bridge-1` | `mt5-socket-api-bridge:latest` | Up 8 days |
| `portainer` | `portainer/portainer-ce:latest` | Up 8 days |

No MT5/Webtop container — `mt5-1-xm-1` compose dir exists but was never
deployed (no `.env` file, no webtop image pulled).

---

## Internal PVE hosts — Docker VMs

| PVE host | Docker VM name | IP | OS | RAM | Disk | SSH user | Auth |
|---|---|---|---|---|---|---|---|
| `pve101` (behind owrt011) | `docker-1-pve-101-5g01-at-a1` | 192.168.51.111 | Ubuntu 26 | 40 GB | 256 GB | `ubuntu` | PVE root key |
| `pve102` (behind owrt011) | `docker-1-pve-102-5g01-at-a1` | 192.168.52.111 | Ubuntu 26 | **124 GB** | **768 GB** | `ubuntu` | PVE root key |
| `pve103` (home LAN) | `vm103` | 192.168.53.111 | Ubuntu 26 | — | — | `ubuntu` | SSH key |
| `pve104` (home LAN) | `vm104` | 192.168.54.111 | Ubuntu 26 | — | — | `ubuntu` | SSH key |

`pve1070` (192.168.141.1) does **not** have a Docker VM.

### pve101 docker (192.168.51.111)

| Container | Image | Ports | Status |
|---|---|---|---|
| `vscode` | `lscr.io/linuxserver/vscode:latest` | 192.168.51.111:3001 → 3001 | Up 5 weeks |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 5 weeks |

### pve102 docker (192.168.52.111)

| Container | Image | Ports | Status |
|---|---|---|---|
| `vscode` | `lscr.io/linuxserver/vscode:latest` | 192.168.52.111:3001 → 3001 | Up 5 weeks |
| `portainer` | `portainer/portainer-ce:latest` | 8000, 9000, 9443 | Up 5 weeks |

For the standard gateway / GPU VM Docker hosts (`nbg-1`, `vie-1`, `vm103`,
`vm104`, `gpu-1`, `gpu-2`) see [`hosts/README.md`](hosts/README.md) and the
compose files in [`hosts/`](hosts/).

---

## Wine + MetaTrader 5 containers

**5 containers** running on **3 Docker VMs**, all using the same stack:

- **Image**: `lscr.io/linuxserver/webtop:ubuntu-xfce` (3.31 GB)
- **Wine**: **10.0** apt-installed at first run (`wine64` + `wine32:i386` +
  `winbind`; verified live: `wine-10.0 (Ubuntu 10.0~repack-12ubuntu1)`)
- **Desktop**: XFCE delivered in-browser via Selkies (WebRTC/JPEG encoder)
- **Platform**: MetaTrader 5 (MT5) trading terminal
- **Init**: A busybox init sidecar generates `custom-cont-init.d` startup
  scripts (`01-install-wine.sh`, `02-install-mt5.sh`, `04-apply-config.sh`)
  before the main container starts
- **Auth**: Browser access requires password (set per-container in `.env`)

| VM | Container | Broker | Web UI port | Status |
|---|---|---|---|---|
| eri-1 docker-1 | `mt5-1-activtrades-1` | ActivTrades | **10101** → 3001 | Up 8 days |
| eri-1 docker-1 | `mt5-1-fxpro-1` | FxPro | **20101** → 3001 | Up 8 days |
| eri-1 docker-1 | `mt5-1-xm-1` | XM | **30101** → 3001 | Up 8 days |
| eri-1 docker-2 | `mt5-1-fxpro-1` | FxPro | **20101** → 3001 | Up 8 days |
| waw-1 docker-1 | `mt5-1-activtrades-1` | ActivTrades | **10101** → 3001 | Up 8 days |

Each MT5 container has a companion `mt5-socket-api-bridge-1` (port 5555) that
exposes a socket API, and a shared `mariadb-1` + `phpmyadmin-1` stack (tick
collection; the MariaDBs replicate to vm104 slaves, see
[`hosts/vm104/`](hosts/vm104/)).

### Port allocation

`HOST_PORT = BROKER_BASE + ACCOUNT * 100 + TERMINAL`, with
`BROKER_BASE`: activtrades 10000, fxpro 20000, xm 30000 — so account 1,
terminal 1 gives **10101** (ActivTrades), **20101** (FxPro), **30101** (XM).
Terminal/account numbers allow multiple terminals or accounts per broker
(e.g. `mt5-4-fxpro-1` → 20104). The pattern is consistent across VMs (e.g.
eri-1 docker-1 and docker-2 both use 20101 for FxPro — each is a separate
MT5 instance with its own config).

### MT5 exe installer setup (3 brokers)

Each broker ships its own **branded MT5 setup exe**, stored in the untracked
source tree and mounted read-only into each container at
`/installer/<broker>/<broker>5setup.exe`:

| Broker | Installer | Size | Installs as |
|---|---|---|---|
| ActivTrades | `activtrades5setup.exe` | 7.2 MB | `C:\Program Files\MetaTrader 5 - ActivTrades` |
| FxPro | `fxpro5setup.exe` | 7.2 MB | FxPro-branded dir |
| XM | `xm5setup.exe` | 5.0 MB | XM-branded dir |

**Source of truth** (untracked in this repo by design):
`vm104:/home/ubuntu/projects/docker/` — `setup-wine-mt5.sh` (deploy
controller, run from vm104 over the mesh), `deploy-settings.sh` (polling-loop
timeouts), `AGENTS.md` (design notes + fix history), and `docker/wine-mt5/`
(canonical `docker-compose.yml`, init scripts, per-container
`config/<container-name>/mt5.ini` + `experts/`, `installer/<broker>/`).
Per-host copies live at `/home/ubuntu/docker/mt5-<T>-<B>-<A>/` on the Docker
VMs; the `setup-wine-mt5.sh` copy scp'd into their `~/scripts/` is **stale**
— run deploys from vm104.

**Install flow** (first boot, `02-install-mt5.sh` inside the container):

1. Start `Xvfb :99` (1440x900x16) + `wineboot -u`, then run
   `wine "<broker>5setup.exe" /auto` in the background as user `abc`; the PID
   is written to `/tmp/.mt5-markers/setup-pid` for the deploy script.
2. Wait for setup.exe to exit, then for the install dir containing
   `terminal64.exe` (broker-named; matched by `find -iname "*<broker>*"`,
   fallbacks `*mt5*` / `*metatrader*`).
3. Pin Wine DPI (`LogPixels=96`, `Win8DpiScaling=1`) to stop font-scaling
   drift, and symlink the `x:` drive to the install dir.

**Account config**: `config/<container-name>/mt5.ini` holds
`[Common] Login/Server/Password` (e.g. `ActivTrades-Server`,
`FxPro-MT5 Demo`, `XM.COM-MT5`); the `mt5.ini.prd` file holds the **live**
account while `mt5.ini` holds the current demo/test one. The deploy renames
it to `mt5-<T>-<B>-<A>.ini`; MT5's **first launch runs with `/config:`** so
the ini credentials log in, then after a graceful exit a `.no-config` marker
switches all future starts to no-`/config:` mode (MT5 reads saved binary
state + `common.ini`).

**EA + deploy pipeline** (`setup-wine-mt5.sh <container-name> --fresh|--compile`
from vm104): scp compose/scripts/ini/experts/installer → `docker compose up -d`
→ polling loops using the `deploy-settings.sh` timeouts (init ≤180s,
setup.exe PID ≤180s, setup.exe exit ≤180s, MT5 dir ≤60s, start ≤120s, stop
≤45s — no hardcoded sleeps) → copy `.mq5` experts (tick collectors +
`mt5-socket-api-bridge.mq5`) → headless-compile with
`MetaEditor64.exe /compile` under Xvfb :99 → 3-phase graceful stop
(`xdotool` → `wine taskkill /IM terminal64.exe` → SIGTERM + `wineserver -k`)
→ start without `/config:` → verify the PID alive 5s.

---

## Agent DVR containers (Hetzner)

Two Docker VMs on Hetzner Proxmox hosts run **Agent DVR** (surveillance):

| VM | Container | Ports | Status |
|---|---|---|---|
| fsn-1 docker (192.168.111.111) | `agent-dvr-1-docker-1-pve-211-dc10-fsn1-de-hetzner` | 8090 (web UI), 3478/udp (TURN), 50000-50010/udp (WebRTC) | Up 8 days |
| hel-1 docker (192.168.112.111) | `agent-dvr-1-docker-1-pve-212-dc5-hel1-fi-hetzner` | 8090 (web UI), 3478/udp (TURN), 50000-50010/udp (WebRTC) | Up 8 days |

Image: `doitandbedone/ispyagentdvr:latest` (936 MB). No Wine.

---

## Undeployed / stopped Wine configs

These compose files and directories exist on various hosts but are **not**
currently running:

| Host | Path / compose dir | Image | Status |
|---|---|---|---|
| **vie-1** | `scripts/docker/docker-wine/` | `scottyhardy/docker-wine:stable-11.0` | Never deployed |
| **vie-1** | `scripts/docker/webtop-wine/` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | Never deployed |
| **vm104** | `projects/docker/docker/wine-mt5/` | `lscr.io/linuxserver/webtop:ubuntu-xfce` | Never deployed |
| **eri-1 docker-2** | `mt5-1-xm-1/`, `mt5-1-activtrades-1/` | Same webtop+Wine+MT5 | Containers stopped |
| **waw-1 docker-1** | `mt5-1-xm-1/` | Same webtop+Wine+MT5 | Never deployed (no `.env`) |
| **waw-1 docker-2** | `mt5-1-xm-1/` | Same webtop+Wine+MT5 | Never deployed (no `.env`) |

---

## Access notes

### SSH credentials

| Host type | User | Auth method |
|---|---|---|
| PVE hosts (all) | `root` | SSH key (`~/.ssh/kandev`) |
| **All 10 Docker VMs** | `ubuntu` | **kandev mesh key** (installed 2026-10-09) — key auth from both kandev sandboxes and from the mesh; passwords still work: `ubuntu` (all) except eri-1/waw-1 docker-2: `*$Toor2003*$` |

### Network reachability

- **Public PVE hosts** (fsn-1, hel-1, gra-1, lim-1, eri-1, waw-1) are directly
  reachable from the internet at their public IPs.
- **Internal PVE hosts** (pve103, pve104) are on the home LAN (192.168.15.0/24)
  and reachable from vm104 or via the WireGuard mesh.
- **pve101, pve102** are behind `owrt011` and were originally only reachable
  via the mesh (through nbg-1/vie-1 → owrt011). Routes were added on
  2026-10-09 to make them reachable from vm104.
- **Docker VMs are reachable from both kandev sandboxes via the WireGuard
  mesh** (2026-10-09). The OWRT gateway VM on each PVE sits on the PVE's
  docker bridge (`eth0 192.168.11x.1/24` on `vmbr1`) and advertises the
  subnet in its hub `AllowedIPs` — fsn-1 (`.111`), hel-1 (`.112`), pve101/102
  (`.51`/`.52` via owrt011) were already set up; `owrt_eri-1` (`.113`),
  `owrt_waw-1` (`.114`), `owrt_lim-1` (`.115`), `owrt_gra-1` (`.116`) got
  their subnets added on both hubs on 2026-10-09 (wg-easy
  `server_allowed_ips`, see `kirks2003/rw_mesh` — `kandev-mesh-access.md`).
- **PVE → docker VM (management):** the OVH PVE `vmbr1` bridges have **no
  host IP** (original state; a temporary `.254` management address added
  2026-10-09 was reverted the same day). For direct PVE → docker VM access,
  add a temporary IP: `ip addr add 192.168.11x.254/24 dev vmbr1` and remove
  it afterwards. The Hetzner/internal PVEs are on the same bridge as their
  OWRT VM and docker VMs.
- **All 10 Docker VMs are in the mesh test:** `docker-fsn-1`, `docker-hel-1`,
  `docker-pve101`, `docker-pve102`, `docker-eri-1`, `docker-eri-2`,
  `docker-waw-1`, `docker-waw-2`, `docker-lim-1`, `docker-gra-1` in
  `scripts/check-hosts/mesh-test-hosts.txt` (source of truth:
  `kirks2003/rw_mesh`). Last run 2026-10-09: **50/50 + 50/50, exit 0**.

### Compose file source of truth

Active compose files live in `/home/ubuntu/docker/<service>/docker-compose.yml`
on each Docker VM. The canonical copies are in this repo under
[`hosts/<host>/<service>/`](hosts/) (see [`hosts/README.md`](hosts/README.md)
for deploy procedure). The MT5/Wine compose files are **not** tracked in the
repo — their canonical source tree is on vm104 (see
[MT5 exe installer setup](#mt5-exe-installer-setup-3-brokers)).
