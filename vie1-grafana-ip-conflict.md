# Grafana on vie-1 and the shared `authelia_shared-grafana` network

Monitoring stack on **vie-1** (`gw-1-vie-1-at-netcup.rwnix.net`), all containers on
the external bridge network `authelia_shared-grafana` (`172.28.0.0/16`; nbg-1 runs
the same network name on `172.27.0.0/16` — the networks are host-local):

| Container | Static IP (vie-1) | Compose |
|---|---|---|
| grafana (13.x) | `172.28.0.2` | `/home/ubuntu/docker/grafana/docker-compose.yml` |
| openrouter-exporter | `172.28.0.3` | `/home/ubuntu/docker/openrouter-exporter/docker-compose.yml` |
| ovhcloud-exporter | `172.28.0.4` | `/home/ubuntu/docker/ovhcloud-exporter/docker-compose.yml` |
| (free) | `172.28.0.5` | – |
| victoria-metrics | `172.28.0.6` | `/home/ubuntu/docker/victoria-metrics/docker-compose.yml` |
| telegraf | `172.28.0.7` | `/home/ubuntu/docker/tasmota-relay/docker-compose.yml` (pinned 2026-10-06, see below) |

Public access: `https://grafana.gw-1-vie-1-at-netcup.rwnix.net` via
nginx-proxy-manager (site conf `/data/nginx/proxy_host/31.conf`) behind Authelia SSO.
The grafana container publishes **no host ports**; probing `localhost:3000` on the
host hits `wetty` instead, which publishes 3000. Health check:
`docker exec grafana curl -s localhost:3000/api/health`.

## 2026-10-06: grafana container failed to start — static IP stolen by telegraf

**Symptom:** `docker ps` showed `grafana Exited (255)`;
`docker inspect` → `Error=failed to set up container networking: Address already in use`.
No Grafana error in the logs — it never got as far as starting the process.

**Root cause:** host reboot at 20:08 UTC. `telegraf` (part of the `tasmota-relay`
compose project) connects to `authelia_shared-grafana` **without a static IP**, so on
boot Docker's IPAM gave it the first free address, `172.28.0.2` — the address freed
when the reboot stopped grafana. Grafana's compose pins `ipv4_address: 172.28.0.2`,
so its start attempt collided and exited 255; the conflict persists for as long as
telegraf keeps the address, so `unless-stopped` never recovers it.

**Fix (deployed 2026-10-06, backup `docker-compose.yml.bak-20261006` on vie-1):**
- `tasmota-relay/docker-compose.yml`: pinned telegraf to `172.28.0.7` on
  `authelia_shared-grafana` (and `172.18.0.3` on `tasmota-mesh`, where mosquitto
  holds `.2`) so no container on the shared network is dynamic anymore.
  telegraf only references peers by DNS name (`victoria-metrics:8428`,
  `mosquitto:1883`), so the IP change is transparent.
- Recreated telegraf (`docker compose up -d`), then `docker start grafana`.

**Verified live:** grafana back on `172.28.0.2`, telegraf on `172.28.0.7`, both Up;
`/api/health` → `database: ok`; public URL redirects to Authelia as expected.

**Rule:** every member of `authelia_shared-grafana` must pin a static IP. When
adding a new container to the network, allocate the next free IP from the table
above (`.5` free) — otherwise it can steal a pinned address after a reboot or
recreate and wedge its victim with exit 255.
