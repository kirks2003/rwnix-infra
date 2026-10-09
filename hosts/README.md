# Host compose files — source of truth

Every per-service `docker-compose` file on the fleet lives in this tree,
mirroring the on-host layout `/home/ubuntu/docker/<service>/docker-compose.yml`.
The repo copy is the **source of truth**; the host copy is a deployment
artifact. If the two differ, the repo wins.

```
hosts/<host>/<service>/docker-compose.yml     (or compose.yaml where the host uses that name)
```

| Host | Services (one dir each) |
|---|---|
| `nbg-1`, `vie-1` (gateways) | authelia, glances, grafana, kandev, nginx-proxy-manager, openrouter-exporter, ovhcloud-exporter, portainer, tasmota-relay (mosquitto + telegraf), uptime-kuma, victoria-metrics, vikunja (app + db + parked `vikunja-mcp` sidecar), wetty, wg-easy, wg-easy-mcp |
| `vm103` | glance, glances, glances-gw1, kandev-1, ollama, portainer, speaches, voice-gpu, vscode, wetty, wetty-gw1 |
| `vm104` | gitlab, glance, glances, glances-gw1, grafana-1, kandev, kandev-2, kandev104, mariadb ×2, phpmyadmin ×2, portainer, tftp-1, vscode, wetty-gw1 — **plus** `jarvis` (compose + Dockerfile live in [`jarvis/`](../jarvis/) at the repo root, not here) and `stocksense` (upstream code cloned host-local at `/home/ubuntu/docker/stocksense`, LAN-only :5005; LLM backend is Ollama on gpu-1) |
| `gpu-1` | cadvisor, fail2ban-exporter, glances, kokoro-tts, llamacpp, nginx-proxy-manager, ollama (phi4-mini q8_0 for StockSense; 127.0.0.1:11434 only, fronted by NPM), portainer, speaches, wetty |
| `gpu-2` | authelia, glances, grafana, kandev, nginx-proxy-manager, openrouter-exporter, ovhcloud-exporter, portainer, uptime-kuma, victoria-metrics, vikunja, wetty |

## Deploy procedure (repo → host)

1. Edit the file here.
2. Back up the live file on the host first (`cp docker-compose.yml docker-compose.yml.bak-<ts>`).
3. `scp hosts/<host>/<service>/docker-compose.yml <host>:/home/ubuntu/docker/<service>/`.
4. On the host: `docker compose up -d` (use `--build` where the service builds an image).
5. Verify the service is up/healthy and behaves as expected; only then commit.

Reverse drift (someone edited the host file directly) is a bug: re-pull the
host file, diff, merge the intended change into the repo copy, push it back.

## Secrets — never in the repo

Compose files must reference secrets as `${VAR}`; the values live in a
host-local `.env` next to the compose file (`chmod 600`, covered by
`.gitignore`). `docker compose` interpolates the project-dir `.env`
automatically. Services currently using this pattern (all externalized
2026-10-07 — before that the values were inline in the compose files):

| Host / service | `.env` variables |
|---|---|
| nbg-1, vie-1 / openrouter-exporter | `OPENROUTER_API_KEY` |
| nbg-1, vie-1 / ovhcloud-exporter | `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY` |
| vm104 / kandev-2 | `CLAUDE_CODE_OAUTH_TOKEN` |
| vm103 / kandev-1 | `CLAUDE_CODE_OAUTH_TOKEN` |
| gpu-1 / speaches | `API_KEY` |
| gpu-1 / llamacpp | `LLAMACPP_API_KEY` |
| vm104 / stocksense | `OLLAMA_HOST`, `OLLAMA_MODEL_NAME`, `OLLAMA_AUTH` (NPM basic-auth for the gpu-1 Ollama front), `FLASK_PORT`, `DEBUG`, `GEMINI_*` (numbers parsed at import; Gemini unused) |

Other services already used `env_file`/`${VAR}` (e.g. vm104 gitlab,
mariadb, phpmyadmin, grafana-1; both gateways' authelia uses a bind-mounted
`secrets/` dir). The same rule applies to any new service: no literal
credentials in a compose file, ever.

## Bind-mounted code and config

The non-data bind mounts of each compose file live in the same service
directory here (pulled 2026-10-07): `exporter.py` (openrouter- and
ovhcloud-exporter on both gateways), `mosquitto.conf` + `telegraf.conf`
(tasmota-relay), `scrape.yml` (victoria-metrics), `wg-easy-host-firewall`
(wg-easy, from `/usr/local/sbin/`), `configuration.yml` (authelia),
`provisioning/` (grafana), `glances.conf` (gpu-1 glances), `index.html` +
`nginx.conf` (glance / glances-gw1 on vm103 + vm104), `app.py`
(vm103 voice-gpu), `gitlab.rb` (vm104 gitlab — root-owned on the host,
pull it with `ssh vm104 "sudo -n cat …"`).

Still **host-local by design** (never committed):

- Runtime data dirs (grafana/data, NPM data+letsencrypt, portainer,
  uptime-kuma, wg-easy, kandev, ollama models, huggingface caches,
  gitlab data+logs, tftp, authelia `db.sqlite3`).
- Credential files: `authelia/secrets/`, `authelia/config/users_database.yml`
  (argon2 hash of the gateway admin user — sits in the rw-mounted
  `config/` dir on purpose, the `authelia` CLI writes it),
  `gitlab/config/gitlab-secrets.json` + the `ssh_host_*` keys, the SSH
  keys under `wetty-gw1/` (both gateways + vm104).

(nbg-1 also has a `claude-code-exporter/` dir with `exporter.py` and logs
but no container — dormant code, not deployed, not tracked here.)

## Containers without a compose file

Created via `docker run`, no compose on the host — not covered by this tree:
vm104 `whisper` (legacy, unused by Jarvis), vm104 `mosquitto` + `telegraf`
(gateway Tasmota stack). If one of these gets a compose file, add it here.

## NPM custom proxy hosts (gpu-1)

Two gpu-1 public endpoints are **not** NPM database-managed proxy hosts; they
live in a hand-maintained include at
`nginx-proxy-manager/npm/data/nginx/custom/http.conf` (NPM never rewrites it):

| Domain | Backend | Notes |
|---|---|---|
| `voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at` | `127.0.0.1:8003` (speaches) | Jarvis Whisper/TTS; auth is the speaches `API_KEY` in the `Authorization` header (set 2026-10-03) |
| `ollama.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at` | `127.0.0.1:11434` (ollama) | StockSense LLM; **basic auth** at nginx (`/data/htpasswd/ollama`); LLM tuning (600 s timeouts, no buffering) mirrors the `qwen38-27b-mtp` proxy host (2026-10-09) |

Their Let's Encrypt certs (`npm-voice`, `npm-ollama`) are also outside the
NPM database, so NPM's renewal timer does not touch them. A host cron
`/etc/cron.d/letsencrypt-renew` runs `certbot renew` in the `npm-ui` container
daily (added 2026-10-09). Roll back a host by deleting its server blocks and
`nginx -s reload`.

## StockSense gateway exposure (nbg-1 + vie-1, 2026-10-09)

StockSense on vm104 is exposed publicly on both gateways, DB-managed NPM
proxy hosts (wildcard LE cert, no per-host cert work):

| Domain | Gateway | NPM host id |
|---|---|---|
| `stocksense.gw-1-nbg-1-de-netcup.rwnix.net` | nbg-1 | 45 |
| `stocksense.gw-1-vie-1-at-netcup.rwnix.net` | vie-1 | 57 |

Both forward to `192.168.54.111:5005` and use the same two-layer protection
as `jarvis.*`/`kandev104.*`: the global Authelia `auth_request` gate (see each
gateway's `nginx-proxy-manager` custom `server_proxy.conf`) **plus** nginx
Basic Auth from the gateway's admin access list (nbg-1 list 1, vie-1 list 8
"mesh-admin") — StockSense has no login of its own. Both domains are in the
Authelia `two_factor` rule list in `authelia/config/configuration.yml`
(fail-closed `default_policy: deny` otherwise). The per-host location
(advanced config) includes the `/snippets/proxy.conf` + `websocket.conf`
includes and strips `Authorization` before the backend.
