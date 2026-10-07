# Vikunja MCP for Jarvis — design + region policy (2026-10-07)

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
- **Users** (both instances, identical): `admin`,
  `roman.windpassinger@gmail.com`. No `Mila` and no short-name `Roman` user
  yet on either instance.
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

## Open items (implementation steps, in order)

1. Decide Roman's account form (email vs `Roman`) and create the missing
   users on **both** instances.
2. Mint the per-user `jarvis` tokens on both hosts (script variant); copy
   the two `VIKUNJA_TOKENS` map entries into vm104's `.env`.
3. Set up the two SSH tunnels on vm104 (systemd) and verify
   `GET /user` returns the right username per region.
4. Backend: region resolution, token map, per-(region, user) MCP child,
   `mcpServers` advertisement (`id: "vikunja"`), brain prompt line,
   `.env.example` additions.
5. Tests: unit (region resolution, token map, spawn env per region/user,
   feature-off/unavailable paths) with a mock stdio Vikunja server, like
   `tests/mock-graph-mcp.mjs`; browser (switch in the controls row).
6. Rollout per `jarvis/DEPLOYMENT.md` procedure; retire or re-purpose the
   parked sidecars; record the rollout.
