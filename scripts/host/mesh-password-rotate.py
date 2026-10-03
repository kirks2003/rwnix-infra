#!/usr/bin/env python3
"""Rotate shared emergency UI passwords for mesh infrastructure.

The script is intentionally host-local: run it on nbg-1 or vie-1 as root.
It generates one strong password per run, stores it in a local root-only
fallback file, and sends it to service-specific updaters through stdin or
local database APIs. It never prints the generated password.

Examples:
  mesh-password-rotate.py --dry-run --include openwrt,proxmox,npm-basic \
    --openwrt-host owrt-pve101 --proxmox-host pve101

  mesh-password-rotate.py --yes --include openwrt,proxmox,npm-basic \
    --openwrt-host owrt-pve101 --proxmox-host pve101
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import string
import subprocess
import sys
import tempfile
from pathlib import Path


NPM_DB = Path("/home/ubuntu/docker/nginx-proxy-manager/data/database.sqlite")
GRAFANA_DB = Path("/home/ubuntu/docker/grafana/data/grafana.db")
KUMA_DB = Path("/home/ubuntu/docker/uptime-kuma/data/kuma.db")
WGEASY_DB = Path("/home/ubuntu/docker/wg-easy/data/wg-easy.db")
VIKUNJA_DIR = Path("/home/ubuntu/docker/vikunja")
PORTAINER_VOLUME = "portainer_data"
BCRYPT_HELPER_CONTAINER = "nginx-proxy-manager"

HOST_FQDNS = {
    "nbg-1": "gw-1-nbg-1-de-netcup.rwnix.net",
    "vie-1": "gw-1-vie-1-at-netcup.rwnix.net",
}

SSH_IDENTITY: str | None = None

DEFAULT_SERVICES = (
    "openwrt",
    "proxmox",
    "npm-basic",
    "npm-admin",
    "grafana",
    "kuma",
    "vikunja",
    "wg-easy",
    "portainer",
)


class RotationError(RuntimeError):
    pass


def run(cmd: list[str], *, input_text: str | None = None, check: bool = True,
        capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=check,
    )


def ssh_cmd(host: str) -> list[str]:
    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UpdateHostKeys=no",
    ]
    if SSH_IDENTITY:
        cmd.extend(["-i", SSH_IDENTITY, "-o", "IdentitiesOnly=yes"])
    cmd.append(host)
    return cmd


def require_root() -> None:
    if os.geteuid() != 0:
        raise RotationError("run as root on nbg-1 or vie-1")


def generate_password(length: int) -> str:
    # Avoid shell/JSON/URL metacharacters while keeping high entropy.
    alphabet = string.ascii_letters + string.digits + "-._~"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def default_secret_path() -> Path:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = Path("/root/mesh-password-rotation") if os.geteuid() == 0 else (
        Path.home() / ".local/share/mesh-password-rotation"
    )
    return base / f"rotation-{ts}.json"


def target_inventory(args: argparse.Namespace, services: list[str]) -> list[dict[str, str]]:
    targets: list[dict[str, str]] = []
    if "openwrt" in services:
        for host in args.openwrt_host:
            targets.append({
                "service": "openwrt",
                "host": host,
                "ui": "LuCI",
                "user": "root",
                "login": "root",
            })
    if "proxmox" in services:
        for host in args.proxmox_host:
            targets.append({
                "service": "proxmox",
                "host": host,
                "ui": "Proxmox VE",
                "user": "root",
                "login": "root@pam",
            })
    local_specs = {
        "npm-basic": ("Nginx Proxy Manager Basic Auth", args.npm_basic_user, "mesh-admin/basic"),
        "npm-admin": ("Nginx Proxy Manager", args.npm_admin_email, args.npm_admin_email),
        "grafana": ("Grafana", args.grafana_user, args.grafana_user),
        "kuma": ("Uptime Kuma", args.kuma_user, args.kuma_user),
        "vikunja": ("Vikunja", args.vikunja_user, args.vikunja_user),
        "wg-easy": ("wg-easy", args.wg_easy_user, args.wg_easy_user),
        "portainer": ("Portainer", args.portainer_user, args.portainer_user),
    }
    for service, (ui, user, login) in local_specs.items():
        if service in services:
            targets.append({
                "service": service,
                "host": args.host_role,
                "ui": ui,
                "user": user,
                "login": login,
            })
    return targets


def write_secret_file(path: Path, password: str, services: list[str],
                      args: argparse.Namespace) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    old_umask = os.umask(0o177)
    try:
        data = {
            "created_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "created_by": getpass.getuser(),
            "host_role": args.host_role,
            "services": services,
            "openwrt_hosts": args.openwrt_host,
            "proxmox_hosts": args.proxmox_host,
            "targets": target_inventory(args, services),
            "notes": "Emergency fallback password. Do not commit or print.",
            "password": password,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.chmod(path, 0o600)
    finally:
        os.umask(old_umask)


def update_secret_metadata(path: Path, args: argparse.Namespace, services: list[str],
                           results: list[str]) -> None:
    if not path.exists():
        return
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if "password" not in data:
        raise RotationError(f"{path} is missing password during metadata update")
    existing_targets = data.get("targets", [])
    if not isinstance(existing_targets, list):
        existing_targets = []
    merged_targets: dict[tuple[str, str, str], dict[str, str]] = {}
    for item in existing_targets + target_inventory(args, services):
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("service", "")),
            str(item.get("host", "")),
            str(item.get("login", "")),
        )
        merged_targets[key] = {str(k): str(v) for k, v in item.items()}

    existing_results = data.get("results", [])
    if not isinstance(existing_results, list):
        existing_results = []
    merged_results = [str(r) for r in existing_results]
    for result in results:
        if result not in merged_results:
            merged_results.append(result)

    existing_services = data.get("services", [])
    if not isinstance(existing_services, list):
        existing_services = []
    merged_services = sorted({str(s) for s in existing_services + services})

    data.update({
        "updated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "host_role": args.host_role,
        "services": merged_services,
        "openwrt_hosts": sorted({str(h) for h in data.get("openwrt_hosts", []) + args.openwrt_host}),
        "proxmox_hosts": sorted({str(h) for h in data.get("proxmox_hosts", []) + args.proxmox_host}),
        "targets": list(merged_targets.values()),
        "results": merged_results,
    })
    old_umask = os.umask(0o177)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
        os.chmod(path, 0o600)
    finally:
        os.umask(old_umask)


def read_secret_file(path: Path) -> str:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    password = data.get("password")
    if not isinstance(password, str) or not password:
        raise RotationError(f"{path} does not contain a password")
    return password


def read_password_stdin() -> str:
    password = sys.stdin.readline()
    if password.endswith("\n"):
        password = password[:-1]
    if not password:
        raise RotationError("--password-stdin received an empty password")
    return password


def backup_sqlite(db_path: Path, label: str) -> Path:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = db_path.with_name(f"{db_path.name}.bak-password-rotate-{label}-{ts}")
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    dst = sqlite3.connect(backup)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    os.chmod(backup, 0o600)
    return backup


def sqlite_exec(db_path: Path, sql: str, params: tuple = ()) -> int:
    con = sqlite3.connect(db_path)
    try:
        cur = con.execute(sql, params)
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def hash_bcrypt_with_node(password: str) -> str:
    js = (
        "const bcrypt=require('bcryptjs');"
        "let p='';process.stdin.on('data',d=>p+=d);"
        "process.stdin.on('end',()=>console.log(bcrypt.hashSync(p.replace(/\\n$/,''),12)));"
    )
    cp = run(["docker", "exec", "-i", BCRYPT_HELPER_CONTAINER, "node", "-e", js],
             input_text=password + "\n")
    value = cp.stdout.strip()
    if not value.startswith("$2"):
        raise RotationError("bcrypt helper did not return a bcrypt hash")
    return value


def hash_apr1_with_npm(password: str) -> str:
    cp = run(
        ["docker", "exec", "-i", "nginx-proxy-manager", "openssl", "passwd", "-apr1", "-stdin"],
        input_text=password + "\n",
    )
    value = cp.stdout.strip()
    if not value.startswith("$apr1$"):
        raise RotationError("openssl did not return an apr1 htpasswd hash")
    return value


def rotate_openwrt(hosts: list[str], password: str, dry_run: bool) -> list[str]:
    if not hosts:
        return ["openwrt: no hosts selected"]
    lines = []
    script = r"""set -eu
if [ -z "$PW" ]; then echo "empty password" >&2; exit 2; fi
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp -p /etc/shadow "/etc/shadow.bak-password-rotate-$TS"
(printf '%s\n%s\n' "$PW" "$PW" | passwd root) >/tmp/password-rotate-passwd.log 2>&1
ESC=$(printf '%s' "$PW" | sed 's/\\/\\\\/g; s/"/\\"/g')
if command -v ubus >/dev/null 2>&1; then
  ubus call session login "{\"username\":\"root\",\"password\":\"$ESC\"}" >/dev/null
fi
rm -f /tmp/password-rotate-passwd.log
"""
    for host in hosts:
        if dry_run:
            lines.append(f"openwrt:{host}: would backup /etc/shadow, run passwd root, validate ubus login")
            continue
        cp = run(
            ssh_cmd(host) + ["read -r PW; export PW; sh -s"],
            input_text=password + "\n" + script,
        )
        if cp.stdout.strip():
            raise RotationError(f"openwrt:{host}: unexpected stdout")
        lines.append(f"openwrt:{host}: rotated root/LuCI password and validated local login")
    return lines


def rotate_proxmox(hosts: list[str], password: str, dry_run: bool) -> list[str]:
    if not hosts:
        return ["proxmox: no hosts selected"]
    lines = []
    script = r"""set -eu
if [ -z "$PW" ]; then echo "empty password" >&2; exit 2; fi
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp -p /etc/shadow "/etc/shadow.bak-password-rotate-$TS"
printf 'root:%s\n' "$PW" | chpasswd
CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
{
  printf 'silent\nshow-error\ninsecure\nrequest = POST\n'
  printf 'data-urlencode = username=root@pam\n'
  printf 'data-urlencode = password=%s\n' "$PW"
} > "$CFG"
curl -K "$CFG" -m 10 https://127.0.0.1:8006/api2/json/access/ticket \
  | grep -q '"ticket"'
"""
    for host in hosts:
        if dry_run:
            lines.append(f"proxmox:{host}: would backup /etc/shadow, chpasswd root, validate root@pam API ticket")
            continue
        cp = run(
            ssh_cmd(host) + ["read -r PW; export PW; bash -s"],
            input_text=password + "\n" + script,
        )
        if cp.stdout.strip():
            raise RotationError(f"proxmox:{host}: unexpected stdout")
        lines.append(f"proxmox:{host}: rotated root/PVE password and validated root@pam")
    return lines


def rotate_npm_basic(username: str, password: str, dry_run: bool) -> list[str]:
    if dry_run and not NPM_DB.exists():
        return [f"npm-basic:{username}: would inspect/update access_list_auth rows and regenerate NPM config"]
    con = sqlite3.connect(NPM_DB)
    try:
        rows = con.execute(
            "select id,access_list_id,username from access_list_auth where username=?",
            (username,),
        ).fetchall()
    finally:
        con.close()
    if dry_run:
        lists = sorted({r[1] for r in rows})
        return [f"npm-basic:{username}: would update {len(rows)} DB row(s), access file(s) {lists}, and reload nginx"]
    if not rows:
        raise RotationError(f"npm-basic:{username}: no matching access_list_auth rows")
    backup = backup_sqlite(NPM_DB, "npm-basic")
    count = sqlite_exec(
        NPM_DB,
        "update access_list_auth set password=?, modified_on=datetime('now') where username=?",
        (password, username),
    )
    apr1 = hash_apr1_with_npm(password)
    for _, access_list_id, _ in rows:
        access_path = Path(f"/home/ubuntu/docker/nginx-proxy-manager/data/access/{access_list_id}")
        if not access_path.exists():
            raise RotationError(f"npm-basic:{username}: missing generated access file {access_path}")
        backup_access = access_path.with_name(
            f"{access_path.name}.bak-password-rotate-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
        )
        shutil.copy2(access_path, backup_access)
        lines = access_path.read_text(encoding="utf-8").splitlines()
        replaced = False
        out = []
        for line in lines:
            if line.startswith(username + ":"):
                out.append(f"{username}:{apr1}")
                replaced = True
            else:
                out.append(line)
        if not replaced:
            out.append(f"{username}:{apr1}")
        access_path.write_text("\n".join(out) + "\n", encoding="utf-8")
        os.chmod(access_path, 0o644)
    run(["docker", "exec", "nginx-proxy-manager", "node", "/app/scripts/regenerate-config", "-y"])
    run(["docker", "exec", "nginx-proxy-manager", "nginx", "-t"])
    run(["docker", "exec", "nginx-proxy-manager", "nginx", "-s", "reload"])
    return [f"npm-basic:{username}: updated {count} DB row(s) and generated access file(s); backup {backup}"]


def rotate_npm_admin(email: str, password: str, dry_run: bool) -> list[str]:
    if dry_run and not NPM_DB.exists():
        return [f"npm-admin:{email}: would inspect/update password auth hash"]
    con = sqlite3.connect(NPM_DB)
    try:
        row = con.execute(
            "select auth.id from auth join user on user.id=auth.user_id "
            "where user.email=? and auth.type='password' and auth.is_deleted=0",
            (email,),
        ).fetchone()
    finally:
        con.close()
    if dry_run:
        return [f"npm-admin:{email}: would update auth secret"]
    if not row:
        raise RotationError(f"npm-admin:{email}: no active password auth row")
    secret = hash_bcrypt_with_node(password)
    backup = backup_sqlite(NPM_DB, "npm-admin")
    sqlite_exec(NPM_DB, "update auth set secret=?, modified_on=datetime('now') where id=?",
                (secret, row[0]))
    return [f"npm-admin:{email}: updated auth hash; backup {backup}"]


def rotate_grafana(login: str, password: str, dry_run: bool) -> list[str]:
    if dry_run and not GRAFANA_DB.exists():
        return [f"grafana:{login}: would inspect/update PBKDF2 password fields"]
    con = sqlite3.connect(GRAFANA_DB)
    try:
        row = con.execute("select id from user where login=?", (login,)).fetchone()
    finally:
        con.close()
    if dry_run:
        return [f"grafana:{login}: would update PBKDF2 password fields"]
    if not row:
        raise RotationError(f"grafana:{login}: user not found")
    salt = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(10))
    rands = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(10))
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 10000, 50).hex()
    backup = backup_sqlite(GRAFANA_DB, "grafana")
    sqlite_exec(GRAFANA_DB, "update user set password=?, salt=?, rands=?, updated=datetime('now') where id=?",
                (digest, salt, rands, row[0]))
    return [f"grafana:{login}: updated password hash; backup {backup}"]


def rotate_kuma(username: str, password: str, dry_run: bool) -> list[str]:
    if dry_run and not KUMA_DB.exists():
        return [f"kuma:{username}: would inspect/update bcrypt hash in kuma.db"]
    con = sqlite3.connect(KUMA_DB)
    try:
        row = con.execute("select id from user where username=?", (username,)).fetchone()
    finally:
        con.close()
    if dry_run:
        return [f"kuma:{username}: would update bcrypt hash in kuma.db"]
    if not row:
        raise RotationError(f"kuma:{username}: user not found")
    js = (
        "const bcrypt=require('/app/node_modules/bcryptjs');"
        "let p='';process.stdin.on('data',d=>p+=d);"
        "process.stdin.on('end',()=>console.log(bcrypt.hashSync(p.replace(/\\n$/,''),10)));"
    )
    cp = run(["docker", "exec", "-i", "uptime-kuma", "node", "-e", js],
             input_text=password + "\n")
    secret = cp.stdout.strip()
    backup = backup_sqlite(KUMA_DB, "kuma")
    sqlite_exec(KUMA_DB, "update user set password=? where id=?", (secret, row[0]))
    return [f"kuma:{username}: updated bcrypt hash; backup {backup}"]


def rotate_vikunja(username: str, password: str, dry_run: bool) -> list[str]:
    psql = ["docker", "exec", "-i", "vikunja-db", "psql", "-U", "vikunja",
            "-d", "vikunja", "-Atq"]
    cp = run(psql + ["-c", f"select id from users where username='{username.replace(chr(39), chr(39)*2)}'"])
    user_id = cp.stdout.strip()
    if dry_run:
        return [f"vikunja:{username}: would reset password for user id {user_id or 'NOT_FOUND'}"]
    if not user_id:
        raise RotationError(f"vikunja:{username}: user not found")
    backup_dir = VIKUNJA_DIR / f"backup-password-rotate-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    backup_dir.mkdir(mode=0o700)
    run(psql + ["-c", "select row_to_json(u) from users u"], capture=True).stdout
    with open(backup_dir / "users.jsonl", "w", encoding="utf-8") as fh:
        fh.write(run(psql + ["-c", "select row_to_json(u) from users u"]).stdout)
    os.chmod(backup_dir / "users.jsonl", 0o600)
    cp = run(
        ["docker", "exec", "-i", "vikunja", "/app/vikunja/vikunja",
         "user", "reset-password", user_id, "--direct"],
        input_text=password + "\n",
        check=False,
    )
    if cp.returncode != 0:
        # Fallback for versions requiring --password; do not use because it
        # exposes the password in process args.
        raise RotationError(f"vikunja:{username}: stdin reset failed; refusing argv password fallback")
    return [f"vikunja:{username}: reset password through Vikunja CLI; backup {backup_dir}"]


def rotate_wgeasy(username: str, password: str, dry_run: bool) -> list[str]:
    if dry_run and not WGEASY_DB.exists():
        return [f"wg-easy:{username}: would inspect/update argon2id hash"]
    con = sqlite3.connect(WGEASY_DB)
    try:
        row = con.execute("select id from users_table where username=?", (username,)).fetchone()
    finally:
        con.close()
    if dry_run:
        return [f"wg-easy:{username}: would update argon2id hash"]
    if not row:
        raise RotationError(f"wg-easy:{username}: user not found")
    try:
        from argon2 import PasswordHasher
    except Exception as exc:  # pragma: no cover - host dependency check
        raise RotationError("python argon2 module is required for wg-easy") from exc
    secret = PasswordHasher().hash(password)
    backup = backup_sqlite(WGEASY_DB, "wg-easy")
    sqlite_exec(WGEASY_DB, "update users_table set password=?, updated_at=datetime('now') where id=?",
                (secret, row[0]))
    return [f"wg-easy:{username}: updated argon2id hash; backup {backup}"]


def rotate_portainer(username: str, password: str, dry_run: bool) -> list[str]:
    if dry_run:
        return [f"portainer:{username}: would stop Portainer, bcrypt password, update bbolt users bucket, restart"]
    secret = hash_bcrypt_with_node(password)
    tmp = tempfile.TemporaryDirectory()
    try:
        writer = Path(tmp.name) / "update-portainer.go"
        writer.write_text(PORTAINER_GO, encoding="utf-8")
        subprocess.run(["docker", "compose", "-f", "/home/ubuntu/docker/portainer/docker-compose.yml", "stop", "portainer"],
                       check=True)
        cp = run([
            "docker", "run", "--rm",
            "-v", f"{PORTAINER_VOLUME}:/data",
            "-v", "bboltcache:/go/pkg/mod",
            "-v", f"{writer}:/update-portainer.go:ro",
            "golang:alpine",
            "sh", "-lc",
            "cd /tmp && go mod init portainer-update >/dev/null 2>&1 && "
            "go get go.etcd.io/bbolt@v1.5.0 >/dev/null 2>&1 && "
            "go run /update-portainer.go /data/portainer.db",
        ], input_text=json.dumps({"username": username, "hash": secret}) + "\n")
        subprocess.run(["docker", "compose", "-f", "/home/ubuntu/docker/portainer/docker-compose.yml", "up", "-d", "--no-build", "--pull", "never", "portainer"],
                       check=True)
        return [f"portainer:{username}: {cp.stdout.strip() or 'updated password hash'}"]
    finally:
        tmp.cleanup()


PORTAINER_GO = r'''
package main
import (
  "encoding/binary"; "encoding/json"; "fmt"; "io"; "os"
  bolt "go.etcd.io/bbolt"
)
type input struct { Username string `json:"username"`; Hash string `json:"hash"` }
func main() {
  if len(os.Args) != 2 { panic("usage: update-portainer.go DB") }
  b, _ := io.ReadAll(os.Stdin); var in input
  if err := json.Unmarshal(b, &in); err != nil { panic(err) }
  db, err := bolt.Open(os.Args[1], 0600, nil); if err != nil { panic(err) }
  defer db.Close()
  err = db.Update(func(tx *bolt.Tx) error {
    bucket := tx.Bucket([]byte("users")); if bucket == nil { return fmt.Errorf("users bucket missing") }
    c := bucket.Cursor()
    for k, v := c.First(); k != nil; k, v = c.Next() {
      var m map[string]any
      if err := json.Unmarshal(v, &m); err != nil { continue }
      if m["Username"] == in.Username || m["Name"] == in.Username {
        m["Password"] = in.Hash
        out, err := json.Marshal(m); if err != nil { return err }
        return bucket.Put(k, out)
      }
    }
    // Most deployments use id=1 for admin; keep this fallback explicit.
    key := make([]byte, 8); binary.BigEndian.PutUint64(key, 1)
    v := bucket.Get(key); if v == nil { return fmt.Errorf("user %s not found", in.Username) }
    var m map[string]any
    if err := json.Unmarshal(v, &m); err != nil { return err }
    m["Password"] = in.Hash
    out, err := json.Marshal(m); if err != nil { return err }
    return bucket.Put(key, out)
  })
  if err != nil { panic(err) }
  fmt.Println("updated bbolt user")
}
'''


def parse_services(value: str) -> list[str]:
    services = [s.strip() for s in value.split(",") if s.strip()]
    unknown = sorted(set(services) - set(DEFAULT_SERVICES))
    if unknown:
        raise RotationError(f"unknown service(s): {', '.join(unknown)}")
    return services


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host-role", choices=sorted(HOST_FQDNS), required=True,
                    help="local host role, used for docs/fallback metadata")
    ap.add_argument("--include", required=True,
                    help="comma-separated services: " + ",".join(DEFAULT_SERVICES))
    ap.add_argument("--openwrt-host", action="append", default=[],
                    help="OpenWrt SSH alias to rotate; repeatable")
    ap.add_argument("--proxmox-host", action="append", default=[],
                    help="Proxmox SSH alias to rotate; repeatable")
    ap.add_argument("--npm-basic-user", default="admin")
    ap.add_argument("--npm-admin-email", default="roman.windpassinger@gmail.com")
    ap.add_argument("--grafana-user", default="roman.windpassinger@gmail.com")
    ap.add_argument("--kuma-user", default="admin")
    ap.add_argument("--vikunja-user", default="roman.windpassinger@gmail.com")
    ap.add_argument("--wg-easy-user", default="admin")
    ap.add_argument("--portainer-user", default="admin")
    ap.add_argument("--password-length", type=int, default=36)
    ap.add_argument("--ssh-identity", default=None,
                    help="private key for remote OpenWrt/Proxmox SSH; defaults to /home/ubuntu/.ssh/kandev when run as root")
    ap.add_argument("--password-file", type=Path, default=None,
                    help="fallback file to write/read; default is /root/mesh-password-rotation/rotation-*.json")
    ap.add_argument("--reuse-password-file", action="store_true",
                    help="read password from --password-file instead of generating a new one")
    ap.add_argument("--password-stdin", action="store_true",
                    help="read a caller-supplied password from stdin and store it in the fallback file; never pass passwords as argv")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true",
                    help="required for mutations")
    args = ap.parse_args()

    try:
        services = parse_services(args.include)
        global SSH_IDENTITY
        SSH_IDENTITY = args.ssh_identity
        if SSH_IDENTITY is None and os.geteuid() == 0 and Path("/home/ubuntu/.ssh/kandev").exists():
            SSH_IDENTITY = "/home/ubuntu/.ssh/kandev"
        if not args.dry_run:
            require_root()
            if not args.yes:
                raise RotationError("--yes is required unless --dry-run is set")
        if args.reuse_password_file and args.password_stdin:
            raise RotationError("--reuse-password-file and --password-stdin are mutually exclusive")
        if args.reuse_password_file:
            if not args.password_file:
                raise RotationError("--reuse-password-file requires --password-file")
            password = read_secret_file(args.password_file)
            secret_path = args.password_file
        elif args.password_stdin:
            password = read_password_stdin()
            secret_path = args.password_file or default_secret_path()
            if not args.dry_run:
                write_secret_file(secret_path, password, services, args)
        else:
            if args.password_length < 24:
                raise RotationError("--password-length must be at least 24")
            password = generate_password(args.password_length)
            secret_path = args.password_file or default_secret_path()
            if not args.dry_run:
                write_secret_file(secret_path, password, services, args)

        if args.dry_run:
            print(f"DRY RUN: would use fallback file {secret_path}")
        else:
            print(f"Fallback password file: {secret_path}")

        results: list[str] = []
        for svc in services:
            if svc == "openwrt":
                results.extend(rotate_openwrt(args.openwrt_host, password, args.dry_run))
            elif svc == "proxmox":
                results.extend(rotate_proxmox(args.proxmox_host, password, args.dry_run))
            elif svc == "npm-basic":
                results.extend(rotate_npm_basic(args.npm_basic_user, password, args.dry_run))
            elif svc == "npm-admin":
                results.extend(rotate_npm_admin(args.npm_admin_email, password, args.dry_run))
            elif svc == "grafana":
                results.extend(rotate_grafana(args.grafana_user, password, args.dry_run))
            elif svc == "kuma":
                results.extend(rotate_kuma(args.kuma_user, password, args.dry_run))
            elif svc == "vikunja":
                results.extend(rotate_vikunja(args.vikunja_user, password, args.dry_run))
            elif svc == "wg-easy":
                results.extend(rotate_wgeasy(args.wg_easy_user, password, args.dry_run))
            elif svc == "portainer":
                results.extend(rotate_portainer(args.portainer_user, password, args.dry_run))

        if not args.dry_run:
            update_secret_metadata(secret_path, args, services, results)
        print("Results:")
        for line in results:
            print(f"- {line}")
        return 0
    except (RotationError, subprocess.CalledProcessError) as exc:
        if isinstance(exc, subprocess.CalledProcessError):
            detail = (exc.stderr or exc.stdout or "").strip()
            print(f"ERROR: command failed: {' '.join(exc.cmd)}", file=sys.stderr)
            if detail:
                print(detail[-2000:], file=sys.stderr)
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
