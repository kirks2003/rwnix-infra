# rwnix-infra

## Rules

### Deploy after testing — always

Recurring mistake (user-reported repeatedly, 2026-10-04): a fix verified in the git worktree but never rolled out to the live host, so the user keeps seeing the old behavior and re-reports the same bug. Changes to live-deployed services (e.g. `jarvis/`) are only complete when the live instance is running them. The user tests the running service, not the worktree.

1. Verify the implementation in the worktree (unit + browser tests, regression test for the reported symptom).
2. Immediately deploy with the documented procedure. For Jarvis (vm104 is **not** a git checkout; files are copied in): back up first (`/home/ubuntu/docker/jarvis-code.bak-<ts>.tgz`, code only, `.env` untouched), sync the changed files to `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104 (see `jarvis/DEPLOYMENT.md`).
3. Verify the live instance: container `healthy`, `/api/health` ok, and the served artifacts match the source (md5 of the served `app.js` / key strings in served HTML/CSS).
4. Only then report completion; when static assets changed, tell the user a browser hard refresh (Ctrl+Shift+R) is needed.

Never report a fix as done based on worktree tests alone.

### Snapshot backups (added 2026-10-09)

Crash-recovery snapshots are versioned with date and time
(`<service>-snapshot-v<N>-<YYYYMMDDTHHMMSSZ>.tgz` + `.sha256`), contain
secrets (live `.env` files), so they live **only** on the backup hosts —
never in git. Jarvis snapshot v1
(`jarvis-snapshot-v1-20261009T190532Z.tgz`) is stored on vm104
(`/home/ubuntu/backups/jarvis/`), nbg-1 and vie-1 (same path) and pve102
(`/local-zfs-1/backups/jarvis/`), each copy sha256-verified. Take a new
one with `scripts/jarvis/backup-jarvis.sh` (from a sandbox; stops the
stack ~1 min, keeps newest 5 per host); restore a host from scratch with
`scripts/jarvis/restore-jarvis.sh`.

**Coverage policy (binding):** every related container of a snapshot-
backed service (for Jarvis on vm104/pve104: `jarvis`, `jarvis-neo4j`,
`vikunja`, `vikunja-db`; the legacy stateless `whisper` is documented but
needs no data part) must be (1) documented in the repo MD files with its
compose file — no API keys in the repo, secrets only in host-local
`.env` + the snapshot — and (2) covered by the snapshot (every data
volume a part, deployed source mirrored). A service's backup is complete
only when a verified copy is on the source host **and** all three backup
hosts. This is what makes disaster recovery on a fresh host possible from
snapshot + repo alone. Policy, locations and inventory:
`snapshot-backups.md`; Jarvis-specific from-scratch setup + verified
restore results: `jarvis/DEPLOYMENT.md`.

### Jarvis service MCP topology (updated 2026-10-09)

Jarvis now uses one vm104-local Vikunja service MCP target for both public
entries. Keep the Host-header region keys (`nbg-1`, `vie-1`) in Jarvis config
for compatibility, but both map to the same vm104 Vikunja API
(`host.docker.internal:34563`). The old gateway Vikunja instances/exposures
were retired on 2026-10-09. Any future service MCP should document whether it
is vm104-local/shared or region-local before rollout; do not assume the old
Vikunja per-gateway pattern still exists. Full context: `vikunja-mcp.md`.

### Jarvis graph brain ingestion policy (added 2026-10-09, question storage added 2026-10-10)

Every Jarvis prompt/answer turn is extracted — one structured LLM call,
backend-side, fire-and-forget, never the brain — into entities and relation
connectors in the Neo4j graph DB (the assistant's brain), owner-scoped to the
signed-in user. **Binding policy: this automatic storage runs only when the
turn's request carries the Knowledge graph MCP toggle on
(`mcp.graph === true`).** With the toggle off the turn stores nothing (no
entities, no relations, no ingest activity entry) and the brain is told so,
so it does not promise to remember what it cannot store. Admin turns are
never auto-ingested (service account). The explicit write paths (the brain's
write tools with the toggle on, the panel's Remove button, the admin's
cross-owner tools) are deliberate actions and stay unaffected. Enforced in
`jarvis/server.js` (the `ingestTurn` gate in `chat()`); regression-tested in
`tests/graph.test.mjs` and `tests/server.test.mjs`. Docs:
`jarvis/README.md` ("Knowledge graph (Neo4j)" → "Stored policy: ingestion
only while the toggle is on").

**Question storage (2026-10-10):** a turn whose prompt is a question about
something stores, connected to the asking user, (1) the question subject as
an entity, (2) the answer's concrete entities and their links to the subject
(e.g. the films in a "tell me more about Jean Reno" answer,
`Jean Reno -ACTED_IN-> Léon: The Professional`), and (3) one
`ASKED_ABOUT` edge from the user's `:User` node to the subject carrying the
question's date and time (the edge's `last_seen`). The subjects come from the
extraction's `question_subjects` field (≤3); the `ASKED_ABOUT` edge itself is
booked deterministically by the backend — the type is reserved like `KNOWS`
and the extraction/brain can never emit it. The date is an edge attribute,
not a standalone node (keeps the 12-entity/turn budget; the edge attribute
answers "what did I ask about, and when?"). Surfaced in the panel (2D hover
tooltip) and the brain's `list-my-facts` (`asked about -> Jean Reno (on
2026-10-10)`). Enforced in `jarvis/graphdb.js` (`parseExtraction` +
`upsertTurn`), regression-tested in `tests/graph.test.mjs`
("a question turn stores the subject, the answer entities, the ASKED_ABOUT
link and the ask date"), `tests/mcp-graph.test.mjs` and
`tests/graph.browser.mjs`.

**User deletion policy (2026-10-10):** users are allowed to delete their own
graph (brain) entities — by asking the assistant (the brain's owner-scoped
`delete-entity`/`rename-entity`/`store-*` MCP tools; `:User` account nodes
can never be deleted) and via the panel's Remove button. Binding
implementation rules: (1) the brain must actually call the tool — the
backend verifies EVERY write-tool result on its success prefix
(`Deleted "`/`Stored `/`Renamed "`) and a non-success result (a not-found or
ambiguous answer is a non-error result that changed nothing) is audited
`ok:false` and fed back to the brain as "The operation did NOT succeed", so
a claimed deletion without a verified tool result is impossible; (2) the
write/delete tools resolve a UNIQUE close match on the user's phrasing
(owner-scoped; the shorter side ≥ 4 chars) — ambiguous matches are refused
with the candidate list, never guessed; (3) a verified write suppresses the
turn's automatic ingestion, so a "X was removed" confirmation cannot
resurrect X. Root cause of the 2026-10-10 incident (three claimed
deletions, all three entities still in the graph): the brain claimed
success without a successful tool call, exact-name-only matching missed the
user's phrasing ("self-hosted LLM for number forecasting" vs the stored
"Self-hosted LLM"), and the backend counted any non-error result as a
successful write. Enforced in `jarvis/server.js` (success-prefix
verification in the brain tool loop) and `jarvis/mcp/graph.mjs`
(`resolveEntityName` + `findEntityNear`), regression-tested in
`tests/mcp-graph.test.mjs` ("resolveEntityName: exact first, then a unique
close match, never short fragments") and `tests/graph.test.mjs` ("delete-
entity: a verified success … suppresses the re-ingest" / "delete-entity: a
not-found answer is a FAILED write …"). Docs: `jarvis/README.md`,
`jarvis/DEPLOYMENT.md` (2026-10-10 user-deletion section).

See `kandev-opencode-dsv4f-setup.md` for the Kandev opencode setup details.
See `kandev-opencode-qwen-setup.md` for the Kandev opencode a1-qwen38-27b setup details.
See `kandev-credential-setup.md` for the Kandev GitHub PAT credential setup.
See `kandev-ssh-ps1-setup.md` for the kandev104 SSH key and PS1/bash settings.
See `scripts/check-hosts/` for the mesh-test script and host list (copies; source of truth is `kirks2003/rw_mesh`).
See `pve-hosts.md` for the full Proxmox VE host inventory (public + internal, versions, OpenWrt gateway VMs), how to run `mesh-test.sh` from the gateway kandev containers, and the 2026-10-09 mesh test results.
See `docker-vm-inventory.md` for every PVE Docker VM (IPs, containers, the 5 Wine+MetaTrader5 stacks), how all 10 docker VMs are routed into the mesh via the OWRT gateway VMs (2026-10-09), the kandev key on each, and how to reach the OVH docker VMs from their PVE (temp `vmbr1` IP — no persistent host IP on the bridge).
See `scripts/host/mesh-password-rotate.py` for the emergency password rotation tool (copy; source of truth is `kirks2003/rw_mesh`).
See `jarvis/README.md` for the browser voice assistant (wake word, Whisper STT, brain, HAL 9000 answer voice, MCP web-search toggle) and `jarvis/DEPLOYMENT.md` for its live deployment, the gpu-1 Whisper/TTS service, the MCP web-search server and the measured voice-pipeline findings.
See `ovhcloud-exporter.md` for the nbg-1 OVHcloud billing/AI-endpoint-cost exporter, the "Cloud & AI Credits" Grafana dashboard (provisioned-file workflow), the OVH in-arrears billing finding, and the live `usage/current` integration.
See `vie1-grafana-ip-conflict.md` for the vie-1 Grafana stack, the `authelia_shared-grafana` network IP allocation, and the 2026-10-06 static-IP-conflict finding (telegraf stole grafana's pinned IP after a reboot).
See `vikunja-mcp.md` for the Vikunja MCP design (per-user Vikunja accounts/tokens, the `@eargollo/vikunja-mcp` sidecars on both gateways) and the binding Jarvis region policy for service MCP connections.
See `stocksense.md` for the StockSense AI stock-prediction deployment record (deployed 2026-10-09, **removed the same day** — finding record kept: measured VRAM/latency, Ollama vram-based default context, Finnhub 40-char header-auth quirk, per-symbol provider fallback, Chart.js scrollbar flicker, empty-`stock_quotes` ETL gap) and `llm_forecasting.md` for the original self-hosted LLM forecasting option comparison.
See `hosts/README.md` for the per-service docker compose files of the whole fleet (nbg-1, vie-1, vm103, vm104, gpu-1) — the repo copy is the source of truth, the deploy procedure (back up → scp → `docker compose up -d` → verify), and the no-inline-secrets rule: compose files reference `${VAR}` and the values live in a host-local `.env` (chmod 600, gitignored), never in the repo.
