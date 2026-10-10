# Fleet security check — exposed services & ports (2026-10-10)

Requested: "run a security check about all our exposed services and ports".
Scope: all 12 public hosts + all internal PVEs, docker VMs, OWRT gateways and
mesh VMs (~46 hosts), two views: (a) what the **internet** can actually reach
(TCP connect scan from the sandbox, ~90 common ports), (b) what **listens** on
each host and to which interface (`ss -ltnH`/`ss -ulnH` / busybox `netstat`
via SSH). No `nmap` on the sandbox — custom scanners:
`extscan.py` (asyncio TCP connect) and `audit.py` (parallel SSH listener dump).
Raw listener map: `security-audit-20261010-listeners.txt` (same dir).

## 1. What the internet can reach (verified by scan)

| Host | Open from internet | What it is | Assessment |
|---|---|---|---|
| 10× OVH/Hetzner/Netcup public hosts | 22 | SSH (key auth) | standard; brute-force surface, key-only |
| nbg-1, vie-1, gpu-1, gpu-2 | 80, 443 | NPM reverse-proxy gateways → published rows behind Authelia (a1-jarvis: NPM basic auth) | intended |
| nbg-1, vie-1 | **2222** | **Kandev agent SSH** (`kandev` container `0.0.0.0:2222->22`) | key auth, but a second public SSH port beyond the documented 22 |
| ber-1 | 443 | nginx gateway (wetty/vscode/PVE proxies for the OVH docker VMs) | 66/70 vhosts auth-protected (`auth_basic` + Authelia); the 4 without auth are harmless (ACME, `444` drop-defaults, redirect, static `cv.rwnix.net` page) |
| ber-2 | — nothing — | fully closed (its own 0.0.0.0:22/80/443 listeners are firewalled) | host effectively offline from the internet |

**Not** reachable from the internet anywhere (verified closed): PVE Web 8006,
Docker API 2375/2376 (none open on any host), Grafana 3000, Portainer
8000/9000/9443, Neo4j 7474/7687, MQTT 1883, DB ports 3306/3307/3308/5432/6379,
metrics 9100/8080/9191, NPM UI 81. Host firewalls on all 12 public hosts hold.

## 2. Mesh/LAN-reachable findings (0.0.0.0 binds, blocked from the internet but open to every WireGuard peer / home-LAN host)

Ranked by how much an unauthenticated or low-auth mesh peer gets:

1. **mosquitto MQTT with `allow_anonymous: true`** — nbg-1 and vie-1
   (gateways) and vm104, all `0.0.0.0:1883`. Anyone on the mesh can publish
   and subscribe to every MQTT topic without credentials (nbg-1 config
   verified: `listener 1883 0.0.0.0`, `allow_anonymous true`). Fix: set
   `allow_anonymous false` + `password_file`, or bind to the specific client
   subnet. (vm104's broker: check the same setting.)
2. **Unauthenticated LLM/TTS inference APIs on the mesh** — gpu-1
   `0.0.0.0:8082` (Qwen3.8-27B llamacpp; `/v1/models` answers 200 with no
   auth, full inference consumable by any mesh peer) and `0.0.0.0:8003`
   (speaches TTS). Intended for the a1 demo's cross-mesh Jarvis calls, but
   there is no auth or rate limit on the endpoint itself.
3. **Management UIs directly reachable on the mesh, bypassing the Authelia
   rows** — PVE Web `*:8006` on all PVE hosts (root-equivalent web UI; mesh
   only, but any compromised WG peer gets it), NPM UI `0.0.0.0:81` on
   gpu-1/gpu-2/nbg-1/vie-1, Grafana `*:3000` on gpu-1/gpu-2/nbg-1/vie-1,
   Portainer `0.0.0.0:8000/9000/9443` on vm104 (+ docker VMs), LuCI 80/443 on
   every OWRT gateway VM. All have their own logins, but they skip the
   Authelia gate the published proxy rows would provide.
4. **Databases reachable on the mesh, outside app scope** — gpu-2
   `*:7474`/`*:7687` (the a1 demo's Neo4j; has auth: neo4j + jarvis_read/
   jarvis_write, but a peer can talk to the DB directly), vm104
   `192.168.54.111:3307/3308` (MariaDB, LAN-bound), `9090/9091` (phpMyAdmin
   for them).
5. **TFTP server on vm104** — `tftp-1` container, UDP `0.0.0.0:69`. TFTP has
   no authentication by design: any home-LAN/mesh host can read/write the
   served path. Confirm what device needs it; consider binding to that host.
6. **Misc mesh-reachable services** — gpu-2 `0.0.0.0:8012/8013` (POC uvicorn
   services) + `*:55903` (vLLM worker); gpu-1 `0.0.0.0:8080` (cadvisor, no
   auth — metrics only), `*:9323` (dockerd internal, *not* the 2375/2376
   remote API); PVE hosts `*:3128` (same on every PVE — mesh tooling
   proxy?), `0.0.0.0:111` + UDP (rpcbind/NFS, standard PVE), gra-1/lim-1
   `0.0.0.0:25` (OpenSMTPD relay), fsn-1/hel-1/pve102/pve104 `*:9100`
   (node_exporter); docker VMs `0.0.0.0:8000/9000/9443` (Portainer per VM);
   vm103 `0.0.0.0:3000/3002/8000/8002/9000/9443/61208`; vm104
   `0.0.0.0:8001` (Whisper STT).

## 3. Could not audit (SSH timeout at check time)

docker-eri-1, docker-eri-2, docker-gra-1, docker-lim-1, docker-waw-1,
docker-waw-2, pve1070 — re-check when they're back up (per
`mesh-test-hosts.txt` convention they stay listed during outages).

## 4. Good findings

- Internet attack surface is exactly the intended one: SSH + the four
  Authelia/basic-auth web gateways + ber-1's (mostly) authed nginx gateway.
- No Docker remote API, no PVE Web, no DB or cache port is internet-facing
  anywhere in the fleet.
- ber-1 nginx: 94% of vhosts carry `auth_basic` + Authelia; default servers
  `return 444` (drop) instead of serving anything.
- Internal-only services (Jarvis 8094, gitlab 8080, mariadb, phpMyAdmin,
  grafana on vm104) are bound to the LAN IP `192.168.54.111`, not 0.0.0.0 —
  tighter than needed, and correct.
- NPM/Authelia model on the four public web hosts is followed consistently
  (a1-jarvis intentionally on NPM basic auth per the demo policy).

## 5. Suggested follow-ups (not done)

- ~~mosquitto: disable anonymous~~ — **decided 2026-10-10 (user):** accepted
  as-is. mosquitto runs only on nbg-1, vie-1, vm104 (verified absent on
  gpu-1/gpu-2) and is firewalled from the internet, so anonymous access is
  mesh/LAN-only.
- Decide whether `2222` (Kandev SSH) needs to stay public on both gateways,
  or move to key-only-on-22 / source-restricted via the host firewall.
- If mesh trust is the threat model, items 2–6 are acceptable as-is; if a
  single compromised mesh device should *not* reach PVE/NPM/Portainer/Neo4j
  directly, the fix is firewall rules on each host allowing those ports only
  from specific WG peers/IPs (or a dedicated admin subnet).
- Re-audit the 7 unreachable hosts when back up.
