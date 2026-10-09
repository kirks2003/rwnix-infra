# StockSense — AI stock prediction (deployment record)

Deployed 2026-10-09. Upstream: `upamanyu92/stocksense` @ `470c50e` (see
`llm_forecasting.md` for the original option comparison that led to this
deployment).

## What it is

Flask app (port 5005) that predicts stock prices with an ensemble of local
ML models (LSTM/Transformer, sklearn) **plus** an LLM advisor (phi4-mini via
Ollama) producing two sub-predictions (`ollama_technical`, `ollama_fundamental`)
with natural-language reasoning. An evaluator agent scores each forecast
before it is served. Live prices come from yfinance (outbound internet
required). No user login in the app itself.

## Topology

```
Browser
  │  LAN:  http://192.168.54.111:5005                     (LAN-only, like Jarvis)
  │  WAN:  https://stocksense.gw-1-nbg-1-de-netcup.rwnix.net   (nbg-1 NPM host 45)
  │        https://stocksense.gw-1-vie-1-at-netcup.rwnix.net   (vie-1 NPM host 57)
  ▼
vm104  /home/ubuntu/docker/stocksense   (host-local code clone, jarvis pattern)
  stocksense_main  (Flask + WebSocket UI, bound 192.168.54.111:5005)
  │  Ollama HTTP API (basic auth)
  ▼
gpu-1  /home/ubuntu/docker/ollama       (compose in repo: hosts/gpu-1/ollama/)
  ollama  (phi4-mini:3.8b-q8_0, GPU 0, 127.0.0.1:11434 only)
  │  via NPM host (custom include, basic auth, LE cert npm-ollama)
  ▼
  https://ollama.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at
```

Gateway exposure (nbg-1 + vie-1): DB-managed NPM proxy hosts → `192.168.54.111:5005`,
wildcard LE certs, two-layer protection identical to `jarvis.*`/`kandev104.*`:
nginx Basic Auth (gateway admin access list — nbg-1 list 1, vie-1 list 8
"mesh-admin") **in front of** the global Authelia `auth_request` gate (two-factor).
Both domains are in the Authelia `two_factor` rule list
(`authelia/config/configuration.yml`, fail-closed `default_policy: deny`
otherwise). Details: `hosts/README.md` § "StockSense gateway exposure".

## Secrets (host-local, never in the repo)

| Where | What |
|---|---|
| vm104 `/home/ubuntu/docker/stocksense/.env` (chmod 600) | `OLLAMA_HOST`, `OLLAMA_MODEL_NAME`, `OLLAMA_AUTH` (base64 user:pass for the gpu-1 NPM front), `FLASK_PORT`, `DEBUG`, numeric `GEMINI_*` (see findings) |
| gpu-1 `nginx-proxy-manager/npm/data/htpasswd/ollama` | Ollama NPM-front basic auth (user `stocksense`) |
| nbg-1/vie-1 NPM access lists (1 / 8) | gateway basic-auth credentials (same as Jarvis) |

## Findings (2026-10-09, from the live deployment)

- **LLM host decision**: gpu-1, not gpu-2. gpu-2's two 96 GB GPUs are
  ~100% VRAM-reserved by the `ds4-flash` vLLM (Jarvis's brain) — stopping it
  is not an option. gpu-1 had ~26.5 GB free; phi4-mini q8_0 load settles at
  **~5.7 GB** (see next finding).
- **Ollama vram-based default context pitfall**: with a 96 GB GPU and no
  `OLLAMA_CONTEXT_LENGTH`, Ollama sized the default context from total VRAM
  (256K → clamped to the model's 128K) and allocated a **~16 GB KV cache**
  for a 4.1 GB model (`20459 MiB = 3887 model + 16384 context + 188 compute`).
  Fixed with `OLLAMA_CONTEXT_LENGTH=8192` → ~5.7 GB total. StockSense prompts
  fit 8K easily (the q8_0 tag is nominally 4K context anyway).
- **Upstream import-time crash**: `app/config/gemini_config.py` parses
  `GEMINI_TEMPERATURE`/`TOP_P`/`TOP_K`/`MAX_OUTPUT_TOKENS`/`MIN_CONFIDENCE`/
  `HIGH_CONFIDENCE_THRESHOLD` as numbers **at class-definition time**, and the
  legacy Gemini path is still imported by the alert service. Without those
  env vars the container crash-loops (`ValueError: could not convert string
  to float: ''`). The numeric vars must exist (values irrelevant; Gemini is
  not used — Ollama is the backend).
- **Phantom `model_monitor` service**: the upstream compose runs
  `python3 -m scripts.model_monitor_scheduler`, but that module **does not
  exist** in the repo, and the Dockerfile `entrypoint.sh` runs
  `python3 -m app.main` unconditionally before `exec "$@"` — so the container
  ran a duplicate Flask app instead of any scheduler. Removed from our
  compose; scheduled work belongs to the main app's background worker
  (enable via admin UI if wanted).
- **Latent cert-renewal gap (fixed)**: the gpu-1 `npm-voice` LE cert (Jarvis
  STT/TTS front, manual custom NPM include) was outside the NPM database, so
  NPM's renewal timer never touched it (would have expired 2026-12-24).
  Host cron `/etc/cron.d/letsencrypt-renew` (daily `certbot renew` in the
  `npm-ui` container) now covers both custom certs (`npm-voice`,
  `npm-ollama`).
- **Ollama is quiet at INFO level**: per-request `/api/generate` calls do not
  appear in `docker logs ollama`. Verify LLM usage from the StockSense
  responses instead: on failure the code returns `predicted_price: 0.0` +
  `decision: reject` (no template fallback), so real prices + distinct
  reasoning text per run are genuine generations.
- **Model naming**: the Ollama library name is **`phi4-mini`** (tags
  `3.8b-q4_K_M` 2.5 GB/128K ctx, `3.8b-q8_0` 4.1 GB/4K ctx, `3.8b-fp16`
  7.7 GB). `OLLAMA.md` in the repo says `phi-mini` — wrong.

## Verified (2026-10-09)

- vm104: `stocksense_main` healthy; `/health` 200; UI 302→dashboard;
  `/api/agentic/health` ok
- End-to-end `GET /api/agentic/predict/ASML` (~12 s): two live Ollama
  sub-models (e.g. 1760.50 / 1770.00, distinct reasoning per run) +
  PredictionEvaluatorAgent (score 0.92, proceed) + ensemble 1765.25,
  decision `caution`; last_close 1769.79 from yfinance (2026-10-08)
- gpu-1: `nvidia-smi` ~77 GB of 98 GB used after deployment (speaches 4.5 +
  qwen38-llamacpp 66.8 + ollama 5.7); the qwen38 endpoint that serves the
  kandev sessions was re-verified after every NPM change (self-dependency)
- Gateways: no/wrong creds → 401 + `WWW-Authenticate`; Authelia authz returns
  portal redirect with correct return-URL for both new domains

## Notes / operations

- **GPU contention**: gpu-1's GPU is busy (Qwen-27B inference + Whisper).
  StockSense LLM calls are low-frequency batch (300 s client timeout);
  ~12 s observed in practice. `OLLAMA_KEEP_ALIVE=24h` keeps the model
  resident (~5.7 GB); ~22 GB headroom remains.
- **Watchlist**: the bundled `stk.json` is NSE/BSE (India) tickers; ASML
  works via yfinance. Add tickers via the app UI.
- **Rollback**: vm104 `docker compose down` in `/home/ubuntu/docker/stocksense`;
  gpu-1 `docker compose down` in `/home/ubuntu/docker/ollama`; gateway hosts
  via NPM UI (ids 45 / 57); Authelia rule lines are marked
  `stocksense.gw-1-…` in both `configuration.yml`s (backups
  `*.bak-stocksense-20261009`).
- **Local code patch** (vm104 clone, documented in the compose header):
  `OLLAMA_AUTH` env is sent as an `Authorization` header on the three Ollama
  call sites (`app/config/ollama_config.py`, `app/models/ollama_model.py`,
  `app/api/system_routes.py`) — upstream sends no auth.

## Related files

- `hosts/gpu-1/ollama/docker-compose.yml` — Ollama (source of truth)
- `hosts/vm104/stocksense/docker-compose.yml` — app (source of truth)
- `hosts/README.md` — fleet table, `.env` table, NPM custom/gateway host notes
- `llm_forecasting.md` — the original three-option comparison
