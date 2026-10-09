# Snapshot backups — where crash-recovery backups live

Point-in-time **snapshot backups** of live services, for the "fatal crash,
set up from scratch" case. A snapshot contains everything needed to rebuild
the service on a fresh host: its docker data volumes, its live `.env`
files (secrets) and a copy of the deployed source, plus a `MANIFEST.txt`
with per-part sha256 checksums.

Rules:

- **Naming**: `<service>-snapshot-v<version>-<YYYYMMDDTHHMMSSZ>.tgz`,
  UTC timestamp, e.g. `jarvis-snapshot-v1-20261009T153748Z.tgz`.
  Bump the version when the snapshot layout changes (new parts, renamed
  volumes); the date-time identifies each individual snapshot. Every
  snapshot ships with a `<name>.sha256` sidecar file.
- **Contents**: data + secrets + source. The snapshot file **contains
  secrets** (service `.env` files, admin credentials) — it is stored only
  on the backup hosts below, **never in git**, never in the repo, and the
  backup directories are not shared publicly.
- **Consistency**: the snapshot script stops the service containers while
  taring the volumes (brief downtime, ~1 minute) so the data is
  crash-consistent.
- **Retention**: keep the newest 5 snapshots per destination
  (`backup-*.sh` prunes older ones automatically).
- **Verification**: every copy is checksum-verified at distribution time;
  a restore re-verifies the whole archive *and* every part against the
  manifest before touching anything.

## Storage locations

| Host | Path | Notes |
|---|---|---|
| `vm104` (source host) | `/home/ubuntu/backups/<service>/` | copy kept on the source host |
| `nbg-1` (gateway) | `/home/ubuntu/backups/<service>/` | 78 GB free on `/home/ubuntu` (2026-10-09) |
| `vie-1` (gateway) | `/home/ubuntu/backups/<service>/` | 188 GB free on `/home/ubuntu` (2026-10-09) |
| `pve102` (offsite PVE) | `/local-zfs-1/backups/<service>/` | 2.8 TB free on `/local-zfs-1` (2026-10-09) |

So a service's snapshot exists in **four places**: its source host plus
three independent backup hosts (two gateways + one Proxmox box behind a
different OpenWrt gateway — a crash of one host cannot take out all
copies).

## Current snapshot inventory

| Service | Snapshot | Size | sha256 | Created | Copies |
|---|---|---|---|---|---|
| jarvis | `jarvis-snapshot-v1-20261009T153748Z.tgz` | 8.2 MB | `8e4810f06bd88d19afe0de184f6354e9436b5d9a144a7fb3b361f675b21b1091` | 2026-10-09 15:37 UTC from `vm104` (repo head `797136e`) | vm104, nbg-1, vie-1, pve102 (paths above, `<service>` = `jarvis`) |

The jarvis snapshot covers the whole Jarvis stack on vm104:
`jarvis` + `jarvis-neo4j` (conversation SQLite + Neo4j knowledge graph)
and `vikunja` + `vikunja-db` (the vm104-local Vikunja instance Jarvis uses
for its task-manager MCP — users, tasks, API tokens), plus the live
`.env` files and deployed source. See
[jarvis/DEPLOYMENT.md](jarvis/DEPLOYMENT.md) ("Snapshot backup" and
"Restoring from a snapshot") for the details and the verified restore
procedure.

## Taking a new snapshot

From a Kandev sandbox (any machine with SSH to the source host and all
backup hosts):

```
bash scripts/jarvis/backup-jarvis.sh
```

It builds the snapshot on the source host (stopping the stack for ~1
minute), copies it to every destination and verifies the sha256 on each.
The standalone host-side builder is `scripts/jarvis/snapshot-jarvis.sh`
(run it on the source host if you only want a local copy).

Extend the pattern to other services the same way: a
`scripts/<service>/snapshot-<service>.sh` + `backup-<service>.sh` pair and
a `<service>` subdirectory in each backup host's path.

## Restoring

Each service's restore script verifies the archive and all parts, then
rebuilds: env files → source → docker volumes → `docker compose up -d
--build` → health checks. For Jarvis:

```
# on the fresh/rebuilt host (as ubuntu, snapshot copied over):
bash scripts/jarvis/restore-jarvis.sh /path/to/jarvis-snapshot-v1-<ts>.tgz
```

See [jarvis/DEPLOYMENT.md](jarvis/DEPLOYMENT.md) for the full
from-scratch setup and the 2026-10-09 restore verification results.
