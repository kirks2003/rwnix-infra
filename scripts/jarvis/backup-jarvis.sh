#!/usr/bin/env bash
# Build a Jarvis snapshot on the docker host and distribute verified copies
# to all backup hosts. Run from a machine with SSH access to JARVIS_HOST and
# every destination (the Kandev sandboxes have all of them; see pve-hosts.md).
#
#   bash scripts/jarvis/backup-jarvis.sh
#
# Env overrides:
#   JARVIS_HOST        ssh alias of the docker host (default vm104)
#   SNAPSHOT_VERSION   snapshot version for the file name (default 1)
#   DESTS              space-separated "host:remote-dir" pairs (default below)
#   RETAIN             snapshots to keep per destination (default 5)
#   REPO_HEAD          repo commit the deployed code came from (default: git HEAD here)
set -euo pipefail

JARVIS_HOST=${JARVIS_HOST:-vm104}
SNAPSHOT_VERSION=${SNAPSHOT_VERSION:-1}
RETAIN=${RETAIN:-5}
REPO_HEAD=${REPO_HEAD:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}
DESTS=${DESTS:-"nbg-1:/home/ubuntu/backups/jarvis vie-1:/home/ubuntu/backups/jarvis pve102:/local-zfs-1/backups/jarvis"}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "==> building snapshot on $JARVIS_HOST (repo head $REPO_HEAD)"
ssh "$JARVIS_HOST" 'cat > /tmp/snapshot-jarvis.sh' < "$SCRIPT_DIR/snapshot-jarvis.sh"
SNAP_OUT=$(ssh "$JARVIS_HOST" "SNAPSHOT_VERSION=$SNAPSHOT_VERSION REPO_HEAD=$REPO_HEAD bash /tmp/snapshot-jarvis.sh")
printf '%s\n' "$SNAP_OUT"
SNAP_PATH=$(printf '%s\n' "$SNAP_OUT" | sed -n 's/^OK //p' | tail -1)
[ -n "$SNAP_PATH" ] || { echo "FATAL: snapshot build did not report a path"; exit 1; }
SNAP_NAME=$(basename "$SNAP_PATH")

fail=0
for dest in $DESTS; do
  host=${dest%%:*}
  dir=${dest#*:}
  echo "==> $host:$dir"
  ssh "$host" "mkdir -p '$dir'"
  scp -q "$JARVIS_HOST:$SNAP_PATH" "$host:$dir/"
  scp -q "$JARVIS_HOST:$SNAP_PATH.sha256" "$host:$dir/"
  if ssh "$host" "cd '$dir' && sha256sum -c '$SNAP_NAME.sha256' >/dev/null 2>&1"; then
    echo "    verified: sha256 OK"
  else
    echo "    FAILED: sha256 mismatch on $host"
    fail=1
  fi
  # prune old snapshots beyond RETAIN (strict name pattern only)
  ssh "$host" "cd '$dir' && ls -1t jarvis-snapshot-*.tgz 2>/dev/null | tail -n +$((RETAIN + 1)) | while read -r f; do rm -f \"\$f\" \"\$f.sha256\"; echo \"    pruned \$f\"; done"
done

echo
if [ "$fail" = "0" ]; then
  echo "OK: $SNAP_NAME verified on all destinations"
  for dest in $DESTS; do
    echo "  ${dest%%:*}:${dest#*:}/$SNAP_NAME"
  done
else
  echo "FAILED: checksum mismatch on at least one destination"
  exit 1
fi
