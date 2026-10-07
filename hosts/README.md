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
| `vm104` | gitlab, glance, glances, glances-gw1, grafana-1, kandev, kandev-2, kandev104, mariadb ×2, phpmyadmin ×2, portainer, tftp-1, vscode, wetty-gw1 — **plus** `jarvis` (compose + Dockerfile live in [`jarvis/`](../jarvis/) at the repo root, not here) |
| `gpu-1` | cadvisor, fail2ban-exporter, glances, kokoro-tts, llamacpp, nginx-proxy-manager, portainer, speaches, wetty |

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

Other services already used `env_file`/`${VAR}` (e.g. vm104 gitlab,
mariadb, phpmyadmin, grafana-1; both gateways' authelia uses a bind-mounted
`secrets/` dir). The same rule applies to any new service: no literal
credentials in a compose file, ever.

## Bind-mounted files stay on the host

Some services bind-mount code or config that is **not** in the repo
(exporter code, mosquitto.conf, glance index.html, SSH keys for the wetty
gateways, gitlab config): those remain host-local. Candidates to pull into
the repo later: `ovhcloud-exporter/exporter.py`, `openrouter-exporter/exporter.py`
(both gateways). (nbg-1 also has a `claude-code-exporter/` dir with
`exporter.py` and logs but no container — dormant code, not deployed.)

## Containers without a compose file

Created via `docker run`, no compose on the host — not covered by this tree:
vm104 `whisper` (legacy, unused by Jarvis), vm104 `mosquitto` + `telegraf`
(gateway Tasmota stack). If one of these gets a compose file, add it here.
