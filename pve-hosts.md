# PVE Proxmox host inventory

All Proxmox VE hosts in the fleet, grouped by **public** and **internal**
(private LAN/mesh) addressing. Last verified 2026-10-09 via `mesh-test.sh`
run natively from both gateway kandev containers (see
[Mesh test results](#mesh-test-results-2026-10-09)).

Source of truth for the mesh host list is
`scripts/check-hosts/mesh-test-hosts.txt` (repo copy; upstream is
`kirks2003/rw_mesh`).

## Public PVE hosts

| Host | Public IP | Location | PVE version | OpenWrt gateway VM |
|---|---|---|---|---|
| `fsn-1` (a.k.a. pve211) | `144.76.14.155` | Hetzner dc10-fsn1-de | 9.2.0 | `owrt-fsn-1` (10.1.1.12 / 10.2.1.12, OpenWrt 25.12.0) |
| `hel-1` (a.k.a. pve212) | `65.109.122.228` | Hetzner dc5-hel1-fi | 9.2.0 | `owrt-hel-1` (10.1.1.11 / 10.2.1.11, OpenWrt 25.12.0) |
| `gra-1` | `5.196.93.234` | OVH gra-1-fr | 9.2.0 | `owrt-gra-1` (10.1.1.13 / 10.2.1.13, OpenWrt 25.12.4) |
| `lim-1` | `51.75.145.232` | OVH lim-1-de | 9.2.0 | `owrt-lim-1` (10.1.1.14 / 10.2.1.14, OpenWrt 25.12.4) |
| `eri-1` | `51.89.192.92` | OVH eri-1-uk | 9.2.0 | `owrt-eri-1` (10.1.1.10 / 10.2.1.10, OpenWrt 25.12.4) |
| `waw-1` | `51.83.220.93` | OVH waw-1-pl | 9.2.0 | `owrt-waw-1` (10.1.1.15 / 10.2.1.15, OpenWrt 25.12.4) |

Web UI: `https://pve-1-<dc>.rwnix.net` (e.g. `pve-1-dc10-fsn1-de-hetzner.rwnix.net`).

## Internal PVE hosts

| Host | Private IP | Network | Hardware | PVE version | OpenWrt gateway VM |
|---|---|---|---|---|---|
| `pve103` | `192.168.15.7` | Home LAN (192.168.15.0/24) | 1140b | 9.2.0 | `owrt-pve103` (192.168.15.53, OpenWrt 25.12.0) |
| `pve104` | `192.168.15.6` | Home LAN (192.168.15.0/24) | 1140b | 9.2.0 | `owrt-pve104` (192.168.15.54, OpenWrt 25.12.0) |
| `pve301` | `192.168.15.21` | Home LAN (192.168.15.0/24) | 1140b | unknown | — |
| `pve101` | `192.168.101.2` | Behind owrt011 (192.168.101.0/24) | 1070 | 9.2.0 | `owrt-pve101` (192.168.51.1, OpenWrt 25.12.0) |
| `pve102` | `192.168.102.2` | Behind owrt011 (192.168.102.0/24) | 1070 | 9.2.0 | `owrt-pve102` (192.168.52.1, OpenWrt 25.12.0) |
| `pve1070` | `192.168.141.1` | Behind owrt031 | 1070 | 9.1.0 | — |

Notes:
- `pve103` hosts `vm103` (192.168.53.111), `pve104` hosts `vm104` (192.168.54.111).
- `pve301` is only referenced in the glance dashboards; it is **not** in
  `mesh-test-hosts.txt` and did not answer ping from `vm104` on 2026-10-09.
- Web UI: `https://pve<NNN>.gw-1-ber-1-de-ionos.rwnix.net` /
  `gw-2-ber-1-de-ionos.rwnix.net` (IONOS gateways).

## Access

- SSH: all PVE hosts use `root` (VMs use `ubuntu`), key `~/.ssh/kandev`,
  aliases in the sandboxes' `~/.ssh/config` (see `kandev-ssh-ps1-setup.md`).
- `gpu-1`/`gpu-2` kandev containers deliberately expose **no** PVE/OpenWrt
  hosts (`extra_hosts` trimmed, fleet policy).

## Running the mesh test

`mesh-test.sh` must run **inside a kandev container** on nbg-1 or vie-1
(it identifies its sandbox via `ssh ubuntu@172.26.0.1 hostname`
and only accepts `*nbg*`/`*vie*` hostnames). Script path in the container:
`/data/home/scripts/check-hosts/mesh-test.sh`.

```
# native run from the nbg-1 kandev container (as user kandev):
ssh ubuntu@152.53.118.212 \
  "docker exec -u kandev kandev bash /data/home/scripts/check-hosts/mesh-test.sh"

# same from vie-1:
ssh ubuntu@152.53.35.177 \
  "docker exec -u kandev kandev bash /data/home/scripts/check-hosts/mesh-test.sh"
```

A native run tests from its own sandbox **and** triggers the peer sandbox
run via ssh + `docker exec --remote`. Running from a plain host (e.g.
`vm104`) fails with `ERROR: unrecognized Docker host`.

## Mesh test results 2026-10-09

Both native runs (nbg-1 and vie-1 kandev containers, user `kandev`,
10:37 UTC): **40/40 passed locally + 40/40 passed on the peer** in each —
every gateway (nbg-1, vie-1, ber-1, ber-2), all 12 PVE hosts, all OpenWrt
gateways, mesh tunnel peers (wg_nbg-1/wg_vie-1), vm103/vm104, gpu-1/gpu-2,
and both kandev sandboxes answered ping + SSH. No timeouts, no host-key
changes.

Findings from the direct ping sweep from `vm104` the same day:
- Hetzner PVE public IPs (`fsn-1` 144.76.14.155, `hel-1` 65.109.122.228)
  did **not** answer ICMP from vm104, but ping + SSH from both gateways is
  fine (3–30 ms) — route/ICMP difference, not a host problem.
- `pve301`, `pve101`, `pve102`, `pve1070` and the `owrt-pve101/102` VMs are
  on subnets not directly routed from vm104; all reachable via mesh from
  both gateways.
- Only recurring report flag: the `kandev` sandbox user has no sudo
  installed (expected for that non-root user).
