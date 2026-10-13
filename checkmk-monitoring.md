# Checkmk fleet monitoring

Checkmk **Community 2.5.0p15** in Docker, deployed **2026-10-12** on the two
OVH Docker VMs `gra-1` and `lim-1`. Both instances monitor the **whole fleet
(29 hosts)** independently — dual-server, no clustering (each is a complete,
standalone monitor; losing one leaves the other fully operational).

- Servers: `hosts/gra-1/checkmk/compose.yaml`, `hosts/lim-1/checkmk/compose.yaml`
  (repo = source of truth; live at `/home/ubuntu/docker/checkmk/`).
- Image `checkmk/check-mk-community:2.5.0-latest`, container `checkmk`.
  Volume `checkmk-data:/omd/sites` (site + htpasswd persist across container
  recreates), tmpfs `/opt/omd/sites/cmk/tmp`, ports **5000** (web/API) +
  **8001** (agent receiver). `TZ=Europe/Berlin`.
- The site is served under **`/cmk`** (2.5 layout): UI at
  `https://<host>:5000/cmk/check_mk/`, REST API base
  `http://<host>:5000/cmk/check_mk/api/1.0/`.

## Public access (Authelia-gated)

Four NPM proxy hosts (2 gateways × 2 Checkmk servers), all in the Authelia
`two_factor` policy on both gateways (added 2026-10-12 to
`hosts/{nbg-1,vie-1}/authelia/config/configuration.yml`):

| Domain | Backend |
|---|---|
| `checkmk-gra-1.gw-1-nbg-1-de-netcup.rwnix.net` | 192.168.116.11:5000 |
| `checkmk-lim-1.gw-1-nbg-1-de-netcup.rwnix.net` | 192.168.115.11:5000 |
| `checkmk-gra-1.gw-1-vie-1-at-netcup.rwnix.net` | 192.168.116.11:5000 |
| `checkmk-lim-1.gw-1-vie-1-at-netcup.rwnix.net` | 192.168.115.11:5000 |

NPM confs: `hosts/nbg-1/nginx-proxy-manager/data/nginx/proxy_host/{46,47}.conf`,
`hosts/vie-1/…/{58,59}.conf` (standard NPM DB-managed hosts; `Remote-*`
headers set for Authelia integration). The Docker VMs have no public IP of
their own — the only internet path to Checkmk is through these four domains.

## Credentials

- **cmkadmin**: password rotated by the user **2026-10-12** (initial value
  `admin` no longer works — verified HTTP 401 on both servers before and
  after the compose recreate). The new value lives **only** in the site's
  htpasswd (`/omd/sites/cmk/etc/htpasswd` inside the `checkmk-data` volume).
  Never in this repo.
- **`CMK_PASSWORD` env**: first-boot only (`omd create --admin-password` runs
  solely when `/opt/omd/sites/<site>/etc` doesn't exist). Compose references
  `${CMK_PASSWORD}` (no inline secret, per `hosts/README.md`); no host-local
  `.env` exists yet — for a **fresh rebuild** set
  `CMK_PASSWORD=<current password>` in `/home/ubuntu/docker/checkmk/.env`
  (chmod 600) before first start, otherwise the site comes up with a blank
  admin password.
- **`agent_registration`** user (secret `cmk-agent-reg-2026`): used only for
  TLS agent registration; currently unused (fleet runs legacy mode).
  Randomization deferred (user decision 2026-10-12).

## Monitored hosts (29)

All hosts run `check-mk-agent` 2.5.0p15 in **legacy pull mode** (plaintext,
TCP 6556, `cmk-agent-ctl-daemon` active). Checkmk host names as registered:

| Type | Hosts (Checkmk name → IP) |
|---|---|
| Public gateways | `nbg-1` → 152.53.118.212, `vie-1` → 152.53.35.177, `ber-1` → 217.154.145.10, `ber-2` → 85.215.213.123, `gpu-1` → 194.182.188.115, `gpu-2` → 92.39.59.7 |
| Hetzner PVE | `fsn-1` → 144.76.14.155, `hel-1` → 65.109.122.228 |
| OVH PVE | `gra-1-pve` → 5.196.93.234, `lim-1-pve` → 51.75.145.232, `eri-1-pve` → 51.89.192.92, `waw-1-pve` → 51.83.220.93 |
| Private PVE | `pve101` → 192.168.101.2, `pve102` → 192.168.102.2, `pve103` → 192.168.15.7, `pve104` → 192.168.15.6, `pve1070` → 192.168.141.1 |
| VMs | `vm103` → 192.168.53.111, `vm104` → 192.168.54.111 |
| Docker VMs | `docker-fsn-1` → 192.168.111.111, `docker-hel-1` → 192.168.112.111, `docker-pve101` → 192.168.51.111, `docker-pve102` → 192.168.52.111, `eri-1-docker-1` → 192.168.113.11, `docker-eri-2` → 192.168.113.12, `docker-waw-1` → 192.168.114.11, `docker-waw-2` → 192.168.114.12, `docker-lim-1` → 192.168.115.11, `gra-1-docker` → 192.168.116.11 |

Notes: `ber-1` was a direct agent install (systemd + dpkg available); the
OpenWrt gateway VMs (owrt*) are not monitored. The 10.1.1.x/10.2.1.x/
192.168.x.x mesh IPs are the `ipaddress` attribute; polling happens over the
WireGuard mesh.

### TLS → legacy reset (2026-10-12)

Five hosts were originally registered for **TLS** pull, then reset to legacy
mode so both Checkmk servers can pull the same agent (an agent can only be
TLS-registered to one server; legacy plaintext is the enabler for dual
monitoring). Reset procedure per host:

1. Clear `/var/lib/cmk-agent/registered_connections.json`
2. Recreate the `/var/lib/cmk-agent/allow-legacy-pull` marker
3. Restart `cmk-agent-ctl-daemon` (file changes are not hot-reloaded)

Hosts: `gra-1-docker`, `pve103`, `pve104`, `vm103`, `vm104`.
**Server-side follow-up (the missing step that caused CRITs — see Findings
below):** remove the stale registration link
`/omd/sites/cmk/var/agent-receiver/uuid-lookup/<host>` (symlink
`<host> → <uuid>`) plus `/omd/sites/cmk/var/agent-receiver/received-outputs/<uuid>`
on each Checkmk server — this is the UI's "Remove TLS registration" action.

## Firewall changes (2026-10-12, all source-restricted)

The agent port 6556 had to be opened on every public host for the two
Checkmk servers. **Key gotcha:** the arriving source IP is the **OVH account
transit IP** (SNAT), not the PVE's own public IP. Discovered via
`ufw logging low` + reading the `SRC=` in the `[UFW BLOCK]` lines:

- gra-1 path arrives as **51.68.65.24**
- lim-1 path arrives as **51.68.177.41**

Rules added:

- **6 public PVEs** (PVE firewall, `cluster.fw` on each):
  `IN ACCEPT -source +fixed_whitelist -p tcp --dport 6556` — inserted before
  the final `IN DROP`. PVEFW syntax gotchas: IPSET sources need the `+`
  prefix and the flag is `--dport` (not `-dport`); without these the rule
  silently never matched. `fixed_whitelist` is the existing IPSET of the 19
  own public IPs.
- **UFW on nbg-1, vie-1, ber-1, ber-2, gpu-1, gpu-2**: allow TCP 6556 from
  5.196.93.234, 51.75.145.232, 51.89.192.92, 51.83.220.93, 144.76.14.155,
  65.109.122.228, 51.68.65.24, 51.68.177.41, 10.0.0.0/8, 192.168.0.0/16.
- **Exoscale edge firewalls** (gpu-1, gpu-2): opened by the user in the
  Exoscale UI 2026-10-12 — no API credentials on the hosts. Verified to be
  source-restricted (port closed from untrusted internet sources).

## REST API quick reference (2.5.0p15)

Base `http://localhost:5000/cmk/check_mk/api/1.0/`, Basic auth (cmkadmin),
`Accept: application/json` on every call. Container gotchas: the system
python is 3.10 (no `typing.Self`) so the `check_mk` CLI is broken — use the
REST API; the site python is `/omd/sites/cmk/bin/python3.13`. Collection
endpoints reject `?limit=`.

| Operation | Call |
|---|---|
| Hosts (pending config / activated) | `GET /domain-types/host_config/collections/all` / `GET /domain-types/host/collections/all` |
| Bulk create | `POST /domain-types/host_config/actions/bulk-create/invoke` body `{"entries":[{"host_name":h,"folder":"/","attributes":{"ipaddress":ip}}]}` — **`folder` is required** |
| Bulk update | `PUT /domain-types/host_config/actions/bulk-update/invoke` (same entries, no folder) |
| Discovery | `POST /domain-types/discovery_run/actions/bulk-discovery-start/invoke` body `{"hostnames":[…],"options":{"monitor_undecided_services":true,"remove_vanished_services":true,"update_service_labels":true,"update_service_parameters":true,"update_host_labels":true},"do_full_scan":true}` → returns a `background_job` id |
| Track job | `GET /objects/background_job/<id>` → `extensions.status.state` (`success`/`failure`); the object is **deleted after completion** |
| Activate | ETag from `GET /domain-types/activation_run/collections/pending_changes` → `POST /domain-types/activation_run/actions/activate-changes/invoke` with `If-Match: <etag>`, body `{}` |
| Service state (no output text!) | `GET /objects/host/<host>/actions/show_service/invoke?service_description=<urlencoded>` → `extensions.state` (0=OK, 1=WARN, 2=CRIT) |

Verify the fleet without the UI: on the server container,
`ls /omd/sites/cmk/var/pnp4nagios/perfdata/` lists every host currently
being polled (perfdata dirs are written per check cycle).

## Findings & incidents

- **Stale TLS registration links → `Check_MK` CRIT** (2026-10-12): after the
  TLS→legacy reset, the 5 hosts showed `Check_MK` service CRIT while all
  other checks were OK. Agent output was byte-identical to healthy hosts
  (including the `<<<cmk_agent_ctl_status>>>` section:
  `{"agent_socket_operational":true,"ip_allowlist":[],"allow_legacy_pull":true,"connections":[]}`).
  Root cause: the server-side `uuid-lookup/<host>` symlinks from the original
  TLS registration were never removed, so the core expected a TLS-registered
  agent on hosts that now speak legacy. Fix: delete the symlink + the
  `received-outputs/<uuid>` dir per host (no restart needed — agent-receiver
  is xinetd socket-activated, reads the links per connection). Result:
  29/29 hosts with `Uptime` = 0 **and** `Check_MK` = 0 on both servers.
- **lim-1 first-boot password** (2026-10-12): lim-1's `cmkadmin` got a
  first-boot random hash (its `CMK_PASSWORD` env didn't take on first
  start); synced to the same known password as gra-1 from htpasswd, later
  superseded by the user's 2026-10-12 rotation.
- **Duplicate `8001:8001` port** in the lim-1 compose — removed 2026-10-13
  (both repo and live), compose re-deployed to both hosts (container
  recreated; site data + rotated password survived, verified).
- **`CMK_PASSWORD` inline in repo compose** — violated the
  no-inline-secrets rule; externalized to `${CMK_PASSWORD}` 2026-10-13.

## Security audit (2026-10-12/13)

**Internet-facing: clean.**
- 6556 is **closed from untrusted internet sources on all 12 public hosts**
  (re-verified 2026-10-13, incl. both Exoscale GPUs — the Exoscale rule is
  source-restricted).
- 5000/8001 are not publicly routable; the only internet path is the four
  domains above, all 302 → Authelia `two_factor` (verified 2026-10-13).
- Versions: server and agent `2.5.0p15` = current latest patch (Checkmk
  docs/SBOM as of Aug 2026). Nothing unpatched.

**Mesh-internal (WireGuard): accepted trade-offs, not public risks.**
- Legacy plaintext agent mode (documented Checkmk default for unregistered
  agents): any host *inside the mesh* can pull an agent's full inventory
  unauthenticated (~165 KB: process list, systemd units, mounts, ZFS pools,
  PVE cluster topology, network config). Scanned: **no actual secret
  values** in the inventory (password/secret/key grep hits were systemd unit
  names); **no remote command execution** possible (RTC not configured — an
  unauthenticated RTC query just returns the agent banner).
- Authelia only guards the public path: from the mesh the UI is reachable
  directly at `192.168.116.11:5000` / `192.168.115.11:5000`. Mitigated by
  the cmkadmin password rotation (user, 2026-10-12).
- Receiver 8001 is mesh-reachable (a mesh host could push fake agent data —
  minor, monitoring-only).

**Decisions (user, 2026-10-12/13):**
- Rotate `cmkadmin/admin` → **done by the user**.
- Randomize the `agent_registration` secret → deferred (no need at the time).
- Narrow the UFW `10/8` + `192.168/16` sources to the exact mesh NAT IPs →
  deferred (no need at the time).

## Operations

- **Deploy** (repo → host): back up the live compose (`cp compose.yaml
  compose.yaml.bak-<ts>`), `scp` the repo copy, `docker compose up -d`,
  verify `docker ps` healthy + `curl -s -o /dev/null -w '%{http_code}'
  http://localhost:5000/cmk/check_mk/` = 302. Container recreates are safe:
  the site (and htpasswd) live in the `checkmk-data` volume; the entrypoint
  only runs `omd create` when the site dir is absent.
- **Add a host**: install the agent (deb, legacy mode = just have
  `cmk-agent-ctl-daemon` running with the `allow-legacy-pull` marker), open
  6556 source-restricted if the host is public, then bulk-create
  (`ipaddress` attribute + `folder:"/"`), bulk-discovery-start, wait for the
  background job, activate-changes.
- **Check agent from anywhere on the mesh**:
  `timeout 10 bash -c 'exec 3<>/dev/tcp/<ip>/6556; printf "version\0" >&3; cat <&3'`
  (null-terminated command; `--inventory` for the full inventory).
