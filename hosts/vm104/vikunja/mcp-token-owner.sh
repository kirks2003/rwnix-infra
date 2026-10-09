#!/usr/bin/env bash
# Issue a Vikunja API token owned by USER for the vikunja-mcp sidecar,
# switch the sidecar to it and revoke the previous MCP token.
# Run on the Docker host as ubuntu from ~/docker/vikunja. The token is never
# printed: only its PBKDF2 hash goes to the DB, the plaintext only to .env.
# Hash scheme (Vikunja 2.6.0, verified against an existing token):
#   hex(pbkdf2_sha256(token, salt, 10000 iterations, 50 bytes))
set -euo pipefail
USER_NAME=${1:?usage: mcp-token-owner.sh <vikunja-username>}
DIR=$HOME/docker/vikunja
cd "$DIR"
psql() { docker exec -i vikunja-db psql -U vikunja -d vikunja -v ON_ERROR_STOP=1 -Atq "$@"; }

UID_=$(psql -c "select id from users where username='${USER_NAME//\'/}'")
[ -n "$UID_" ] || { echo "user $USER_NAME not found"; exit 1; }
OLD_ID=$(psql -c "select id from api_tokens where title='mcp' order by id limit 1")
[ -n "$OLD_ID" ] || { echo "no existing 'mcp' token to copy permissions from"; exit 1; }
OLD_OWNER=$(psql -c "select owner_id from api_tokens where id=$OLD_ID")
[ "$OLD_OWNER" != "$UID_" ] || { echo "mcp token already owned by $USER_NAME"; exit 0; }

BK=$DIR/backup-mcptoken-$(date +%Y%m%d_%H%M%S)
install -d -m 700 "$BK"
install -m 600 .env "$BK/.env"
psql -c "select row_to_json(t) from api_tokens t" > "$BK/api_tokens.jsonl"
chmod 600 "$BK/api_tokens.jsonl"

umask 077
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'EOF'
import hashlib, secrets, string, sys
d = sys.argv[1]
tok = "tk_" + secrets.token_hex(20)
salt = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(10))
h = hashlib.pbkdf2_hmac("sha256", tok.encode(), salt.encode(), 10000, 50).hex()
open(f"{d}/token", "w").write(tok)
open(f"{d}/header", "w").write(f"Authorization: Bearer {tok}\n")
open(f"{d}/sql", "w").write(
    "insert into api_tokens (title,token_salt,token_hash,token_last_eight,permissions,expires_at,created,owner_id) "
    f"select 'mcp','{salt}','{h}','{tok[-8:]}',permissions,expires_at,now(),{{uid}} from api_tokens where id={{old}} returning id;")
EOF
sed -i "s/{uid}/$UID_/; s/{old}/$OLD_ID/" "$TMP/sql"
NEW_ID=$(psql < "$TMP/sql" | head -1)
echo "new token id=$NEW_ID owner=$USER_NAME (old id=$OLD_ID owner_id=$OLD_OWNER)"

API=http://$(docker inspect vikunja --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):3456/api/v1
WHO=$(curl -fsS -m 10 -H @"$TMP/header" "$API/user" | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])') || WHO=
if [ "$WHO" != "$USER_NAME" ]; then
  psql -c "delete from api_tokens where id=$NEW_ID"
  echo "verification failed (got '$WHO'), new token removed, nothing switched"; exit 1
fi

python3 - "$TMP/token" <<'EOF'
import re, sys
tok = open(sys.argv[1]).read()
env = open(".env").read()
env, n = re.subn(r"(?m)^VIKUNJA_API_TOKEN=.*$", "VIKUNJA_API_TOKEN=" + tok, env)
if not n:
    env += ("" if env.endswith("\n") else "\n") + "VIKUNJA_API_TOKEN=" + tok + "\n"
open(".env", "w").write(env)
EOF
docker compose up -d --no-deps --no-build --force-recreate vikunja-mcp >/dev/null 2>&1

WHO2=$(docker exec vikunja-mcp sh -c 'wget -qO- --header="Authorization: Bearer $VIKUNJA_API_TOKEN" "$VIKUNJA_URL/user"' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])')
[ "$WHO2" = "$USER_NAME" ] || { echo "sidecar check failed ($WHO2); restore $BK/.env"; exit 1; }
psql -c "delete from api_tokens where id=$OLD_ID"
echo "OK: vikunja-mcp now acts as $WHO2; old token $OLD_ID revoked; backup $BK"
