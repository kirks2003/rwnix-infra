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

## Coverage policy

Binding for every snapshot-backed service (currently: Jarvis on vm104 /
pve104):

1. **Every related container is documented in the repo.** The service's
   whole stack — not just the main app — must have its `docker-compose`
   (plus `Dockerfile` and any bind-mounted code) in this repo
   (`jarvis/`, `hosts/<host>/<service>/`) and be listed in the service's
   MD docs with image, published ports, and which one is active vs
   legacy. Container definitions in the repo are the source of truth for
   a from-scratch rebuild; the host copy is a deployment artifact.
2. **No API keys or secrets in the repo.** Compose files reference
   `${VAR}` / `env_file: .env`; the values live only in host-local
   `.env` files (`chmod 600`, gitignored) and — for crash recovery — in
   the snapshot's `env/` part. Only `.env.example` templates (empty
   values) are committed.
3. **Every data-bearing container is in the snapshot.** Every docker
   volume a stack writes to (databases, file stores) is a `data/` part
   in the snapshot, and the snapshot's `source/` part mirrors the
   deployed tree so a restore is self-contained even offline. Stateless
   containers (re-downloadable model caches, etc.) need no part but
   must be documented as such.
4. **Snapshots live on all defined hosts.** A service's snapshot is
   complete only when a sha256-verified copy exists on the source host
   **and** every backup host in the table above. Distribution is done by
   the `backup-<service>.sh` script, which fails loudly on any checksum
   mismatch.
5. **Disaster recovery = snapshot + repo.** On a fresh host: copy the
   latest snapshot (and its `.sha256`) over and run the service's
   `restore-<service>.sh` (verify archive + manifest → env files →
   source → volumes → `docker compose up -d --build` → health checks),
   or rebuild code from the repo and secrets from the snapshot's
   `env/`. The restore procedure must be documented in the service's
   MD and verified end to end at least once before it is trusted.

## Current snapshot inventory

| Service | Snapshot | Size | sha256 | Created | Copies |
|---|---|---|---|---|---|
| jarvis | `jarvis-snapshot-v1-20261009T190532Z.tgz` | 8.0 MB | `aa657530ed7ce437ad1c5463767c0ed0bf247404587dd5e1c9b46ae6d65db4da` | 2026-10-09 19:05 UTC from `vm104` (repo head `d92dd16`) | vm104, nbg-1, vie-1, pve102 (paths above, `<service>` = `jarvis`) |

The previous jarvis snapshot of the same day
(`jarvis-snapshot-v1-20261009T153748Z.tgz`, sha256
`8e4810f06bd88d19afe0de184f6354e9436b5d9a144a7fb3b361f675b21b1091`,
repo head `797136e`) is retained on all four hosts per the retention
policy and remains a valid restore point.

The jarvis snapshot covers the whole Jarvis stack on vm104:
`jarvis` + `jarvis-neo4j` (conversation SQLite + Neo4j knowledge graph)
and `vikunja` + `vikunja-db` (the vm104-local Vikunja instance Jarvis uses
for its task-manager MCP — users, tasks, API tokens), plus the live
`.env` files and deployed source. The legacy `whisper` container on vm104
is Jarvis-related but stateless (its model cache is a host-local,
re-downloadable bind mount — see `hosts/vm104/whisper/`), so it has no
snapshot part. See
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
