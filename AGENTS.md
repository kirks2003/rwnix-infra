# rwnix-infra

## Rules

### Deploy after testing — always

Recurring mistake (user-reported repeatedly, 2026-10-04): a fix verified in the git worktree but never rolled out to the live host, so the user keeps seeing the old behavior and re-reports the same bug. Changes to live-deployed services (e.g. `jarvis/`) are only complete when the live instance is running them. The user tests the running service, not the worktree.

1. Verify the implementation in the worktree (unit + browser tests, regression test for the reported symptom).
2. Immediately deploy with the documented procedure. For Jarvis (vm104 is **not** a git checkout; files are copied in): back up first (`/home/ubuntu/docker/jarvis-code.bak-<ts>.tgz`, code only, `.env` untouched), sync the changed files to `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104 (see `jarvis/DEPLOYMENT.md`).
3. Verify the live instance: container `healthy`, `/api/health` ok, and the served artifacts match the source (md5 of the served `app.js` / key strings in served HTML/CSS).
4. Only then report completion; when static assets changed, tell the user a browser hard refresh (Ctrl+Shift+R) is needed.

Never report a fix as done based on worktree tests alone.

### Jarvis region policy — service MCP connections are region-pinned (2026-10-07)

**Jarvis on nbg-1 must use only service MCP connections to services on the nbg-1 host; Jarvis on vie-1 only to services on the vie-1 host.** No service MCP connection may cross regions (Vikunja today, any future service MCP included). Today one Jarvis backend (vm104) sits behind both public gateways, so the region is resolved **per request** from the public entry (gateway `Host` header) and the backend pins that region's service endpoints for the request; a user's service data is per region by design. Any new service MCP must ship with a per-region endpoint table from day one — never one global URL. Full context (Vikunja topology, per-user token design, rollout steps): `vikunja-mcp.md`.

See `kandev-opencode-dsv4f-setup.md` for the Kandev opencode setup details.
See `kandev-opencode-qwen-setup.md` for the Kandev opencode a1-qwen38-27b setup details.
See `kandev-credential-setup.md` for the Kandev GitHub PAT credential setup.
See `kandev-ssh-ps1-setup.md` for the kandev104 SSH key and PS1/bash settings.
See `scripts/check-hosts/` for the mesh-test script and host list (copies; source of truth is `kirks2003/rw_mesh`).
See `pve-hosts.md` for the full Proxmox VE host inventory (public + internal, versions, OpenWrt gateway VMs), how to run `mesh-test.sh` from the gateway kandev containers, and the 2026-10-09 mesh test results.
See `scripts/host/mesh-password-rotate.py` for the emergency password rotation tool (copy; source of truth is `kirks2003/rw_mesh`).
See `jarvis/README.md` for the browser voice assistant (wake word, Whisper STT, brain, HAL 9000 answer voice, MCP web-search toggle) and `jarvis/DEPLOYMENT.md` for its live deployment, the gpu-1 Whisper/TTS service, the MCP web-search server and the measured voice-pipeline findings.
See `ovhcloud-exporter.md` for the nbg-1 OVHcloud billing/AI-endpoint-cost exporter, the "Cloud & AI Credits" Grafana dashboard (provisioned-file workflow), the OVH in-arrears billing finding, and the live `usage/current` integration.
See `vie1-grafana-ip-conflict.md` for the vie-1 Grafana stack, the `authelia_shared-grafana` network IP allocation, and the 2026-10-06 static-IP-conflict finding (telegraf stole grafana's pinned IP after a reboot).
See `vikunja-mcp.md` for the Vikunja MCP design (per-user Vikunja accounts/tokens, the `@eargollo/vikunja-mcp` sidecars on both gateways) and the binding Jarvis region policy for service MCP connections.
See `stocksense.md` for the StockSense AI stock-prediction deployment record (deployed 2026-10-09, **removed the same day** — finding record kept: measured VRAM/latency, Ollama vram-based default context, Finnhub 40-char header-auth quirk, per-symbol provider fallback, Chart.js scrollbar flicker, empty-`stock_quotes` ETL gap) and `llm_forecasting.md` for the original self-hosted LLM forecasting option comparison.
See `hosts/README.md` for the per-service docker compose files of the whole fleet (nbg-1, vie-1, vm103, vm104, gpu-1) — the repo copy is the source of truth, the deploy procedure (back up → scp → `docker compose up -d` → verify), and the no-inline-secrets rule: compose files reference `${VAR}` and the values live in a host-local `.env` (chmod 600, gitignored), never in the repo.
