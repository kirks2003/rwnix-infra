#!/usr/bin/env bash
# Build a Jarvis stack snapshot ON THE DOCKER HOST (vm104).
#
# The snapshot contains everything needed to rebuild Jarvis from scratch
# after a fatal crash: live .env files (secrets), all docker data volumes
# (SQLite conversation DB, Neo4j knowledge graph, Vikunja DB + files) and a
# copy of the deployed source. The repo (kirks2003/rwnix-infra, jarvis/ and
# hosts/vm104/vikunja/) is the primary source of truth for code; the source
# copy here makes the snapshot self-contained for an offline restore.
#
# The snapshot file contains secrets. It is distributed to the backup hosts
# by backup-jarvis.sh and must NEVER be committed to git.
#
# Run as ubuntu on vm104:  bash snapshot-jarvis.sh
# Env overrides: SNAPSHOT_VERSION (default 1), STOP_SERVICES (default 1),
#                OUT_DIR (default ~/backups/jarvis), JARVIS_DIR, VIKUNJA_DIR,
#                REPO_HEAD (repo commit the deployed code came from).
set -euo pipefail

SNAPSHOT_VERSION=${SNAPSHOT_VERSION:-1}
JARVIS_DIR=${JARVIS_DIR:-$HOME/docker/jarvis}
VIKUNJA_DIR=${VIKUNJA_DIR:-$HOME/docker/vikunja}
OUT_DIR=${OUT_DIR:-$HOME/backups/jarvis}
STOP_SERVICES=${STOP_SERVICES:-1}
REPO_HEAD=${REPO_HEAD:-n/a}

TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAP="jarvis-snapshot-v${SNAPSHOT_VERSION}-${TS}.tgz"
STAGE=$(mktemp -d /tmp/jarvis-snapshot.XXXXXX)
ROOT="$STAGE/$SNAP"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$ROOT"/data "$ROOT"/env "$ROOT"/source

started_at=$(date -u +%FT%TZ)

stop_stack() {
  docker compose -f "$JARVIS_DIR/docker-compose.yml" stop jarvis neo4j
  docker stop vikunja vikunja-db
}
start_stack() {
  docker start jarvis-neo4j vikunja-db
  sleep 5
  docker start jarvis vikunja
}
stopped=0
if [ "$STOP_SERVICES" = "1" ]; then
  echo "==> stopping jarvis/neo4j/vikunja for a consistent volume snapshot"
  stop_stack
  stopped=1
  sleep 2
fi

vol_tar() { # $1=volume  $2=dest tarball (host path; tar writes to stdout)
  docker run --rm -v "$1":/src:ro alpine tar czf - -C /src . > "$2"
}
echo "==> taring docker volumes"
vol_tar jarvis_jarvis_data    "$ROOT/data/jarvis_data.tar"
vol_tar jarvis_neo4j_data     "$ROOT/data/neo4j_data.tar"
vol_tar vikunja_vikunja_db    "$ROOT/data/vikunja_db.tar"
vol_tar vikunja_vikunja_files "$ROOT/data/vikunja_files.tar"

if [ "$stopped" = "1" ]; then
  echo "==> restarting the stack"
  start_stack
fi

echo "==> collecting env files and deployed source"
install -m 600 "$JARVIS_DIR/.env" "$ROOT/env/jarvis.env"
install -m 600 "$VIKUNJA_DIR/.env" "$ROOT/env/vikunja.env"
if [ -f "$VIKUNJA_DIR/admin-login.txt" ]; then
  install -m 600 "$VIKUNJA_DIR/admin-login.txt" "$ROOT/env/vikunja-admin-login.txt"
fi
mkdir -p "$ROOT/source/jarvis"
tar -C "$JARVIS_DIR" --exclude=node_modules --exclude='.env*' --exclude='.git' -cf - . \
  | tar -C "$ROOT/source/jarvis" -xf -
mkdir -p "$ROOT/source/vikunja"
tar -C "$VIKUNJA_DIR" --exclude='.env*' --exclude='backup-mcptoken-*' --exclude='.git' -cf - . \
  | tar -C "$ROOT/source/vikunja" -xf -

echo "==> writing manifest"
{
  echo "snapshot: $SNAP"
  echo "version: v${SNAPSHOT_VERSION}"
  echo "created: $started_at (manifest finished $(date -u +%FT%TZ))"
  echo "source host: $(hostname) ($(hostname -I 2>/dev/null | awk '{print $1}'))"
  echo "repo head: $REPO_HEAD"
  echo "services stopped during volume tar: $stopped"
  echo
  echo "docker volumes snapshotted:"
  for v in jarvis_jarvis_data jarvis_neo4j_data vikunja_vikunja_db vikunja_vikunja_files; do
    sz=$(docker run --rm -v "$v":/s:ro alpine du -sh /s 2>/dev/null | cut -f1)
    echo "  $v  ${sz:-?}"
  done
  echo
  echo "part checksums (sha256):"
  (cd "$ROOT" && find data env source -type f -print0 | sort -z | xargs -0 sha256sum | sed 's/^/  /')
} > "$ROOT/MANIFEST.txt"

mkdir -p "$OUT_DIR"
echo "==> compressing"
tar czf "$OUT_DIR/$SNAP" -C "$STAGE" "$SNAP"
(cd "$OUT_DIR" && sha256sum "$SNAP" > "$SNAP.sha256")

echo
echo "OK $OUT_DIR/$SNAP"
cat "$OUT_DIR/$SNAP.sha256"
