# ovhcloud-exporter and the "Cloud & AI Credits" dashboard

Live-deployed on **nbg-1** (`gw-1-nbg-1-de-netcup.rwnix.net`, the Grafana host):

| Item | Location |
|---|---|
| Exporter code | `/home/ubuntu/docker/ovhcloud-exporter/exporter.py` (bind-mounted into container) |
| Compose | `/home/ubuntu/docker/ovhcloud-exporter/docker-compose.yml` |
| Container | `ovhcloud-exporter`, python:3.12-slim, `172.27.0.4:8001` on the `authelia_shared-grafana` docker network |
| Dashboard (provisioned) | `/home/ubuntu/docker/grafana/provisioning/dashboards/openrouter-credits.json` |
| Grafana | container `grafana` (13.x), `172.27.0.2:3000`, behind Authelia SSO; dashboard uid `openrouter-credits`, title "Cloud & AI Credits" |
| Dashboard in DB | Grafana unified storage (`resource` table, group `dashboard.grafana.app`) — dashboards are NOT in the classic `dashboard` table |

The provisioning file is the source of truth: Grafana re-syncs it every
`updateIntervalSeconds: 60` (provider in `provisioning/dashboards/dashboards.yml`,
`allowUiUpdates: true`). Edit the JSON file on nbg-1, not the DB.

## Data sources (Grafana)

| Name | Type | URL |
|---|---|---|
| OVHcloud Exporter (`OVHCLOUD0000001`) | prometheus | `http://172.27.0.4:8001` (the exporter itself) |
| OpenRouter Exporter (`P8B7DE2EB3699DDB2`) | prometheus | `http://172.27.0.3:8000` |
| Claude Code Exporter (`CLAUDE_CODE_001`) | prometheus | `http://172.27.0.1:8002` |
| VictoriaMetrics (`VICTORIA_METRICS`) | victoriametrics | `http://victoria-metrics:8428` |

The OVHcloud panels query the exporter's own fake Prometheus API
(`/api/v1/query`, `/api/v1/query_range`), not VictoriaMetrics.

## Exporter

Env (compose): `REFRESH_INTERVAL=3600`, `NUM_INVOICES=6`, `OVH_CLOUD_PROJECT=258291023b884da4bd7361ec6c774e0d`
(account's only project), OVH app key/secret + consumer key for `eu.api.ovh.com/1.0`.
Refetches at most once per hour; the cache is in process memory only.

Two data sources for AI endpoint numbers:

1. **Invoices** (`/me/bill`, `/me/bill/{id}`, `/me/bill/{id}/details/{id}`):
   final billed amounts. OVH bills AI endpoint usage **in arrears**: month M's
   token line items (descriptions like
   `Amount of input tokens for AI Endpoints Qwen3.6-27B model`,
   `periodStart` = 1st of M) land in an invoice dated ~1st of M+1.
   Verified 2026-10-06: Aug usage in invoice DE1919819 (2026-09-01),
   Sep usage in DE1942570 (2026-10-01).
2. **Live usage** (`GET /cloud/project/{id}/usage/current`, IAM action
   `publicCloudProject:apiovh:usage/current/get` — the consumer key has it):
   current-month consumption so far, `lastUpdate` refreshed ~hourly by OVH.
   `resourcesUsage[type="ai-endpoints"]` holds per-component entries named
   `<model-slug>-<input|output>_tokens` (dash before the direction!) with
   `quantity.value` (tokens) and `totalPrice` (EUR).
   No per-day granularity exists for AI endpoints — month-to-date only.
   Related endpoints: `/cloud/project/{id}/ai/endpoint` (list of model display
   names, used to map slugs back to e.g. `Qwen3.6-27B`),
   `/cloud/project/{id}/usage/history` + `/usage/history/{id}` (past periods),
   `/cloud/project/{id}/usage/forecast`.

### Metrics

| Metric | Labels | Source |
|---|---|---|
| `ovhcloud_up` | – | 1 if invoice fetch OK |
| `ovhcloud_invoice_total_eur` | bill_id, date, month, category | invoices |
| `ovhcloud_monthly_total_eur` / `ovhcloud_current_month_total_eur` | month | invoices |
| `ovhcloud_category_total_eur` | category | invoices |
| `ovhcloud_ai_cost_eur`, `ovhcloud_ai_input_tokens`, `ovhcloud_ai_output_tokens` | model, month | invoices + live current month merged in |
| `ovhcloud_ai_live_cost_eur`, `ovhcloud_ai_live_input_tokens`, `ovhcloud_ai_live_output_tokens` | model, month | usage/current (current month) |
| `ovhcloud_ai_live_total_eur`, `ovhcloud_ai_live_input_total`, `ovhcloud_ai_live_output_total` | month | usage/current, summed over models |
| `ovhcloud_ai_usage_last_update_timestamp_seconds` | – | usage/current `lastUpdate` |

Fake-Prometheus limitations: only bare `metric` / `metric{label="v"}`
selectors are understood; no functions, aggregations, or binary ops.
`query_range` returns one proper series per matching label set (fixed
2026-10-06 — before that all matches were collapsed into one series with
duplicate timestamps, which made multi-series panels zigzag).

## Dashboard: "Cloud & AI Credits"

Rows: OpenRouter Credits (balance/usage/key limits/free tier), OVHcloud
Costs, Claude Code Usage. The OVHcloud Costs row:

| Panel | Query |
|---|---|
| Current Month Total | `ovhcloud_current_month_total_eur` (invoices, month-to-date — in-advance billing, so always current) |
| AI Endpoints Cost | `ovhcloud_ai_live_total_eur` (live, month-to-date, hourly) |
| AI Input Tokens | `ovhcloud_ai_live_input_total` |
| AI Output Tokens | `ovhcloud_ai_live_output_total` |

All four are stat panels with `lastNotNull` over the dashboard range.
Billed per-model history stays queryable as
`ovhcloud_ai_cost_eur{model,month}` for future charts.

## 2026-10-06: stale "AI Endpoints Cost" — findings and fix

**Symptom:** the panel showed 0.48 EUR (September's cost) on Oct 6 while the
rest of the dashboard was current.

**Root cause:** the exporter derived AI costs only from invoice line items,
and OVH invoices AI usage in arrears (see above) — no October data existed
anywhere in OVH until ~Nov 1. Not an exporter/scrape failure
(`ovhcloud_up 1`, hourly refetch working).

**Fix (deployed 2026-10-06, backups `*.bak-20261006094800` on nbg-1):**
- `exporter.py`: added the live `usage/current` fetch (project from
  `OVH_CLOUD_PROJECT`, model-slug mapping via `/ai/endpoint`), the
  `ovhcloud_ai_live_*` metrics, last-update timestamp gauge, and the
  multi-series `query_range` fix. Live fetch is failure-isolated — if it
  errors, invoice data is still served.
- `docker-compose.yml`: added `OVH_CLOUD_PROJECT`.
- Provisioned dashboard: the three AI panels switched from the
  invoice-based `ovhcloud_ai_*` to `ovhcloud_ai_live_*_total` queries.

**Verified live:** `ovhcloud_ai_live_total_eur{month="2026-10"} 0.7961`
matched the raw API (`totalPrice` 0.79609 EUR; Qwen3.6-27B 0.0141 +
Qwen3.8-27B 0.782); Grafana DB confirmed the reloaded panel exprs.

**Behaviour note:** at each month rollover the live total resets to ~0 for
the new month until the first token is used; the just-finished month's final
value appears in `ovhcloud_ai_cost_eur{model,month}` when its invoice lands.

## Ops

- Test changes in an isolated container first (same image/network, other
  port, `--env-file` staged from `docker exec ovhcloud-exporter env`), then
  back up (`cp x x.bak-$(date +%Y%m%d%H%M%S)`), replace,
  `docker compose up -d`.
- Read-only Grafana DB inspection without SSO:
  `docker exec grafana cat /var/lib/grafana/grafana.db` → sqlite3
  (`resource` table, unified storage).
- Probe OVH API without printing secrets: run python inside
  `docker exec -i ovhcloud-exporter` (env already there); heredocs need `-i`.
