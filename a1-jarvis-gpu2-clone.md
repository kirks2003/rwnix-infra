# a1 Jarvis demo on gpu-2 — clone policy from pve104

Binding policy for distributing the **actual pve104 Jarvis** to the
**a1-enterprise company demo** on **gpu-2** (`92.39.59.7`, user `ubuntu`).
The demo must be the same app with the same functions as pve104, minus the
owner's private LLM links, minus all graph data, rebranded to a1.

Mirror of this document: `romeowindi/a1-jarvis` (private repo, a1 side).
The two copies must stay in sync; the rwnix-infra copy is maintained by the
owner, the a1-jarvis copy is the a1-side reference. **Status 2026-10-10: the
mirror repo does not exist yet** — it belongs to the `romeowindi` account,
which this repo's deploy token cannot create. Until the owner creates it
(empty repo + `kirks2003` as collaborator, or a romeowindi token is provided
so the agent can create and push it), the rwnix-infra copy is the single
source of truth.

## Binding rules

1. **Clone the whole app and all functions** — voice pipeline (wake word,
   Whisper STT, brain, HAL TTS), knowledge graph (Neo4j) with panel and brain
   tools, prompt/answer history, multi-user login, MCP toggles (web search,
   Vikunja, graph). No feature is removed from the demo.
2. **No private LLM links.** The owner's private endpoints — the Claude Code
   API profile, Whisper on vm103, OVHcloud and OpenRouter — must not appear
   in the demo: no selector entries, no advertised endpoints, no keys in any
   env file. The demo advertises exactly two brain profiles
   (`a1-deepseek`, `a1-qwen`) and one Whisper/TTS profile (`gpu-1`), all on
   shared mesh infrastructure. Mechanism:
   - `BRAIN_PROFILES=a1-deepseek,a1-qwen` in the demo `.env` — the backend
     only builds and advertises the listed AI profiles (`buildAiProfiles` in
     `jarvis/server.js`); unlisted profiles are absent from `/api/config`
     entirely, so the UI selector cannot show them (not even disabled).
   - `WHISPER_VM103_ENDPOINTS=` and `WHISPER_OVHCLOUD_ENDPOINTS=` set
     **empty** (not unset — `??` semantics: empty disables the profile, unset
     falls back to the default URL) so only the `gpu-1` Whisper profile
     remains (`buildWhisperProfiles` filters on non-empty endpoints).
   - None of the private keys exist in the demo `.env` (forbidden list below).
3. **No cloned graph data.** The demo Neo4j database starts empty — no
   `:User` nodes, no `:Entity` nodes, no relations from pve104. Sarah's brain
   is built from scratch by her own turns.
4. **Demo user: `Sarah`**, documented **only** in the host-local `.env`
   (`USERS=...,Sarah:<sarah-password>`). Never in this repo, never in
   a1-jarvis — the a1 side receives the credential out of band. The owner's
   `admin` account stays for maintenance.
5. **No Authelia on the demo link.** The demo is fronted by Nginx Proxy
   Manager **basic auth** with user `demo` (password stored only in the NPM
   database / access-list htpasswd on gpu-2, never in any repo). The
   Authelia auth_request block must NOT be in the jarvis proxy host's
   advanced config.
6. **Reuse the gpu-2 NPM domain prefix** `<service>.gpu-2-de-fra-1-exo.csdc-nm.at`
   — the demo lives at `jarvis.gpu-2-de-fra-1-exo.csdc-nm.at` (proxy host
   forwarding to `127.0.0.1:8094`, SSL forced, websocket upgrade on).
7. **a1 branding.** The a1 instance keeps the pve104 layout but uses the a1
   colors and logo: `BRAND=a1` in the demo `.env` makes the server inject
   `public/theme-a1.css` (a1.net palette: white/light-gray surfaces, dark
   text, a1 red `#DA291C` accent, secondary `#005FCC`) and the a1 logo
   (`public/logo-a1.png`, 146×146 PNG from `cdn21.a1.net`, 2026-10-10) into
   the served index.html. **Without `BRAND=a1` the app is served
   byte-identical** — the pve104 deployment is never affected.
8. **No secrets in any repo.** No API keys, no user passwords, no tokens in
   rwnix-infra or a1-jarvis — not in code, not in compose files, not in
   docs. All values live in the host-local `/home/ubuntu/docker/jarvis/.env`
   (chmod 600) and the NPM database on gpu-2. This document names env vars
   and public endpoint hosts only.

## Live state (audited 2026-10-10)

- Code cloned **2026-10-08** to `/home/ubuntu/docker/jarvis` (same layout as
  vm104: code copied, `.env` host-local); containers `jarvis` +
  `jarvis-neo4j` (neo4j:5.26.31-community) on port 8094; NPM proxy host
  created 2026-10-08 (`jarvis.gpu-2-de-fra-1-exo.csdc-nm.at`).
- Private LLM env values already blanked at clone time
  (`BRAIN_CLAUDECODE_*`, `BRAIN_OVHCLOUD_*`, `BRAIN_OPENROUTER_*`,
  `WHISPER_VM103_*` empty).
- Graph DB audited empty (no users, no entities) — rule 3 satisfied.
- 2026-10-10: `BRAIN_PROFILES` allowlist + `BRAND=a1` theme added to the
  repo and rolled out (this closes the "selector still listed the private
  profiles as disabled" gap), `Sarah` added to `USERS`, NPM row switched
  from Authelia+mesh-admin to basic auth `demo`.
- 2026-10-10 (later, same day): **credential rotation** — the owner set the
  gateway basic-auth user `demo` and the demo app user `Sarah` to **one
  shared password** (a strong value chosen by the owner; per rule 8 it is
  recorded in no repo — it exists only in the NPM access-list htpasswd and
  the host-local `.env`). Both values rotated on gpu-2 and live-verified
  (new → 200, old → 401/403); the previously used gateway/app values are
  dead. Deployment mechanics: `jarvis/DEPLOYMENT.md` (2026-10-10 later
  entry).

## Demo `.env` (names only — values are host-local, never in a repo)

```
# Branding
BRAND=a1
# Profile allowlist: the private profiles do not exist for this deployment
BRAIN_PROFILES=a1-deepseek,a1-qwen
# Brain (a1 endpoints on shared mesh; keys stay host-local)
BRAIN_BASE_URL=...            # a1-deepseek (gpu-2 local LLM)
BRAIN_MODEL=...
BRAIN_API_KEY=...
BRAIN_PROFILE_DEFAULT=a1-deepseek
BRAIN_A1_QWEN_BASE_URL=...    # a1-qwen (gpu-1 LLM)
BRAIN_A1_QWEN_MODEL=...
BRAIN_A1_QWEN_API_KEY=...
# Whisper / TTS — only the shared gpu-1 voice service; the private
# endpoints are disabled by being explicitly EMPTY
WHISPER_ENDPOINTS=...         # gpu-1 voice service
WHISPER_GPU1_ENDPOINTS=...
WHISPER_VM103_ENDPOINTS=      # must stay empty (private, vm103)
WHISPER_OVHCLOUD_ENDPOINTS=   # must stay empty (private, OVHcloud)
TTS_ENDPOINTS=...
TTS_MODEL=...
# Graph (demo Neo4j, local compose service `neo4j`)
NEO4J_URI=bolt://neo4j:7687
NEO4J_READ_USER=... NEO4J_READ_PASSWORD=...
NEO4J_WRITE_USER=... NEO4J_WRITE_PASSWORD=...
NEO4J_MCP_*=...
# Users — Sarah is the demo account, admin is owner maintenance
USERS=admin:...,Sarah:<sarah-password>
ADMIN_USERS=admin
# Misc
PUBLIC_BASE_PATH=/
WAKE_PHRASE=...
PORT=8094
JARVIS_BIND_IP=...
```

**Forbidden in the demo `.env` (must not exist or must be empty):**
`BRAIN_CLAUDECODE_API_KEY`, `BRAIN_CLAUDECODE_BASE_URL`,
`BRAIN_CLAUDECODE_MODEL`, `BRAIN_OVHCLOUD_API_KEY`,
`BRAIN_OVHCLOUD_BASE_URL`, `BRAIN_OPENROUTER_API_KEY`,
`BRAIN_OPENROUTER_BASE_URL`, `WHISPER_VM103_API_KEY`,
`WHISPER_VM103_ENDPOINTS` (empty), `WHISPER_OVHCLOUD_API_KEY`,
`WHISPER_OVHCLOUD_ENDPOINTS` (empty), `EMBEDDING_*` (unset on the demo),
`VIKUNJA_*` (unset on the demo).

## Reproducing the demo from scratch

Prereq: gpu-2 with Docker + NPM running (`npm-ui`), the mesh reachable from
gpu-2 (a1 LLM/voice endpoints on gpu-1/gpu-2 resolve).

1. **Code**: copy the current `main` of this repo's `jarvis/` to
   `/home/ubuntu/docker/jarvis` (backup first:
   `/home/ubuntu/docker/jarvis-code.bak-<ts>.tgz`, code only — never the
   `.env`).
2. **`.env`**: create host-local (chmod 600) from the template above; fill
   the real values (brain/whisper/TTS keys, Neo4j credentials, Sarah's
   password) — never commit them.
3. **Compose**: `docker compose up -d --build` in
   `/home/ubuntu/docker/jarvis` (services: `jarvis` on 8094, `neo4j`
   5.26.31-community). Fresh `neo4j` volume = empty graph (rule 3).
4. **NPM** (container `npm-ui`, DB
   `/home/ubuntu/docker/nginx-proxy-manager/npm/data/database.sqlite`):
   proxy host `jarvis.gpu-2-de-fra-1-exo.csdc-nm.at` → `127.0.0.1:8094`,
   SSL forced, websocket upgrade, **advanced config WITHOUT the Authelia
   block** — only the basic-auth layer:
   `auth_basic` + `auth_basic_user_file` for a dedicated access list whose
   single user is `demo` (password `<demo-basic-auth-password>`, stored only
   in the NPM database), plus the standard
   `proxy_set_header`/websocket/`proxy.conf` includes.
5. **Verify** (checklist below), then tell the user a hard refresh
   (Ctrl+Shift+R) is needed after any static-asset change.

## Verification checklist

- [ ] containers `jarvis` + `jarvis-neo4j` healthy; `GET :8094/api/health` ok
- [ ] served index.html (via the public host) contains `theme-a1.css` +
      `logo-a1.png`; the a1 logo renders; page is light with a1 red accents
- [ ] login as `Sarah` (credential from the host-local `.env`) works; `admin`
      still works (owner)
- [ ] AI profile selector shows **exactly** `A1 DeepSeek` + `A1 Qwen` — no
      Claude Code / OVHcloud / OpenRouter, not even disabled
- [ ] Whisper selector shows **only** `gpu-1`
- [ ] a voice turn works end-to-end (wake word → STT → brain → HAL TTS)
- [ ] graph panel empty for a fresh user; a question turn stores the user's
      entities + `ASKED_ABOUT` edge (toggle on)
- [ ] the demo link prompts basic auth `demo` — **no** Authelia portal
- [ ] no private key value appears anywhere in `jarvis/` source, the demo
      `.env` template in this doc, or any repo file

## Deploy notes (owner side)

- Rollout to the demo follows the AGENTS.md rule: verify in the worktree
  (unit + browser tests), then deploy to gpu-2 and verify the live instance
  (health + served artifacts match source).
- The pve104 (vm104) deployment runs the same code **without** `BRAND` and
  **without** `BRAIN_PROFILES` — byte-identical look and full profile set.
- Dated rollout record: `jarvis/DEPLOYMENT.md` (repo + host copy).
