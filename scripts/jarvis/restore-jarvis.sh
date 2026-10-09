#!/usr/bin/env bash
# Restore the Jarvis stack (jarvis + jarvis-neo4j + vikunja + vikunja-db)
# from a snapshot tgz on a fresh or rebuilt host. Use this after a fatal
# crash when the host must be set up from scratch — see snapshot-backups.md
# (repo root) and jarvis/DEPLOYMENT.md ("From-scratch setup").
#
#   bash restore-jarvis.sh /path/to/jarvis-snapshot-v1-<ts>.tgz
#
# Prerequisites on the target host: docker + compose v2 installed, user in
# the docker group, the snapshot file (and its .sha256) copied over. The
# script assumes the canonical layout:
#   ~/docker/jarvis   (jarvis + neo4j, compose project "jarvis")
#   ~/docker/vikunja  (vikunja + db,    compose project "vikunja")
# so the restored volume names (jarvis_jarvis_data, jarvis_neo4j_data,
# vikunja_vikunja_db, vikunja_vikunja_files) match what compose creates.
# It refuses to run over an existing deployment unless --force is given.
#
# Env overrides (defaults are the canonical layout): JARVIS_RESTORE_DIR,
# VIKUNJA_RESTORE_DIR, JARVIS_COMPOSE_PROJECT, VIKUNJA_COMPOSE_PROJECT,
# VIKUNJA_INFO_URL, PRE_START_CMD (shell snippet run before `docker compose
# up`, e.g. to tweak the restored .env for a test restore).
set -euo pipefail

SNAP=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *.tgz) SNAP=$arg ;;
    *) echo "unknown argument: $arg"; exit 1 ;;
  esac
done
[ -n "$SNAP" ] || { echo "usage: restore-jarvis.sh <snapshot.tgz> [--force]"; exit 1; }
[ -f "$SNAP" ] || { echo "FATAL: no such file: $SNAP"; exit 1; }

JDIR=${JARVIS_RESTORE_DIR:-${HOME}/docker/jarvis}
VDIR=${VIKUNJA_RESTORE_DIR:-${HOME}/docker/vikunja}
JPROJ=${JARVIS_COMPOSE_PROJECT:-jarvis}
VPROJ=${VIKUNJA_COMPOSE_PROJECT:-vikunja}
JARVIS_CONTAINER=${JARVIS_CONTAINER:-jarvis}
VIKUNJA_INFO_URL=${VIKUNJA_INFO_URL:-http://172.17.0.1:34563/api/v1/info}

if { [ -f "$JDIR/.env" ] || [ -f "$VDIR/.env" ]; } && [ "$FORCE" != "1" ]; then
  echo "FATAL: existing deployment found in $JDIR / $VDIR. Re-run with --force to overwrite."
  exit 1
fi

echo "==> verifying snapshot checksum"
SNAP_DIR=$(cd "$(dirname "$SNAP")" && pwd)
SNAP_NAME=$(basename "$SNAP")
if [ -f "$SNAP_DIR/$SNAP_NAME.sha256" ]; then
  (cd "$SNAP_DIR" && sha256sum -c "$SNAP_NAME.sha256")
else
  echo "WARN: $SNAP_NAME.sha256 not beside the snapshot — continuing without checksum"
fi

echo "==> extracting"
STAGE=$(mktemp -d /tmp/jarvis-restore.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
tar xzf "$SNAP" -C "$STAGE"
ROOT=$(find "$STAGE" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -f "$ROOT/MANIFEST.txt" ] || { echo "FATAL: MANIFEST.txt missing — not a Jarvis snapshot"; exit 1; }
echo "snapshot: $(grep -m1 '^snapshot:' "$ROOT/MANIFEST.txt")"
echo "repo head: $(grep -m1 '^repo head:' "$ROOT/MANIFEST.txt")"

echo "==> verifying parts against the manifest"
grep -E '^[[:space:]]+[0-9a-f]{64}[[:space:]]' "$ROOT/MANIFEST.txt" | sed 's/^[[:space:]]*//' > "$STAGE/manifest.sha256"
(cd "$ROOT" && sha256sum -c "$STAGE/manifest.sha256")

echo "==> restoring source + env files"
mkdir -p "$JDIR" "$VDIR"
cp -a "$ROOT/source/jarvis/." "$JDIR/"
cp -a "$ROOT/source/vikunja/." "$VDIR/"
install -m 600 "$ROOT/env/jarvis.env" "$JDIR/.env"
install -m 600 "$ROOT/env/vikunja.env" "$VDIR/.env"
if [ -f "$ROOT/env/vikunja-admin-login.txt" ]; then
  install -m 600 "$ROOT/env/vikunja-admin-login.txt" "$VDIR/admin-login.txt"
fi

echo "==> restoring docker volumes"
restore_vol() { # $1=volume  $2=tarball name
  docker volume create "$1" >/dev/null
  docker run --rm -v "$1":/dest -v "$ROOT/data":/snap:ro alpine \
    tar xzf "/snap/$2" -C /dest
}
restore_vol "${JPROJ}_jarvis_data"    jarvis_data.tar
restore_vol "${JPROJ}_neo4j_data"     neo4j_data.tar
restore_vol "${VPROJ}_vikunja_db"     vikunja_db.tar
restore_vol "${VPROJ}_vikunja_files"  vikunja_files.tar

if [ -n "${PRE_START_CMD:-}" ]; then
  echo "==> running PRE_START_CMD"
  bash -c "$PRE_START_CMD"
fi

echo "==> starting the stack (jarvis image build takes a few minutes)"
(cd "$JDIR" && COMPOSE_PROJECT_NAME="$JPROJ" docker compose up -d --build)
(cd "$VDIR" && COMPOSE_PROJECT_NAME="$VPROJ" docker compose up -d)

echo "==> waiting for healthy state"
st="starting"
for _ in $(seq 1 90); do
  st=$(docker inspect --format '{{.State.Health.Status}}' "$JARVIS_CONTAINER" 2>/dev/null || echo starting)
  [ "$st" = "healthy" ] && break
  sleep 5
done
if [ "$st" != "healthy" ]; then
  echo "FATAL: $JARVIS_CONTAINER is not healthy (state: $st)"
  docker logs --tail 50 "$JARVIS_CONTAINER" || true
  exit 1
fi
echo "jarvis: $(docker exec "$JARVIS_CONTAINER" node -e "fetch('http://127.0.0.1:8094/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})")"
for _ in $(seq 1 30); do
  if curl -fsS -m 5 "$VIKUNJA_INFO_URL" >/dev/null 2>&1; then
    echo "vikunja: $(curl -fsS -m 5 "$VIKUNJA_INFO_URL")"
    break
  fi
  sleep 5
done
echo
echo "OK: Jarvis restored from $SNAP"
echo "Next: public routes (NPM proxy hosts on nbg-1/vie-1) if this is a replacement host — see jarvis/DEPLOYMENT.md."
