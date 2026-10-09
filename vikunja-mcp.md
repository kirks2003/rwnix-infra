# Vikunja MCP for Jarvis — vm104-local deployment (updated 2026-10-09)

## 2026-10-09 current state

Jarvis now uses **one vm104-local Vikunja instance** for both public Jarvis
entries. The old nbg-1 Vikunja config/data was cloned to
`vm104:/home/ubuntu/docker/vikunja` (`vikunja` + `vikunja-db`, no parked MCP
sidecar), published only on the vm104 docker gateway
`172.17.0.1:34563 -> 3456`, and Jarvis' `VIKUNJA_URLS` maps both compatible
region keys to `http://host.docker.internal:34563/api/v1`.

The old per-gateway instances are retired:

- nbg-1 and vie-1 NPM `vikunja.*` proxy hosts were disabled in the NPM
  SQLite DB after backup.
- `docker compose down` removed `vikunja`, `vikunja-db` and `vikunja-mcp`
  containers on both gateways; named volumes were left in place as rollback
  data, and `/home/ubuntu/docker/vikunja-retired-bak-<ts>.tgz` backups were
  created.
- vm104's old SSH tunnel services
  `jarvis-vikunja-tunnel-nbg1.service` and
  `jarvis-vikunja-tunnel-vie1.service` were disabled/stopped.

Jarvis still resolves a compatibility region from the public `Host` header
(`nbg-1` / `vie-1`) and caches one MCP child per `(region, user)`, but both
regions now use the same cloned token map and same local API URL. The token is
still the scope: Roman's Jarvis turn uses Roman's Vikunja token, Mila's uses
Mila's; `VIKUNJA_MCP_ALLOW_DELETE` remains unset, so the brain can create and
update but not delete tasks.

Live validation on 2026-10-09:

- Jarvis container healthy and `/api/health` OK after rebuild.
- Direct vm104 Vikunja `/api/v1/info` returned `v2.6.0`.
- Jarvis chat with the Vikunja MCP switch created a smoke task through the
  vm104-local API, then the task was deleted via the API token; cleanup
  verified no smoke task remained.
- Graph MCP smoke verified a regular user can create/delete their own test
  entity, a different regular user cannot delete it, and the test entity was
  removed afterward.

The original 2026-10-07 region-pinned design is retained below as historical
context only; it is no longer the live topology.

# Historical design — region-pinned gateway Vikunja (2026-10-07)

Goal: give the Jarvis brain access to the user's Vikunja task manager through an
MCP server, where **each Jarvis user acts as their own Vikunja user** (Roman's
turns operate Roman's Vikunja account, Mila's Mila's) — and pin every service
MCP connection to the region the request came in on (policy below).

## Region policy (binding)

> **Jarvis on nbg-1 uses only service MCP connections to services on the
> nbg-1 host; Jarvis on vie-1 uses only service MCP connections to services on
> the vie-1 host.** No service MCP connection may cross regions, for any
> service (Vikunja today, future ones included).

Consequences for the current topology (single Jarvis backend, two public
entries):

- The backend must know **which region the request arrived on** and resolve
  the region's service endpoints per request. The public entry is the
  gateway, so the region is derivable from the request `Host` header
  (`jarvis.gw-1-nbg-1-de-netcup.rwnix.net` → nbg-1,
  `jarvis.gw-1-vie-1-at-netcup.rwnix.net` → vie-1); direct internal access
  (`192.168.54.111:8094`) falls back to a configured default region.
- A user's service data is **per region**: nbg-1's Vikunja and vie-1's
  Vikunja are separate instances with separate databases. Roman talking to
  Jarvis via the nbg-1 entry works in his nbg-1 Vikunja; via the vie-1 entry
  in his vie-1 Vikunja. This is intended, not a bug.
- Any new "service MCP" (a service whose API Jarvis reaches via MCP) must be
  added with a per-region endpoint table from day one — never one global URL.

## Findings (verified 2026-10-07)

### Topology

- **One Jarvis backend**: `vm104` (`192.168.54.111`, pve104). Both public
  routes proxy to it (NPM proxy_host 44 on nbg-1, 56 on vie-1 →
  `http://192.168.54.111:8094`; see `jarvis/DEPLOYMENT.md`, "Public routes").
  So "Jarvis on nbg-1 / on vie-1" today = the same backend behind two
  gateways; the region must be resolved per request as above.
- **Vikunja exists on both gateway hosts** (separate instances):
  `vikunja/vikunja:2.6.0` + `postgres:17.11` + a parked
  `vikunja-mcp:1.2.3-local` sidecar in `~/docker/vikunja/` on each host,
  on a shared Docker network `authelia_shared-vikunja` (172.29.0.0/24;
  vikunja app `172.29.0.2:3456`, db `.3`, mcp `.4`).
- Public exposure: `https://vikunja.gw-1-nbg-1-de-netcup.rwnix.net`
  (NPM proxy_host 20) and `https://vikunja.gw-1-vie-1-at-netcup.rwnix.net`
  (proxy_host 32), each proxying `172.29.0.2:3456` **behind the Authelia
  two-factor gate** (no Basic layer — Vikunja's UI sends its own Bearer
  header). The public route therefore cannot be the backend's API path
  (Authelia would gate the API calls); the backend must reach the Vikunja
  API internally (see Connectivity).
- **Users** (both instances, identical since 2026-10-07): `admin`,
  `roman.windpassinger@gmail.com` (kept for the admin UI), plus the
  short-name `Roman` and `Mila` accounts matching the Jarvis accounts
  (created via the container CLI `vikunja user create`; the CLI's password
  prompt needs a TTY, which `docker exec -it` provides only when the caller
  side has one — a small python `pty.fork` wrapper on each gateway host does
  the feeding, password via pty, never argv). Each new user has a generated
  password (reported to the user once, not stored here).
- **Parked sidecar**: the `vikunja-mcp` containers run `sleep infinity`
  (image CMD) with one API token each (`VIKUNJA_API_TOKEN`,
  `VIKUNJA_MCP_ALLOW_WRITE=1`, `VIKUNJA_URL=http://vikunja:3456/api/v1`).
  One token per gateway = one Vikunja user — the old single-owner design.
  The per-user design below replaces it; the sidecars stay parked (or are
  retired once the Jarvis integration is live).
- `~/docker/vikunja/mcp-token-owner.sh <username>` on each gateway host:
  mints a fresh API token **owned by a given Vikunja user** (PBKDF2-SHA256
  hash into `api_tokens`, plaintext only into `.env`), verifies it via
  `GET /user`, switches the sidecar to it and revokes the previous `mcp`
  token. Its mint/verify/rotate logic is the right template for issuing the
  per-user Jarvis tokens (minus the sidecar switch and revoke).

### The MCP server package

`@eargollo/vikunja-mcp@1.2.3` (the `vikunja-mcp:1.2.3-local` image is exactly
`node:22-alpine` + `npm i -g` of this package):

- **stdio MCP server** (official `@modelcontextprotocol/sdk`, one
  dependency, plain `node index.js`) — the same transport the Jarvis backend
  already speaks for `mcp/websearch.mjs` and `mcp/graph.mjs`.
- Env: `VIKUNJA_URL`, `VIKUNJA_API_TOKEN`, opt-in tiers
  `VIKUNJA_MCP_ALLOW_WRITE=1` (updates, sharing, webhooks, …) and
  `VIKUNJA_MCP_ALLOW_DELETE=1` (deletes). Read + additive tools (list/get/
  create, comments, assignees, labels, attachments) are always on.
- ~30 tools, grouped by tier: `list_projects`, `get_project`, `list_tasks`,
  `list_all_tasks`, `get_task`, `list_labels`, `search_users`,
  `list_task_comments`, `list_task_relations`, `list_buckets`, `create_task`,
  `create_project`, `add_label_to_task`, `assign_user`, `add_task_comment`,
  `upload_task_attachment`, … (see the package README for the full table).
- Scoping is **the token**: every request goes to `VIKUNJA_URL` with that
  token; a user's token can only see and change that user's data (plus what
  Vikunja's sharing grants).

### Jarvis-side fit

- `server.js` MCP client (line ~908): JSON-RPC 2.0 over stdio, and
  `spawn(command, args, { env: { ...process.env, ...this.extraEnv } })`
  already supports **per-server env at spawn time**. Today one child is
  reused per server id across requests; a per-user token needs the child
  keyed per **(region, user)** instead (spawn once per user per region,
  reuse across that user's requests).
- The per-browser **MCP switch** pattern (backend advertises `mcpServers` in
  `/api/config`, the UI builds one switch each, `/api/chat` carries
  `mcp: { id: true }`) applies unchanged: a third switch, **Vikunja tasks**.
- The shared five-round tool budget and request deadline apply to the
  Vikunja tools like the graph/web-search tools.

## Design

1. **Vikunja users** — one per (region, Jarvis account), same name as the
   Jarvis account (e.g. `Roman`, `Mila` on each instance). Today only
   `roman.windpassinger@gmail.com` exists on both; open item: keep that
   email as Roman's account or create a short-name `Roman` (recommend
   short names matching the Jarvis accounts; the email user can be kept for
   the admin UI). Create the missing users in each region (Vikunja admin).
2. **Tokens** — one API token per (region, user), title `jarvis` (distinct
   from the sidecar's `mcp` title), minted by a variant of
   `mcp-token-owner.sh` (mint + verify, **no sidecar switch, no revoke of
   the user's other tokens**). The plaintext tokens live in the Jarvis
   backend's `.env` on vm104 only, as a per-region JSON map, e.g.
   `VIKUNJA_TOKENS={"nbg-1":{"Roman":"tk_…","Mila":"tk_…"},
   "vie-1":{"Roman":"tk_…","Mila":"tk_…"}}`. Rotation = re-mint + edit the
   map + `docker compose up -d` (no code change).
3. **Region resolution** — `Host` header suffix → region (nbg-1 / vie-1);
   fallback `VIKUNJA_DEFAULT_REGION` for direct internal access. The region
   selects both the Vikunja URL and the token map entry. A request can
   never resolve to the other region's endpoints.
4. **MCP wiring** — the jarvis image installs `@eargollo/vikunja-mcp`
   (npm, pinned, like the old `neo4j-mcp` build-time install). When the
   Vikunja switch is on, the backend spawns the package's `index.js` (stdio)
   with `VIKUNJA_URL=<region URL>`, `VIKUNJA_API_TOKEN=<this user's token>`,
   `VIKUNJA_MCP_ALLOW_WRITE=1` and **no** `VIKUNJA_MCP_ALLOW_DELETE` (the
   brain can create and update, never delete; deletes stay in the Vikunja
   UI). The child is cached per (region, user). A user with no token for the
   active region gets the feature reported as unavailable (brain prompt
   line), not an error.
5. **Brain surface** — the system prompt gains a short line (switch on):
   the user's Vikunja task manager is available, acts as the user themself,
   confirm what was created/changed. Tools are the package's read + additive
   + write tiers as-is (no re-wrapping, no parameter injection needed —
   the token *is* the scope).
6. **Connectivity (vm104 → gateway hosts)** — the Vikunja API lives on the
   gateway host's internal Docker network (172.29.0.2:3456), and the public
   route is Authelia-gated. Recommended: **two persistent SSH tunnels from
   vm104** (systemd service, existing SSH trust),
   `127.0.0.1:34561 → nbg-1:172.29.0.2:3456` and
   `127.0.0.1:34562 → vie-1:172.29.0.2:3456`; the region table then maps
   nbg-1 → `http://127.0.0.1:34561/api/v1`, vie-1 → `http://127.0.0.1:34562/api/v1`.
   No new public or mesh listeners, auth stays SSH. Alternative: publish the
   port bound to the mesh/tunnel interface only (never the public IP) —
   rejected by default because it adds a new network surface to the gateway.

## Implementation (done 2026-10-07, rolled out live)

All six steps landed; the feature is live on vm104.

1. **Users** — short-name `Roman` and `Mila` created on **both** instances
   (the email user kept). The `vikunja user create` CLI reads its password
   with a TTY prompt that `docker exec -i` (pipe) cannot satisfy
   ("inappropriate ioctl for device"); `docker exec -it` requires the caller
   side to have a TTY too. Working feeder: a small python `pty.fork` wrapper
   (`/tmp/vk-pty.py` on each gateway) gives the docker CLI a real pty,
   disables local echo, and writes the password when the "Enter Password:"
   prompt appears (plus one retry write); `docker exec -it` then carries it
   into the container TTY. Passwords: generated per (host, user), reported
   to the user once, not stored anywhere but the user's own notes.
2. **Tokens** — one API token per (region, user), title `jarvis`, minted by
   `/tmp/vk-jarvis-token.sh` on each gateway (variant of
   `mcp-token-owner.sh`: PBKDF2-SHA256 hash into `api_tokens`, permissions
   copied from the existing `mcp` token, verified via `GET /user` against
   the owner, **no sidecar switch, no revoke**; idempotent — it refuses to
   double-mint). Plaintext tokens live only in vm104's `.env`
   (`VIKUNJA_TOKENS` JSON map, region → user → token). Rotation = delete the
   old `jarvis` row on that gateway, re-run the script, update the `.env`
   map, `docker compose up -d` (no code change).
3. **Tunnels** — two systemd units on vm104,
   `jarvis-vikunja-tunnel-nbg1.service` / `jarvis-vikunja-tunnel-vie1.service`:
   `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L
   172.17.0.1:3456{1,2}:172.29.0.2:3456 gw-{nbg-1,vie-1}` (mesh IPs
   10.1.1.1 / 10.2.1.1, `HostKeyAlias` on the public IP so known_hosts
   matches; `ServerAliveInterval 15`, `Restart=always`). **Bind address is
   `172.17.0.1` (the host's docker0 gateway), not `127.0.0.1`**: the jarvis
   container's loopback is its own, and its `host.docker.internal`
   (`host-gateway` in the compose `extra_hosts`) resolves to the docker0
   gateway on this host — a loopback-bound tunnel is invisible from inside
   the container (the first live smoke test failed with "connection
   refused" for exactly this reason, which the brain reported cleanly as
   "Vikunja is currently unreachable"). The container's `VIKUNJA_URLS`
   therefore point at `http://host.docker.internal:34561/api/v1` (nbg-1)
   and `:34562` (vie-1). Verified from inside the container: all four
   (region, user) token combos return the right username.
4. **Backend** (`jarvis/server.js`):
   - `VIKUNJA_HOST_REGIONS` maps the two public Host names to regions;
     `vikunjaRegionFor(host)` falls back to `VIKUNJA_DEFAULT_REGION`
     (live: `nbg-1`). The `/api/chat` handler passes `req.headers.host`
     into `chat()`.
   - `VIKUNJA_URLS` / `VIKUNJA_TOKENS` are parsed from JSON env
     (`parseJsonEnv`, warn-on-invalid); `vikunjaConfigured` = non-empty URL
     map, and only then does `/api/config` advertise the third switch
     (`{ id: "vikunja", label: "Vikunja" }`) — the UI builds it
     dynamically, no client change.
   - `vikunjaClientFor(region, user)` keeps one `McpClient` per
     (region, user), spawned as `node /usr/local/bin/vikunja-mcp`
     (`VIKUNJA_MCP_SCRIPT` overrides for tests) with `VIKUNJA_URL`,
     `VIKUNJA_API_TOKEN` and `VIKUNJA_MCP_ALLOW_WRITE=1` (no delete tier).
     New `McpClient.listTools()` (the package's `tools/list`) feeds the
     brain's tool list live; a per-request brain line tells the brain it
     acts as the user themself, per region, no delete, confirm changes.
   - `runBrain` offers the Vikunja tools in the shared five-round budget
     and dispatches by the live tool-name set; failures land as a
     "Vikunja lookup failed" tool result, never a 500.
   - `Dockerfile`: `npm install -g @eargollo/vikunja-mcp@1.2.3` (pinned,
     build-time, like the old `neo4j-mcp`); `.env.example` documents the
     three `VIKUNJA_*` vars.
5. **Tests** — unit: `server.test.mjs` "vikunja is region-pinned per
   request and scoped to the signed-in user" (mock stdio server whose
   `tools/call` echoes the spawned env, so the assertions pin URL **and**
   token per (region, user): Roman-on-nbg-1, Roman-on-vie-1, Mila-on-nbg-1,
   plus the OFF line, the no-token-for-region line, and the config
   advertisement; region is driven with a raw `http.request` because
   undici's `fetch` replaces a custom `Host` header). Browser: the
   MCP-switch test now advertises a second server and asserts a switch is
   built per advertised entry and the untouched flag rides along as `false`.
6. **Rollout** — see `jarvis/DEPLOYMENT.md` (2026-10-07 ~19:35 entry):
   backup `jarvis-code.bak-20261007_191340.tgz`, synced `server.js` /
   `Dockerfile` / `.env.example`, `docker compose up -d --build`, live
   verification incl. a real end-to-end `create_task` through the nbg-1
   entry (task landed on the nbg-1 instance only, absent on vie-1, deleted
   again afterwards).

Remaining: the parked `vikunja-mcp` sidecars (and their old single-owner
`mcp` tokens) are still running `sleep infinity` on both gateways — retired
or re-purposed at the next maintenance pass; nothing depends on them.

### Vikunja 2.6 API notes (measured)

- List endpoints are plural: `GET /api/v1/tasks`, `GET /api/v1/projects`
  (`/task`, `/project` are 404). Delete: `DELETE /api/v1/tasks/{id}`.
- Login: `POST /api/v1/login` with `{"username": ..., "password": ...}`
  (the field is `username`, not `email`).
- `api_tokens` hash scheme (verified against an existing token):
  `hex(pbkdf2_sha256(token, salt, 10000, 50))`.
