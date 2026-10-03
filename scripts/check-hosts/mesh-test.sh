#!/usr/bin/env bash
# mesh-test.sh — test reachability of all mesh hosts (list in mesh-test-hosts.txt)
#              + docker host → kandev container
# Parallel by default on two tiers, both capped at MAX_PAR (25, hardcoded):
#   tier 1: host jobs run concurrently in a pool of at most $PAR jobs
#   tier 2: inside each job, the ping and ssh checks run concurrently
#           (2 subchecks per host — always under the cap)
# The local and the peer-sandbox runs also execute concurrently, so a bare
# `mesh-test.sh` is fully parallel end-to-end (no flag needed).
# After the result table, a host-type report is printed: per host the OS
# (Ubuntu/Debian, Proxmox VE, OpenWrt), whether the address is public or
# private (RFC1918), and for non-root logins whether `sudo su -` works
# (passwordless sudo, password required, or no sudo at all).
# Unreachable hosts are skipped after 2 s: ping waits PING_TIMEOUT for the
# reply, ssh gives up after SSH_TIMEOUT without TCP connect/banner and after
# 2 missed 1 s keepalives in an established session; SSH_MAX is only a hard
# ceiling for a session that stays alive but never finishes. Unknown host
# keys are added to known_hosts automatically (accept-new); a *changed* key
# is never replaced silently — the row reports it with the ssh-keygen -R fix.
# Usage: mesh-test.sh [--remote] [-p N | --parallel N] [label]

set -u
set -o pipefail
PING_TIMEOUT=2; SSH_TIMEOUT=2; SSH_MAX=10
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=$SSH_TIMEOUT
          -o ServerAliveInterval=1 -o ServerAliveCountMax=2
          -o StrictHostKeyChecking=accept-new -o PasswordAuthentication=no)
HAS_PING=no; command -v ping >/dev/null 2>&1 && HAS_PING=yes

# ANSI colors: green/yellow/orange/red/reset
C_GREEN='\033[0;32m'; C_YELLOW='\033[0;33m'; C_ORANGE='\033[38;5;214m'; C_RED='\033[0;31m'; C_RST='\033[0m'

MAX_PAR=25

# ---- args: [--remote] [-p N | --parallel N] [label] ----
PAR=$MAX_PAR
REMOTE=no
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE=yes; shift ;;
    -p) [ $# -ge 2 ] || { echo "ERROR: -p needs a count" >&2; exit 1; }; PAR="$2"; shift 2 ;;
    --parallel) [ $# -ge 2 ] || { echo "ERROR: --parallel needs a count" >&2; exit 1; }; PAR="$2"; shift 2 ;;
    -p*) PAR="${1#-p}"; shift ;;
    -*) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
    *) [ -z "$LABEL" ] || { echo "ERROR: only one label is allowed" >&2; exit 1; }; LABEL="$1"; shift ;;
  esac
done
case "$PAR" in ''|*[!0-9]*) echo "ERROR: parallel count must be a number (got: $PAR)" >&2; exit 1 ;; esac
PAR=${PAR#"${PAR%%[!0]*}"}
PAR=${PAR:-0}
if [ "${#PAR}" -gt 2 ]; then PAR=$MAX_PAR; else PAR=$((10#$PAR)); fi
[ "$PAR" -gt "$MAX_PAR" ] && PAR=$MAX_PAR
[ "$PAR" -lt 1 ] && PAR=1

# Detect which container
if ! HOST_GW=$(timeout $SSH_MAX ssh "${SSH_OPTS[@]}" ubuntu@172.26.0.1 "hostname"); then
  echo "ERROR: cannot identify the local sandbox's Docker host" >&2
  exit 1
fi
case "$HOST_GW" in
  *vie*) IAM="vie-1"; OTHER="nbg";  OTHER_USER="ubuntu"; OTHER_IP="152.53.118.212";;
  *nbg*) IAM="nbg";   OTHER="vie-1"; OTHER_USER="ubuntu"; OTHER_IP="152.53.35.177";;
  *) echo "ERROR: unrecognized Docker host: $HOST_GW" >&2; exit 1 ;;
esac

# Host list: data file next to this script — add hosts there, not here.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOSTFILE="$SCRIPT_DIR/mesh-test-hosts.txt"
if [ ! -r "$HOSTFILE" ]; then
  echo "ERROR: host list not found: $HOSTFILE" >&2
  exit 1
fi

HOSTS=()
while read -r alias user ip tag rest; do
  case "${alias:-}" in ''|\#*) continue ;; esac
  [ -n "${tag:-}" ] && [ "$tag" != "$IAM" ] && continue
  HOSTS+=("${alias}|${user}|${ip}")
done < "$HOSTFILE"
if [ ${#HOSTS[@]} -eq 0 ]; then
  echo "ERROR: no hosts to test (host file: $HOSTFILE)" >&2
  exit 1
fi

ga() { local e="$1"; echo "${e%%|*}"; }
gu() { local e="$1"; e="${e#*|}"; echo "${e%%|*}"; }
gi() { local e="$1"; e="${e#*|}"; e="${e#*|}"; echo "${e%%|*}"; }

# Remote probe program: prints hostname plus host-type info. POSIX sh, no
# single quotes (it is also embedded single-quoted in the two-hop container
# check). Protocol: line 1 "OK", then "HOST"/"OS"/"SUDO" key lines.
REMOTE_PROG='
h=$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname)
uid=$(id -u 2>/dev/null || echo 1)
name=$(sed -n "s/^NAME=//p" /etc/os-release 2>/dev/null | head -n1 | sed "s/\"//g")
ver=$(sed -n "s/^VERSION_ID=//p" /etc/os-release 2>/dev/null | head -n1 | sed "s/\"//g")
if [ -f /etc/openwrt_release ]; then
  name="OpenWrt"
elif [ -d /etc/pve ]; then
  name="Proxmox VE"
  ver=$(pveversion -v 2>/dev/null | head -n1 | sed "s/^proxmox-ve: //; s/ (running kernel:.*//")
fi
os="$name${ver:+ $ver}"
case "$os" in
  *[![:space:]]*) : ;;
  *) os=unknown ;;
esac
sudo="n/a (root login)"
if [ "$uid" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      sudo="sudo su - OK (passwordless)"
    else
      sudo="sudo needs a password"
    fi
  else
    sudo="no sudo installed"
  fi
fi
printf "OK\nHOST %s\nOS %s\nSUDO %s\n" "$h" "$os" "$sudo"
'

# public/private by RFC1918 ranges (container rows pass "ip:port")
ip_net() {
  case "${1%%:*}" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) echo "private" ;;
    *) echo "public" ;;
  esac
}

report_row() {
  local alias="$1" user="$2" ip="$3" meta="$4" os="" sudo=""
  if [ -r "$meta" ]; then
    os=$(sed -n 's/^OS=//p' "$meta" | head -n1)
    sudo=$(sed -n 's/^SUDO=//p' "$meta" | head -n1)
  fi
  printf "  %-16s %-8s %-22s %-9s %s\n" "$alias" "$user" "${os:--}" "$(ip_net "$ip")" "${sudo:--}"
}

do_ping() {
  local ip="$1"
  if [ "$HAS_PING" = "yes" ]; then
    local ms; ms=$(ping -c 1 -W $PING_TIMEOUT "$ip" 2>/dev/null | sed -n 's/.*time[=<]\([0-9.]*\) ms/\1/p')
    [ -n "$ms" ] && echo "$ms" || echo "FAIL"
  else
    local s e; s=$(date +%s%N)
    timeout $PING_TIMEOUT bash -c "exec 3<>/dev/tcp/$ip/22" 2>/dev/null && { e=$(date +%s%N); echo "$(( (e - s) / 1000000 ))"; } || echo "FAIL"
  fi
}

# Short failure reason for a failed ssh check (exit status, output, key hint)
ssh_fail_detail() {
  local status="$1" out="$2" keyhint="$3"
  if [ "$status" -eq 124 ]; then
    echo "timeout: no result within ${SSH_MAX}s"
  elif echo "$out" | grep -q "IDENTIFICATION HAS CHANGED\|Host key verification failed"; then
    echo "HOST KEY CHANGED: ssh-keygen -R $keyhint"
  elif echo "$out" | grep -qi "timed out\|Timeout, server"; then
    echo "no answer within ${SSH_TIMEOUT}s, skipped"
  else
    echo "$out" | grep -v '^@\|^$' | head -1 | tr -d '\n' | head -c 60
  fi
}

pick_color() {
  local ping_ok="$1" ssh_ok="$2"
  if [ "$ping_ok" = "OK" ] && [ "$ssh_ok" = "OK" ]; then echo "$C_GREEN"
  elif [ "$ping_ok" = "OK" ] && [ "$ssh_ok" != "OK" ]; then echo "$C_YELLOW"
  elif [ "$ping_ok" != "OK" ] && [ "$ssh_ok" = "OK" ]; then echo "$C_ORANGE"
  else echo "$C_RED"; fi
}

print_line() {
  local alias="$1" ip="$2" ping_ms="$3" ssh_res="$4" detail="$5"
  local ping_ok="FAIL"; [ "$ping_ms" != "FAIL" ] && ping_ok="OK"
  local color; color=$(pick_color "$ping_ok" "$ssh_res")
  local ms; [ "$ping_ms" = "FAIL" ] && ms="  ---  " || ms="$(printf "%5s" "$ping_ms")ms"
  printf "${color}  %-13s -> %-18s  ping=%7s  ssh=%-4s %s${C_RST}\n" \
    "$alias" "$ip" "$ms" "$ssh_res" "$detail"
}

# PS1-style names for the two docker hosts
declare -A PS1_NAME
PS1_NAME["nbg"]="kandev.gw-1-nbg-1-de-netcup"
PS1_NAME["vie-1"]="kandev.gw-1-vie-1-at-netcup"

# Docker host public IPs and container bridge IPs for both hosts
declare -A DHOST
DHOST["nbg"]="152.53.118.212"
DHOST["vie-1"]="152.53.35.177"
declare -A DCONTAINER
DCONTAINER["nbg"]="172.26.0.2"
DCONTAINER["vie-1"]="172.26.0.2"

# A display label must not change the sandbox identity used for routing.
LOCAL_LABEL="${LABEL:-kandev.${HOST_GW%.rwnix.net}}"

# Each job writes its formatted line to $WORK/<kind><idx>.line so the main
# shell can print results in input order after the pool drains. Inside each
# job the ping and ssh subchecks run concurrently (tier 2) and land in
# $WORK/<kind><idx>.{ping,ssh} (tab-separated: RESULT<TAB>DETAIL).
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

job_host() {
  local idx="$1" e="$2"
  local alias user ip
  alias=$(ga "$e"); user=$(gu "$e"); ip=$(gi "$e")
  ( do_ping "$ip" ) > "$WORK/h${idx}.ping" &
  local pid_ping=$!
  [ "$PAR" -gt 1 ] || wait "$pid_ping"
  (
    local out os sudo
    out=$(timeout $SSH_MAX ssh -n "${SSH_OPTS[@]}" "${user}@${ip}" "$REMOTE_PROG" 2>&1)
    local ssh_status=$?
    if [ "$ssh_status" -eq 0 ] && echo "$out" | grep -q "^OK"; then
      os=$(echo "$out" | sed -n 's/^OS //p' | head -n1)
      sudo=$(echo "$out" | sed -n 's/^SUDO //p' | head -n1)
      printf "OS=%s\nSUDO=%s\n" "${os:-unknown}" "${sudo:-unknown}" > "$WORK/h${idx}.meta"
      printf 'OK\t%s\n' "$(echo "$out" | sed -n 's/^HOST //p' | head -n1)"
    else
      printf 'FAIL\t%s\n' "$(ssh_fail_detail "$ssh_status" "$out" "$ip")"
    fi
  ) > "$WORK/h${idx}.ssh" &
  local pid_ssh=$!
  wait "$pid_ping" "$pid_ssh" 2>/dev/null
  local ping_ms ssh_res detail
  ping_ms=$(cat "$WORK/h${idx}.ping")
  ssh_res=$(cut -f1 "$WORK/h${idx}.ssh")
  detail=$(cut -f2- "$WORK/h${idx}.ssh")
  print_line "${user}@${alias}" "$ip" "$ping_ms" "$ssh_res" "$detail" > "$WORK/h${idx}.line"
  if [ "$ping_ms" != "FAIL" ] && [ "$ssh_res" = "OK" ]; then
    echo 0 > "$WORK/h${idx}.status"
  else
    echo 1 > "$WORK/h${idx}.status"
  fi
  rm -f "$WORK/h${idx}.ping" "$WORK/h${idx}.ssh"
}

job_container() {
  local idx="$1" h="$2"
  ( do_ping "${DHOST[$h]}" ) > "$WORK/c${idx}.ping" &
  local pid_ping=$!
  [ "$PAR" -gt 1 ] || wait "$pid_ping"
(
    local out os sudo
    out=$(timeout $SSH_MAX ssh -n "${SSH_OPTS[@]}" "ubuntu@${DHOST[$h]}" \
          "ssh ${SSH_OPTS[*]} -p 2222 kandev@127.0.0.1 '$REMOTE_PROG'" 2>&1)
    local ssh_status=$?
    if [ "$ssh_status" -eq 0 ] && echo "$out" | grep -q "^OK"; then
      os=$(echo "$out" | sed -n 's/^OS //p' | head -n1)
      sudo=$(echo "$out" | sed -n 's/^SUDO //p' | head -n1)
      printf "OS=%s\nSUDO=%s\n" "${os:-unknown}" "${sudo:-unknown}" > "$WORK/c${idx}.meta"
      printf 'OK\t%s\n' "${PS1_NAME[$h]:-$h}"
    else
      printf 'FAIL\t%s\n' "$(ssh_fail_detail "$ssh_status" "$out" "${DHOST[$h]} (or [127.0.0.1]:2222 on the host)")"
    fi
  ) > "$WORK/c${idx}.ssh" &
  local pid_ssh=$!
  wait "$pid_ping" "$pid_ssh" 2>/dev/null
  local ping_ms ssh_res detail
  ping_ms=$(cat "$WORK/c${idx}.ping")
  ssh_res=$(cut -f1 "$WORK/c${idx}.ssh")
  detail=$(cut -f2- "$WORK/c${idx}.ssh")
  print_line "kandev@${h}" "${DHOST[$h]}:2222" "$ping_ms" "$ssh_res" "$detail" > "$WORK/c${idx}.line"
  if [ "$ping_ms" != "FAIL" ] && [ "$ssh_res" = "OK" ]; then
    echo 0 > "$WORK/c${idx}.status"
  else
    echo 1 > "$WORK/c${idx}.status"
  fi
  rm -f "$WORK/c${idx}.ping" "$WORK/c${idx}.ssh"
}

# Tier 1: keep at most $PAR host jobs running; block until a slot frees up.
wait_slot() {
  local n
  while :; do
    n=$(jobs -rp | wc -l)
    [ "$n" -lt "$PAR" ] && break
    wait -n || true
  done
}

test_all() {
  local label="$1" i=0 j=0 k failed=0
  local cnames=()
  echo ""
  echo "--- From: $label (parallel, max $PAR hosts x 2 checks) ---"
  for e in "${HOSTS[@]}"; do
    wait_slot
    job_host "$i" "$e" &
    i=$((i+1))
  done
  for h in "$IAM" "$OTHER"; do
    wait_slot
    job_container "$j" "$h" &
    cnames+=("$h")
    j=$((j+1))
  done
  wait
  for ((k=0; k<i; k++)); do
    cat "$WORK/h$k.line"
    [ "$(cat "$WORK/h$k.status")" = 0 ] || failed=$((failed + 1))
  done
  for ((k=0; k<j; k++)); do
    cat "$WORK/c$k.line"
    [ "$(cat "$WORK/c$k.status")" = 0 ] || failed=$((failed + 1))
  done
  echo "Result: $((i + j - failed))/$((i + j)) passed"
  print_host_report "$i" "$j" "${cnames[@]}"
  [ "$failed" -eq 0 ]
}

# Host-type report: per host the OS, public/private address, and the sudo
# situation. For non-root logins the SUDO column answers whether
# `sudo su -` works (passwordless / password / missing).
print_host_report() {
  local i="$1" j="$2"; shift 2
  local cnames=("$@")
  echo ""
  echo "--- Host type & sudo su - report ---"
  printf "  %-16s %-8s %-22s %-9s %s\n" "host" "user" "os" "net" "sudo"
  local k e u s nr=0 bad=""
  for ((k=0; k<i; k++)); do
    e="${HOSTS[$k]}"
    report_row "$(ga "$e")" "$(gu "$e")" "$(gi "$e")" "$WORK/h${k}.meta"
    u=$(gu "$e")
    if [ "$u" != "root" ]; then
      nr=$((nr+1))
      s=$(sed -n 's/^SUDO=//p' "$WORK/h${k}.meta" 2>/dev/null | head -n1)
      case "${s:-}" in
        "sudo su - OK (passwordless)") : ;;
        *) bad="${bad}  $(ga "$e") ($u): ${s:-- (unreachable)}\n" ;;
      esac
    fi
  done
  for ((k=0; k<j; k++)); do
    report_row "kandev@${cnames[$k]}" "kandev" "${DHOST[${cnames[$k]}]}:2222" "$WORK/c${k}.meta"
    nr=$((nr+1))
    s=$(sed -n 's/^SUDO=//p' "$WORK/c${k}.meta" 2>/dev/null | head -n1)
    case "${s:-}" in
      "sudo su - OK (passwordless)") : ;;
      *) bad="${bad}  kandev@${cnames[$k]} (kandev): ${s:-- (unreachable)}\n" ;;
    esac
  done
  if [ -n "$bad" ]; then
    echo "  Non-root logins without working passwordless sudo (sudo su -):"
    printf "%b" "$bad"
  else
    echo "  All $nr non-root logins allow passwordless sudo (sudo su - works)."
  fi
}

# If --remote flag is set, only run local tests (avoids recursion)
if [ "$REMOTE" = "yes" ]; then
  echo "=========================================="
  echo " Mesh test — remote run"
  echo "=========================================="
  test_all "$LOCAL_LABEL"
  status=$?
  echo "=========================================="
  exit "$status"
fi

echo "=========================================="
echo " Mesh test — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Running from: $LOCAL_LABEL"
echo " Parallel: max $PAR hosts and $PAR per-host checks (hard cap $MAX_PAR), local + peer sandbox concurrent"
echo "=========================================="

# Run the local and the peer-sandbox tests concurrently (both tiers parallel
# on both sides, same -p); display order stays local section first.
test_all "$LOCAL_LABEL" > "$WORK/local.out" &
pid_local=$!
ssh -n "${SSH_OPTS[@]}" "${OTHER_USER}@${OTHER_IP}" \
  "docker exec -u 1000:999 kandev sh -c 'bash ~/scripts/check-hosts/mesh-test.sh --remote -p $PAR'" 2>"$WORK/remote.err" \
  | sed 's/^/  /' > "$WORK/remote.out" &
pid_remote=$!
wait "$pid_local"; local_status=$?
wait "$pid_remote"; remote_status=$?

cat "$WORK/local.out"
echo ""
echo "--- From: $OTHER (via ssh docker exec) ---"
cat "$WORK/remote.out"
cat "$WORK/remote.err" >&2
if [ "$remote_status" -ne 0 ]; then
  echo "ERROR: peer sandbox checks or SSH execution failed (exit $remote_status)" >&2
fi

echo ""
echo "=========================================="
echo " Done: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
[ "$local_status" -eq 0 ] && [ "$remote_status" -eq 0 ]
