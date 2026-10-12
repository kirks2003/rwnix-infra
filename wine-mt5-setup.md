# Wine + MetaTrader 5 — per-broker setup, accounts & findings

Companion detail to [`docker-vm-inventory.md`](docker-vm-inventory.md)
(§ "Wine + MetaTrader 5 containers"). Compiled **2026-10-12** by reading the
live source of truth on vm104 (`/home/ubuntu/projects/docker/docker/wine-mt5/`)
and cross-checking the actually-deployed ini on the running hosts.

> ⚠️ **Credentials.** The `[Common] Login/Server/Password` values below are
> **live broker account credentials**, transcribed verbatim from the
> untracked source tree on vm104 and the deployed host inis at the request of
> the owner. This conflicts with the repo's no-inline-secrets convention
> (secrets live host-local in `.env`, never in the repo) — they are recorded
> here for completeness of the setup record only. Treat this file as
> sensitive; consider rotating these broker passwords or masking this file
> if the repo is ever shared.

---

## Stack (identical for every MT5 container)

- **Image**: `lscr.io/linuxserver/webtop:ubuntu-xfce` (3.31 GB)
- **Wine**: **10.0**, apt-installed at first run (`wine64` + `wine32:i386` +
  `winbind`; verified live `wine-10.0 (Ubuntu 10.0~repack-12ubuntu1)`)
- **Desktop**: XFCE delivered in-browser via Selkies (WebRTC/JPEG encoder)
- **Init**: busybox init sidecar generates `custom-cont-init.d` startup
  scripts (`01-install-wine.sh`, `02-install-mt5.sh`, `04-apply-config.sh`)
  before the main container starts
- **Auth**: browser access requires a password set per-container in the
  host-local `.env` (not in the repo)
- **Companions**: each MT5 container pairs with `mt5-socket-api-bridge-1`
  (port 5555, exposes a socket API) and a shared `mariadb-1` + `phpmyadmin-1`
  stack (tick collection; the MariaDBs replicate to vm104 slaves, see
  [`hosts/vm104/`](hosts/vm104/))

## Live containers (5 on 3 VMs)

| VM | Container | Broker | Web UI port |
|---|---|---|---|
| eri-1 docker-1 (192.168.113.11) | `mt5-1-activtrades-1` | ActivTrades | **10101** → 3001 |
| eri-1 docker-1 | `mt5-1-fxpro-1` | FxPro | **20101** → 3001 |
| eri-1 docker-1 | `mt5-1-xm-1` | XM | **30101** → 3001 |
| eri-1 docker-2 (192.168.113.12) | `mt5-1-fxpro-1` | FxPro | **20101** → 3001 |
| waw-1 docker-1 (192.168.114.11) | `mt5-1-activtrades-1` | ActivTrades | **10101** → 3001 |

**Port formula**: `HOST_PORT = BROKER_BASE + ACCOUNT*100 + TERMINAL`, with
`BROKER_BASE`: activtrades 10000, fxpro 20000, xm 30000 — so account 1,
terminal 1 gives **10101** / **20101** / **30101**. Terminal/account numbers
allow multiple terminals or accounts per broker (e.g. `mt5-4-fxpro-1` → 20104).

The web port is driven by `${HOST_PORT}` in each container's `.env`
(`ports: ["${HOST_PORT}:3001"]`), **not** by the ini. The ini's `[Deploy]
Port` is informational to the deploy controller (see Finding 3).

## Per-broker exe installer setup

Each broker ships its own **branded MT5 setup exe**, stored in the untracked
source tree on vm104 and mounted read-only into each container at
`/installer/<broker>/<broker>5setup.exe`:

| Broker | Installer | Size | Installs as |
|---|---|---|---|
| ActivTrades | `activtrades5setup.exe` | 7.2 MB | `C:\Program Files\MetaTrader 5 - ActivTrades` |
| FxPro | `fxpro5setup.exe` | 7.2 MB | FxPro-branded dir |
| XM | `xm5setup.exe` | 5.0 MB | XM-branded dir |

### Install flow (first boot, `02-install-mt5.sh` inside the container)

1. Start `Xvfb :99` (1440x900x16) + `wineboot -u`, then run
   `wine "<broker>5setup.exe" /auto` in the background as user `abc`; the PID
   is written to `/tmp/.mt5-markers/setup-pid` for the deploy script.
2. Wait for setup.exe to exit, then for the install dir containing
   `terminal64.exe` (broker-named; matched by `find -iname "*<broker>*"`,
   fallbacks `*mt5*` / `*metatrader*`).
3. Pin Wine DPI (`LogPixels=96`, `Win8DpiScaling=1`) to stop font-scaling
   drift, and symlink the `x:` drive to the install dir.

## Account data (from `config/<container>/mt5.ini[.prd]`)

`mt5.ini` = the **current demo/test** account; `mt5.ini.prd` = the **live**
account. The deploy renames the active ini to `mt5-<T>-<B>-<A>.ini`; MT5's
**first launch runs with `/config:`** so the ini credentials log in, then
after a graceful exit a `.no-config` marker switches all future starts to
no-`/config:` mode (MT5 reads saved binary state + `common.ini`).

Common `[Common]` flags on every ini: `KeepPrivate=1`, `KeepSettings=1`,
`NewsEnable=0`, `CertInstall=0`, `ExpertDllImport=1`. Every `.prd` (live) ini
also carries `[Experts] AllowLiveTrading=0`.

### ActivTrades — same account set in all 3 instances

| Env | Login | Server | Password |
|---|---|---|---|
| Demo (`mt5.ini`) | `6250594` | `ActivTrades-Server` | `IOCgzx6?` |
| Live (`mt5.ini.prd`) | `882073` | `ActivTrades-Server` | `*$54412003` |

### FxPro — eri-1 docker-1 + docker-2 (source ini v1.11, `[Deploy] Terminal=4`)

| Env | Login | Server | Password |
|---|---|---|---|
| Demo (`mt5.ini`) | `591624088` | `FxPro-MT5 Demo` | `'dkjf$dkdfjd49dT'` |
| Live (`mt5.ini.prd`) | `530042402` | `FxPro-MT5 Live03` | `$$Mt52003$$` |

### XM — eri-1 docker-1 + docker-2

| Env | Login | Server | Password |
|---|---|---|---|
| Demo (`mt5.ini`) | `27706465` | `XM.COM-MT5` | `$$$Trade2003$$$` |
| Live (`mt5.ini.prd`) | `882073` | `ActivTrades-Server` | `*$54412003` |

⚠️ The XM live row is a **copy-paste of the ActivTrades live account**, not an
XM live account — see Finding 1.

## Deploy pipeline

`setup-wine-mt5.sh <container-name> --fresh|--compile` (run **from vm104** over
the mesh; the copy scp'd into each Docker VM's `~/scripts/` is **stale**):

scp compose/scripts/ini/experts/installer → `docker compose up -d` → polling
loops using the `deploy-settings.sh` timeouts (init ≤180 s, setup.exe PID ≤180
s, setup.exe exit ≤180 s, MT5 dir ≤60 s, start ≤120 s, stop ≤45 s — no
hardcoded sleeps) → copy `.mq5` experts (tick collectors +
`mt5-socket-api-bridge.mq5`) → headless-compile with `MetaEditor64.exe /compile`
under Xvfb :99 → 3-phase graceful stop (`xdotool` → `wine taskkill /IM
terminal64.exe` → SIGTERM + `wineserver -k`) → start without `/config:` →
verify the PID alive 5 s.

**Source of truth** (untracked in this repo by design):
`vm104:/home/ubuntu/projects/docker/` — `setup-wine-mt5.sh` (deploy
controller), `deploy-settings.sh` (polling-loop timeouts), `AGENTS.md` (design
notes + fix history), and `docker/wine-mt5/` (canonical `docker-compose.yml`,
init scripts, per-container `config/<container-name>/mt5.ini` + `experts/`,
`installer/<broker>/`). Per-host copies live at
`/home/ubuntu/docker/mt5-<T>-<B>-<A>/` on the Docker VMs.

---

## Findings (2026-10-12, from the raw inis + live host check)

1. **XM live account is a placeholder.** Every `mt5.ini.prd` for XM (eri-1
   docker-1 **and** docker-2) holds the ActivTrades live credentials
   (Login `882073` / `ActivTrades-Server`) instead of an XM live account. XM
   live was never actually configured — the `.prd` is a stale copy.

2. **Stale `[Deploy]` sections on non-primary ActivTrades hosts.** The
   `mt5.ini.prd` for ActivTrades on waw-1 docker-1 and eri-1 docker-2 both say
   `Host=docker-1-pve-1-eri-1-uk-ovh` (a copy of the original eri-1 docker-1
   config) rather than their own host. Cosmetic for the deploy controller but
   misleading in the record.

3. **FxPro web port ≠ ini `[Deploy] Port`.** The source-tree *and* deployed
   FxPro ini (v1.11) declare `[Deploy] Terminal=4 / Port=20104`, but the
   running `mt5-1-fxpro-1` containers on both eri-1 docker-1 and docker-2 are
   exposed on **20101** (verified with `docker port`). The web port comes from
   `HOST_PORT` in the container `.env`, so the ini's `[Deploy]` block is
   ahead of the actual exposure (an aspirational terminal-4 bump that was never
   re-exposed). Either re-deploy with `HOST_PORT=20104` to match the ini, or
   reset the ini to `Terminal=1 / Port=20101` to match the running service.

4. **Live trading disabled at the EA level everywhere.** All live (`.prd`)
   inis set `[Experts] AllowLiveTrading=0`, so the tick-collector EAs cannot
   open live trades even on live accounts — consistent with a
   data-collection-only purpose.

5. **Browser password per container.** The webtop login password is in each
   container's host-local `.env` (not in the repo); the MT5 ini does not carry
   the web password, only the broker account.
