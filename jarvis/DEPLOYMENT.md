# Jarvis deployment

## Live service

- Docker host: `vm104` (`192.168.54.111`) on pve14
- App directory: `/home/ubuntu/docker/jarvis`
- Container: `jarvis`
- Internal/public host bind: `192.168.54.111:8094`
- Compose file: `jarvis/docker-compose.yml`
- Health endpoint: `http://192.168.54.111:8094/api/health`
- Browser UI: served directly by the Node backend from `jarvis/public/`

vm104 hosts Jarvis. vm103 hosts the active Whisper STT service. vm104 still has a legacy/local Whisper container, but Jarvis no longer uses it:

| Host | Container | Image | Published endpoint | Jarvis use |
|---|---|---|---|---|
| vm103 | `voice-gpu` | `python:3.12-slim` | `http://192.168.53.111:8003` | active STT |
| vm104 | `jarvis` | locally built from `jarvis/Dockerfile` | `http://192.168.54.111:8094` | web app/backend |
| vm104 | `jarvis-neo4j` | `neo4j:5.26.31-community` | none (compose network only) | knowledge graph |
| vm104 | `whisper` | `fedirz/faster-whisper-server:latest-cpu` | `http://192.168.54.111:8001` | legacy/not active |

Jarvis calls the vm103 Whisper service directly across the internal network at `192.168.53.111:8003`; the prior vm104-local `host.docker.internal:8001` endpoint is not the active Jarvis STT target.

## Public routes

Both routes point to `http://192.168.54.111:8094` and are protected by the existing global Authelia NPM configuration plus the `mesh-admin` NPM Basic Auth access list.

| Gateway | URL | NPM row | Certificate | Basic Auth file |
|---|---|---:|---:|---:|
| vie-1 | `https://jarvis.gw-1-vie-1-at-netcup.rwnix.net/` | `proxy_host.id=56` | `npm-24` | `/data/access/8` |
| nbg-1 | `https://jarvis.gw-1-nbg-1-de-netcup.rwnix.net/` | `proxy_host.id=44` | `npm-6` | `/data/access/1` |

**Region policy (binding, 2026-10-07):** because both routes front the same backend, the backend resolves the region per request from the entry's `Host` header and pins that region for every **service MCP** connection — Jarvis on nbg-1 uses only services on the nbg-1 host, Jarvis on vie-1 only services on the vie-1 host, never cross-region (user service data is per region by design). First application: the Vikunja MCP integration (per-user Vikunja accounts, one per region) — see `vikunja-mcp.md` at the repository root.

The proxy files were rendered directly because NPM did not generate config files from direct SQLite inserts on restart:

- vie-1: `/home/ubuntu/docker/nginx-proxy-manager/data/nginx/proxy_host/56.conf`
- nbg-1: `/home/ubuntu/docker/nginx-proxy-manager/data/nginx/proxy_host/44.conf`

Findings while exposing the service:

- DNS follows the existing gateway pattern: `*.gw-1-vie-1-at-netcup.rwnix.net` resolves to `152.53.35.177`, and `*.gw-1-nbg-1-de-netcup.rwnix.net` resolves to `152.53.118.212`.
- The first direct DB inserts were created on the wrong gateway/name pairing and then corrected in SQLite and the rendered Nginx files.
- NPM's database is owned such that the SSH user could read but needed `sudo` to copy/write `database.sqlite`.
- The existing global Authelia hook is included through `/data/nginx/custom/server_proxy[.]conf`; per-host configs add only the backend proxying, identity headers, upload size, WebSocket include, and the outer Basic Auth layer.
- `client_max_body_size 64m` is set in both Jarvis proxy hosts so command audio uploads are not blocked by Nginx.
- Backups were created before NPM DB edits using `database.sqlite.bak-jarvis-*` and `database.sqlite.bak-jarvis-fix-*` naming.
- Authelia uses `default_policy: deny`; after the first deploy, `jarvis.gw-1-nbg-1-de-netcup.rwnix.net` returned `403 Forbidden` after valid Basic Auth because the Jarvis domains were missing from the Authelia two-factor allowlists. Both gateway configs now include their Jarvis domain and were restarted. Backups were created as `configuration.yml.bak-jarvis-*`.

## Runtime behavior

- Language: English end to end. `WHISPER_LANGUAGE`, the brain system prompt and the HAL 9000 TTS voice all default to English as of 2026-10-03. The deployed vm103 `.env` still carries `WHISPER_LANGUAGE=de` until it is updated on the host.
- Voice services: deployed on `gpu-1` 2026-10-03 (see "gpu-1 voice services" below). STT and TTS both run there now, reached at `https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`; the vm103 Whisper endpoint is no longer used. vm104 was updated in the same step, because the new endpoint requires `WHISPER_API_KEY` and the previous build could not send it.
- Wake word: `Hey Rocky` (changed from `Rocky` on 2026-10-03 at the user's request, earlier from `hey jarvis`; matching is case-insensitive)
- Personal wake override: the UI's **Your wake word** field persists locally per browser/origin. Apply aborts the active session; re-arm to use the new word. It does not change `.env` or other users' defaults.
- Wake engine: self-hosted Whisper probes from continuous browser AudioWorklet PCM capture, triggered on the trailing edge of speech (~350 ms after the talker stops, 3 s speech cap). Measured against the gpu-1 service with four isolated "Rocky" utterances: the old fixed-interval trigger cut two of eight probe windows mid-word and returned empty for them; the trailing-edge trigger recognized all six of its probes and detected the phrase about 0.9 s sooner.
- Command recording: complete mono WAV snapshots; capture continues during Whisper latency
- Auto-stop: `1500 ms` continuous silence (server default `SILENCE_MS`; the UI's Silence stop slider overrides it per browser, 100 ms-5 s, live)
- STT: backend proxy to the selected Whisper profile. The UI's **Whisper server** selector is saved per browser and currently offers:
  - `gpu-1`: `https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/transcriptions`, model `Systran/faster-whisper-large-v3`
  - `vm103 on pve103`: `http://192.168.53.111:8003/v1/audio/transcriptions`, model `deepdml/faster-whisper-large-v3-turbo-ct2`
  - `OVHcloud Whisper`: `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions`, model `whisper-large-v3`
- Brain: backend proxy to the selected AI API endpoint profile. The UI's **AI API endpoint** selector is saved per browser; live vm104 has `a1-deepseek`, `a1-qwen`, `ovhcloud` and `openrouter` configured. `claudecode` is listed but disabled until a Claude Code OpenAI-compatible gateway is provided.
- Output: the selected answer voice plus prompt/result text in the UI
- Hero controls (2026-10-07): the **Jarvis on/off** switch (enable/disable the session) and the **Speak / Text only** switch (voice output; per browser) sit left of Sign out, in a `.user-controls` cluster.
- Conversation history (2026-10-07): every finished turn (prompt + answer, server-stamped) is stored per user (`conversationLogs` in `server.js`, 500-entry cap); `GET /api/conversation` serves the last 24 days, and the Prompt/Answer panels render that window as a scrollable history with date-time stamps.
- Graph policy (2026-10-07): no entity may exist without a bounded path of fact edges to its owner — after every ingestion and every entity removal, disconnected clusters are swept (`DISCONNECT_SWEEP` in `graphdb.js`), and every sweep is counted in the activity feed. The seed graph (Mila: Rocky/Berlin/Kokoro-82M; Roman: Coffee) is pre-policy legacy state, swept on that user's first ingestion or removal.
- Answer voice: the UI's **Answer voice** select and **Speaking speed** slider (0.60x-1.60x, a multiplier on the voice's own pace) persist locally per browser/origin. **Browser voice** uses `speechSynthesis`; **HAL 9000** and the character profiles (Commander, Android, Wizard, Newscaster) proxy clauses through `/api/speak` to `TTS_ENDPOINTS` (OpenAI `/v1/audio/speech`) and shape them in Web Audio. The deployed backend is the `speaches` Kokoro container on gpu-1; `server.js` maps each profile to its own Kokoro voice (`profileVoices`), so the timbre changes with the profile.
- Language: the UI's **Language** toggle (English/Deutsch, per browser) sends the language with every Whisper request (`/api/transcribe?language=…`), appends a `Language override` directive to the brain system prompt per `/api/chat` request, and switches spoken output. German answers are spoken with the browser voice (German voice preferred) because the Kokoro engine ships English voices only; `/api/speak` rejects non-English with `tts_language_unsupported` as a backstop.
- Observability: browser live log and backend JSON logs via `docker logs jarvis`
- Recognized speech: the browser live log explicitly prints every wake/command transcript (or no-speech result), followed by endpoint/request metadata. Full transcripts are not newly persisted in Docker logs.

The frontend exposes progress at each small step:

1. Wake probe recording
2. vm103 Whisper wake transcription
3. Active microphone recording
4. Voice activity / silence tracking
5. Whisper upload and transcription
6. Brain request
7. Speech output in the selected voice
8. Error states and backend request IDs

The backend intentionally proxies Whisper and brain requests so browser clients never receive service keys and do not need direct CORS access to internal endpoints.

## Endpoint selector rollout (2026-10-07)

The Jarvis controls panel now has an **Endpoint selectors** section. The frontend persists
both dropdowns in local storage and sends the choices per request: `/api/chat` receives
`brainProfile`, and `/api/transcribe` receives `whisperProfile`. Existing in-flight calls
are not moved when the user changes a selector; the next brain or transcription request
uses the new profile.

Backend behavior:

- AI profiles are built from the local opencode/Kandev profile config when readable, with
  environment variables taking precedence. On live vm104 the app directory is not a git
  checkout and the useful opencode config was not present under the container's default
  path, so live `.env` was updated with non-committed endpoint keys copied from the local
  Kandev opencode config. `.env` backups were taken first as
  `.env.bak-ai-profiles-<timestamp>`.
- AI profiles that require provider keys are shown but disabled unless their key is
  available. Live status after rollout: `a1-deepseek`, `a1-qwen`, `ovhcloud` and
  `openrouter` are configured; `claudecode` is disabled because the Kandev Claude Code
  profile is ACP/CLI, not an OpenAI-compatible `/chat/completions` endpoint.
- Whisper profiles are built from env/defaults. `gpu-1` and `vm103` keep sending the
  faster-whisper `vad_filter` form field. OVHcloud's OpenAI-compatible
  `whisper-large-v3` endpoint rejects that field (`HTTP 400: Unknown field name:
  vad_filter`), so Jarvis deliberately omits `vad_filter` only for the OVH profile.
  OVH STT auth reads `WHISPER_OVHCLOUD_API_KEY`, falling back to
  `OVH_AI_ENDPOINTS_ACCESS_TOKEN` and then `BRAIN_OVHCLOUD_API_KEY`.

Validation and deployment:

- Local validation: `npm test` passed with 145 tests after adding OVH Whisper coverage,
  including that the OVH STT request uses model `whisper-large-v3`, sends its bearer key
  and does **not** send `vad_filter`. Browser coverage from the selector rollout passed
  separately (`npm run test:browser`: 43 pass, 2 skipped).
- vm104 code backups were taken before each sync:
  `jarvis-code.bak-20261007_061528.tgz`,
  `jarvis-code.bak-20261007_061825.tgz`,
  `jarvis-code.bak-20261007_062018.tgz` and
  `jarvis-code.bak-20261007_062157.tgz`.
- Live `/api/health` after the OVH Whisper rollout returned `whisperEndpoints: 3`,
  `brainConfigured: true`, `aiProfiles: 4`, `ttsEndpoints: 1`, and the container health
  was `healthy`.
- Served static assets matched the source checksums after deployment:
  `app.js` `6223db1a8eea80e80df2492b909ab4b1`,
  `index.html` `87afc404f4f15adea0cc69e682fb5873`,
  `style.css` `b2e086b20a1b6094e0634d619b27e3a0`.
- Live smoke tests: `a1-qwen` chat answered `OK` using model
  `Qwen3.8-27B-UD-Q8_K_XL.gguf`; OVH Whisper transcribed a Jarvis-generated WAV as
  `Jarvis OVH Whisper Test` through `/api/transcribe?whisperProfile=ovhcloud`.

## Whisper and pipeline finding: ZDF subtitle hallucination

Live config uses vm103's `voice-gpu` Whisper service through `http://192.168.53.111:8003/v1/audio/transcriptions` with model `deepdml/faster-whisper-large-v3-turbo-ct2`, language `de`, and `WHISPER_VAD_FILTER=true`. The underlying container is `voice-gpu` (`python:3.12-slim`) published on `192.168.53.111:8003` and serving `/v1/audio/transcriptions` plus `/health`.

When the user said `hey jarvis, what's the time`, the original browser flow detected only the wake phrase, then started a new recording after the command had already been spoken. That second recording mostly contained silence/background audio, and faster-whisper hallucinated `Untertitelung des ZDF, 2020`, a common no-speech/subtitle artifact. The bad transcript was then sent to the brain, whose response had `content: null` because `max_tokens` was too low and the model spent the budget on reasoning, so the browser had no answer to speak.

Fixes applied:

- Jarvis uses vm103 Whisper for wake detection too. Voice-containing, overlapping WAV probes go to `/api/transcribe`. After wake detection the complete utterance is transcribed again, so a partially heard command is not submitted prematurely. If it contains only the wake phrase, Jarvis beeps and waits for a separate command.
- Whisper requests now send `vad_filter=true` and `temperature=0`.
- Known no-speech hallucinations such as `Untertitelung des ZDF` and Amara subtitle phrases are rejected and shown as no-speech errors instead of prompting the brain.
- Brain requests now include the current server timestamp, use a larger token budget, and answer time/date questions from that timestamp.
- Browser TTS completion is awaited before re-arming. Failure/watchdog timeout cancels playback and reports an error; old callbacks cannot change a stopped or newer session.

## Pipeline redesign findings

The previous health checks and mocked transcript tests did not validate real audio capture. Later live logs confirmed successful vm103 requests even while the UI pipeline was failing; a configured endpoint or successful HTTP probe alone is not evidence that repeated browser wake cycles work.

Concrete defects in the successive implementations:

- Stopping capture during each wake transcription introduced gaps and cut off command tails.
- Literal `indexOf("hey jarvis")` rejected normal Whisper punctuation such as `Hey, Jarvis!`.
- The rolling WebM implementation dropped initial container headers while retaining later chunks; those slices are not standalone recordings.
- Independent UI/restart/TTS timers and mutable recording flags allowed late callbacks to affect later runs.
- Whisper/brain requests had no deadline; upstream failures were returned as HTTP 200, and wake polling treated failures like no wake word.

The replacement uses one sequential async pipeline per cancellable browser session and valid WAV snapshots from a bounded PCM ring. Stop/re-arm and leaving the page invalidate the session, cancel downstream fetches and release the mic; hiding the tab or minimizing the window does not — an armed session keeps listening in the background, clocked off capture blocks rather than throttled background timers. Voice probes overlap; command completion waits for silence. The UI distinguishes listening, checking wake audio, command capture, Whisper, brain, TTS and errors. The displayed last STT endpoint/request ID comes from the response rather than a hardcoded success label.

Whisper has a 20-second deadline per attempt; brain has a 45-second deadline. Actual upstream failures return HTTP 502 with attempt details. Valid silence/hallucination filtering returns `noSpeech: true` with empty text and a `whisper_no_speech` log, never a fabricated prompt. Browser errors are visible before bounded retry; capture failure requires re-arming.

Redesign verification on 2026-10-03:

- Nine audio/backend tests cover punctuation, valid overlapping WAV data, cancellation, actual multipart forwarding, no-speech handling, HTTP failures, a real 20-second upstream timeout, and the brain proxy.
- Eight Chromium lifecycle checks use actual fake-device microphone capture through the production AudioWorklet: three consecutive wake cycles, Stop/re-arm with a delayed response, STT failure/retry, missing TTS completion, wake-only/separate command, silence/background stop, denied permission, and permission granted after Stop.
- Real synthesized speech through Chromium and vm103 passed twice with the live `de` language setting and 1500 ms silence threshold. The first short probe sometimes returned `Hey Jarvis! What type?`; the completed audio correctly returned `Hey Jarvis! What time is it?`. This demonstrates why submitting the first partial wake transcript was wrong.
- An isolated candidate container used the existing live environment without exposing its secrets. Two complete browser -> backend -> vm103 -> real DeepSeek cycles succeeded. Command transcription request IDs: `1dd5ec51-a57b-402a-a6fe-fad0389a7339` and `6c4c48f8-c316-4f77-b6e9-c92bfc04d2ab`; brain IDs: `a91e9250-4ba6-4d13-8eb4-39688f525cf1` and `fbf7ee20-237a-49f7-9519-6d10c5d95b9a`.
- After deployment, the same two-cycle test passed against the production container: command STT IDs `34b7e39c-717e-4f23-b2e4-9b04a8319cbf` and `62049b0a-8f76-4c04-ba89-3a0cc62ad42f`, with two real brain answers. The previous image is retained as `jarvis-before-pcm-v2`; the pre-change source backup is `/tmp/jarvis-before-pcm-v2.tar.gz` on vm104.
- Headless TTS callbacks were simulated because that Chromium has no installed voices. Physical microphone acoustics, speaker playback and Android hardware remain unverified; server health alone does not establish those.

## Brain configuration finding

The `deepseek-v4-flash` endpoint requires bearer authentication. Leaving `BRAIN_API_KEY` empty makes the backend support no-auth self-hosted endpoints, but this live deployment needed the `a1-dsv4f` provider key from the existing kandev104 opencode configuration. The key was written only to `/home/ubuntu/docker/jarvis/.env` on vm104 and is not committed.

Initial testing with the wrong provider key returned:

```text
Brain HTTP 401: {"error":"Unauthorized"}
```

After using the `a1-dsv4f` / `ds4-flash` key, `/api/chat` returned the expected answer.

## MCP web search

The UI's **MCP web search** toggle (per browser, saved in local storage like the wake word) switches the brain between plain answering and web-grounded answering:

- The browser sends `websearch: true/false` with every `/api/chat` request.
- When on, the backend spawns `mcp/websearch.mjs` (a Model Context Protocol server, JSON-RPC 2.0 over stdio, reused as one child process across requests) and calls its `web_search` tool with the user prompt.
- The search itself needs no API key: **DuckDuckGo** (HTML endpoint with one retry; result links unwrapped from the `//duckduckgo.com/l/?uddg=…` redirect form, ad links dropped), **Bing** (HTML endpoint; `bing.com/ck/a` redirect links unwrapped to the real target) and the **Wikipedia** search API are queried in **parallel**, and the **DuckDuckGo Instant Answer API** (abstract/definition/direct answer + related topics) runs alongside as an "instant answer" block. The results are merged round-robin across engines, deduplicated by URL (scheme/www/trailing-slash insensitive) and each is tagged with its source engine. Top 5 merged results (title, URL, snippet) are added to the brain request as one extra system message — fresh per prompt, never stored in the per-session conversation history. A walled or down engine degrades to zero results without failing the search. Measured engine availability from server IPs: see "Multi-engine web search findings" below.
- A failed or empty search degrades to a normal brain answer; the backend JSON logs record `websearch_success` (chars, ms), `websearch_failure`, and `websearch_skipped` (request aborted).
- Requirement: outbound internet from the backend container (the container egresses to DuckDuckGo/Wikipedia; the browser is unaffected). No new `.env` entries — the toggle is the only control.
- Spoken answers are sanitized in the browser before any TTS request or `speechSynthesis` utterance (`textForSpeech` in `public/voice.js`): markdown, links, code markers, URLs and special signs are stripped, so the speaker says normal language only. The printed Answer panel is unchanged.

## Browser limitations and next improvements

- Browser speech recognition is not used. While armed, voice-containing ambient audio is sent to the configured vm103 service to check for wake words; this is not on-device wake detection.
- Android Chrome can stop capture when the tab is backgrounded, the device locks, or the OS throttles the browser. This build no longer disarms on tab hiding — an armed session keeps listening — so on mobile the session survives backgrounding only as far as the OS lets capture continue; if the platform does cut capture, the stale-block watchdog (no capture block for 3 s) surfaces it as an error and the user re-arms.
- A production wake-word path should replace the current wake listener with an on-device WASM model such as Porcupine or another local wake-word model.
- Browser TTS is intentionally used for the first version; cloned/server-side TTS can be added later behind a backend proxy if needed.

## Validation

Validated on 2026-10-03:

```bash
curl http://192.168.54.111:8094/api/health
curl -X POST http://192.168.54.111:8094/api/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"Say only: Jarvis online","sessionId":"verify"}'
curl -k -I https://jarvis.gw-1-vie-1-at-netcup.rwnix.net/
curl -k -I https://jarvis.gw-1-nbg-1-de-netcup.rwnix.net/
```

Expected public route result without credentials is `401 Unauthorized` with
`WWW-Authenticate: Basic realm="Authorization required"`.

With valid `mesh-admin` Basic Auth credentials (verified on 2026-10-04 on both
gateways) the route passes the Basic layer and answers `302` to the gateway's
Authelia portal (`auth.gw-1-*-at-netcup` / `-de-netcup` with `?rd=` back to the
requested path), where the browser two-factor login completes. The vhost access
log shows `[Sent-to 192.168.54.111]`, confirming the proxy chain to the app.
Note: the NPM access files are htpasswd `apr1` hashes (`admin:$apr1$...`), not
plaintext — the plaintext password is the NPM database value.

Observed successful checks:

- `/api/transcribe` route test returned endpoint `http://192.168.53.111:8003/v1/audio/transcriptions`, and vm103 `voice-gpu` logged the POST
- `node --check jarvis/server.js`
- `node --check jarvis/public/app.js`
- `docker ps --filter name=jarvis` reported `Up ... (healthy)`
- `/api/health` returned `brainConfigured: true`
- `/api/chat` with `Say only: Jarvis online` returned `Jarvis online`
- Both public routes returned the expected Basic Auth challenge before credentials

## gpu-1 voice services

Deployed 2026-10-03 on `gpu-1` (`194.182.188.115`): one `speaches` container serving both
Whisper STT and Kokoro TTS over the OpenAI audio API.

- Compose: `/home/ubuntu/docker/speaches/docker-compose.yaml`, image `ghcr.io/speaches-ai/speaches:latest-cuda`, published on `8003:8000`, model cache bind-mounted at `./hf-cache` (2.9 GB).
- STT: `Systran/faster-whisper-large-v3` on the GPU (`float16`), about 4.4 GB VRAM, leaving the llama.cpp allocation untouched. `WHISPER__TTL=-1` keeps the model resident: the default 300 s TTL costs a ~27 s reload on the first wake probe after idle.
- TTS: `speaches-ai/Kokoro-82M-v1.0-ONNX`, voice `bm_george`, on CPU.
- Auth: the container's `API_KEY` (in the compose file, as with llama.cpp's `--api-key`) guards every route including `/health`, so the compose healthcheck authenticates too. Unauthenticated requests get `403`. Jarvis sends it as `WHISPER_API_KEY` and `TTS_API_KEY`.
- Kokoro-FastAPI (`~/docker/kokoro-tts`) was deployed first, measured, then retired once speaches proved it covers both tasks; the compose file is left in place but the stack is down.

### Exposure

`gpu-1` ufw allows only 22/80/443 publicly, so the service is published through the
on-host nginx-proxy-manager as `voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`
(wildcard DNS for the zone already resolves to the host).

- This proxy host is **not** in NPM's database. It is an additive custom include at `/data/nginx/custom/http.conf` (`nginx.conf` includes `/data/nginx/custom/http[.]conf`), so NPM's rendered configs and database are untouched. NPM runs with `network_mode: host`, so the block proxies to `127.0.0.1:8003`.
- Certificate: `certbot certonly --webroot --webroot-path=/data/letsencrypt-acme-challenge --cert-name npm-voice` run inside `npm-ui`, stored at `/etc/letsencrypt/live/npm-voice/`, expires 2027-01-01. NPM's existing renewal cron covers it because the renewal config is in the shared `/etc/letsencrypt`.
- `client_max_body_size 25m` and 120 s proxy timeouts match Jarvis's own upload cap and request timeouts.
- Rollback: delete `/data/nginx/custom/http.conf` and `docker exec npm-ui nginx -s reload`. A database backup was taken first as `database.sqlite.bak-voice-20261003_204446` even though the database was never modified.

### Verified

`nginx -t` passed before each reload, and the live llama.cpp endpoint kept returning
`200` throughout. Over the public HTTPS path, with the Jarvis backend itself as the client:
`/api/speak` returned a 104 KB WAV in 0.54 s, and `/api/transcribe` of that same audio
returned `"Rocky, what time is it?"` in 1.02 s. Direct service timings: 0.80 s warm for a
1.2 s command, 1.19 s for 3.3 s of audio, 27 s cold (model load). Unauthenticated requests
return `403`.

### vm104 rollout (2026-10-03)

vm104 is not a git checkout; the app files are copied in. The HAL voice build was
rolled out by extracting `server.js`, `public/`, `Dockerfile`, `docker-compose.yml`
and the docs over `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build`.

- Backups taken first: `.env.bak-gpu1-voice-20261003_205829` and `../jarvis-code.bak-<ts>.tgz`.
- `.env` gained `WHISPER_API_KEY`, `TTS_ENDPOINTS`, `TTS_MODEL`, `TTS_VOICE`, `TTS_API_KEY`; `WHISPER_ENDPOINTS`, `WHISPER_MODEL` and `WHISPER_LANGUAGE` now point at gpu-1 in English, and `BRAIN_SYSTEM_PROMPT` answers in English. `BRAIN_API_KEY` was left untouched.
- Both voice keys hold the `speaches` container's `API_KEY` from gpu-1.
- Verified against the running container on `192.168.54.111:8094` (the compose binds that address, not `127.0.0.1`): `/api/health` ok with `ttsEndpoints: 1`, `/api/config` reporting `whisperLanguage: en` and `ttsConfigured: true`, `/api/speak` returning a 187 KB WAV in 0.71 s, `/api/transcribe` of that audio returning "Good evening, I am completely operational." in 1.04 s, and `/api/chat` answering in 1.17 s.
- The public gateway URLs answer `401` from outside, which is the existing Basic Auth/Authelia layer, not an app error. Browser verification of the HAL voice still needs a real login.

## Voice pipeline findings (2026-10-03)

Measured against the deployed gpu-1 service, not inferred.

### Wake probes were cut mid-word

The probe trigger fired as soon as 2 s of new audio existed and any voice had been heard,
including while the talker was still speaking, so the window ended mid-syllable. Whisper
returns an empty string for half a word, and the phrase was then only caught by the next
probe about 2 s later: the user-visible symptom was having to repeat the wake word.

A fixture of four isolated "Rocky" utterances (Kokoro-synthesized, 5 s of silence either
side) played through real Chromium capture into the live service:

| Trigger | Probes | Recognized | First detection |
|---|---|---|---|
| fixed 2 s interval | 8 | 6, two cut windows empty | 7.39 s (word at 5.0 s) |
| trailing edge of speech | 6 | 6, none cut | 6.53 s |

The trailing-edge trigger waits ~350 ms after voice stops, with a 3 s cap for speech that
never pauses. An earlier attempt capped on elapsed audio instead of speech, which failed
the same way, because 5 s of leading silence had already exceeded the cap by the time the
word started. `tests/pipeline.browser.mjs` guards the fixed behaviour by asserting every
probe window has a near-silent tail.

Only 2 of the 4 utterances produced a full cycle in both runs: utterances 2 and 4 arrived
while the pipeline was still in the command phase of the previous detection, which can run
~15 s for a wake-only cycle. That is the single-pipeline design, not a cut, and is the
obvious next thing to shorten.

### Whisper behaviour on the new model

- `large-v3` with `vad_filter=true` returns `""` for digital silence, faint noise and 50 Hz
  hum. With `vad_filter=false` all three return `"Thank you."`. The filter stays on, and
  `"Thank you."` / `"Okay."` / `"You"` are now treated as hallucinations: a silent command
  window would otherwise send a phantom prompt to the brain.
- The VAD is not over-aggressive: synthesized speech attenuated to 8% and 3% of full scale
  still transcribed perfectly with the filter on.
- Forcing English on German speech breaks wake matching outright.
  *"Rocky, wie viel Uhr ist es?"* transcribes as *"Roki waivil ua ist iz."*. Implemented as
  the per-browser **Language** toggle (English/Deutsch) that sends the language with every
  Whisper request — see "Frontend feature rollout" below.
- Latency: 0.80 s warm for a 1.2 s command, 1.19 s for 3.3 s of audio, ~27 s cold while the
  model loads into VRAM. `WHISPER__TTL=-1` keeps it warm.

### Reading the backend logs

The backend deliberately logs `transcriptChars` rather than transcripts, so a session is
diagnosed by shape. A run of `transcriptChars: 5` with no `/api/chat` requests means the
wake phrase alone is being recognized (`"Rocky"` is 5 characters) and the command step is
failing; `transcriptChars: 0` is an empty window; `transcriptChars: 10` was the
`"Thank you."` hallucination. Exact transcripts are only in the browser's live log.

### Incidental observations

- Capture sample rate follows the client's `AudioContext`; one tested browser ran at
  192 kHz, which makes uploaded windows four times the size expected at 48 kHz. Harmless,
  but it skews any size-based reasoning about window length.
- The deployed container binds `192.168.54.111:8094`, not `127.0.0.1`, so a localhost curl
  on vm104 looks like a dead service when the app is healthy.
- `npm ci` on vm104 and in CI-like containers skips devDependencies when `NODE_ENV` is
  `production`; use `npm ci --include=dev` before running the browser suite.

## Frontend feature rollout (2026-10-03, evening)

Rolled out to vm104 from this branch using the same file-copy + `docker compose up -d
--build` procedure as the HAL voice rollout. Backups under `/home/ubuntu/docker/` on vm104:

- `jarvis-code.bak-20261003_220410.tgz` — before live waveform ring + Prompt/Answer above controls
- `jarvis-code.bak-20261003_220829.tgz` — before animation preview buttons
- `jarvis-code.bak-20261003_221924.tgz` — before character voices, language switch and full-width bottom log
- `jarvis-code.bak-20261003_222222.tgz` — before the Kokoro voice-ID fix (wizard/newscaster)
- `jarvis-code.bak-20261003_223240.tgz` — before the language switch UI (first pass)
- `jarvis-code.bak-20261003_223857.tgz` — before the language toggle switch
- `jarvis-code.bak-20261003_230701.tgz` — before the realtime level ring, LEVEL % readout and faster stage animations
- `jarvis-code.bak-20261003_231630.tgz` — before the longer bar break-out and the ~30% smaller animation panel
- `jarvis-code.bak-20261003_232149.tgz` — before the `Hey Rocky` default wake word and English default language
- `jarvis-code.bak-20261004_071206.tgz` — before the test-signal/wake-test, MCP web search, plain-speech TTS and smaller core (current state)

Features shipped:

- Live circular waveform ring around the core: mic-driven while listening, shaped-TTS-driven
  while speaking, deterministic synthetic motion where audio cannot be tapped (browser
  `speechSynthesis`, Whisper/brain waiting). Reactor glow and size follow the overall level.
- Animation preview buttons (Standby/Wake/Recording/Transcribing/Thinking/Speaking/Error);
  disabled while a session runs so the live pipeline owns the core.
- Four character voice profiles (Commander, Android, Wizard, Newscaster) mapped to their own
  Kokoro voices via `profileVoices` in `server.js`.
- EN/DE **Language** toggle in the top controls row: per-request Whisper language, brain
  `Language override` directive, German spoken output via the browser voice because the
  Kokoro engine is English-only; `/api/speak` answers 503 `tts_language_unsupported` for
  non-English as a backstop.
- Layout: Prompt/Answer above the mic-level controls; Live log is a full-width panel at the
  bottom; STT endpoint/request-ID detail appears only in the Live log.
- Realtime level: a circular VU ring around the reactor plus a numeric `LEVEL %` readout
  under the core, driven at 60 fps by the analyser RMS (mic while armed, shaped TTS output
  while speaking, ambient input during transcribing/thinking).
- More dynamic core: faster ring spins in every stage, standby pulses and slowly rotates,
  reactor glow/scale/brightness react harder to level; waveform bars break out further at
  high level on a 360 canvas while the animation panel shrank ~30% (core 320px → 224px) to
  give Prompt/Answer more room.
- Defaults: wake word is `Hey Rocky` when no per-browser value is saved (server default,
  live `.env`, `.env.example`); the UI language defaults to English for browsers without a
  saved choice.

Verified against the running container:

- Unit suite 36/36, including per-profile voice mapping, per-request Whisper language, brain
  override, TTS guard, German voice picker, waveform math and the time-domain level meter.
- All five voice profiles returned valid RIFF WAVs from the live Kokoro engine
  (`hal9000/commander/android/wizard/newscaster` → `bm_george/bm_daniel/bm_lewis/bm_fable/am_michael`).
- The engine's supported-voice list was probed through its 422 detail dump: en-GB males are
  `bm_daniel, bm_fable, bm_george, bm_lewis`; there are **no German voices**, which is why
  German answers fall back to the browser voice.
- Live brain through the deployed backend: German request → `"Ich bin bereit."`, English
  request → `"I am ready."`.
- `/api/transcribe?language=de` and `=en` both returned 200 from gpu-1.
- `/api/config` on the live instance reports `wakePhrase: "Hey Rocky"` and
  `whisperLanguage: "en"` after the final rollout.
- Container reported `healthy` after every rebuild, including the last one.

## MCP web search + test-signal rollout (2026-10-04)

Rolled out to vm104 from main (PR #7) with the same file-copy + `docker compose up -d
--build` procedure. Backup first: `jarvis-code.bak-20261004_071206.tgz` under
`/home/ubuntu/docker/` on vm104 (code only; `.env` untouched, unchanged). Files copied:
`server.js`, `mcp/`, `public/`, `Dockerfile`, `docker-compose.yml`, docs.

Shipped:

- **MCP web search**: the backend now spawns `mcp/websearch.mjs` (JSON-RPC 2.0 over stdio,
  DuckDuckGo with one retry, Wikipedia fallback) and, when the browser's **MCP search**
  toggle is on, sends the top-5 results to the brain per prompt. No `.env` changes; the
  container's outbound internet is the only requirement — confirmed live below.
- **Test signal / Wake test** buttons in the controls row (armed only): the test signal
  injects an 880→1320 Hz peep into the live capture mix so the capture-to-Whisper round
  trip can be checked without a microphone; the wake test speaks the wake word through the
  speaker and runs the full hands-free pipeline.
- **Plain-speech TTS**: spoken output is sanitized in the browser (`textForSpeech`) so the
  speaker says normal language only; the printed answer and the answer prompt are unchanged.
- Core animation 30% smaller (224px → 157px desktop, 175px → 122px mobile).

Verified against the running container on `192.168.54.111:8094`:

- `/api/health` ok: `whisperEndpoints: 1`, `brainConfigured: true`, `ttsEndpoints: 1`.
- `/api/chat` (no search) answered `"Jarvis online"`.
- `/api/chat` with `websearch: true` answered from real search results (Kokoro-82M facts);
  backend log shows `websearch_success` (747 ms, 1554 chars) — the MCP server runs inside
  the container and vm104 has working egress to DuckDuckGo.
- Both public gateways (`gw-1-vie-1-at-netcup`, `gw-1-nbg-1-de-netcup`) answer `401` from
  outside — the existing Basic Auth layer, not an app error.
- Container `healthy` after the rebuild.

## MCP panel row + brain web-search state (2026-10-04)

Two fixes after the MCP feature went live. The search itself was working (backend logs
showed `websearch_success` for the user's session), so the reported failure
("IT answers No MCP Server available") came from the brain, not the MCP server.

- **MCP button panel one row below.** The MCP web-search switch no longer shares the main
  controls row (Arm/Stop/Manual prompt, test buttons, language switch, meters — seven
  columns that did not fit the 1180px shell). The controls panel is now two rows: the main
  row on top, and the MCP switch with its status line centered on the row directly below.
  On mobile (≤780px) everything stacks in the same order. Placement is `grid-template-areas`
  in `public/style.css` (`mcp-control` marker class in `index.html`).
- **The brain now knows the web-search state.** The brain is a raw LLM on
  `/chat/completions` with no tools, so it had no self-knowledge of the feature and answered
  capability questions from training data — "No MCP Server available" / "Ich habe keine
  Live-Websuche" — even with the toggle on. `chat()` in `server.js` appends the per-request
  state to the system prompt:
  - toggle on + results: "Web search (MCP web-search server) is ON …" plus the results message,
  - toggle on + failed search: ON but no results; answer from own knowledge,
  - toggle off: OFF; point to the MCP search toggle in the UI.
  New `MCP_SEARCH_SCRIPT` env var lets tests point the stdio client at a mock server;
  `tests/server.test.mjs` covers all three states without network (unit suite 39/39).

Rolled out to vm104 with the file-copy + `docker compose up -d --build` procedure
(`server.js`, `public/index.html`, `public/style.css`, docs; `.env` untouched).
Backup first: `jarvis-code.bak-20261004_080104.tgz` under `/home/ubuntu/docker/`.

Verified against the running container on `192.168.54.111:8094`:

- `/api/health` ok: `whisperEndpoints: 1`, `brainConfigured: true`, `ttsEndpoints: 1`.
- `Ist der MCP Server verfügbar?` with `websearch: true` →
  "Ja, der MCP Web-Search Server ist verfügbar und aktiviert." (previously "No MCP Server
  available"); with `websearch: false` → "Der MCP Web-Search Server ist in Ihrem Browser
  derzeit deaktiviert. Sie können ihn über den MCP-Such-Toggle … einschalten."
- Real question with `websearch: true` answered from live DuckDuckGo results; backend log
  shows `websearch_success` for every request.
- Browser suite 17/22: the 3 wake-word `page.fill` tests fail identically in this container
  environment (see `README.md`), including on unmodified `main`.
- Container `healthy` after the rebuild.

## Multi-user login + per-user prompt cache (2026-10-04)

Change set, rolled out to vm104 on 2026-10-04 with the usual file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_100943.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched — `USERS` is not set there, so the default
`Mila,Roman` applies):

- `USERS` env var (default `Mila,Roman`) defines the login accounts; each
  user's password is their own name. `server.js` validates with
  `timingSafeEqual`, issues a 256-bit token as an `HttpOnly; SameSite=Lax`
  cookie (`Secure` behind the HTTPS gateways), keeps sessions in memory for
  7 days, and locks an address out for 15 min after five failed logins.
- Every `/api/*` route except `/api/login`, `/api/logout`, `/api/health`
  now answers `401` without a valid session; `/api/config` additionally
  reports the signed-in `user`. The UI shows the login panel on the 401 and
  the whole app shell stays hidden until a config request succeeds;
  "Signed in as …" + Sign out live in the hero.
- The brain conversation cache (`conversations`) is keyed by the
  authenticated account instead of the client-sent session id, so every tab
  of one user shares that user's last-10-messages cache and no other user
  can read or write it. The client-sent `sessionId` is now ignored.
- New server tests: login success/wrong password/unknown user, the 401
  gate, the lockout, logout, and a Mila/Roman history-isolation test
  (unit suite 49/49).
- Test environment: the dev container (Debian 12, user `kandev` uid 1000
  without sudo) could not run `npm run test:browser` — Playwright's
  Chromium build downloads fine, but the ~20 shared libraries it links
  against (libglib-2.0.so.0, libnss3, libgbm1, libasound2, …) are missing
  and installing them needs root. A Kandev task (nbg instance) was created
  to run `npx playwright install-deps chromium` as root in that container;
  once the libraries resolve, the full browser suite (18 tests + 2 opt-in
  skips) should be runnable there.
- The opt-in `candidate backend` browser test logs in first via
  `page.request` so the shared cookie jar authenticates the page load.

Note for the live gateways: Authelia + Basic Auth stay in front as before;
the app-level login is the second layer and is what separates the Mila and
Roman prompt caches. `USERS` is not in the host `.env` — the default
`Mila,Roman` applies; add it explicitly (with the desired list) if that
ever changes — it is already in `.env.example`.

Verified on 2026-10-04 against the running container:

- Login `Roman`/`Roman` (field `username`) → 200 with session cookie;
  `/api/config` reports `user: "Roman"`; `/api/chat` answered through the
  brain.
- `/api/health` ok: `whisperEndpoints: 1`, `brainConfigured: true`,
  `ttsEndpoints: 1`; container `healthy` after the rebuild.
- Both public gateways still answer `401` (Basic Auth layer) from outside;
  the served HTML is the new build (new panel markup present in the page
  source). Browsers holding a cached copy of the old UI need a hard
  refresh (Ctrl+Shift+R); the login panel appears on first load of the
  new version.

## 2026-10-04: UI round, layout pass and voice-stop hardening

PR #11 (commit 1908a57) shipped the 2026-10-04 UI round on top of the
multi-user login: taller Prompt/Answer panels with the direct prompt input,
the Panels off/on switch, short hero captions only, one switch per MCP
server, removed test-signal/wake-test buttons, the Speak / Text-only switch,
the live Silence meter and the original stop-by-voice watch. It was rolled
out to vm104 on 2026-10-04 with the usual file-copy + `docker compose up -d
--build` procedure (backup `jarvis-code.bak-20261004_100943.tgz` under
`/home/ubuntu/docker/`; `.env` untouched).

Layout pass on 2026-10-04 (same day, user request): the Silence meter moved
into the Mic level panel (one panel, two bars — mic cyan, silence green) and
the controls panel became a single row (Arm Jarvis, Stop, language switch,
per-MCP-server switches; mobile still stacks). Rolled out with the same
procedure (backup `jarvis-code.bak-20261004_101553.tgz`). Unit suite 49/49;
served HTML/CSS verified on the running container.

Voice-stop hardening on 2026-10-04 (user request: "Hey <wake word>, stop"
must cut the speaking answer in the browser):

- The speech wake-watch now uses the wake probes' trailing-edge trigger
  (350 ms of silence after voice, plus the 3 s forced speech cap) instead of
  a single 800 ms settle. The old settle could never fire for the default
  browser voice, whose clause pauses are 150-450 ms, so a stop command said
  while the answer spoke was neither cut nor recognized. A stop command is
  now cut within at most 3 s of being said for every voice profile; the
  watch only interrupts on a non-empty command, so the assistant's own text
  mentioning the wake phrase without a command cannot cut the speech.
- Post-speech stop window: `speak()` timestamps `session.lastSpeechEndedAt`;
  the wake pipeline checks `isPostSpeechStop` (new in `public/voice.js`) and
  treats a stop command heard up to 10 s after the answer's speech finished
  as a speech stop — beep, Live log line, back to wake listening, no brain
  round trip. This is the fallback for the case where the audio already
  ended (or the browser-voice gaps never let the watch probe in time);
  without it, "stop" went to the brain as a normal prompt.

Verification:

- Unit suite 50/50 (new test: the post-speech stop window).
- Two new Playwright browser tests: `wake word plus stop cuts a speaking
  answer before it finishes` (hung TTS, the watch must cut it, no second
  brain prompt, utterance cancelled) and `a stop command right after the
  spoken answer is not sent to the brain` (natural TTS end, next cycle hears
  "Rocky stop", stays out of the brain). They cannot run in the dev
  container (Chromium's system libraries are missing, as before) — run
  `npx playwright install --with-deps chromium && npm run test:browser` on a
  proper host.

## 2026-10-04: voice-pipeline fixes, beeps, first name and multi-engine web search

A batch of user-reported fixes plus the web search becoming multi-engine. The
mid-speech stop fix (abort the answer's AbortController, not its signal) landed on
main separately as `eb93c7b`; PR #12 (`a6d1621`, merged as `f5613ba`) carries the
rest.

Rolled out to vm104 on 2026-10-04 with the usual file-copy + `docker compose up -d
--build` procedure. Backup first: `jarvis-code.bak-20261004_123111.tgz` under
`/home/ubuntu/docker/` (code only; `.env` untouched — no new `.env` entries). Files
synced: `server.js`, `mcp/`, `public/`, `tests/`, `Dockerfile`, `docker-compose.yml`,
`package.json`, `package-lock.json`, docs.

### Stop-by-voice was broken by a swallowed abort

`watchForVoiceCommand` called `speechSignal.abort(speechStopped)` on an **AbortSignal**
— only the **AbortController** has `.abort()`. The resulting `TypeError` was caught by
the watch's own catch block and dropped, so the stop-during-speech path (the whole
point of the trailing-edge speech wake-watch) had **never actually cut the speech**; the
5 s TTS watchdog ended the utterance instead, and the reported symptom was that saying
"stop" did nothing while the answer spoke. The fix passes the controller (not the
signal) down through `answer()` → `speak()` → `watchForVoiceCommand`, which now aborts
the real controller. This is why the two stop browser tests that "cannot run in the dev
container" now pass on a host with Chromium's libraries installed.

### Meters froze, then jumped to full

The mic-level and silence bars were driven from the pipeline loop, which suspends for
the whole Whisper/brain round trip; the bars froze at their last value (usually ~400 ms
of silence) and jumped straight to full when the round trip returned. Both meters now
run on their own 100 ms `setInterval` (`startMeters`/`stopMeters`/`updateMeters` in
`public/app.js`), independent of the pipeline loop, so they fill in real time while
audio is in flight. The silence bar still tracks trailing silence during wake listening.

### WAV encoding blocked the main thread

`AudioBufferWindow.wav()` wrote each PCM sample with an individual
`DataView.setUint16` call. At a 192 kHz `AudioContext` a 25 s window is up to ~9.6 MB;
the per-sample DataView loop stalled the main thread long enough to visibly freeze the
UI. It now fills a single `Int16Array` over the PCM region in one pass (little-endian
hosts only, like every target browser). Measured: 960 000 samples encode in ~4 ms.

### Audible upload beeps

Two new distinct tones join the 880→1320 Hz wake/speak sweep (`Microphone` in
`public/audio.js`): a soft 660 Hz `probeBeep()` the moment a wake-probe window is sent
to Whisper, and a higher 1760 Hz `sentBeep()` the moment the command audio is sent and
transcription starts. Every upload is now audible even if the UI looks idle.

### Jarvis knows who is signed in

The brain's system prompt now carries the authenticated user's name and is told it is
their first name, so answers address the user by name (Mila → "Mila, …"). While web
search is **off**, the prompt additionally tells the brain that live data (the weather
now, news, prices, scores) needs the **MCP web search** toggle, so it answers a weather
question honestly instead of denying the feature or guessing.

### Multi-engine web search findings

The search now queries DuckDuckGo (HTML), Bing (HTML), Wikipedia (API) in parallel plus
the DuckDuckGo Instant Answer API, merges round-robin and dedupes by URL. Measured
engine availability **from a server/datacenter IP** (the dev container's egress; the
vm104 container egresses from its own IP, which may differ):

| Engine | From server IP | Notes |
|---|---|---|
| DuckDuckGo HTML | flaky | intermittent `202` anomaly challenge; retry helps. Ad links are double-wrapped (`/l/?uddg=<encoded duckduckgo.com/y.js?ad_…>`) and are dropped by checking the final target's hostname, not the redirect's. |
| Bing HTML | works | result links are `bing.com/ck/a` redirects; the real URL is the base64url value of the `u=a1…` parameter. |
| Wikipedia API | works | structured, no bot wall. |
| DuckDuckGo Instant Answer API | works | keyless; abstract/definition/answer + related topics. |
| Mojeek, Startpage, Ecosia, Yahoo, SearXNG instances | blocked | bot wall (403/429/captcha/JS) from datacenter IPs — not used. |

A failed or walled engine degrades to zero results; the merged list stands on its own.
`tests/mcp.test.mjs` covers the pure engine helpers (redirect unwrapping, ad filtering,
dedupe, merge, formatting) and the stdio protocol without network.

### Verification

- Unit suite **58/58** (was 50): new tests for the 192 kHz bulk WAV fill, the six
  search-engine helpers, the first-name + MCP-off brain prompt, and the stop-by-voice
  abort.
- Browser suite **20 pass / 2 opt-in skip** on a host with Chromium's libraries:
  previously-failing `wake word plus stop cuts a speaking answer before it finishes`
  now passes, along with `a stop command right after the spoken answer is not sent to
  the brain`.

Verified against the running container on `192.168.54.111:8094` after the rollout:

- `/api/health` ok: `whisperEndpoints: 1`, `brainConfigured: true`,
  `ttsEndpoints: 1`; container `healthy` after the rebuild.
- Served `/app.js` carries the new beeps (`sentBeep`/`probeBeep`); the container has
  `mcp/engines.mjs` plus the multi-engine `websearch.mjs`.
- Browsers holding a cached copy of the old UI need a hard refresh (Ctrl+Shift+R).

## 2026-10-04: pipeline icons stay green after a manual prompt

Reported: after a typed (manual) prompt, the brain ("DeepSeek brain") and
speech output steps kept their green `done` highlight instead of returning to
waiting once the spoken answer finished.

Root cause: the step icons are `<li>` elements whose `className` is the status
(`done` = green, `skipped` = gray, `active` = amber, none = waiting).
`stage()` only ever removes the `active` class, and `stop()` — which the manual
flow (and every disarmed state) ends in — never reset the steps. The voice flow
only looked right because `listen()` calls `resetSteps()` at the top of each
loop. So a manual prompt (brain + tts marked `done`, the four audio steps
`skipped`) and any mid-run Stop left the icons frozen.

Fix: `stop()` in `public/app.js` now calls `resetSteps()` before moving to
standby — a disarmed pipeline has no running session, so every step returns to
waiting. Regression test: `manual prompt returns the pipeline icons to waiting
after the answer speaks` in `tests/pipeline.browser.mjs` (fails on the old
code with `['skipped','skipped','skipped','skipped','done','done']`, passes
with the fix). Unit suite 58/58, browser suite 21 pass / 2 opt-in skip.

Rolled out to vm104 on 2026-10-04 with the usual file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_143153.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched). Files synced: `public/app.js`,
`tests/pipeline.browser.mjs`. Verified against the running container on
`192.168.54.111:8094`: `/api/health` ok (`whisperEndpoints: 1`,
`brainConfigured: true`, `ttsEndpoints: 1`), container `healthy` after the
rebuild, and the served `/app.js` md5 matches the fixed source (browsers
holding a cached copy of the old UI need a hard refresh, Ctrl+Shift+R).

## 2026-10-04: double Basic Auth prompt (and why the app no longer answers 401)

Reported: the browser asks for the gateway's Basic Auth (mesh-admin) twice —
once before the Jarvis sign-in form and once after. Reproduced from the
VIE-1 NPM access log (`proxy-host-56_access.log`, log format
`[authelia_user] [final_status] [upstream_status]`; `- - 401` = rejected by
the Basic Auth layer, the backend never saw it; `- 401 401` = the backend
itself answered 401). Phone session on 2026-10-04, client 46.125.139.172:

```text
12:39:16  - - 401  GET  /            -> Basic Auth prompt #1 (no credentials yet)
12:39:17  - 200 200 GET  /           -> page loads, credentials now cached
12:39:18  - 401 401 GET  /api/config -> app 403-flow probe: no session yet (normal)
12:39:36  - - 401  POST /api/login   -> challenged: sent WITHOUT the credentials
12:39:37  - 401 401 POST /api/login  -> reached the app, app rejected it
12:39:46  - - 401  POST /api/login   -> challenged again (credentials cleared again)
12:39:47  - 200 200 POST /api/login  -> signed in
13:07:55  - 401 401 GET  /api/config -> app session gone (the 13:05 deploy
                                         restarted the container; sessions are
                                         in memory only)
13:08:09  - - 401  POST /api/login   -> Basic Auth prompt #2
13:08:10  - 200 200 POST /api/login  -> re-signed in
```

Root cause: the app itself answered **401** for "no session" (`/api/config`
probe on every page load) and for a wrong password (`/api/login`). A 401 that
arrives on a request that *carried* the gateway's Basic credentials makes the
browser treat those credentials as rejected and **clears its cached Basic
credentials for the origin** — even though the app's 401 is a bare JSON body
with no `WWW-Authenticate` header (verified: the gateway does not add one;
`proxy_intercept_errors` is off, so the app's 401 passes through untouched).
The next request then goes out without the Authorization header, the nginx
`auth_basic` layer challenges it (the 578-byte response in the log), and the
browser shows the Basic Auth dialog again. So every app-level 401 — the
normal pre-login `/api/config` probe and every wrong-password attempt —
caused a second (third, ...) Basic Auth prompt. The 13:08 instance happened
because the 13:05 vm104 deploy wiped the in-memory app sessions, not because
of anything wrong with the Basic layer.

Fix: the app never answers 401. It is not a Basic Auth endpoint — it sits
*behind* one — so its "no session" and "wrong password" responses are now
**403** (`error: "forbidden"`), which the browser's auth machinery ignores
(only 401/407 trigger credential handling). The 429 login lockout is
unchanged. The UI now treats a 403 on `/api/config` as "show the login form"
(`loadConfig` in `public/app.js`); the login form already handled any non-OK
status generically. Updated: `server.js` (login failure + API gate),
`public/app.js` (config probe), `tests/server.test.mjs` (401 -> 403 in the
login, gate, lockout and logout tests), README.

Net effect: one Basic Auth prompt per browser session per gateway origin
(Chrome keeps the credentials in memory while the browser is alive; the two
gateway URLs remain separate origins), and Jarvis sign-in/out no longer
triggers a gateway re-prompt. Note that deploys/restarts still wipe app
sessions (in memory by design), so after a deploy users re-enter the
*Mila/Roman* login — but not the mesh-admin one.

Rolled out to vm104 on 2026-10-04 (PR #15) with the usual file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_132818.tgz` under `/home/ubuntu/docker/`
(`.env` untouched). Verified against the running container:
`/api/config` without a session cookie answers `403 Forbidden` (no
`WWW-Authenticate`), a wrong-password `/api/login` answers `403`, and the
container is `healthy` after the rebuild.

## 2026-10-04: "Wetter Wien" manual prompt ended in a red pipeline error (empty brain answer)

Reported: the manual text prompt `Wetter Wien` (MCP web search on) finished in a
red pipeline error. The backend log showed `websearch_success` (780 ms, 1301
chars), then ~9.2 s later `Brain returned no answer text` from `chat()`.

Root cause: the brain (`deepseek-v4-flash`) is a reasoning model, and
`max_tokens` covers its thinking tokens as well. The request sent
`max_tokens: 1200`, so the model spent the whole budget reasoning over the
web-search context and returned `content: null` (`finish_reason: "length"`) —
the same failure class recorded under "Whisper and pipeline finding" (the ZDF
case, where the budget was raised once). 1200 was still too small once search
results joined the prompt.

Fix (PR #18):

- `max_tokens: 1200` -> `4096`: ~26 s of budget at the measured ~150 tok/s,
  inside the 45 s brain timeout, with 3.4x the headroom that failed.
- Empty answers are now logged with `finish_reason` and `usage`
  (`brain_empty_answer`), and the browser-visible error distinguishes the
  budget-exhausted case ("The brain spent its whole token budget on reasoning
  and returned no answer; ask again.") from a genuinely empty reply.
- New unit test: the brain request carries a reasoning-safe budget (>= 4096)
  and an exhausted budget answers 500 with the budget message (unit suite
  59/59, browser suite 21 pass / 2 opt-in skip).

Rolled out to vm104 on 2026-10-04 with the usual file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_145543.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched). Files synced: `server.js`,
`tests/server.test.mjs`. Verified against the running container on
`192.168.54.111:8094`: container `healthy`, and the reporter's exact request
— signed in as Mila, `Wetter Wien` with `websearch: true` — returned a real
answer in 10.0 s (`websearch_success` 843 ms, no `brain_empty_answer`).

## 2026-10-04: "Whisper returned no command" red error after wake word + command

Reported: saying the wake word **and** the command in one phrase ended in a red
pipeline error `Whisper returned no command. Please speak after the beep.`

Reconstructed from the vm104 log (15:00-15:02 CEST session, `language=de`):

- Every Whisper request succeeded (HTTP 200, 264-1706 ms) — the gpu-1 service
  was healthy; the brain was never reached (no `/api/chat` in the session).
- The failing shape: wake probe heard the phrase -> completed-utterance
  transcription (48 chars) carried the wake phrase but **not the command**
  (Whisper/VAD dropped it) -> pipeline beeps and waits for a separate command
  -> the user had already spoken, the post-beep window came back
  `whisper_no_speech` (0 chars) -> hard error. A dead end: the only recovery
  was saying the whole phrase again.

Fix (PR #19) in `public/app.js`:

- Completed-utterance transcription empty (no-speech) after a wake-detecting
  probe is now treated as a wake-only utterance (beep + command window)
  instead of the `Whisper did not confirm the wake phrase...` error.
- Empty command window after the beep (and the 10 s no-voice timeout) no
  longer throws: `waitForCommandEnd` returns `false` and the pipeline logs
  `No command captured with or after the wake word; returning to wake
  listening.` and retries on the next wake word — no red error, no backoff.
- New browser tests: `an empty completed utterance after a wake probe asks
  for the command instead of erroring` and `an empty command window after the
  beep returns to wake listening without an error`. Unit 59/59, browser 23
  pass / 2 opt-in skip.

Rolled out to vm104 on 2026-10-04 with the usual file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_152030.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched). Files synced: `public/app.js`,
`tests/pipeline.browser.mjs`, `README.md`. Verified against the running
container: container `healthy`, `/api/health` ok, served `/app.js` md5
matches the fixed source. A hard refresh (Ctrl+Shift+R) is needed in
browsers holding the old UI. Note: the behavioural fix itself is covered by
the two new Chromium tests; a real-microphone occurrence could not be
reproduced on demand.

## 2026-10-04: the brain answers as the wake word's name, and a bare "stop" cuts the speech

Two requested behaviours shipped together:

1. **Wake-word name.** The browser now sends the active wake phrase (server
   default or the personal per-browser override) with every `/api/chat`
   request. The server derives the name from it (`wakeNameFromPhrase`: last
   word after dropping a leading "Hey/Hi/Hallo" filler, capitalized) and the
   system prompt tells the brain "Your name is …". "Hey Rocky" → Rocky,
   "Kaya" → Kaya, no phrase → Jarvis fallback.
2. **Bare stop word.** The speech wake-watch now also cuts a speaking answer
   when the probe window transcribes exactly a stop word, with or without the
   wake phrase — the escape hatch for answers that run too long. The match is
   exact over the whole window (`isStopCommand`), so a longer speaker-echo
   sentence does not self-trigger. The post-speech fallback in the wake
   pipeline accepts the bare stop word too (up to 10 s after the speech),
   instead of the old "Whisper did not confirm the wake phrase" dead end.

Rolled out to vm104 from main with the file-copy + `docker compose up -d
--build` procedure. Backup first: `jarvis-code.bak-20261004_160523.tgz` under
`/home/ubuntu/docker/` (code only; `.env` untouched). Files copied:
`server.js`, `public/app.js`.

Verified against the running container on `192.168.54.111:8094`:

- Container `healthy`, `/api/health` ok (`whisperEndpoints: 1`,
  `brainConfigured: true`, `ttsEndpoints: 1`), served `/app.js` md5 matches
  the source, and it carries both new code paths.
- Signed in as Mila: `/api/chat` with `wakePhrase: "Hey Rocky"` and prompt
  "What is your name?" → **"My name is Rocky, Mila."**; the same prompt with
  no `wakePhrase` → **"My name is Jarvis, Mila."** (fallback).
- The bare-stop behaviour is browser-side and covered by the new Chromium
  test `a bare stop word without the wake phrase cuts a speaking answer`
  (plus `chat requests carry the active wake phrase so the brain answers as
  its name`); a real-microphone "stop" while the HAL voice is mid-answer is
  the user-facing check. A hard refresh (Ctrl+Shift+R) is needed in browsers
  holding the old UI.

## 2026-10-04: silence stop slider (100 ms-5 s, live) and bounded step retries (max 3)

Two requested behaviours shipped together:

1. **Silence stop slider.** A **Silence stop** range input (100-5000 ms, 50 ms
   steps) in the Mic level panel sets the command silence stop. The server
   default `SILENCE_MS` (1500 ms) is only the initial value; the value is
   saved per browser (`jarvis.silenceMs` local storage, like the wake word)
   and applies **live** — the VAD in `waitForCommandEnd` reads the current
   value on every 100 ms tick, so dragging the slider mid-recording changes
   when the pending command is submitted. The silence bar scale, the vad
   step name and the status-line countdown follow the slider.
2. **Bounded step retries.** `withStepRetries(session, label, run)` in
   `public/app.js` retries a failed pipeline step up to 3 times, 1 s apart,
   with the material already captured, instead of returning to wake
   listening and making the user speak the input again. Covered steps:
   wake-probe transcription, command transcription (the audio window is
   still in the 45 s capture buffer), the brain request (prompt captured),
   and the speech output (answer text known). Aborts (Stop, leaving the page)
   propagate immediately; after all 3 attempts the error reaches the
   pipeline's usual red error stage and backoff. The Live log records each
   attempt (`<step> failed (attempt N/3): …; retrying in 1000 ms`) and the
   pipeline status line shows the pending retry.

Rolled out to vm104 from the worktree with the file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_165059.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched, verified absent from the tarball). Files
copied: `public/index.html`, `public/style.css`, `public/app.js`,
`tests/pipeline.browser.mjs`, `README.md`, `DEPLOYMENT.md`.

Verification (worktree): unit suite 60/60; Chromium suite 29/29 (2 opt-in
live tests skipped), including the new tests `the silence slider adjusts
the live stop delay and persists per browser` (default 250 ms ends the
command at the fixture's 2.8 s pause; 5 s does not; dropping to 250 ms
mid-recording submits the pending command at the next pause without
re-arm; value survives reload), `a failed brain request is retried with
the captured prompt`, `a failed speech output is retried and still speaks
the answer`, `an exhausted Whisper retry is a visible error, then recovers
sequentially` and `a transient Whisper failure recovers on the bounded
retry without an error stage`.

Verified against the running container on `192.168.54.111:8094`:

- Container `healthy`, `/api/health` ok (`whisperEndpoints: 1`,
  `brainConfigured: true`, `ttsEndpoints: 1`).
- Served `app.js` / `index.html` / `style.css` md5 match the source
  (`8002e5c3…`, `d92da8f3…`, `466a28a9…`); the served HTML carries the
  `silenceDelay` slider and the served `app.js` carries
  `withStepRetries`.
- The slider and the retry loop are browser-side; the user-facing checks
  are dragging the Silence stop slider while armed (the silence bar and
  "Stop after …" step name follow) and a transient Whisper/brain blip
  retrying without an error stage. A hard refresh (Ctrl+Shift+R) is needed
  in browsers holding the old UI; a saved `jarvis.silenceMs` from the old
  UI does not exist, so everyone starts from the 1500 ms server default.

## 2026-10-04: the stop word did not cut a speaking answer (echo-aware stop match)

Reported live: "I get often whisper transcription error and the stop voice
command is not working for me during the answer is being spoken on audio
output" (user says **just the stop word**, listens on laptop speakers,
German mode). The vm104 log of the 14:56 session told the story: the
Whisper endpoint was healthy (successes 358-2386 ms, one failure = the user
closing the tab), but after the 14:56:57 brain call the mic produced a
5.5-minute stream of short (~12 char) probes at 2-5 s intervals — the user
repeating the stop word while nothing cut the speech. Two code paths turned
out to be broken by the speaker echo:

1. **The speech watch** (`watchForVoiceCommand`, `public/app.js`) required
   the stop word to match the **whole probe window exactly**. With speaker
   echo the window transcribes as the answer's own words plus the stop
   word, so the exact match never fired and the speech ran on.
2. **The post-speech fallback** (`isPostSpeechStop`, `public/voice.js`) had
   the same exact-match problem: a "Stopp" repeated after the answer —
   possibly with the answer's echo tail in the window — fell into
   "Whisper did not confirm the wake phrase in the completed utterance."
   That red error is what read as "whisper transcription error" even
   though Whisper itself was fine.

Fix (all browser-side):

- `hasLoudBurst(samples, start, end, sampleRate)` in `public/audio.js`:
  true when the window holds a contiguous ≥200 ms run of 100 ms blocks at
  least 1.5× the window's voice-block median RMS (and ≥0.02 absolute) —
  the user's own voice standing out against a quieter speaker echo. A
  uniform window (pure echo, or one loud voice level) never matches, so it
  cannot self-trigger.
- `stopCommandIn(command, { trailing })` in `public/voice.js`: the stop
  list as a word-boundary containment match ("Der Regen bleibt bis morgen.
  Stopp" → "stopp"; "Stoppuhr" and "Halten" do not match).
- The watch now cuts when the window **is** the stop word (exact, as
  before) or when the window carries a loud user burst **and** the
  transcript contains a stop word. `STOP_COMMANDS` gained the natural
  German phrases "hör auf", "lass es", "lass das", "genug schon".
- The post-speech fallback uses the same gate (plus: the stop word must
  end the utterance, so "Genug, was ist das Wetter?" is not a stop).
- Every watch probe's transcript now lands in the Live log
  ("Speech watch probe: …"), so a stop that does not trigger is debuggable
  from the page alone (the server log only ever stores char counts).

Tests: unit 64/64 (new: `hasLoudBurst` burst/echo/uniform/blip/noise
cases, `stopCommandIn` containment and trailing boundaries, the
burst-gated `isPostSpeechStop`); Chromium 30/30 (new: `a stop word inside
the echoed window cuts a speaking answer on a loud user burst` — a 6 s
fixture loop of 0.2 s loud burst + 1.2 s quieter echo, brain slowed 3 s so
the speaking phase starts mid-loop and the watch's settled probe window
carries the burst as a clear minority of voice blocks; the cut lands
before the 5 s TTS watchdog without a second brain round trip). Two
findings from building that test: the fake capture's audio processing
(AGC/noise suppression) decays a steady tone below the 0.012 voice
threshold within ~2 s, so the echo part of the fixture must stay short,
and the watch's settled probe covers the last 2 s of the window, so the
user burst must sit inside that tail.

Rolled out to vm104 from the worktree with the file-copy +
`docker compose up -d --build` procedure. Backup first:
`jarvis-code.bak-20261004_181714.tgz` under `/home/ubuntu/docker/`
(code only; `.env` untouched, verified absent from the tarball — the
three `*env*` entries are `.env.example` and two pre-existing `.env.bak-*`
snapshots). Files copied: `public/app.js`, `public/audio.js`,
`public/voice.js`, `tests/pipeline.browser.mjs`, `tests/audio.test.mjs`,
`tests/voice.test.mjs`, `README.md`, `DEPLOYMENT.md`.

Verified against the running container on `192.168.54.111:8094`:

- Container `healthy`, `/api/health` ok (`whisperEndpoints: 1`,
  `brainConfigured: true`, `ttsEndpoints: 1`).
- Served `app.js` / `audio.js` / `voice.js` md5 match the source
  (`8e958f0f…`, `5a6bbf75…`, `738e7186…`); the served `app.js` carries
  `hasLoudBurst` and `stopCommandIn`.
- The fix is browser-side: the user-facing checks are saying the stop word
  (in German: "Stopp", "Hör auf", "Lass das", "Genug schon") while an
  answer is still speaking — the Live log must show
  "Stop word heard while speaking" and the speech must cut — and, if a
  stop still does not trigger, the Live log now shows the probe transcript
  so the actual window content can be seen. A hard refresh (Ctrl+Shift+R)
  is needed in browsers holding the old UI.

## 2026-10-04: Bella (af_bella) female voice

New named female answer voice **Bella** backed by Kokoro `af_bella` — the
second-highest-graded female voice in the deployed Kokoro-82M v1.0 model
(A- per the official voice grades; `af_heart` is A). Chosen from internet
research of popular free female TTS voices: it ships with the model already
running on gpu-1, so no backend or model change was needed.

Research finding (user request "find some popular free female voice for our
tts", 2026-10-04):

- The deployed engine is **Kokoro-82M v1.0** (Apache-2.0; ranked #1 in the
  Hugging Face TTS Spaces Arena at release). The official per-voice grades
  (target quality × training duration) short-list the free female voices
  *already available on gpu-1* — exposing one is a Jarvis code-only change:
  - en_US: `af_heart` **A** (Heart), `af_bella` **A-** (Bella, added by this
    change), `af_nicole` B- (Nicole), `af_aoede` C+, `af_kore` C+,
    `af_sarah` C+ (Sarah), `af_sky` C-, `af_nova` C, `af_alloy` C,
    `af_jessica` D, `af_river` D
  - en_GB: `bf_emma` B-, `bf_isabella` C, `bf_alice` D, `bf_lily` D
- The `speaches` backend (MIT, 3.7k stars) also supports **Piper** models
  with dynamic loading — e.g. `en_US-lessac-medium` (the most popular Piper
  female), `en_US-amy-medium`, `en_GB-alba-medium`, `en_GB-cori-high`. A
  future option with no Jarvis code change, just a new model in the gpu-1
  container; quality below Kokoro.
- Other popular free/open engines with female voices, **not deployed**:
  - **Orpheus-TTS** (canopyai; Llama-3b based, open weights, popular via
    Poe/ComfyUI) — 8 voices, female **Tara, Leah, Jess, Mia, Zoe**, with
    phrase-level emotion tags (excited, happy, sad, angry, ...). Would need
    a new gpu-1 service.
  - **Chatterbox** (ResembleAI; MIT, big 2025 release) — natural female
    voices plus zero-shot cloning from a short sample. Also a new service.
  - **XTTS-v2** (Coqui) — cloning, but non-commercial license.
- Cloud-only, not self-hostable (listed for completeness, not candidates):
  ElevenLabs free tier (Rachel, Emma, ... — the most popular female voices
  overall), Azure Jenny/Sara.
- Decision: expose `af_bella` — the best unexposed female in the model
  already running, zero infra work. Next-cheapest step if more variety is
  wanted: a Piper female voice via the same speaches container; then
  Orpheus-TTS (Tara/Mia) as a second TTS backend.

- `public/voice.js`: new `bella` profile (Female voices group, delivery
  shape rate 0.95 / pitch 1.0 / 220 ms clause pause / 280-char chunks /
  speed 0.98, browser-voice fallback hints matching the other female
  profiles).
- `server.js`: `profileVoices.bella = "af_bella"`.
- `tests/voice.test.mjs` and `tests/server.test.mjs` extend the
  profile→voice mapping assertions; `README.md` lists the voice.

Tests: unit 64/64; Chromium 30/30 (2 opt-in live skips).

Rolled out to vm104 with the file-copy + `docker compose up -d --build`
procedure. Backup first: `jarvis-code.bak-20261004_184242.tgz` under
`/home/ubuntu/docker/` (code only; `.env` untouched — the only `*env*`
entry in the tarball is `.env.example`). Files copied:
`public/voice.js`, `server.js`, `tests/voice.test.mjs`,
`tests/server.test.mjs`, `README.md`, `DEPLOYMENT.md`.

Verified against the running container on `192.168.54.111:8094`:

- Container `healthy`, `/api/health` ok (`whisperEndpoints: 1`,
  `brainConfigured: true`, `ttsEndpoints: 1`).
- In-container `server.js` / `public/voice.js` / `public/app.js` md5 match
  the worktree; the served `/voice.js` and `/app.js` md5 match the source
  and the served `/voice.js` carries `af_bella`.
- Live round trip: login, then `POST /api/speak` with
  `{"profile":"bella"}` answered 200 with a 24 kHz mono WAV from the gpu-1
  Kokoro engine.
- Browsers holding the old UI need a hard refresh (Ctrl+Shift+R) to see
  the new voice in the Answer-voice select.

## Knowledge graph (Neo4j) rollout (2026-10-04)

A Neo4j Community database and knowledge graph were added for the assistant:
per-user knowledge (`(:User)-[:KNOWS]->(:Entity)`), entity-to-entity
relations from a fixed allowlist of relation types, and a `common` flag for
shared knowledge. The graph populates itself from every answered turn (web
search results and brain answers) and is exposed to the brain as a second MCP
server — **Knowledge graph** — with a read-only panel below the Prompt/Answer
panels (see `README.md`, "Knowledge graph (Neo4j)").

**Guarantee that chat turns can never write to the graph (application
layer).** During the rollout it turned out that Neo4j Community Edition has
no RBAC: `CREATE ROLE`/`GRANT` are rejected with
`UnsupportedAdministrationCommand` (verified on a fresh default-configured
`neo4j:5.26.31-community` container; official docs: "In Neo4j Community
Edition there are no roles, but all users have implied administrator
privileges"). The no-delete guarantee therefore rests on the MCP server and
the application layer:

1. The brain's MCP server is the official `neo4j-mcp` (PyPI
   `neo4j-mcp-server==1.6.0`, installed into the jarvis image at build time,
   spawned by the backend on demand). The backend spawns it with
   `NEO4J_MCP_READ_ONLY=true` and `NEO4J_MCP_TELEMETRY=false` **forced
   regardless of the host environment** — `write-cypher` is not in its tool
   list.
2. `read-cypher` is enforced read-only by Neo4j's query classification
   (an `EXPLAIN`-based check for write operations), so a prompt-injected
   brain cannot run `CREATE`/`MERGE`/`DELETE` through the read tool.
3. The only write path is the backend's own post-turn ingestion: one
   structured extraction LLM call over the prompt, the search results (if
   any) and the answer, sanitised (allowlisted entity/relation types, capped
   counts, validated property keys) and upserted with `MERGE`/`SET` using
   `jarvis_write` — there is no `DELETE` anywhere in the ingestion code —
   fire-and-forget after the answer was already delivered.

   `jarvis_read`/`jarvis_write` provide credential separation (MCP/panel vs
   ingestion), but on Community every user has full privileges — treat both
   passwords as write access to the graph.

**Services and env:** `neo4j` (container `jarvis-neo4j`, pinned
`neo4j:5.26.31-community`, `NEO4J_PLUGINS=["apoc"]`, heap 512m/1g, pagecache
512m, named volume `neo4j_data`, no published ports, wget-7474 healthcheck);
jarvis has `depends_on: neo4j: service_healthy`. New variables in vm104's
`.env` (never committed): `NEO4J_ADMIN_PASSWORD` (neo4j superuser, only for
the one-shot user creation below and admin work — the value in `.env` is
authoritative; it was rotated once during this rollout and the database was
updated to match), `NEO4J_READ_PASSWORD` (user `jarvis_read`) and
`NEO4J_WRITE_PASSWORD` (user `jarvis_write`); `NEO4J_MCP_*` mirrors the read
credentials for the MCP process.

**One-shot user creation (after the first healthy start).** Two gotchas hit
during the rollout: (a) the `cypher-shell` bundled with `5.26.31` rejects
admin commands in non-interactive mode — positional, `-f` and stdin all fail
with `UnsupportedAdministrationCommand`, even against the `system` database —
so admin commands must go through the HTTP API `POST /db/system/tx/commit`
with Basic auth (the same endpoint the browser uses); (b) the 5.26
`CREATE USER` syntax is `SET [PLAINTEXT | ENCRYPTED] PASSWORD '…'` (the 4.x
`REQUIRE ENCRYPTED PASSWORD` form no longer parses), and `CHANGE NOT
REQUIRED` must be appended, otherwise the new user is locked out with
`CredentialsExpired` until its first login. Both users were created on
2026-10-04:

```bash
cd /home/ubuntu/docker/jarvis
ADMIN=$(grep '^NEO4J_ADMIN_PASSWORD=' .env | cut -d= -f2-)
docker compose exec -T neo4j wget -qO- \
  --post-data='{"statements":[{"statement":"CREATE USER jarvis_read IF NOT EXISTS SET PASSWORD \"<NEO4J_READ_PASSWORD>\" CHANGE NOT REQUIRED"}]}' \
  --header="Content-Type: application/json" \
  --header="Authorization: Basic $(printf neo4j:$ADMIN | base64)" \
  http://127.0.0.1:7474/db/system/tx/commit
# identical call for jarvis_write with NEO4J_WRITE_PASSWORD
```

**Rollout:** usual file-copy + `docker compose up -d --build`, backup first
(code-only tarball under `/home/ubuntu/docker/`, `.env` untouched). Files:
`graphdb.js`, `server.js`, `Dockerfile`, `docker-compose.yml`, `package.json`,
`.env.example`, `public/index.html`, `public/style.css`, `public/app.js`,
`tests/graph.test.mjs`, `tests/graph.browser.mjs`, `tests/mock-graph-mcp.mjs`,
`tests/server.test.mjs`, `README.md`, `DEPLOYMENT.md`.

**Risks checked at deploy time:** the `neo4j-mcp-server` PyPI package ships
glibc wheels only (no sdist, no musl wheels), so the jarvis base image moved
from `node:20-alpine` to `node:20-slim` (Debian bookworm, Python 3.11 via
apt, pip `--break-system-packages`); the APOC jar download on first container
start (needs internet on vm104); `tools` support of the `a1-dsv4f`
`deepseek-v4-flash` endpoint (if it does not honour tools, the loop makes one
plain call and degrades to context injection only — the pre-graph behaviour
plus the context block) — verified live on 2026-10-04: the endpoint honours
`tools` and the `get-schema`/`read-cypher` loop completes — and tool-loop
latency vs the 60 s browser request timeout (3-round cap, 50 s total
deadline).

**Rollback:** restore the backup tarball, remove the `NEO4J_*` lines from
`.env`, `docker compose up -d --build` (or `docker compose rm -s neo4j` to
drop the DB service too). The app runs fully without the graph — endpoints
answer 503, the panel shows "Not configured on this server". The `neo4j_data`
volume can be kept or deleted; deleting it is the only destructive step.

**Fixes and live migration after rollout (2026-10-04, PRs #25–#26).** The
first real chat turns exposed latent bugs that the mock-based tests could not
see; all were fixed, re-deployed (backups
`jarvis-code.bak-20261004_213626.tgz`, `jarvis-code.bak-20261004_220031.tgz`)
and verified against the running containers:

1. **The MCP `read-cypher` tool takes a `query` parameter, not `cypher`**
   (verified against the server binary's own `tools/list` schema) — the first
   live tool loop failed every read with "Query parameter is required and
   cannot be empty". The tool schema, mock and tests were updated to `query`.
2. **The JS neo4j-driver encodes plain numbers as floats** and Neo4j rejects
   them for `LIMIT` (`'60.0' is not a valid value`) — the subgraph limit is
   now wrapped in `neo4j.int()`; a mock-driver regression test pins it.
3. **Invalid Cypher silently dropped every relation.** The shared-knowledge
   step used `MATCH (e:Entity)-[:KNOWS<-](:User)` — a reversed arrow written
   inside the brackets is not valid Cypher (`Invalid input '<'`). It threw
   after the entity `MERGE` and before the relation `MERGE`s, and the
   fire-and-forget catch swallowed the error, so entities landed but no
   `LIKES`/`FRIEND_OF`/… edge was ever written. Fixed to
   `MATCH (:User)-[:KNOWS]->(e:Entity)`; a regression test pins the pattern
   shape because the mock driver accepts any Cypher (which is how this one got
   through).
4. **The extraction returned empty for "I like Lego."** First-person
   statements (likes, ownership, family, home, work) are now explicit
   must-store facts in the extraction prompt, with a concrete example;
   `graph_ingest_empty` logs the model's raw output (truncated) so empty
   extractions are debuggable. Related: `GRAPH_MEMORY=1` was gated behind the
   `NEO4J_*` configuration (dead, contradicting its comment) and now swaps in
   the memory store on its own — the end-to-end ingestion test uses it.
5. **The signed-in user was stored as two nodes** (the account `:User`, a
   same-named `:Entity` person and a self-`KNOWS` edge — the panel rendered
   "Mila → Mila → Lego"). The `:User` account is now the person: ingestion
   skips the extractor's own-person entity, and relation endpoints named after
   the user target the `:User` node (Neo4j and memory stores). The panel
   draws `:User` nodes larger, in the accent colour, labelled `(you)` for the
   signed-in user.

**Live data migration (2026-10-04).** The pre-fix graph contained the stale
duplicate `:Entity{Mila, person}` with its self-`KNOWS` edge. A one-shot
migration via `POST /db/neo4j/tx/commit` (run from inside the jarvis
container with the `jarvis_write` credentials; note the request body must be
`{"statements": [...]}` — a bare array is rejected with `InvalidFormat`)
removed the duplicate with `DETACH DELETE` and re-pointed the `LIKES` edge at
`:User{Mila}`. Graph after migration: `Mila(:User) -KNOWS-> Lego(:Entity)`
and `Mila(:User) -LIKES-> Lego(:Entity)`; a fresh "I like Lego." turn
ingests cleanly without recreating the duplicate. Known simplification for a
future multi-user deployment: when another user mentions the name of an
existing account holder, the Neo4j store still creates a separate `:Entity`
 for them (only the current user resolves to `:User`); it does not occur in
 the current single-user deployment, and the memory store dedupes by name and
 is unaffected.

## 3D graph view rollout (2026-10-04, PR #28)

The Knowledge graph panel's default view became a live 3D visualisation: a
continuously animating three.js force layout (type-coloured sphere nodes, one
dynamic line object for the links, DOM-projected clickable labels, drag-to-orbit,
wheel zoom, auto-rotate after 5 s idle, and node positions preserved across the
15 s polls so the view keeps settling instead of jumping). The old SVG layout
remains as a 2D toggle with the same click-to-re-centre behaviour; browsers
without WebGL 2 fall back to it automatically (three.js dropped WebGL 1 support
in r163, so the 3D view requires WebGL 2). three.js is vendored locally at
`public/vendor/three.module.min.js` (pinned `three@0.164.1`, fetched from unpkg),
so the panel has no CDN dependency at runtime.

Rollout: the standard vm104 procedure — backup `jarvis-code.bak-20261004_231156.tgz`,
synced `public/app.js`, `public/graph3d.js` (new), `public/index.html`,
`public/style.css`, `public/vendor/three.module.min.js` (new) and
`tests/graph.browser.mjs`, then `docker compose up -d --build`. Verified live:
served artifact md5s match the worktree, `/api/health` ok, and a logged-in
headless Chromium session shows the 3D view as default with the real graph
("Mila (you)", "Lego") and a working 2D toggle. The browser check runs against
the plain-HTTP LAN origin with `--unsafely-treat-insecure-origin-as-secure`
because `crypto.randomUUID` (used for the session id) only exists in secure
contexts; normal browsers reach the app over the HTTPS proxies, which are
already secure contexts.

Two findings: (1) the `hidden` IDL property does not reflect the `hidden`
attribute on **SVG elements** in Chromium — `svgEl.hidden = false` leaves the
attribute, and with it the `[hidden]` CSS `display: none`, in place; the view
switch therefore uses `toggleAttribute("hidden", …)` for the 2D SVG. (2) The
headless SwiftShader here fires a spurious `webglcontextcreationerror` ("Canvas
has an existing context of a different type") even though the
`getContext("webgl2")` call succeeds — the renderer is created and renders
normally, so the console line is cosmetic.

**Fix after rollout (2026-10-05, PR #29).** User report: in 3D mode the graph
rectangle overlapped the "Panels off/on" row and everything below it. Cause:
the 3D stage was `position: absolute` inside `.graph-canvas-wrap`, while the
hidden 2D SVG contributes no flow height in 3D mode — the wrap collapsed to
0 px and the 320 px stage painted over the following panels. The stage is now
an in-flow element (`position: relative`, the same fixed 320 px height the 2D
SVG reserves), so the wrap always holds the canvas height in both views. A
browser-test regression pins the wrap height, the stage staying inside the
wrap, and the panels toggle row starting below the graph panel. Redeployed
(backup `jarvis-code.bak-20261005_090500.tgz`) and re-verified live: wrap
320 px, stage inside the wrap, the panels row 18 px below the graph section.

## Relation-type link labels (2026-10-05, PR #30)

Both graph views now label every link with its relation type in plain words
(`KNOWS` → knows, `LIKES` → likes, `LIVES_IN` → lives in), so the graph reads
like sentences together with the node labels (Mila —knows→ Lego, Mila
—likes→ Lego). 2D: an SVG text at each edge's midpoint with a dark
`paint-order` outline so it stays readable over the lines. 3D: a DOM label
projected onto each link's midpoint every frame (the same technique as the
node labels; non-interactive, smaller and dimmer). Parallel edges between the
same pair stack their labels (10 px per extra edge) instead of painting on top
of each other, in both views.

Finding from the first live verification: the 3D edge-label diff keyed labels
by `source->target` only, so a pair carrying two edges at once (the live
graph's Mila KNOWS Lego + Mila LIKES Lego) silently dropped the second
label. The id now includes the relation type and the text is refreshed on
change; the browser-test fixture gained a parallel edge pair (KNOWS + LIKES on
the same nodes) so the scenario is pinned in both views.

Deployed (backup `jarvis-code.bak-20261005_091708.tgz`) and verified live in
both views: the 3D scene shows both `knows` and `likes` between Mila (you) and
Lego, as does the 2D view.

## Negation and the hidden bookkeeping edge (2026-10-05, PR #31)

Two connector-semantics fixes after reviewing the live panel:

1. **The bookkeeping `KNOWS` edge is no longer drawn.**
   `(:User)-[:KNOWS]->(:Entity)` is provenance — it feeds the brain's context
   ("what does Mila know") and the shared-knowledge flag — not a fact. The
   panel showed it as a "knows" link next to the real facts, which read like a
   relation of its own. The filter is in the API layer: both Neo4j subgraph
   queries (`type(r) <> 'KNOWS'`) and the schema's relation list skip `KNOWS`
   in both stores (Neo4j and the in-memory fallback), so the edge stays in the
   database and in `readContext`; only the panel data changes.
2. **Negation is a flag on the relation, never a new type.** "I don't like X"
   is `LIKES` + `negative: true`, displayed as "doesn't like" — the label map
   (positive/negative forms for all 14 relation types) lives in
   `public/relLabel.js`, shared by both views. The extraction prompt learned
   the flag with positive/negative examples and the rule that a negative
   statement overwrites an earlier positive one. Ingestion is a `SET` upsert
   (`SET r.last_seen = row.now, r.negative = row.negative`), so a later
   statement flips the same edge; the in-memory store flips the flag in place
   the same way.

Deployed (backup `jarvis-code.bak-20261005_103805.tgz`) and verified live
end-to-end: the schema line lists only `LIKES` (no `KNOWS`), and both views
show a single `likes` between Mila (you) and Lego. A real chat turn "I don't
like Lego anymore." flipped the live edge (`negative: true` via
`/api/graph/subgraph`, panel label "doesn't like" in the 2D view), and
"Actually I do like Lego, I was joking." flipped it back — the graph is in its
previous state.

## Brain graph-query fix: user facts live on the :User node (2026-10-05, PR #32)

User report (signed in as Roman, graph panel showing "Mila likes Lego"):
"what does Mila like?" → the brain answered it had no information about Mila's
preferences. The panel's recent-activity log showed the brain's three tool
calls: `get-schema`, `MATCH (u:User) WHERE u.name CONTAINS 'Mila' RETURN u`,
`MATCH (e:Entity) WHERE e.name CONTAINS 'Mila' RETURN e` — it confirmed the
`:User` node exists but **never queried its outgoing relations** (where the
`LIKES` edge lives), and the third round was the last one allowed.

Root causes (both backend, no data problem):
1. The brain's system prompt said it "can call get-schema and read-cypher for
   anything deeper" but never described the data model, so the brain had no
   reason to look past `RETURN <node>` — and after the single-user-node fix,
   "Mila" is a `:User`, so the `:Entity` lookup came back empty.
2. `GRAPH_TOOL_ROUNDS = 3` was spent on the exploratory queries, leaving no
   round for the actual relation query.

Fix:
1. The graph-on state line in the brain's system prompt now carries a short
   data-model cheat-sheet: `:User` nodes are the signed-in accounts (one per
   user), `:Entity` is everything else, and a user's stored facts are the
   *outgoing relations* of their `:User` node — with the example query
   `MATCH (u:User {name: 'X'})-[r]->(t) RETURN type(r), t.name` for exactly
   the "what does X like?" question.
2. `GRAPH_TOOL_ROUNDS` raised 3 → 5 (schema call plus a few follow-up queries
   is the common pattern; the 50 s request deadline still bounds the total).

Tests: the mock brain gained a "Loop the tools" mode that requests a tool on
every round; a new test asserts the server executes exactly five tool rounds,
delivers five tool results to the brain, and forces the final answer with the
"Tool budget reached" message. The configured-tool-loop test now also pins the
cheat-sheet in the system prompt. Unit 82/82, browser 37 pass + 2 opt-in
skips.

Deployed (backup `jarvis-code.bak-20261005_110205.tgz`; `server.js` +
`tests/graph.test.mjs` synced, md5-verified) and verified live: the same
question as Roman now gets `get-schema` followed by
`MATCH (u:User {name: 'Mila'})-[r:LIKES]->(e:Entity) RETURN e.name,
r.negative, r.last_seen`, and the answer is "Mila likes Lego. That's the only
thing stored in the knowledge graph about her preferences."

## Per-user data isolation (2026-10-05, PR #33)

User request: signed in as Roman, the user must not see — in the graph panel
or via the brain's MCP access — any user-related data of other users (Mila's
`:User` node, her `LIKES`/fact edges, her `KNOWS` edges).

Why the pre-#33 panel and MCP could not guarantee this:
1. The panel endpoints (`/api/graph/status`, `/api/graph/subgraph`) returned a
   global newest-N subgraph: every user's nodes and fact edges were visible to
   everyone.
2. The brain's graph MCP server was the official `neo4j-mcp` with a
   free-form `read-cypher` tool. Neo4j Community has no RBAC, so any raw read
   is a bypass: `MATCH (e)-[r]-(x) RETURN x` reaches another user's node
   without ever naming the `:User` label. A read-only flag is not enough;
   only a surface with no Cypher at all is.
3. A legacy data shape made the leak concrete: pre-`af0d338` ingestion created
   a person `:Entity` named after a user (a proxy for their personal data).
   The live DB held `Mila:Entity` with `Mila:Entity -[:LIKES]-> Lego` and
   `Roman -[:KNOWS]-> Mila:Entity`, so Roman's panel showed "Mila likes Lego"
   as world knowledge even after the panel was scoped.

Changes:
- **`mcp/graph.mjs` (new):** own stdio MCP server (Node, newline JSON-RPC)
  replacing `neo4j-mcp`. Four parameterized read tools — `get-schema`,
  `get-entity(name)`, `list-my-knowledge`, `list-my-facts(about?, relation?)`
  — no write tool, no Cypher tool. Every query is built inside the file,
  `MATCH`/`RETURN` only, pinned to a `user` argument the backend injects per
  call; the tool schema the brain sees has no `user` parameter, and the
  server fails calls that arrive without one (defense in depth). Connects
  with the read-only `jarvis_read` credentials passed via env at spawn.
- **`server.js`:** `mcpGraph` now spawns `mcp/graph.mjs` (env
  `NEO4J_URI`/`NEO4J_DATABASE`/`NEO4J_READ_USER`/`NEO4J_READ_PASSWORD`;
  `MCP_GRAPH_SCRIPT` overrides for tests, same pattern as
  `MCP_SEARCH_SCRIPT`). The brain gets the four tools plus a privacy line in
  its prompt ("other users' personal data is not accessible to you"). The
  tool loop injects the session user into every call (`{ ...args, user }`, so
  a brain-supplied `user` could never win), logs a short
  `tool: arguments` summary (`detail`) instead of raw Cypher, and rejects
  unknown tool names with a corrective tool result. `/api/graph/status`,
  `/api/graph/subgraph` and `/api/graph/activity` are scoped to `req.user`
  (the activity feed is filtered to the session user's entries; the per-line
  `(user)` suffix in the panel is gone with it).
- **`graphdb.js` (both stores):** `status({ user })` counts the signed-in
  user's visible world (user node + known entities + one entity-hop
  neighbours, fact edges + entity↔entity edges, `KNOWS` filtered from
  `relTypes`). `subgraph({ user, limit, center })` returns that world;
  `center` is only honoured if it is the user's own node, a known entity, or
  an entity one entity-hop from a known one, and neighbours are `:Entity`
  nodes plus the user's own node — a foreign elementId comes back empty, and
  the Cypher pins the same guard server-side. `upsertTurn` keeps the
  one-node-per-user invariant for **every registered user** (the user list is
  passed from `config.users`): entities named after a user are dropped,
  referenced users' `:User` nodes are `MERGE`d, and relation endpoints named
  after a user resolve to `:User {name: row.from/row.to}` — so a fact stated
  about another user is stored *on* that user, visible only to them. The old
  `knownBy >= 2 → common` auto-flag is removed (it derived common-ness from
  other users' mentions); `common` is now only ever the extractor's flag.
- **`public/app.js`:** the activity line renders `entry.detail` (tool +
  argument summary) instead of raw Cypher, without a per-entry user suffix.
- **`Dockerfile`:** the `python3`/`pip neo4j-mcp-server==1.6.0` layer is gone;
  the graph MCP server runs from the copied Node source (only `neo4j-driver`
  is needed, already a production dependency). The now-unused
  `NEO4J_MCP_*` variables in `.env` are harmless leftovers.

Live data cleanup (one-off, via the Neo4j HTTP API in the jarvis container):
`MATCH (e:Entity {name: 'Mila'}) DETACH DELETE e` — the legacy proxy node and
its `LIKES` edge, whose fact is already carried canonically by
`Mila:User -[:LIKES]-> Lego`. After cleanup the graph holds exactly the
users `Mila`/`Roman`, the entity `Lego`, the fact edge above, and the two
`KNOWS` edges to `Lego`.

Tests: unit 84/84 (new: the memory-store per-user isolation test, the
"endpoints named after other users target their `:User` node" Cypher pin for
the Neo4j store, the unknown-tool/rejected-`read-cypher` test; reworked:
scoped `status`/`subgraph` calls, `knownBy` expectations removed, the mock
MCP implements the four tools, the browser fixture is a per-user subgraph
shape with no `KNOWS` edges and the activity mock uses `detail`), browser
37 pass + 2 opt-in skips.

Deployed (backups `jarvis-code.bak-20261005_120148.tgz` and
`jarvis-code.bak-20261005_122521.tgz`; `server.js`, `graphdb.js`,
`public/app.js`, `mcp/graph.mjs`, `tests/*`, `Dockerfile` synced,
md5-verified, image rebuilt without the Python layer) and verified live:
- As **Roman**: `/api/graph/subgraph` returns `Roman, Lego` with zero edges —
  no Mila node, no Mila edge; activity feed scoped to his entries only.
- As **Mila**: her world is intact — `Mila, Lego` with the
  `Mila -LIKES-> Lego` edge (positive), no Roman node.
- As **Roman**, "What does Mila like?" → "I don't have any information about
  Mila or what she likes" (the tools are pinned to Roman; `get-entity` finds
  no `Mila` entity, `list-my-facts` has nothing about her). As **Mila**,
  "What do I like?" → "You like Lego, Mila".
- Write path end-to-end: the live chat turns (real extractor + ingestion on
  the new code) re-created no user-named entity — the graph after the
  verification chats still holds exactly `Lego` as the only entity.

## Hide isolated mentions in the panel (2026-10-05, PR #34)

User question: "If there is no connection between user Roman and Lego, why do
you show Lego in the 3D graph?" After #33 the panel drew every entity the
user *knows* (`KNOWS`), even when no visible fact edge touched it — so Roman's
panel showed a floating `Lego` node (he knows it, but the only fact edge is
Mila's private `LIKES`). Chosen behaviour: an entity is drawn **only if at
least one visible fact edge touches it** in the user's world. Isolated
mentions stay in the database — `KNOWS` is intact, so the brain's context and
`list-my-knowledge` still see them — but they are neither drawn nor counted.

Changes (`graphdb.js`, both stores; no API shape change, no frontend change —
the panel just draws whatever the subgraph returns):
- **Neo4j store:** the newest-mode `subgraph` queries (user node, known
  entities, one entity-hop neighbours, fact edges between them) now run in a
  shared `visibleWorld(user, cap)` helper that also marks `drawn` on the user
  node plus every entity a returned fact edge touches. `subgraph` returns
  only the drawn nodes; `status({ user })` counts exactly the drawn nodes and
  edges (same helper, cap 60 = the panel's default `?limit=60`), so the
  node/link counter and the drawing can never disagree. The centred mode is
  unchanged (an explicit click on a visible node still shows its
  neighbourhood).
- **Memory store:** the same `visibleWorld(user, cap)` helper (candidate
  world = user + known + one entity-hop, drawn = user node + fact-edge
  endpoints), used by both `status` and the newest-mode `subgraph`.
- **Tests:** the starter-graph `Berlin` is now an isolated mention, so
  `status`/subgraph expectations for the bare starter world changed from
  4 nodes to 3 (Mila/Roman + Rocky + Kokoro via `Rocky -USES-> Kokoro`); the
  per-user isolation test gains a drawn `Mila -OWNS-> Car` fact so the two
  users' counts still differ (the old "Berlin makes Mila higher" reasoning no
  longer holds); the Neo4j mock pins are unchanged (same query strings).
- **Docs:** README isolation bullet + Panel paragraph describe the drawn
  world and isolated mentions.

Tests: unit 84/84, browser 37 pass + 2 opt-in skips.

Deployed (backup `jarvis-code.bak-20261005_131654.tgz`; only `graphdb.js`
synced, md5-verified, image rebuilt) and verified live:
- As **Roman**: `/api/graph/status` → `1 node · 0 links`, subgraph returns
  only `Roman (you)` — the isolated `Lego` mention no longer floats.
- As **Mila**: `2 nodes · 1 link` — `Mila (you)` + `Lego:thing` with the
  `LIKES` edge, her real fact intact.
- DB check: `KNOWS` edges `Mila->Lego` and `Roman->Lego` untouched, so the
   brain context and `list-my-knowledge` still see the mention.
 - Browsers need a hard refresh (Ctrl+Shift+R) to pick up the (unchanged)
   static assets; the panel polls, so the new data shows without a refresh.

## Scoped, honest brain answers about the graph (2026-10-05, PR #35)

User question: asked as Roman "Does any graph db user like Lego?", the brain
answered "…no LIKES relations to any person are recorded" — a *scoped*
answer (Roman's view, where he has no LIKES facts) phrased as a *global*
claim about the whole graph. No data leaked (the tools are pinned to Roman and
`get-entity` only returns `:Entity`↔`:Entity` links, so `Mila -[:LIKES]-> Lego`
is invisible to him), but the wording was misleading: it read as "no one in
the graph likes Lego" when it really meant "I have no record of *you* liking
Lego and I cannot see other users' data."

Confirmed the isolation model is airtight (each user = a private brain, only a
backend admin with direct DB access sees all users' data):
- `list-my-facts` matches only the signed-in user's own outgoing fact edges.
- `get-entity(name)` returns the entity's data plus links to other `:Entity`
  nodes only — a `:User` endpoint is never returned, so another user's fact
  edge to that entity is invisible, not even anonymously.
- `list-my-knowledge` returns only the signed-in user's `KNOWS` edges.
- `get-schema` returns structure (labels / relation types / property keys),
  not personal data.
So if Roman later also likes Lego, his brain says "you like Lego" and cannot
say "Mila also likes Lego." The brain remembering Roman's own `KNOWS` of Lego
(he mentioned it) is his own provenance, not a leak; the panel hides that
isolated mention from the drawing while the brain keeps the user's memory.

Change: the graph prompt in `server.js` now tells the brain its view is the
signed-in user's private view and requires it to phrase anything it says about
the graph from that user's view ("I have no record of you liking X", "I have no
access to other users' facts"), never as a global claim ("no one likes X").
No store or tool change; the isolation was already correct.

Tests: unit 84/84 (the prompt-content assertion updated to the new wording),
browser 37 pass + 2 opt-in skips.

Deployed (backup `jarvis-code.bak-20261005_135035.tgz`; only `server.js`
synced, md5-verified, image rebuilt) and verified live: as **Roman**, "Does
any graph db user like Lego?" now answers "…no LIKES relation recorded for
you … I can only see data belonging to you (Roman) plus shared/public
knowledge. I have no access to other users' preferences or facts, so I can't
say whether any other user likes Lego." — scoped, honest, no global claim, no
leak.

## Ownership model: every entity is private to its owner (2026-10-05, PR #36)

User question: the MCP `get-entity` tool reported the `Lego` entity as
*public* ("Lego (thing), public knowledge") even though it was only ever
"liked" by Mila. Follow-up security question: if Mila mentioned a credit card
number, could Roman's brain or panel see it?

Audit of every read path found **three leak paths**, all rooted in the same
design: entities were global nodes with a `common` flag, and the flag was set
by the LLM extractor (it flagged `Lego` as general knowledge — the same model
would flag a credit card number as a "thing"):

1. **`get-entity(name)` was not owner-scoped** (`mcp/graph.mjs`):
   `MATCH (e:Entity {name: $name})` returned the full `properties(e)` of any
   entity regardless of the requesting user; the injected `user` only computed
   a `known` flag. Any entity the extractor marked `common: true` was readable
   by every user's brain — names *and* properties.
2. **The brain context injected shared knowledge into every user**:
   `readContext` put every `common: true` entity name into *every* user's
   context block ("Shared knowledge: …"), so a sensitive entity wrongly
   flagged public leaked its name to all brains.
3. **The panel's one-entity-hop expansion** could pull another user's private
   entity into a panel: a shared entity connected to a private one made the
   private one appear in the other user's world.

Decision (user-confirmed): **everything private, owner-keyed entities.** No
shared/public tier at all. Admins keep direct-DB visibility (`MATCH
(e:Entity {name: "Lego"})` returns every owner's copy — the per-user guarantee
is application-layer, as it always was; Community Edition has no RBAC).

Model:
- `:Entity` is keyed by `(name, type, owner)`; `owner` = the signed-in user of
  the turn that mentioned it. "Lego" mentioned by Mila and by Roman is two
  nodes. The `common` flag is gone (extractor prompt, store, panel API); the
  `(:User)-[:KNOWS]->(:Entity)` bookkeeping edge is gone — ownership *is* the
  provenance.
- Read paths, all pinned to the session user: `get-entity` matches
  `{name: $name, owner: $user}` (foreign = nonexistent — no enumeration);
  `list-my-knowledge` matches `{owner: $user}`; `list-my-facts` is unchanged
  (facts stored about the user, on their `:User` node); `readContext` returns
  only the user's own entities (no shared line).
- Panel `visibleWorld`: user node + owned entities + fact edges between them —
  no neighbour expansion at all, so nothing can leak through it. A fact edge
  is visible when every `:Entity` endpoint is the user's; `:User` endpoints
  are account markers (name only) and may appear as edge endpoints; a pure
  user-to-user edge is visible only to its two parties. Centre mode: the
  centre must be the user's own node or an owned entity; neighbours are owned
  entities and `:User` markers.
- Ingestion: `MERGE (e:Entity {name, type, owner: $user})`; relation entity
  endpoints match `{name, owner: $user}` (the turn user's own copies); no
  `KNOWS` write, no `common` write.
- `mcp/graph.mjs` restructured: the owner-scoped Cypher strings are exported
  as `QUERIES` (pinned by `tests/mcp-graph.test.mjs`), the result formatting
  is exported pure, and the stdio server only starts when run directly
  (importing the module in tests opens no driver, reads no stdin).

Live migration (one-time, after the new build was up so the old writer could
no longer run): full JSON dump backup first, then ONE atomic transaction —
create an owned copy of each ownerless entity for every user that `KNOWS` it
or has a fact edge to it (props copied, no `common`), re-point every fact edge
(user → ownerless entity) to the copy owned by that user, `DETACH DELETE` the
ownerless originals, delete all `KNOWS` edges. State before: `Lego`
(ownerless, `common: true`, 11 mentions), `KNOWS` from Mila and Roman,
`Mila -[:LIKES]-> Lego`. State after: `Lego(owner: Mila)` + `Lego(owner:
Roman)`, `Mila:User -[:LIKES]-> Lego(owner: Mila)` (props preserved), zero
`KNOWS`, zero ownerless, zero `common`. (Migration note: the first run lost
the re-pointed `LIKES` edge — the driver helper read only the first row of the
`RETURN DISTINCT type(r)` result, so the per-type loop only saw `KNOWS` and
the later `DETACH DELETE` dropped the still-attached `LIKES`; the backup dump
made the restore a single statement. Helper fixed; the sequence itself is
idempotent-safe because tx/commit is atomic.)

Tests: unit 91/91 (memory store owner-keyed isolation incl. the account-marker
case — a fact one user states about the other lands on the other's type-less
`:User` marker and never leaks an entity; neo4j mock pins for the owner-keyed
`MERGE`, owner-scoped relation endpoints, the owner-scoped subgraph/centre
queries and the user-to-user edge clause; new `tests/mcp-graph.test.mjs`
query pins + formatting; integration test asserts the ingested node's
`owner`), browser 37 pass + 2 opt-in skips (fixture nodes now carry `owner`).

Deployed (backup `jarvis-code.bak-20261005_170657.tgz`; `graphdb.js`,
`server.js`, `mcp/graph.mjs` synced, md5-verified, image rebuilt, container
healthy) and verified live: **Mila** sees `Mila(you)` + `Lego(owner: Mila)`
with the `LIKES` edge and no foreign nodes; **Roman** sees only his own node
(his isolated `Lego` copy is not drawn) with zero edges and no `Mila` node;
admin `MATCH (e:Entity {name: "Lego"})` returns both owner copies — per-user
privacy for users, full visibility for the admin.

 ## Admin session + isolated mentions drawn dimmed (2026-10-05, PR #37)

 User report (as Roman, admin): asked the brain "tell me about all graph db
 entries of all graphdb users" — the brain answered with `Lego (thing)` but
 the panel showed only `Roman(you)`. Audit (read-only admin Cypher against the
 live DB) showed **no leak**: `Lego(owner: Mila)` + `Lego(owner: Roman)`, one
 edge `Mila:User -[:LIKES]-> Lego(owner: Mila)`. Roman's brain saw only his
 own copy (owner-scoped `list-my-knowledge`), which has no fact edge — so the
 panel (PR #34) hid it while the brain listed it. Two gaps, both fixed here:

 1. **No in-app admin view.** The only cross-user visibility was direct DB
    access. Now an `admin` login (name in both `USERS` and `ADMIN_USERS`,
    password = name like all users) sees the whole graph:
    - Panel: `visibleWorld(user, cap, userRows, admin)` — the admin's status
      and subgraph return every `:User` node and every owner-keyed `:Entity`
      (with the `owner` field) and all fact edges; centre mode accepts any
      node. Works even before the admin has a `:User` node of their own.
    - Brain: same four tools, but the backend injects `admin: true` into every
      MCP call (the flag is not in the brain's tool schema, so a non-admin
      call can never reach the cross-owner queries). `mcp/graph.mjs` gains
      admin `QUERIES` (`getEntityAll`, `listAllKnowledge`, `listAllFacts`)
      and per-owner formatters; the admin's system prompt gets an all-users
      line instead of the privacy line.
    - Activity feed: global for the admin.
    - `isAdmin()` is derived from the session against `ADMIN_USERS`
      (default `admin`) — never from client input.
 2. **Owned isolated mentions now drawn, dimmed.** PR #34 hid them; now the
    node shape is `{id, name, type, owner, isolated}` (every node is drawn;
    `isolated: true` marks an owned entity with no fact edge — never a
    `:User` node) and both views dim it (2D `fill-opacity 0.35`, 3D material
    opacity + label class). In the admin view, entity labels carry the owner
    suffix. Panel and brain `list-my-knowledge` now agree.

 Latent bug found and fixed while verifying live: **`direction(r)` is not a
 Cypher function in Neo4j 5.26** ("Unknown function 'direction'") — every
 `get-entity` call (user and admin variant) was a hard runtime error since
 the custom MCP shipped (PR #33); the unit tests pin query strings and the
 mock driver never executes them, so nothing caught it. Both queries now use
 `CASE WHEN e = startNode(r) THEN 'OUTGOING' ELSE 'INCOMING' END AS dir`
 (single undirected match, one row per relationship — verified live against
 real data), and `tests/mcp-graph.test.mjs` pins that no query may call
 `direction(`. Also fixed a null-safe centre filter in both stores' subgraph
 queries: with zero edges `r` is null and `type(r) <> 'KNOWS'` drops the row,
 so centring on an isolated node returned an empty view — now `r IS NULL OR
 (type(r) <> 'KNOWS' AND …)`.

 Tests: unit 99/99 (memory + neo4j-mock admin global views, isolated flag and
 dimming inputs, admin subgraph/centre queries, the null-safe centre pin,
 `mcp-graph` admin query pins + formatters + the `direction()` regression
 pin, admin integration test: global panel, `admin: true` in the tool calls,
 admin prompt line, global activity), browser 37 pass + 2 opt-in skips
 (fixture gains an isolated mention; both views assert it is drawn but
 dimmed).

 Deployed (backup `jarvis-code.bak-20261005_181329.tgz` +
 `.env.bak-20261005_181329`; `USERS=Mila,Roman,admin` added to the live
 `.env`; `graphdb.js`, `server.js`, `mcp/graph.mjs`, `public/app.js`,
 `public/graph3d.js`, `public/style.css`, the three test files and `README.md`
 synced, md5-verified, image rebuilt, container healthy) and verified live:
 **admin** panel shows the whole graph — `Mila`, `Roman`, `Lego(owner:
 Mila)`, `Lego(owner: Roman)` (isolated) and the single `LIKES` edge;
 **Roman** now sees `Roman` + his `Lego` (flagged isolated, drawn dimmed)
 with zero edges and no `Mila`; **Mila**'s world is unchanged. The user's
 exact question, asked as admin, answered with the per-user breakdown (Mila:
 likes Lego; Roman: owns the entity, no facts) and the activity feed recorded
 the admin's tool reads globally.

## PR #38 — explicit owner-scoped entity deletion (2026-10-05)

**Request (as Roman, admin):** "i see in graphdb 3d panel: Roman(you) and
greyed out Lego, lets remove Entity Lego" — the dimmed isolated mention
(PR #37) needs an explicit removal path. The brain's MCP tools stay strictly
read-only (pinned by test); deletion is an explicit panel action only.

**Design**

- `DELETE /api/graph/entity?id=<elementId>` (max 128 chars) — deletes by
  elementId, not by name, so exactly the clicked node is targeted. Cypher:
  user = `MATCH (e:Entity) WHERE elementId(e) = $id AND e.owner = $user
  WITH e.name AS name, e DETACH DELETE e RETURN name, 1 AS deleted`;
  admin = same without the owner pin. The `:Entity` label filter means
  `:User` nodes can never match; a foreign or absent id yields 0 rows →
  404 (no enumeration). `DETACH DELETE` also removes the entity's edges.
- Every removal is audited: `recordGraphActivity({ kind: "delete", user,
  name })`; the panel's activity feed renders it as "… · removed \<name\>".
- `/api/config` now returns `admin: isAdmin(req.user)` so the admin's
  global view can offer removal on any entity.
- `graphdb.removeEntity({ user, id, admin })` in both stores (Neo4j
  writeClient; memory store removes the node and its attached edges,
  never a `:User` node).
- Panel: a Remove button in the graph header, visible only when the centred
  node is a typed entity (entities have `type`; `:User` nodes have
  `type: null`) and the viewer is its owner or an admin. Click → confirm
  dialog → DELETE → re-centre to latest and reload.
- `mcp/graph.mjs` exports `TOOLS`; the test pins the surface to the four
  read tools and rejects any write/delete/create/update tool name.

**Tests**

- Unit 103/103 (99 + 4): memory-store `removeEntity` (own entity + edges
  gone, freed neighbour becomes isolated, foreign id no-op, `:User` never
  deletable, admin deletes any, re-delete no-op); neo4j-mock pin (owner-
  pinned `DETACH DELETE`, admin variant unpinned, empty result →
  `{deleted: 0, name: null}`); integration "the panel's explicit delete
  removes only the caller's own entity" (200 own, 404 foreign + survives,
  404 `:User`, admin deletes any, 400 missing id, audit entries,
  `/api/config` admin flag); MCP read-only surface pin.
- Browser 38 pass + 2 opt-in skips (37 + 1): "the Remove button deletes
  the centred entity and refreshes the panel" — clicks the real button,
  accepts the confirm, waits for the re-render (MutationObserver on the
  SVG; status text alone is ambiguous between centres), and asserts the
  entity is gone, the neighbour list shrank, and the mock DELETE ran once.

**Also fixed in the docs:** the stale "What it does" bullet that still
described the official `neo4j-mcp` with `read-cypher` and a shared
knowledge base (pre-#33 wording).

**Deploy**

- Backup `jarvis-code.bak-20261005_190048.tgz`; `.env` untouched
  (`USERS=Mila,Roman,admin` already in place since #37).
- Synced: `graphdb.js server.js README.md public/app.js
  public/index.html mcp/graph.mjs tests/graph.test.mjs
  tests/graph.browser.mjs tests/mcp-graph.test.mjs`.
- Rebuilt: `docker compose -f docker-compose.yml up -d --build jarvis`;
  container md5 == worktree for all five runtime files;
  `/api/health` `{"status":"ok"}`.

**Live verification (in-container, live Neo4j)**

- The delete Cypher was validated against scratch entities first (owner-
  pin rejects the wrong owner with 0 rows, deletes for the right owner,
  idempotent, admin variant deletes any, `:User` ids never match).
- **Roman deleted his isolated `Lego` through the real endpoint (200,
  `deleted: 1`)** — the user's exact request; his panel then showed only
  `Roman(you)` with zero links, the status counts followed, and the
  activity feed carried the audit entry.
- Roman deleting Mila's `Lego` → 404 and it survives; deleting a `:User`
  node → 404; missing id → 400; Mila's world unchanged; the admin's
  global view shows the three remaining nodes.
- Note: at verification time the entity had since picked up a fact edge
  from user chat activity in between (so it was correctly no longer
  flagged isolated — the API reflected the live state); the delete removed
  the entity with its edge. The isolated-flag behaviour is proven
  separately by recreating the original state exactly (flag: true).
- Final DB state: `Mila:User`, `Roman:User`, `Lego(thing, owner: Mila,
  mention_count 11)`, one edge `Mila:User -[:LIKES]-> Lego(owner: Mila)`.

## Honest ingest feed: user-account mentions are not entities (2026-10-05, PR #39)

**Report (as Roman):** the activity feed showed "20:11:28 · stored 1 entity"
but no new entity appeared in the 3D panel.

**Root cause (live forensics):** the DB held only the three known nodes
(Mila:User, Roman:User, Lego(owner: Mila)) — no new entity, no delete after
19:08 (feed audit), Neo4j up 23 h (no restart), and the container log showed
`graph_ingest_success {entities: 1, relations: 0}` for exactly that turn. The
only code path where `upsertTurn` succeeds while creating zero `:Entity`
nodes is an extracted entity **named after a registered user** (Mila/Roman/
admin) — by design (documented in README) that person is their `:User`
account node, never an entity, so the store correctly wrote nothing (and
with `relations: 0` no account marker is pulled into the panel either). The
bug was the *report*: the activity feed and the log counted
`extraction.entities.length` (what the extractor *emitted*), not what the
write *stored* — so a turn that only named a person read "stored 1 entity"
while nothing was stored.

**Fix**

- `server.js` `ingestTurn`: uses the store's return value
  (`{ upserted, relations: linked }`, both stores already returned it) — the
  activity entry now carries `entities: upserted, relations: linked,
  skippedUsers: extracted - upserted`; the log records `extracted` vs
  `stored` plus `skippedUsers` for the same reason.
- `public/app.js`: the feed line is computed by `ingestLine()` — stored
  entities/links as before, but a turn that stored only user mentions reads
  "N user-account mention(s) — nothing stored as an entity" (links-only
  turns read "updated N link(s)"; "no new graph data" as the last resort)
  instead of "stored 0 entities".

**Tests:** unit **105/105** (103 + 2: memory store — a mention of a
registered user stores nothing and reports `{upserted: 0, relations: 0}`
with the user's world unchanged; integration — a turn whose extraction only
names another registered user stores nothing, the activity entry reports
`entities: 0, relations: 0, skippedUsers: 1`, and the panel is unchanged).
Browser **38 pass + 2 opt-in skips** (activity fixture gained the
0-stored/2-skipped entry; asserts the "2 user-account mentions — nothing
stored as an entity" line).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_202834.tgz`; synced
`server.js`, `public/app.js`, `tests/graph.test.mjs`, `tests/graph.browser.mjs`
(+ docs), md5-verified, image rebuilt, container healthy, `/api/health` ok.
The user's live DB is untouched by this change (no data migration needed —
nothing was ever lost; the "stored 1 entity" turn simply stored nothing by
design).

## Auto-created relation types (2026-10-05, PR #40)

**Report (as Roman):** "warum ist interessiere mich als like gespeichert" —
"I'm interested in Home Assistant" was stored as `LIKES`, because the brain
answered that LIKES was the only relation type the graph had (interest was
forced into the closest existing type).

**Design (user request):** connectors should create the relation type
automatically when it does not exist yet — "I'm interested in X" gets
`INTERESTED_IN`, not `LIKES`.

**Changes**

- `graphdb.js`:
  - `normalizeRelationType()` + `isRelationType()` replace the allowlist
    check in `parseExtraction`: known types pass through; a well-formed new
    type (UPPER_SNAKE_CASE, ≤ 3 words, ≤ 24 chars, never the reserved
    `KNOWS`) is accepted as-is; malformed prose still falls back to
    `RELATED_TO` so the fact itself is never lost.
  - Both ingestion gates (Neo4j + memory store) use `isRelationType`
    instead of `RELATION_TYPES.has`. Neo4j creates the type on first use —
    the MERGE carries the new name verbatim (`MERGE (a)-[r:INTERESTED_IN]->(b)`,
    type validated to `[A-Z][A-Z0-9_]*`, so no injection), no migration and
    no registry update. The schema (distinct types from the store), the
    panel labels (`relLabel.js` plain-word fallback: "interested in" /
    "not interested in") and the brain's fact formatting are all
    type-agnostic and pick new types up automatically.
- `server.js` `EXTRACT_SYSTEM_PROMPT`: prefers the 14 known types, but a
  genuine relation none of them expresses gets a precise new type of at
  most 3 words (with the "I'm interested in X" → `INTERESTED_IN` example);
  explicit rules: never paraphrase an existing type (liking/preference/taste
  stay `LIKES`; "interested in" is NOT liking), never invent a type for
  negation (that is the `negative` flag).

**Tests:** unit **109/109** (105 + 4: parseExtraction introduced types —
`interested_in` → `INTERESTED_IN`, `PLANNING TO VISIT` → `PLANNING_TO_VISIT`,
5-word prose + `KNOWS` → `RELATED_TO`; memory store — introduced type stored
under its own name, schema picks it up, malformed type dropped; neo4j mock —
introduced-type MERGE pin (name verbatim, owner-scoped endpoints) and
malformed types dropped before any query; integration — an introduced type
created on the fly end-to-end: the edge appears under the new type, the
entity lands in the user's world, the schema lists the type). Browser
**38 pass + 2 opt-in skips** (fixture gained an `INTERESTED_IN` edge; both
views assert the plain-word fallback label "interested in").

**Deploy + live verification:** backup `jarvis-code.bak-20261005_205746.tgz`; synced
`graphdb.js`, `server.js`, `tests/graph.test.mjs`, `tests/graph.browser.mjs`
(+ docs), md5-verified, image rebuilt, container healthy, `/api/health` ok. Live data fix (one-off, admin Cypher): the
reported edge `Roman:User -[:LIKES]-> Home Assistant(owner: Roman)` re-typed
to `INTERESTED_IN` (props `last_seen`/`negative` copied, original edge
deleted). Then a live chat turn as Roman with the interest statement — the
real extraction LLM emitted `INTERESTED_IN` (log: `extractedRelations: 1,
linked: 1`), the DB holds exactly one `Roman -[:INTERESTED_IN]-> Home
Assistant(owner: Roman)` edge (the MERGE matched the re-typed edge, no
duplicate), the panel subgraph carries it (label "interested in" via the
fallback), the schema lists `INTERESTED_IN`, and the brain's own answer read
"you're already linked as **interested in** Home Assistant".

## Graph size sliders: entity size + link text, live in 2D and 3D (2026-10-05, PR #41)

**Request (user):** "lets make 2 slider for the size of Entities and link
Text size to adjust live for 2d and 3d graph panel" — two sliders under the
Knowledge graph panel head, **Entities** (node size and node names) and
**Link text** (edge labels), 50%–200% in 10% steps, adjusting the open view
live and persisting per browser.

**Changes**

- `public/index.html`: the panel section carries `id="graphPanel"` (the
  scope for the scale custom properties); new `.graph-controls` row between
  the head and the body with the two `<input type="range">` sliders
  (`#graphNodeSize`, `#graphTextSize`, min 50 / max 200 / step 10 / value
  100), each with a `<label>` + `<output>` percentage readout, plus a help
  line (`#graphControlsHelp`).
- `public/style.css`:
  - `.graph-canvas .edge-label` font-size is
    `calc(9px * var(--graph-text-scale, 1))` (2D link text).
  - `.graph-3d-labels span` is `calc(10px * var(--graph-node-scale, 1))`
    (3D node names follow the **Entities** slider) and `span.edge` is
    `calc(8px * var(--graph-text-scale, 1))` (3D link text).
  - The scales are set as inline custom properties on `#graphPanel`, so
    both the SVG and the projected DOM label layer inherit them — a slider
    drag re-scales the open 3D label layer with no scene work.
  - `.graph-controls` / `.graph-controls-help` styling (compact row, 120 px
    sliders, muted text).
- `public/app.js`:
  - `graphScales = { node, text }` (1 = 100%) + `applyGraphScales()`: sets
    the two CSS custom properties on `#graphPanel`, updates the `<output>`
    readouts, calls `graph3d.setNodeScale(node)`, and re-renders the 2D
    view when it is the visible one (the 2D layout is deterministic — fixed
    90-step simulation, no randomness — so re-rendering on input does not
    move nodes).
  - `onGraphScaleInput()` reads both sliders, persists
    `localStorage["jarvis.graphSizes"] = {node, text}` and applies; plain
    `input` listeners, no debounce (the work is one style pass + one SVG
    re-render at most).
  - `renderGraph()`: circle `r` is `9 * node` for the `:User` node and
    `7 * node` for entities; the node-name font (`10 * node`) and its
    offset above the node (`11 * node`) track the slider.
  - `setGraphView()` passes `nodeScale: graphScales.node` into
    `createGraph3D(...)` so a lazily created 3D scene starts at the right
    scale.
  - Init: the persisted values are restored (50–200 clamped) **before**
    `setGraphView("3d")`, so the first render already uses them.
- `public/graph3d.js`:
  - `createGraph3D(..., { nodeScale = 1 })`; every node entry keeps its
    `baseScale` (1.7 typed / 2.7 `:User`) and its sphere scale is
    `baseScale * nodeScaleFactor`.
  - `setNodeScale(scale)` rescales all spheres in place — the settled
    layout keeps its positions, so the view does not jump.

**Tests:** unit **109/109** (unchanged — the feature is client-side).
Browser **39 pass + 2 opt-in skips** (+1: "the size sliders scale the
entities and link text live in both views" — 2D: entity radius 7→14 and
`:User` 9→18 at 200%, node-name font 10→20, edge labels 9px→18px only via
the text slider; 3D: projected node labels 20px→10px tracking the entity
slider live, edge labels 16px at 200%; persistence across reload).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_212603.tgz`;
synced `public/app.js`, `public/graph3d.js`, `public/index.html`,
`public/style.css`, `tests/graph.browser.mjs` (+ docs), md5-verified against
the worktree, image rebuilt, container healthy, `/api/health` ok, served
`app.js`/`style.css`/`index.html` md5 match the source.

## Live web search + news for the brain (2026-10-05, PR #42)

**Report (as Roman):** "suche im internet über letzte news zu meinen
Interessen" → the brain answered it had "no active web-search tool" and that
the results it had gotten were "general, not specific to my interest".

Two separate gaps, found by inspection + a live probe:

1. **The brain could not steer the search at all.** Web search ran once,
   server-side, with the *raw user prompt* ("suche im internet über letzte
   news zu meinen Interessen") as the query — a meta-prompt, so the engines
   returned generic pages. The brain saw those results but had no way to
   re-query with a concrete topic ("Home Assistant news 2026"). The graph
   already had a tool loop for exactly this; web search did not.
2. **The measured engines were partly dead from the production IP.** A probe
   run from inside the live jarvis container (the real egress IP) on
   2026-10-05:
   - DuckDuckGo HTML **and** the DuckDuckGo Instant Answer API: `fetch failed`
     (connection-level refusal) — both dead from this IP, which is why the
     merged payloads were small (~1.4 KB = Bing + Wikipedia only).
   - GDELT doc API: timed out.
   - Bing HTML, Wikipedia API: ok.
   - **Bing News RSS** (`/news/search?q=…&format=rss`): ok, ~11 items. Its
     `bing.com/news/apiclick.aspx?…` links are **real HTTP redirects** —
     `fetch(redirect:"follow")` lands on the actual article (verified:
     borncity.com / heise.de / notebookcheck.com).
   - **Google News RSS** (`/rss/search?q=… when:7d`): ok, 38–51 items, but
     its `news.google.com/rss/articles/…` links are **JS-only wrappers**:
     the 200 page is an Angular app shell with no server-side redirect and no
     anchor to the article (verified: 594 KB page, `location.href`/meta-
     refresh absent, the `CBMi…` token no longer embeds the URL in its
     base64). Unresolvable server-side.
   - Interest feeds all reachable without a bot wall: heise (150 items),
     Golem (40), Ars Technica (20), The Verge (10), TechCrunch (20), CNBC
     (30), MarketWatch (10), Financial Times (11), Hacker News front page
     (20), Lobsters (25), r/programming (25). (heise-security feed 404s —
     dropped; hnrss.org `frontend?points` variant times out — dropped,
     `frontpage` works.)

**Design**

- **`mcp/websearch.mjs` — new `web_news` tool** (besides `web_search`),
  `serverInfo` bump 1.1.0 → 1.2.0. `web_news({topic, max_results})`:
  - `topic` is either a free topic (e.g. "Home Assistant") or an interest
    area: **technik, it, finance, geek, nerd** (spelling aliases in
    `normalizeTopic`, e.g. "Finanzen" → finance, "Informatik" → it).
  - Free topic: **Bing News RSS primary**; **Google News RSS backup** that
    only fills slots the primary left empty (its wrapper URLs are unusable
    in the Answer panel, so it never leads). Interest area: the curated
    feeds from `INTEREST_FEEDS` (below) + a Bing News RSS search for the
    area.
  - All sources fetched in parallel; each degrades to zero items on failure.
  - **Bing `apiclick.aspx` links are resolved server-side** (`fetch` with
    `redirect:"follow"`, body cancelled, 5 s cap; a failed resolution keeps
    the wrapper). Resolution happens **before dedupe** so the same article
    via two wrappers merges on its real URL.
  - `lang` (de/en) is injected by the backend per call — not in the brain's
    tool schema — and steers the Google News locale (`hl=de&gl=DE&ceid=DE:de`)
    and the area query language.
- **`mcp/engines.mjs` — pure news helpers** (no network, unit-tested):
  `INTEREST_FEEDS` (the five interest areas → verified-reachable feeds),
  `normalizeTopic`, `parseFeedItems` (RSS 2.0 `<item>` **and** Atom
  `<entry>`, CDATA unwrapped, markup stripped, linkless items skipped,
  pubDate/published/updated → epoch ms), `formatNewsItems` (newest first,
  numbered, source + ISO date + URL + snippet).
- **`server.js` — the web tool loop.** `runBrain` is generalized: it takes
  `webTools` + `lang` and offers the brain `web_search` + `web_news`
  (function tools, same shape as the graph tools) when the web-search toggle
  is on — sharing the graph's five-round budget when both toggles are on.
  The answer language is injected per call (`{ ...args, lang }`), like the
  graph user, so a prompt injection cannot steer the locale. Tool results
  are logged (`websearch_tool` with tool, topic/query, ok, ms, chars) and
  collected into `webResults`, which joins the up-front search results and
  is passed to post-turn ingestion (the extractor now reads what the turn
  actually used, not just the raw-prompt search). The ON state line tells
  the brain it may call both tools and to use `web_news` (one interest at a
  time, concrete topic) for any "latest news" question — including the
  user's interests from the graph or the conversation.

**Tests:** unit **114/114** (109 + 5: parseFeedItems RSS+Atom/CDATA/linkless,
normalizeTopic aliases, INTEREST_FEEDS shape, formatNewsItems newest-first,
cleanHtml `&apos;`; the server web-tool-loop test pins that the brain is
offered both tools, a `web_news` round returns the MCP result, and the
backend injected `lang:"de"`). Browser **39 pass + 2 opt-in skips**
(unchanged — no UI change).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_221451.tgz`; synced
`mcp/websearch.mjs`, `mcp/engines.mjs`, `server.js`, `tests/mcp.test.mjs`,
`tests/server.test.mjs` (+ docs), md5-verified, image rebuilt, container
healthy, `/api/health` ok. Live MCP smoke from the production IP: `web_news`
"Home Assistant" (de) → fresh Bing News items with **resolved direct article
URLs** (borncity.com, heise.de); "technik" → heise; "finance" → CNBC/
MarketWatch. (Google News wrapper links are not resolved — see design; they
only appear as backup fill.)

## Search requests look like a normal browser user (2026-10-05, PR #43)

**Request:** make the web-search requests look like a normal browser user
request, so they are not blocked as a bot/AI agent.

**Findings (re-probe from the production IP, a few hours after the PR #42
probe):**

- **DuckDuckGo is intermittent, not banned.** The PR #42 probe got a
  connection-level failure (`fetch failed`); the re-probe got **HTTP 200 with
  real results** (12 parseable result links) on both `html.duckduckgo.com`
  and the instant-answer API. This is a rate limit against datacenter IPs
  that clears again, not a permanent block — which is why the DDG fetch keeps
  its one retry and degrades to zero instead of failing the search.
- **A bare user-agent is the classic bot tell.** Real Chrome sends a full
  header set (`Accept`, `Accept-Language`, `sec-ch-ua*`, `Sec-Fetch-*`,
  `Upgrade-Insecure-Requests`, `Priority`). The measured effect from the
  production IP: no change for an already-accepted request (DDG 33.6 KB with
  UA only vs 33.4 KB with the full set), but it is the shape of a normal
  user request, and it is what keeps datacenter traffic from standing out.
- **`Accept-Language` is the practical win.** With
  `Accept-Language: de-DE,de;q=0.9,…` the same German query returns German
  results (verified: top DuckDuckGo hits for "home assistant" switched from
  English-leaning to German pages). Previously only the user-agent was sent,
  so the locale fell back to the engine default.

**Changes:**

- `mcp/engines.mjs` — new pure helper `browserHeaders(lang, navigation)`
  (unit-tested, no network): the Chrome user-agent plus `sec-ch-ua`,
  `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `Sec-Fetch-Dest/Mode/Site`,
  `Priority`, `Accept-Encoding` and a language-aware `Accept-Language`
  (`de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7` vs `en-US,en;q=0.9`).
  `navigation=true` adds the document-load headers (`Accept: text/html…`,
  `Sec-Fetch-User: ?1`, `Upgrade-Insecure-Requests: 1`, `Priority: u=0,i`)
  for the search pages; `navigation=false` is the subresource shape
  (`Accept: */*`) for RSS fetches and redirect resolution.
- `mcp/websearch.mjs` (serverInfo 1.2.0 → 1.3.0) — every HTML search-engine
  fetch (DuckDuckGo HTML, Bing HTML) and every news fetch (Bing News RSS,
  Google News RSS, Bing `apiclick.aspx` redirect resolution) now uses the
  full browser header set with the answer language; the `lang` the backend
  injects per call is threaded through `searchWeb` → the engine functions and
  through `searchNews` → the redirect resolution. Feed/API endpoints
  (interest feeds, Wikipedia API, DuckDuckGo instant API) keep the
  descriptive `Jarvis/1.0` user-agent — that is how RSS readers and API
  clients identify themselves, and those endpoints already work.
- The stale header note ("DuckDuckGo unreachable") was corrected to
  "intermittent rate limiting".

**Tests:** unit **115/115** (114 + 1: the header set for de-navigation and
en-subresource — user-agent shape, both `Accept-Language` variants, the
sec-ch-ua/sec-fetch split, and the navigation-only headers); browser
**39 pass + 2 opt-in skips** (unchanged, no UI change).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_223837.tgz`; synced
`mcp/engines.mjs`, `mcp/websearch.mjs`, `tests/mcp.test.mjs` (+ docs),
md5-verified (container == worktree), image rebuilt, container healthy,
`/api/health` ok. Live: `web_search("Home Assistant News", lang:"de")`
returns DuckDuckGo + Bing + Wikipedia merged, with Bing now answering
German-localized results (athome.at, home24.at) via the language-aware
`Accept-Language`; the end-to-end chat as Roman ("letzte news zu meinen
Interessen") still resolves the Home Assistant interest from the graph,
calls `web_news` (log: `websearch_tool tool=web_news ok=true`) and answers
with dated German HA news.

## Storing save/track instructions as WATCHES facts (2026-10-05, PR #44)

**Report (as Roman):** "Add to my trading news list keywords: Trump btcusd
gold silver nvidia" → the brain answered it had "no way to store keywords
in the knowledge graph — I can only read, not write", and the graph indeed
stayed unchanged (verified in Neo4j: Roman's only entity was "Home
Assistant").

**Root cause (three layers, all in the prompts — no code bug):**
1. By design the brain's tools are read-only (a prompt-injected brain must
   never write); the only write path is the **post-turn ingestion** — a
   cheap structured extraction call over prompt + search results + answer,
   run after the answer is delivered.
2. The extraction prompt only taught **first-person fact statements**
   ("I like X" → LIKES, "I'm interested in X" → INTERESTED_IN, …). Roman's
   message was an **imperative instruction** ("Add … to my trading news
   list"), which no rule covered — and the brain's own answer ("I can't
   store …") reinforced the "no facts in this turn" reading. Log:
   `graph_ingest_empty` for the turn.
3. The brain's system prompt never told it that what the user says is
   stored automatically after every answer — so it answered "I can only
   read, not write" (true for its tools, wrong for the product).

**Changes (all `server.js` prompts + tests):**
- `EXTRACT_SYSTEM_PROMPT`: new rule — instructions to save/remember/track/
  add topics ("add X, Y to my (trading) news list", "remember these
  keywords: X, Y", "track/watch X") are facts to store: a `WATCHES`
  relation from the user to each listed topic (stored even though the
  prompt is an instruction, including when the answer only confirms it),
  with a full JSON example (Roman + Trump/Gold/Nvidia). `WATCHES` (and
  `INTERESTED_IN`) joined the "prefer the existing types" hint — the type
  is auto-created by the schema (PR #40), so no registry change.
- Brain graph state lines (non-admin with context, non-admin empty, admin):
  "Your graph tools are read-only, but the graph is updated automatically
  after every answer from the conversation — so when the user asks you to
  save, remember or track topics (e.g. 'add X to my trading news list'),
  confirm that it is done instead of claiming you cannot write; the topics
  are stored (as WATCHES facts) and visible in the graph context and the
  list-my-facts tool from the next turn on."
- The web-search ON line now names the stored topics: "including about the
  user's interests and their stored topics (the WATCHES facts from the
  knowledge graph, e.g. a trading news list the user asked to track)".
- `tests/server.test.mjs`: the graph-ingest mock answers a "trading news
  list" extraction with a WATCHES extraction; new test pins the end-to-end
  path (turn → 2 WATCHES edges + both topic nodes stored, the extraction
  prompt the production LLM reads contains the WATCHES rule, and the next
  turn's brain prompt contains the auto-save/confirm guidance). A new
  `lastBrain` capture (last non-extraction brain request) avoids racing the
  fire-and-forget ingestion, which calls the same upstream endpoint after
  the answer is sent.

**Tests:** unit **116/116** (115 + 1: the WATCHES end-to-end test); browser
**39 pass + 2 opt-in skips** (unchanged, no UI change).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_231109.tgz`; synced
`server.js`, `tests/server.test.mjs` (+ docs), md5-verified (container ==
worktree), image rebuilt, container healthy, `/api/health` ok. Live
regression as Roman, both turns: (1) the exact prompt from the report —
"Add to my trading news list keywords: Trump btcusd gold silver nvidia" —
now gets a confirmation answer, and ingestion stored all five topics
(`graph_ingest_success extracted=6 stored=5 extractedRelations=5 linked=5`:
Trump/person, BTCUSD/topic, Gold/topic, Silver/topic, Nvidia/organization,
each `Roman -[:WATCHES]->` — verified in Neo4j); (2) "Gib mir die letzten
News zu meinen Trading-Themen" — the brain read the stored topics from its
graph context and called `web_news` once per topic (log: five
`websearch_tool tool=web_news ok=true` lines for Trump, BTCUSD, Gold,
Silver, Nvidia) and answered with fresh per-topic German trading news
(Trump midterms/EU diesel reserves, BTCUSD at the 87k resistance, Gold
China buying/JPMorgan $4.500, Silver equities, Nvidia SpaceX/Microsoft).
The pre-PR failure mode (brain denying a write, graph unchanged) is gone.

## Named lists are graph entities (assign-to-list) (2026-10-05, PR #45)

**Report (as Roman):** "Assign Trumpn to my TradingMonitor List" → the
brain answered it had "assigned" Trump to the list, but the 3D graph view
showed no "TradingMonitor List" entity — only the keywords and their
WATCHES edges. Verified in Neo4j: the turn was `graph_ingest_empty`, the
list entity did not exist at all. The brain's "zugeordnet" was unbacked —
it confirmed an assignment the storage pass never made.

**Root cause:** the PR #44 extraction rule only covered "add/remember/track
topics" (→ WATCHES facts). "Assign X to my **named list** L" is a different
instruction: it needs the list itself as an entity and a membership edge.
No rule covered it, and the brain's "already stored / assigned" answer
again reinforced the "no facts in this turn" reading.

**Changes (all `server.js` prompts + tests):**
- `EXTRACT_SYSTEM_PROMPT`: new rule — named lists the user maintains
  ("my TradingMonitor List", "my news list") are stored as **thing
  entities with the exact name the user gave the list**;
  "assign/add/move X (and Y) to my L" → the list entity L, a **`PART_OF`**
  relation from each listed topic to L (PART_OF is an existing core type;
  the panel labels it "part of"), and the user's WATCHES relation to each
  topic (idempotent upsert). The list entity must appear in "entities"
  even when only mentioned in this turn. Full JSON example (Roman + Trump
  + TradingMonitor List).
- Brain lines: the auto-save/confirm sentence (non-admin with context,
  non-admin empty, admin) now names the list path ("…or assign them to a
  named list (e.g. 'assign X to my TradingMonitor list') … stored as
  WATCHES and PART_OF facts, a named list as its own entity"); the
  web-search ON line maps "news about my <list>" to the list's members via
  its PART_OF edges.
- `tests/server.test.mjs`: the graph-ingest mock gains a named-list
  extraction variant; new end-to-end test: "Assign Trump to my TradingMonitor
  List" stores the list entity (type thing) + the topic's PART_OF edge
  (source Trump → target TradingMonitor List) + the WATCHES fact; the
  extraction prompt pins the named-list rule; the next turn's brain prompt
  names the assign-to-list example and PART_OF.

**Tests:** unit **117/117** (116 + 1: the named-list end-to-end test);
browser **39 pass + 2 opt-in skips** (unchanged, no UI change).

**Deploy + live verification:** backup `jarvis-code.bak-20261005_233348.tgz`; synced
`server.js`, `tests/server.test.mjs` (+ docs), md5-verified (container ==
worktree), image rebuilt, container healthy, `/api/health` ok. Live as
Roman: the report prompt "Assign Trumpn to my TradingMonitor List" — the
brain first clarified the "Trumpn" typo (sensible), and on confirmation
("Ja, Trump. Bitte eintragen in meine TradingMonitor List") answered
"Erledigt … Ich habe Trump zu deiner TradingMonitor List hinzugefügt" and
ingestion stored it (`graph_ingest_success extracted=3 stored=2
extractedRelations=2 linked=2`: `TradingMonitor List (thing, owner: Roman)`
+ `Trump -[:PART_OF]-> TradingMonitor List`, the re-emitted WATCHES upserted
idempotently). The `/api/graph/subgraph` the 3D panel renders now includes
the `TradingMonitor List` node (not isolated — it carries an edge) with the
`Trump -[part of]-> TradingMonitor List` label — the node the user could
not see before the fix now exists and is drawn.

## 2026-10-06: dynamic graph entities never stored — the ingest extraction call was undersized for the reasoning model

Reported: the user asked Jarvis to track "Robinhood after hours" on the
TradingMonitor List, and the brain confirmed it, but no such entity appeared
in the live 2D/3D graph panel. The suspicion was that the panel's graph
query was too narrow to pick up dynamically created entities.

Root cause: the panel query was fine. `visibleWorld` in `graphdb.js` matches
**every** `:Entity {owner: $user}` (newest first, capped at the 60-node
default) plus every fact edge between them — a freshly stored entity has the
freshest `last_seen` and lands at the top of the draw set, and the panel
re-fetches on a 15 s poll (plus a 4 s refresh after a chat turn). The real
defect was upstream, in the **only write path**: the post-turn ingestion
extraction call in `server.js` still sent `max_tokens: 1200` to a reasoning
model. `deepseek-v4-flash` spends the whole budget on thinking tokens, so the
JSON reply came back as `content: null` (or a JSON object truncated at 16
chars) and `parseExtraction` found nothing. Live logs from vm104 showed
**every** `/api/chat` turn since 2026-10-05 21:35Z ending in
`graph_ingest_empty` with `content: null` + a `reasoning` field in the raw
brain response — while the main chat path had already been raised to
`max_tokens: 4096` for exactly this failure class ("Wetter Wien", 2026-10-04).
The graph's Neo4j state confirmed it: Roman's newest entity was `TradingMonitor
List` at 2026-10-05 21:35Z; no Robinhood/NVDA/after-hours node existed at all.
The brain's "the link is in your list" was answered from the stored list
entity, not from a stored Robinhood fact.

Fix (same as the chat path, plus the matching timeout):

- `server.js` `ingestTurn`: extraction request `max_tokens: 1200` -> `4096`,
  and its abort `AbortSignal.timeout(30000)` -> `45000` — a full 4096-token
  budget can be ~27 s of pure reasoning at the measured ~150 tok/s, so 30 s
  would race the extraction. Fire-and-forget, so the longer deadline never
  blocks the user's reply.
- `tests/server.test.mjs`: the end-to-end ingest test now also asserts the
  extraction request (the last upstream call of the turn) carries a
  reasoning-safe budget (`max_tokens >= 4096`) — the regression that let this
  ship.

**Tests:** unit **117/117** (the ingest end-to-end test now carries the
budget assertion).

**Deploy + live verification:** backup `jarvis-code.bak-20261006_103103.tgz`;
synced `server.js` + `tests/server.test.mjs`, image rebuilt, container
`healthy`, `/api/health` ok, the running `/app/server.js` carries the
4096/45000 values. Live as Roman: "Add Robinhood after hours to my
TradingMonitor List" -> brain confirmed, `graph_ingest_success extracted=3
stored=2 extractedRelations=2 linked=2`, and Neo4j now holds
`Robinhood after hours (topic, owner: Roman)` with
`Roman -[:WATCHES]-> Robinhood after hours -[:PART_OF]-> TradingMonitor
List`. The `/api/graph/subgraph?limit=60` the panel renders lists the node
plus both edges, so the 2D/3D view (15 s poll / 4 s post-turn refresh) picks
it up automatically — no panel query change was needed.

## 2026-10-06: admin session can write to the graph via MCP (store-entity / store-fact / delete-entity)

Requested: an `admin`/`admin` login whose session can also **write, delete and
read all users' graph data via the brain's MCP tools** — not just the
cross-owner reads the admin session already had. `admin` was already in the
live `USERS` (since PR #37) and in `ADMIN_USERS` (default), so the login
itself worked; the gap was the MCP surface: `mcp/graph.mjs` was read-only.

Changes:

- `server.js`: `USERS` default is now `Mila,Roman,admin` (a default
  deployment can actually log in as admin; a name in `ADMIN_USERS` that is
  not in `USERS` cannot sign in, as before). The `mcpGraph` child now also
  gets `NEO4J_WRITE_USER`/`NEO4J_WRITE_PASSWORD`. The admin brain is offered
  three extra tools — `store-entity(owner, name, type)`,
  `store-fact(owner, from, to, type, negative?)`, `delete-entity(owner, name)`
  — and the tool loop routes them to the graph MCP server **only for admin
  sessions**, injecting `{ ...args, user, admin, users: config.users }` per
  call (the spread order means a brain-supplied `user`/`admin`/`users` can
  never win). A non-admin brain asking for a write-tool name gets
  "Unknown tool" and the attempt is audited as a failed `brain_write`
  activity entry; successful writes are audited as `brain_write` too
  (`graphToolDetail` carries owner/from/to/type/negative, never Cypher).
- `mcp/graph.mjs`: the three tools are on the surface but **refused by the
  handler before any database access** unless the backend-injected
  `admin === true`; `owner` is validated against the backend-injected
  registered-user list (case-insensitive, canonicalised to the configured
  spelling), names/types are sanitised with the shared graphdb helpers,
  user-named fact endpoints resolve to their `:User` account nodes, a
  self-fact is refused, and a malformed relation type degrades to
  `RELATED_TO` (never lost, never an injection: the type is only
  interpolated after the `isRelationType` check). Writes run over a **second
  driver** opened only when `NEO4J_WRITE_USER` is set (the `jarvis_write`
  credentials; reads stay on `jarvis_read`). Semantics mirror the ingestion
  upserts: `MERGE (e:Entity {name, type, owner})` with `first_seen`/
  `last_seen`/`mention_count` bookkeeping, `MERGE (a)-[r:TYPE]->(b)` edge
  upsert, and a `DETACH DELETE` that matches `:Entity` only, pinned to
  `owner` — a `:User` account node can never be deleted.
- `graphdb.js`: `sanitizeName`/`normalizeRelationType` exported (single
  source of truth for the sanitisation both write paths use).
- `public/app.js`: the activity feed renders `brain_write` entries as
  "brain wrote <detail>" / "brain write failed <detail>".
- `.env.example` + `README.md`: `USERS=Mila,Roman,admin` + `ADMIN_USERS`,
  the admin account documented under Login, the write surface + double gate
  (backend offer/injection, MCP re-validation) under Knowledge graph.
- Tests: `tests/mcp-graph.test.mjs` (new surface pin: 4 read + 3 admin write
  tools, no free-form Cypher, no `admin`/`users` in the write schemas;
  `validateWriteTool` gate/owner/sanitisation/self-fact/type-degradation
  pins; `factQuery` pattern-pair + injection pins; write-query pins —
  owner-keyed MERGE, `:User` MERGE, `DETACH DELETE` `:Entity`-only),
  `tests/mock-graph-mcp.mjs` (echoes the write tools with the injected
  args), `tests/graph.test.mjs` (integration: the admin brain gets all
  seven tools and the write call reaches the MCP server with
  `user=admin, admin=true, users=[Mila, Roman, admin]` injected, the result
  feeds back to the brain, the feed shows a `brain_write` entry; a
  non-admin brain gets the four reads only and a forged write call is
  rejected as unknown before the MCP server sees it, audited as a failed
  write), `tests/graph.browser.mjs` (a `brain_write` feed entry renders as a
  write line).

**Tests:** unit **121/121**; browser **39 pass + 2 opt-in skips**.

**Deploy + live verification:** backup
`jarvis-code.bak-20261006_112627.tgz` (code only, `.env` untouched — the
live `USERS=Mila,Roman,admin` was already in place); synced `server.js`,
`graphdb.js`, `mcp/graph.mjs`, `public/app.js`, `.env.example`, `README.md`
+ the four test files, md5-verified against the worktree, image rebuilt,
container `healthy`, `/api/health` ok, served `app.js` md5 == worktree.
Live: `admin`/`admin` logs in, `/api/config` reports `admin: true`
(Mila: `false`); an in-container run of `mcp/graph.mjs` against the live
Neo4j showed the full write cycle — no-admin call refused, `store-entity`
+ `store-fact` landed (`DeployCheck… (place, owner: Roman)` +
`Roman -[:LIKES]->`), unregistered owner refused, `delete-entity` removed
node + links. Then through the app itself: as **admin**, one chat turn
("store the city DeployCheckLive as a place under Roman, then the LIKES
fact") — the brain called `store-entity` + `store-fact`, the live graph
showed the entity + `LIKES` edge, the global activity feed recorded both as
`brain_write` (`store-fact: owner=Roman, from=Roman, to=DeployCheckLive,
type=LIKES`), and the panel's `DELETE /api/graph/entity` (admin, cross-owner)
removed the test data again. Note: the same turn's **automatic ingestion**
also stored an `owner: admin` copy of the entity (ingestion is pinned to
the session user, as always) — expected, cleaned up as well; the admin's
first turn also created the `admin` `:User` account marker, like any
first-mentioned user.

## 2026-10-06: one entity per user per name — the type (and casing) no longer splits an entity into copies

Reported: Roman's panel showed the entity "BTCUSD" **twice**. The live
graph confirmed two same-named nodes under one owner — `BTCUSD (topic)`
and `BTCUSD (thing)` (and the same for `Robinhood after hours` /
`robinhood after hours`). Root cause: entities were keyed by
`(name, type, owner)` — the ingestion `MERGE (e:Entity {name, type, owner})`
created one node per type, so the same thing re-extracted with a different
type (or casing) in a later turn became a second node. The panel, the
brain context and the brain tools all read by owner, so every one of them
saw the twin.

Fix: entity identity is now **(name, owner), the name
case-insensitively** — the type is a property of the first stored copy, not
part of the key. The same user re-mentioning the same thing (any type, any
casing) always lands on the one existing node; the same name under another
owner is still a separate copy (ownership stays the isolation boundary).

- `graphdb.js` (Neo4j store): the ingestion upsert is now a
  `OPTIONAL MATCH (e:Entity {owner: $user}) WHERE toLower(e.name) =
  toLower(row.name)` + `FOREACH … CREATE` + `SET` (the MERGE-less upsert
  idiom) — no `MERGE (e:Entity {name, type, owner})` left anywhere; the
  fact-endpoint matches use the same `owner + toLower(name)` identity.
  `parseExtraction` dedupes per turn by lower-cased name (first occurrence
  wins) and drops case-variant self-relations. The memory store mirrors the
  key (case-insensitive name per owner; first copy's spelling+type kept).
- `mcp/graph.mjs`: `get-entity`/`get-entity` (admin) match
  `toLower(e.name)`; the admin write tools' `ensureEntity` uses the same
  MERGE-less upsert as the ingestion, `touchEntity`/`findEntity`/
  `delete-entity` match by `owner + toLower(name)`, and `store-fact`
  endpoint patterns do the same — plus a case-variant self-fact is refused
  (it would MERGE a self-loop).
- Tests: the upsert-cypher pins now assert the `OPTIONAL MATCH` +
  `toLower` key and explicitly reject a type-keyed `MERGE (e:Entity` (the
  "two BTCUSD" regression); new memory-store regression: the same name
  re-extracted with a different type/casing stays ONE node (first copy
  wins, facts to the variant resolve to it, per-owner copies unaffected);
  `parseExtraction` dedupe updated to the per-name rule; MCP write-query
  and fact-query pins updated; a case-variant self-fact is refused.

**Tests:** unit **122/122**; browser **39 pass + 2 opt-in skips**.

**Deploy + live verification:** backup
`jarvis-code.bak-20261006_114830.tgz` (code only, `.env` untouched); synced
`graphdb.js`, `mcp/graph.mjs`, `README.md` + the two test files
(md5-verified), image rebuilt, container `healthy`, `/api/health` ok.
One-off data migration (in-container, via the `neo4j` admin user,
`DETACH DELETE` of the younger copy per `(owner, lower(name))` group,
keeping the oldest `first_seen`): merged exactly the 2 reported pairs —
`BTCUSD (thing)` → `BTCUSD (topic)`, `robinhood after hours (thing)` →
`Robinhood after hours (topic)`; Roman's live subgraph now shows each once.
Then, live against the real Neo4j over the **new ingestion code path**
(`upsertTurn`): re-storing `BTCUSD` as `thing` left exactly one node (type
stayed `topic`); a fresh entity stored twice with different casing+type
stayed one node (first spelling+type kept); a fact to the case-variant
added one edge to the one node; test data removed via the admin delete.

## 2026-10-06: the admin rename leak — tool-call XML shown as the answer; rename-entity tool; no admin ingestion

Reported: the admin asked to rename "TradingMonitor List" to "Trading"
(Roman's list); the answer panel showed raw tool-call markup instead of an
answer — `<|tool_calls|><|invoke| name="list-my-facts"><|parameter|
name="relation" string="true">PART_OF<|/parameter|><|/invoke|><|/tool_calls|>`:
the brain's native tool-call XML leaked out as the answer text.

Root cause: the DeepSeek brain endpoint (behind an OpenAI-compatible proxy)
**intermittently** returns tool calls in the model's native XML format inside
the message `content` instead of the OpenAI `tool_calls` field. The backend
only looked at `tool_calls`, so in those rounds the XML was treated as the
final answer — rendered, spoken, and the call never executed. The activity
feed showed how fragile those turns were: the user's turn had performed a
real partial rename (`Robinhood after hours` → `Robinhood`) and then ended
in the leaked (never-executed) XML call; the follow-up turn made NO writes
yet the brain *claimed* the rename was done — and auto-ingestion of that
admin turn then materialised the hallucination as `owner=admin` copies plus
phantom edges (`TradingMonitor List RENAMED_TO Trading`) from the answer
text.

Fix (three parts):

- **Tool-call XML fallback** (`graphdb.js`): new `parseToolCallsFromContent`
  recovers OpenAI-shaped calls from the native XML — the `invoke`/`parameter`
  anchors with `name="..."` matched leniently (wrapper tokens vary between
  model builds), a gate that requires the `tool_calls` wrapper, or both an
  invoke and a parameter tag, so ordinary prose is never reinterpreted; max
  8 calls; values try `JSON.parse` then plain string. The `runBrain` tool
  loop falls back to it when `tool_calls` is empty and carries the parsed
  calls on the assistant turn, so the tool result's id stays protocol-valid
  for the next round. Parsed calls flow through the exact same path as
  native ones — same backend injection, same audit.
- **`rename-entity` admin tool** (`mcp/graph.mjs` + `server.js`): the brain
  had no rename primitive before, so it improvised delete+recreate+relink —
  a five-round-budget dance in which the old node survived and the links
  were lost. The new fourth admin write tool renames in place: `SET e.name`
  on the owner-pinned node — elementId, type and **every link survive**.
  Validated before any database access: `owner` is a registered user, `name`
  and `newName` are present and differ case-insensitively (a case variant is
  no rename), and `newName` is not a registered user's name; the handler
  additionally refuses a collision with an existing copy of the same owner
  (the `(name, owner)` key stays unique) and a missing old name. Audited in
  the global feed as `brain_write`.
- **Admin turns are no longer auto-ingested** (`server.js`): the admin is a
  service account for graph maintenance — ingesting its turns minted
  `owner=admin` copies of every user's entity it touched (the live graph
  showed four such copies plus the phantom edges after two turns). The admin
  now changes the graph only through its explicit, audited write tools. The
  admin system prompt was updated to match: `rename-entity` is documented as
  THE way to rename ("never delete+store"), and the "graph is updated
  automatically after every answer" line is replaced with the truth for
  admin sessions.

**Tests:** unit **127/127** (5 new: the parser unit — native XML recovered
as OpenAI-shaped calls, multi-call + typed values + missing wrapper tokens,
and ordinary prose never reinterpreted; the admin `rename-entity` surface,
routing with the injected args and audit; the XML fallback end-to-end — the
tool executes and the answer stays prose, with the parsed call riding on the
assistant turn; the admin no-ingestion — an admin turn mints no
`owner=admin` entities); browser **39 pass + 2 opt-in skips**.

**Deploy + live verification:** backup
`jarvis-code.bak-20261006_123614.tgz` (code only, `.env` untouched); synced
`server.js`, `graphdb.js`, `mcp/graph.mjs`, `README.md`, `DEPLOYMENT.md`
and the three test files (md5-verified), image rebuilt, container `healthy`,
`/api/health` ok. Live data cleanup + dogfooding: removed the orphaned
`Trading (Roman)` node the failed half-rename left behind and the four
`owner=admin` pollution entities (via the panel delete endpoint, admin
session), then ran the user's actual request through the **new
`rename-entity` tool** in an admin chat turn: `TradingMonitor List` →
`Trading` under Roman as one atomic call — the node kept its elementId and
all its links (`Roman OWNS Trading`, `Trump PART_OF Trading`,
`Robinhood PART_OF Trading`) came with it.

## 2026-10-06: the 3D panel kept a stale node name after a rename

Reported: after the admin renamed an entity (e.g. `Trading` → `Trading
Monitoring`), the 3D knowledge-graph panel showed no change — the sphere kept
its old caption. The data was correct (the API, the 2D view, the status
counts and the activity feed all showed the new name); only the 3D label was
stale.

Root cause: `rename-entity` changes the node's `name` but keeps the same
`elementId` (that is how its links survive). The 3D view (`public/graph3d.js`)
diffs each poll against the live scene **by `elementId`** to keep node
positions stable, and for a surviving node it refreshed the mesh colour,
opacity and `isolated` flag — but the label text was set exactly once, in
`makeLabel()` at node creation, and `update()` never re-read it. So a
renamed node kept its first-rendered caption forever. The 2D view was
unaffected (it rebuilds its SVG from scratch on every poll).

Fix: extract the label text into `labelText(node)` (name + owner suffix + the
`(you)` marker, re-derived from the current subgraph row) and, in `update()`,
refresh a surviving node's label text (diffed, like the edge labels) plus its
`user` class on every poll — so the 3D caption tracks the data instead of the
first render.

**Tests:** new browser regression "the 3D view: a rename (same elementId, new
name) re-labels the node live" — a node renamed in place gets its caption
updated on the next refresh and no twin node is spawned. Browser **40 pass +
2 opt-in skips**; unit **127/127** (unchanged).

**Deploy:** backup `jarvis-code.bak-20261006_130301.tgz` (code only, `.env`
untouched); synced `public/graph3d.js` + `tests/graph.browser.mjs`
(md5-verified), image rebuilt, container `healthy`, `/api/health` ok, and the
served `graph3d.js` md5 matches the source. Static asset changed → a browser
hard refresh (Ctrl+Shift+R) is needed to pick up the new `graph3d.js`.

## 2026-10-06: full-size knowledge-graph page with whole-graph fuzzy search

The panel head's **Full view ↗** link opened `/graph.html` in its own tab:
the same 3D/2D renderers filling the viewport (150% default entity/link-text
sizes, persisted under `jarvis.graphSizes.full` so the panel's sliders are
untouched), a signed-in account chip in the head bar, and a search row whose
results run **server-side against the whole graph** — a Neo4j full-text
(Lucene) index over `(name, owner)` created idempotently at startup
(`ensureIndexes()` in `graphdb.js`, plus the owner/last-seen indexes the
panel reads need), so search stays index-time at millions of nodes. Query
tokens AND-match; within a token exact outranks prefix outranks fuzzy (edit
distance grows with token length), so typos and casing are forgiven; relation
types are matched in JS against the bounded token-store type list (`KNOWS`
never emittable). The owner is a required Lucene term for non-admin sessions
(re-checked server-side), the admin searches the whole graph, results are
paged and the drawn window is not (60 nodes). Typing highlights the hits in
the drawn window in both views (everything else fades); narrowing to exactly
one entity moves the 3D camera onto it live (`setFocus()` re-reads the node's
position every frame; a lone hit outside the window is fetched first), and
picking a paged result re-centres on its neighbourhood. The 2D renderer was
extracted from `app.js` into `public/graph2d.js` (shared by panel and page);
`public/graph.html` + `public/graph-page.js` are new. Unit tests: Lucene
escaping/owner term, relation-type matching, memory-store fuzzy search,
Neo4j index-backed owner-pinned bounded query.

Rolled out to vm104 with the file-copy + `docker compose up -d --build`
procedure. Files synced: `server.js`, `graphdb.js`, `public/app.js`,
`public/index.html`, `public/style.css`, `public/graph3d.js`, `public/graph.html`,
`public/graph-page.js`, `public/graph2d.js`, `tests/`. Verified against the
running container: container `healthy`, `/api/health` ok, served files
md5-matched the source. The user then reported issues on the live page
(panels overlapping, no single-hit centring, no account shown, and clearing
the search not restoring the initial objects), each fixed and rolled out the
same day — see the following section.

## 2026-10-06: full-size graph page — panels overlapped, single hit not centred, no account shown

The full-size knowledge-graph page (`/graph.html`, its own tab opened from the
app's **Full view ↗** link) shipped the same day earlier: the 2D/3D renderers
plus a server-side fuzzy search (`/api/graph/search`, Lucene full-text index in
`graphdb.js`) that covers the whole graph, not just the drawn window. Typing
highlights the hits in the drawing (dimming the rest) — that part was right.
Three things were wrong:

1. **The panels overlapped vertically.** The body grid declared
   `grid-template-rows: auto minmax(0, 1fr) auto` — three rows for four
   children (head, search row, stage, hint). The search row landed in the
   `1fr` track and the stage in an `auto` track. In a short window (e.g.
   844×390) the 1fr track collapsed to zero, the search input overflowed its
   zero-height row and painted over the head's controls row and the stage —
   the reported "three panels overlapping". In a tall window the same bug
   showed as a stretched empty gap under the search field. Fixed by the
   four-row template `auto auto minmax(0, 1fr) auto`: head, search and hint
   take their natural height and the stage gets the rest (and may shrink to
   fit, never pushing the others off-screen).
2. **A lone search hit was not centred.** Narrowing the query to exactly one
   entity now also moves the 3D camera onto that node, live: `setFocus(id)` in
   `graph3d.js` points `orbit.centerTarget` at the node's position every frame
   (the layout keeps moving it, so the follow is per-frame, not a one-off
   recentre) and `applyMatchHighlight()` in `graph-page.js` calls it with the
   single match. A lone hit outside the drawn window is fetched first
   (`loadGraph`) so the camera has something to follow; re-typing the same
   query does not refetch (`focusLoadedFor` guard).
3. **The signed-in account was not shown.** `graph-page.js` already wrote the
   config's user into `#graphUser`, but `graph.html` had no such element (the
   page would have thrown on load). Added the element to the head bar plus a
   small `.graph-user` chip (empty/hidden when signed out).

**Tests:** two new browser regressions in `tests/graph.browser.mjs` — the
short-viewport page stacks head/search/stage/hint with no overlap, the search
field never collapses and `#graphUser` shows the account; and a lone search
hit stays highlighted, dims everything else and ends up centred in the live
3D view (within a quarter of the stage from centre). Unit **136/136**;
browser **42 pass + 2 opt-in skips** (the 12 in `graph.browser.mjs` all green).

**Deploy:** backup `jarvis-code.bak-20261006_145823.tgz` (code only, `.env`
untouched); synced `public/graph.html`, `public/graph-page.js`,
`public/graph3d.js`, `public/style.css` (md5-verified against the source),
image rebuilt, container `healthy`, `/api/health` ok. Live check on
`192.168.54.111:8094` signed in as Mila at 844×390: no overlap, `#graphUser`
shows "Mila", and searching "Lego" (1 hit) centred it in the 3D view with the
rest dimmed. Static assets changed → a browser hard refresh (Ctrl+Shift+R)
picks up the new `style.css` / `graph.html` / `graph-page.js` / `graph3d.js`.

### Same day: clearing the search must bring back the initial objects

Follow-up report: deleting the search text (or hitting the input's X / the
Clear button) lifted the highlight, but if the query had narrowed to a lone
hit **outside the drawn window** — or a result had been clicked — the drawing
window was that entity's neighbourhood, and it stayed there: the initial
objects never came back, and the 15 s poll kept re-fetching the neighbourhood
(`graphCenter` was never reset).

Fix in `public/graph-page.js`: the empty-query path of `runSearch()` now
detects a search-derived window (`focusLoadedFor` is set exactly when a lone
hit was fetched or a result clicked) and calls `loadGraph(null)`, which
re-fetches the initial subgraph and resets `graphCenter` — so the 15 s poll
stops chasing the neighbourhood too. A window the user chose deliberately by
clicking a node in the drawing is untouched (that persists until Refresh, as
before).

**Tests:** new browser regression `clearing the search brings back the
initial objects after a lone hit swapped the window` — the initial window is
a 4-node subset, the lone hit (Amelie) is outside it, clearing restores the
original 4 labels with nothing dimmed; the lone-hit test additionally asserts
the Clear button lifts every dim. The regression test fails on the old code
(timeout waiting for the initial objects). Graph browser **13/13**; unit
**136/136**.

**Deploy:** backup `jarvis-code.bak-20261006_151533.tgz` (code only, `.env`
untouched); synced `public/graph-page.js` + `tests/graph.browser.mjs`
(md5-verified), image rebuilt, container `healthy`, `/api/health` ok. Live
check signed in as Mila: search "Lego" → centred with the other node dimmed;
Clear → both nodes bright again, camera back on the whole graph. Hard refresh
(Ctrl+Shift+R) picks up the new `graph-page.js`.

## 2026-10-06: MCP web-search gains a real-browser `web_fetch` tool

Report: "pull from google finance" → the brain found the Google Finance link
in the `web_search` results but had **no tool to open a URL** (`mcp/websearch.mjs`
exposed only `web_search` + `web_news`), so "I pulled up the page … couldn't
extract a live price" was a hallucination off the result title. And a plain
HTTP fetch would not have helped anyway: the live quote loads in a **post-load
XHR (JS)**. Measured from both server IPs, the existing Chrome header set gets
HTTP 200 with the real page shell (~1.3 MB), no bot wall — but no price in the
static HTML. So the fix needed a browser that actually runs the page.

Change: a third MCP tool, **`web_fetch(url)`**, in `mcp/websearch.mjs`. It
opens the URL in a **real headless Chromium** (Playwright) — a genuine
human-browser fingerprint (real TLS/HTTP2 stack, JavaScript execution,
cookies, locale), which is what bypasses bot recognition a spoofed header set
alone cannot and what reads JS-rendered content. One **persistent browser per
MCP process** (lazy launch, closed on SIGTERM/SIGINT/exit), a fresh isolated
context per fetch (locale follows the answer language, so German answers get a
German-rendered page), `goto(domcontentloaded, 10 s)` then the `load` event and
a bounded `networkidle` settle (4 s) so post-load XHRs land, then the rendered
`document.body.innerText` (visible text, reading order) capped at 12 000 chars
(max 30 000). If the browser is unavailable (not installed, crashed, no system
libraries) it degrades to a plain browser-header fetch and marks the result
`[fetched without JavaScript — dynamic page content may be missing]`.
Because the brain is prompt-injectable, `web_fetch` is **SSRF-guarded** like the
graph is owner-scoped: http/https only, default ports 80/443, no embedded
credentials, and private/loopback/link-local/CGNAT/benchmarking IPs blocked —
both as URL literals and against the **DNS-resolved** addresses (a hostname that
rebinds to `169.254.169.254`, the Neo4j container or the app itself is
refused), so the brain reaches the public web as a human but never the internal
network. New pure helpers `isSafeFetchUrl` / `isBlockedIp` / `htmlToText` live
in `mcp/engines.mjs` (unit-testable without network). The backend wires
`web_fetch` into `WEB_TOOL_NAMES`, `webTools()`, the ON-state brain prompt line
and the tool log; `playwright` moves from dev to production dependency and the
Dockerfile installs Chromium + its Debian system libs at build time
(`npx playwright install --with-deps chromium`, `--no-sandbox
--disable-dev-shm-usage` launch args because the container runs as root with a
64 MB `/dev/shm`).

**Tests:** new unit tests for `isBlockedIp` (v4/v6/mapped/garbage),
`isSafeFetchUrl` (scheme/port/creds/literal-IP), `htmlToText` (head/script
stripping, cap), a live SSRF-rejection test over the MCP protocol (loopback,
metadata, private, IPv6, file://, non-default port, creds — all rejected before
any network), the protocol test now asserts three tools, and a server.test.mjs
end-to-end round where the mock brain calls `web_fetch` on the exact Google
Finance URL (tool offered, system prompt mentions it, lang injected per call).
Unit **141/141**. Live in-container MCP `web_fetch` of
`https://www.google.com/finance/quote/NVD:FRA` returned the rendered page with
the live quote; the no-browser fallback path verified separately (returns the
shell + the `[fetched without JavaScript]` marker).

**Deploy:** backup `jarvis-code.bak-20261006_155629.tgz` (code only, `.env`
untouched); synced `Dockerfile`, `package.json`, `package-lock.json`,
`server.js`, `mcp/engines.mjs`, `mcp/websearch.mjs`, `tests/mcp.test.mjs`,
`tests/server.test.mjs` (all md5-verified), image rebuilt (Chromium v1208 +
system deps, image now **1.25 GB**), container `healthy`, `/api/health` ok.
Live end-to-end signed in as Mila (web search on): "Rufe die Nvidia Aktie von
Google Finance ab (…NVD:FRA) und sag mir den aktuellen Kurs" → the brain called
`web_fetch` (backend log: `websearch_tool web_fetch … ok 5401 ms 4179 chars`)
and answered **214,70 € (+0,82 %, +1,75 €)**, Vortagesschluss 212,95 € — the
exact live quote, read from the rendered page, not recalled. No static-asset
change, so no browser hard refresh is needed (backend/image only).

## 2026-10-07: an armed session survives a minimized window (no more auto-disarm)

**Symptom.** Arm Jarvis, then minimize the Chrome window on Windows: the UI
dropped straight back to **Stopped** and the microphone was released. Returning
to the window meant clicking **Arm Jarvis** again. A wake word you have to be
looking at the page for is not a wake word.

**Cause.** `public/app.js` disarmed on purpose:

```js
document.addEventListener("visibilitychange", () => {
  if (document.hidden && current) stop("Tab hidden; microphone and pending requests stopped. Re-arm when ready.");
});
```

Chrome fires `visibilitychange` with `document.hidden === true` when a window is
minimized, not just when the tab is switched away, so a minimize hit the same
path as leaving the page.

**Why the handler existed at all**, and why removing it is not enough: the
pipeline polls on `setTimeout` (`tick()` → `delay(100)`, the voice stop-watch →
`delay(150)`). Chrome clamps timers in a hidden page to **>= 1 s**, and after
five minutes hidden to roughly **once a minute** under intensive throttling. So
simply keeping the session alive would have produced a session that is nominally
armed but reacts seconds — eventually a minute — late, and `Microphone.check()`
would then trip its own "no capture block for 3 s" watchdog and error out. The
disarm was the honest behaviour for a timer-clocked loop.

**Fix — clock the loop off the audio thread, not off timers.** The capture
AudioWorklet posts a 2048-sample block (~43 ms at 48 kHz) to the main thread for
the whole session. Those arrive as **tasks, not timers**, and are not throttled
while a microphone stream is live, so a block arrival is what advances the loop:

- `Microphone.tick(ms, signal)` (new, `public/audio.js`) resolves once **at
  least `ms` of wall time** has passed, woken by block arrivals; a block that
  lands early re-arms the waiter instead of resolving, so the cadence is the
  same in the foreground as in the background. A `setTimeout` is kept as the
  *fallback* path only — it is what still fires if capture itself has died, so
  `check()` can report it.
- `tick()`, `waitForQuiet()` and `watchForVoiceCommand()` in `app.js` use it
  instead of `delay()`. The inter-cycle pauses (`delay(300)`, the error backoff)
  stay on plain timers: a 1 s clamp on those is harmless.
- `Microphone.check()` no longer treats a non-running context as fatal. A
  **suspended** context is recoverable (the browser may suspend the graph around
  a minimize), so it calls `context.resume()` and keeps going; only a *closed*
  context or a stale capture buffer (no block for 3 s) ends the session. The
  message lost its "keep this tab in the foreground" instruction.
- `visibilitychange` now logs `Window hidden; still armed and listening for the
  wake word.` and, on return, nudges `context.resume()`. `pagehide` still
  stops — leaving the page genuinely must release the mic.
- The `document.hidden` guard on the Arm button is gone (it was unreachable: you
  cannot click a button in a minimized window) and the opening-microphone stage
  now reads "You can minimize the window once armed."

**Privacy note.** The microphone is now live while the page is not visible,
which is the requested behaviour, but it is deliberately not silent about it:
only **Stop**, a pipeline error or leaving the page releases capture, and
Chrome's own recording indicator (tab marker + taskbar/omnibox icon) stays up
for the entire armed session, so the mic is never live without the user being
able to see it. Wake probes still go to the configured Whisper server exactly as
before — hiding the window changes nothing about what is uploaded.

**Tests.** `tests/audio.test.mjs` gains three `Microphone.tick` cases against
the prototype (a real `Microphone` needs an `AudioContext`): a block advances
the clock **with `setTimeout` stubbed out to never fire** (the throttled
background case), an early block re-arms rather than resolving early, the timer
still resolves when capture has gone silent, and an abort rejects the pending
tick and drops its waiter. The Chromium lifecycle test formerly named "hiding
the tab releases capture" is now "hiding the tab keeps the session armed": after
the `visibilitychange`, the stage stays **Wake listening**, every track stays
`live`, the log carries the still-armed line, and it waits out another 3.5 s —
past the stale-block watchdog — to prove the loop is still being driven, before
**Stop** ends the tracks. Unit **148/148**, browser **43/43** (2 skipped: the
live-backend tests).

**Not verified here:** the browser test spoofs `document.hidden`, so the page is
really visible and Chromium's throttling is not actually engaged; the
unthrottled-timer path is covered by the unit test instead. A genuinely
minimized Windows Chrome window has not been exercised in CI — worth one manual
check after deploy (arm, minimize for >5 min to cross into intensive throttling,
speak the wake word).

**Rolled out 2026-10-07 ~11:30.** The change is static-asset-only
(`public/app.js`, `public/audio.js`, `public/index.html`) plus tests and docs,
but `public/` is baked into the image (`Dockerfile` `COPY`, no volume mount),
so the rollout needed the standard rebuild:

- Backup first: `jarvis-code.bak-20261007_112953.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/audio.js`, `public/index.html`,
  `tests/audio.test.mjs`, `tests/pipeline.browser.mjs` and `README.md` to
  `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104.
- Verified: container `healthy` (recreated, not just re-run), `/api/health`
  returns `ok: true` with `whisperEndpoints: 3`, `brainConfigured: true`,
  `aiProfiles: 4`, `ttsEndpoints: 1`, and the served `app.js`, `audio.js` and
  `index.html` md5sums match the committed source byte-for-byte.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up. The manual minimized-window check above
(arm, minimize for >5 min, speak the wake word) is still open for the user on
Windows.

## 2026-10-07: spoken command-window greeting + 3 s silence abort

User request: when the app waits for the command after a wake word alone, it
should say **"Yes, <username>"** to the user, and if there is silence for
3 s it should abort back to wake-word listening instead of waiting out the
old 10 s.

Changes (all in `public/app.js` unless noted):

- New `COMMAND_WAIT_SILENCE_MS = 3000`. `waitForCommandEnd(session, start,
  true)` (the wake-word-alone command window) no longer plays the bare beep
  and no longer waits 10 s wall time for initial speech:
  - the window opens with a **spoken greeting** — `Yes, <username>.`
    (`Ja, <username>.` in German mode), where `<username>` is the signed-in
    account — in the selected answer voice (same pipeline as answers, via the
    new `speakText()` extracted from `speak()`; the greeting has no speech
    wake-watch and does not touch `lastSpeechEndedAt`),
  - the greeting's **speaker echo is let die down** (`waitForQuiet` 2 s max,
    300 ms quiet) and the window arms at that echo-free point, so the
    greeting itself is never transcribed as the command: the function now
    returns the armed sample offset, and `listen()` transcribes the command
    from there (the beep window used to start at the wake-utterance end and
    would have included the greeting),
  - **3 s of silence** without a command closes the window (log line
    `No command after 3 s of silence; returning to wake listening.`) and the
    pipeline returns to wake listening; once speech has started, the silence
    stop slider ends the command exactly as before. The 15 s cap stays as
    the safety net for a never-quiet microphone.
- The beep is kept as the **fallback cue** when the voice output is switched
  off (Text only mode) or the TTS fails (logged), and unchanged for the
  one-breath flow ("Rocky, what time is it?").
- New `command` pipeline stage (green, slow ring spin, hero caption
  "Waiting for your command. Three seconds of silence returns to wake
  listening."): `stageCaptions.command` in `app.js`, `stageMode.command =
  "mic"` in `public/visualizer.js`, `.core.command` / `.command .ring-a` in
  `public/style.css`; the silence bar fills in it like in `recording` once
  command speech is heard. The old "Speak after the beep" stage is gone.

Tests (`tests/pipeline.browser.mjs`):

- `wake-only response greets with the user's name, then transcribes the
  command` — with `user: "Mila"` in the config mock, the first utterance is
  exactly `Yes, Mila.`, the command is transcribed and prompted as before
  (3 transcribe calls).
- `three seconds of silence after the greeting returns to wake listening` —
  a dedicated fixture (1 s tone per 6 s loop) fires the wake probe once and
  leaves the command window in silence; the stage must return to **Wake
  listening** within 8 s of the greeting stage (the old 10 s wait fails
  this), the log carries the abort line, and no brain prompt is sent.
- The two empty-window tests updated for the greeting utterance (the answer
  is now the second utterance, not the first).

Unit **148/148**, browser **44/44** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~12:07.**

- Backup first: `jarvis-code.bak-20261007_120650.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/visualizer.js`, `public/style.css`,
  `public/audio.js`, `tests/pipeline.browser.mjs` and `README.md` to
  `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104.
- Verified: container `healthy` (recreated), `/api/health` returns
  `ok: true` with `whisperEndpoints: 3`, `brainConfigured: true`,
  `aiProfiles: 4`, `ttsEndpoints: 1`, and the served `app.js`, `style.css`,
  `visualizer.js` and `audio.js` md5sums match the source byte-for-byte
  (`f73a9e83…`, `f2be27b6…`, `22708cb4…`, `d51d8849…`), with the new
  greeting/abort strings present in the served `app.js`.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: command window no longer drops commands spoken right after the greeting

User report (against the ~12:07 greeting rollout): after "Yes, Roman." the app
jumped straight back to wake listening instead of waiting for the command.
Live logs showed the greeting's `/api/speak` followed by no command
transcription and no brain prompt.

Root cause: the window armed only after the greeting's speaker echo settled
(`waitForQuiet` 2 s max / 300 ms quiet, then `speechAfter = buffer.end`). A
command spoken as soon as the greeting ends — over the echo tail, before that
arming point — landed entirely before the transcript start, so the window
closed on the 3 s silence rule with nothing captured.

Fix (`public/audio.js`, `public/app.js`):

- The command window now **arms where the greeting ends**: the transcript
  starts at `buffer.end` the moment `speakText()` resolves, so the user's
  command is in the window whenever it comes.
- `waitForCommandEnd(session, start, true)` tracks the first voice event
  (the echo tail, or a command merged into it) and a separate later event:
  - when the first event ends, `heldVoiceAfterEcho()` (new, in `audio.js`
    next to `hasLoudBurst`) decides what it was: a pure reverb decay never
    holds 40 % of the window's opening peak 250 ms past the opening, while a
    user voice talked over the echo does — the merged window is then command
    audio and closes on that event's silence,
  - a voice event that starts separately after the echo settled is the
    command by construction (transcribed from its onset minus 400 ms
    pre-roll, so no echo in the audio),
  - 3 s of silence with neither closes the window as before (`No command
    after 3 s of silence; returning to wake listening.`), and the 15 s cap
    stays the safety net.
- `stripGreetingEcho()` in `app.js` drops a leading "yes"/"ja" + the
  user's name from a merged-window transcript, so the brain gets the command,
  not the greeting's echoed tail.
- The pipeline status line now shows a live countdown to the 3 s abort, and
  the silence bar fills toward the 3 s abort while the window waits for the
  user (flat before, once the echo settled).

Tests:

- Unit: `heldVoiceAfterEcho` coverage in `tests/audio.test.mjs` — merged user
  voice detected, pure decay not, quiet user not, silent opening not, too
  short not. Unit **149/149**.
- Browser (`tests/pipeline.browser.mjs`): new regression
  `a command spoken right after the greeting over the echo is captured, not
  lost` — fixture plays the wake tone, a first command attempt the
  completed-utterance transcription drops (VAD), then the repeated command
  tone starting 0.35 s after the wake tone ends, across the greeting window.
  The test fails on the old code (30 s timeout: the command is lost, no
  answer is produced) and passes on the fix; it also asserts the command
  window's audio carries the 880 Hz command tone and not the 440 Hz wake
  tone (Goertzel). All four pre-existing two-step-flow tests still pass.
  Browser **45/45** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~13:07.**

- Backup first: `jarvis-code.bak-20261007_130643.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/audio.js`, `tests/pipeline.browser.mjs`,
  `tests/audio.test.mjs` and `README.md` to `/home/ubuntu/docker/jarvis`,
  then `docker compose up -d --build` on vm104.
- Verified: container `healthy` (recreated), `/api/health` returns
  `ok: true` with `whisperEndpoints: 3`, `brainConfigured: true`,
  `aiProfiles: 4`, `ttsEndpoints: 1`, and the served `app.js`
  (`660ef8f6d7ba9b5c64587f0cffb65007`) and `audio.js`
  (`cbe82b73636dd4afb6b95ac9a5a4dbde`) md5sums match the source
  byte-for-byte, with the new `heldVoiceAfterEcho` / `stripGreetingEcho`
  strings present in the served files.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: command wait slider (0.5-15 s) + abort clock anchored to the greeting

User report (against the ~13:07 echo fix): the command stage still returned to
wake listening immediately after "Yes, Roman." instead of waiting 3 s. Request:
a slider, 0.5 s-15 s, for that delay.

Root cause of the immediate return: the abort clock was `silentMs` — time
since the last mic voice. The capture uses `echoCancellation: true`, so the
spoken greeting is largely kept out of the microphone; the last voice was then
the user's wake word itself, several seconds old. By the time the window
armed (probe settle + completed-utterance transcription + greeting TTS),
`silentMs` was already at or past 3 s, so the first loop tick closed the
window on the 3 s rule.

Fix (`public/app.js`, `public/index.html`):

- The abort clock now runs from the **greeting's end**:
  `session.commandWaitStartedAt` is stamped where the transcript window arms,
  and the abort fires on `performance.now() - commandWaitStartedAt >=
  commandWaitMs`. The status line counts the remaining seconds down and the
  silence bar fills toward the abort (its scale follows the active cap).
- **Command wait slider** in the Mic level panel: 0.5 s-15 s in 0.5 s steps,
  3 s default, per browser (`jarvis.commandWaitMs` in local storage, like the
  silence stop). The value applies from the next greeting on (the window
  counts it down live). The 15 s command limit becomes a safety net that
  follows the wait (`max(15 s, command wait) + 5 s`) so a 15 s wait is not
  cut short by the old fixed cap.
- `No command after <value> of silence; returning to wake listening.` uses
  the slider value (e.g. `No command after 500 ms of silence`).

Tests (`tests/pipeline.browser.mjs`):

- New `the command wait slider sets the abort delay and persists per
  browser` — one tone per 6 s loop fixture; cycle 1 aborts on the 3 s
  default, the slider drops to 0.5 s when cycle 2's command stage opens, and
  the second abort must land well under 2 s (greeting + 0.5 s). Asserts both
  log lines, the `Saved` status, `localStorage` persistence and restoration
  after `page.reload()` (per browser, like the wake word).
- All pre-existing two-step-flow tests pass unchanged (default 3 s):
  `three seconds of silence after the greeting returns to wake listening`,
  the fast-command regression, and the two empty-window tests.

Unit **149/149**, browser **46/46** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~13:41.**

- Backup first: `jarvis-code.bak-20261007_134055.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/index.html`, `README.md` and
  `tests/pipeline.browser.mjs` to `/home/ubuntu/docker/jarvis`, then
  `docker compose up -d --build` on vm104.
- Verified: container `healthy` (recreated), `/api/health` returns
  `ok: true` with `whisperEndpoints: 3`, `brainConfigured: true`,
  `aiProfiles: 4`, `ttsEndpoints: 1`, and the served `app.js`
  (`3a7f1c5305805c822d4e31ea31cbd4dd`) and `index.html`
  (`e25b9baf00f083ac028671360061aa8b`) md5sums match the source
  byte-for-byte, with the `commandWait` slider markup in the served HTML.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: record-command mode and abort timer start together, after the greeting

User follow-up on the slider: the timer for returning to "wake word" should
run **after** being in "record command" mode, not before. Previously the
"Waiting for command" stage appeared *before* the greeting (while "Yes,
Roman." was still playing) and the status-line counter showed elapsed time
that included the greeting, so the wait looked like it had already started
counting down before the app was ready to record.

Fix (`public/app.js`):

- While the greeting speaks, the pipeline now shows the **Speaking** stage
  ("Saying the greeting.", TTS step active — the hero caption for `speaking`
  is now the neutral "Speaking." so it covers both the greeting and answers).
  No command-wait UI is visible while "Yes, <name>." plays.
- The "Waiting for command" stage, its hero caption, the silence bar and the
  abort clock (`session.commandWaitStartedAt`) all start at the **same
  instant** — when the greeting ends. The full Command wait (slider value,
  default 3 s) is spent inside the record-command mode.
- The status-line counter measures from `commandWaitStartedAt` in the
  post-greeting window, so its elapsed seconds never include the greeting.
- The hero caption follows the slider: `Waiting for your command. <value> of
  silence returns to wake listening.` (was the hardcoded "Three seconds");
  `applyCommandWait` keeps `stageCaptions.command` in sync.

Tests: all six two-step-flow browser tests pass unchanged (their
"Waiting for command" edge now fires after the greeting; timing margins still
hold). Unit **149/149**, browser **46/46** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~14:07.**

- Backup first: `jarvis-code.bak-20261007_140701.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js` to `/home/ubuntu/docker/jarvis`, then
  `docker compose up -d --build` on vm104.
- Verified: container `healthy` (recreated), `/api/health` returns
  `ok: true` with `whisperEndpoints: 3`, `brainConfigured: true`,
  `aiProfiles: 4`, `ttsEndpoints: 1`, and the served `app.js`
  (`d82af5c27162cca7089a58da76a39f2b`) md5sum matches the source
  byte-for-byte, with the new "Saying the greeting." string in the served
  asset.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: follow-up command window after a spoken answer or stop

User request: after the answer speaking is finished — or the stop word cuts
it — the assistant should jump to the record-command mode, not to wake
listening, and wait the set Command wait for silence before returning to wake
word.

Implementation (`public/app.js`):

- `waitForCommandEnd(session, start, mode)` — the third argument is now a
  mode: `"greeting"` (as before, spoken greeting opens the window),
  `"inline"` (command came with the wake word; only its end is awaited) and
  the new `"post-speech"` (the window opens right where the last speech
  ended, record stage and abort clock start at once, no greeting). The
  echo/open/speaking phase logic and the level-hold echo test are shared by
  both post-speech windows, so a follow-up command spoken over the answer's
  speaker tail is captured exactly like one over the greeting's.
- `listen()`: a turn that ends in spoken output (answered command, or a stop
  word acknowledged via the speech watch, the wake-pipeline fallback or the
  window itself) sets `turnEndedWithSpeech`; the probe loop then opens the
  follow-up command window in a loop — command → answer → window — and only
  a full Command wait of silence (or an empty window) closes it and returns
  to wake listening. A stop word inside the follow-up window is acknowledged
  (beep, window stays open) instead of being sent to the brain; the
  post-speech 10 s stop window stays fresh across chained windows.
- The abort now also requires the microphone actually quiet
  (`silentMs >= silenceMs`) in addition to the elapsed Command wait, so a
  command that starts in the last moment of the wait is not cut off at the
  deadline — it just ends on the silence stop like any other command.
- The old post-answer settle (`waitForQuiet` + 300 ms delay before the next
  wake cycle) is gone — the window's echo phase provides the settle.
  `VOICE_THRESHOLD` and `waitForQuiet` were removed with it.

Tests (`tests/pipeline.browser.mjs`):

- New `a follow-up command right after the answer is captured without the
  wake word` — shared 4 s loop fixture: burst 1 wakes, burst 2 is the command
  after the greeting, burst 3 (no wake word) must be captured by the
  follow-up window; asserts two brain prompts and 4 transcriptions.
- New `silence after the answer waits the full command wait before returning
  to wake listening` — one tone per 6 s loop: after the answer the window
  must hold the full 3 s (measured ≥ 2.5 s and < 8 s, so neither immediate
  return nor waiting out the loop) before "Wake listening".
- Updated: `real Chromium capture completes three answered turns with fresh
  valid audio` (turns now chain through follow-up windows: 4 transcriptions
  instead of 6), and the three stop tests now expect "Waiting for command"
  after an acknowledged stop instead of "Wake listening".

Unit **149/149**, browser **48/48** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~14:45.**

- Backup first: `jarvis-code.bak-20261007_144515.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `tests/pipeline.browser.mjs` and `README.md` to
  `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served `app.js`
  md5 matches the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: butler closings for acknowledgment commands

User request: when the record-command window ends on a bare acknowledgment —
"ok", "thank you", … — there is nothing to answer, so instead of
round-tripping it to the brain Jarvis should end the turn politely, "like an
English butler".

Implementation:

- `public/voice.js`: `ACKNOWLEDGMENTS` (thanks + general, English and
  German), `acknowledgmentKind(text)` — whole-utterance match, case- and
  trailing-punctuation-insensitive ("ok, and now check the weather" is a
  real command, never an acknowledgment) — and `CLOSING_LINES` /
  `pickClosing(language, kind)`: butler-style closings per turn and per
  answer language ("Very good. Standing by.", "You are most welcome.
  Standing by.", "Sehr gut. Ich stehe bereit.", …), injected `random`
  parameter for testability.
- `public/app.js`: the spoken part of `answer()` is extracted into
  `speakAnswer(session, text)` (TTS stage, stop/interruption watch,
  retryable speech output — unchanged behaviour); new
  `acknowledge(session, prompt)` picks the closing, marks the brain step
  skipped (no brain request, no graph ingestion), and speaks the closing on
  the normal TTS path (a stop word cuts it, an interrupting command starts a
  new brain round trip). Wired into both command paths — the probe loop
  (wake-only / one-breath / post-greeting) and the follow-up command window —
  after the post-speech-stop check. The closing is spoken output, so the
  follow-up command window opens after it like after any answer.

Tests:

- `tests/voice.test.mjs`: whole-utterance acknowledgments recognized (ok/
  okay/punctuation/german), real commands and stops not, `pickClosing`
  language/kind/list invariants.
- `tests/pipeline.browser.mjs`: `a thank-you after the answer gets a butler
  closing instead of a brain round trip` (one brain prompt total, closing
  clauses spoken, log line) and `an ok after the greeting gets a butler
  closing without any brain round trip` (greeting + closing, zero brain
  prompts). The deterministic closing comes from a stubbed `Math.random`.

Unit **151/151**, browser **50/50** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~15:07.**

- Backup first: `jarvis-code.bak-20261007_150659.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/voice.js`, `tests/voice.test.mjs`,
  `tests/pipeline.browser.mjs` and `README.md` to `/home/ubuntu/docker/jarvis`,
  then `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served `app.js`
  md5 matches the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: butler closing for acknowledgments after the follow-up window closed

User report: after the answer finished, saying "ok" or "thank you" produced no
closing at all — the pipeline jumped straight to "Wake listening".

Root cause: the closing only fired for acknowledgments captured *inside* the
follow-up command window (Command wait, 3 s default). An acknowledgment spoken
after the window had already closed on silence hit the wake probe's
"no wake phrase heard" branch and was silently dropped. Secondary gap: an
echo-merged window (the answer's own last words in front of the user's "Ok")
transcribed as one utterance and failed the whole-utterance match, so it went
to the brain instead.

Implementation:

- `public/voice.js`: `acknowledgmentKind` is now a wrapper around
  `acknowledgmentIn(command, { trailing })` — whole-utterance match as before,
  or, with `trailing`, the last phrase of a longer transcript may be the
  acknowledgment ("Done. Ok.", "It is 12:00. Thank you.", "Es ist 12 Uhr.
  Danke."); callers gate the looser match with a loud user burst, exactly like
  the post-speech stop fallback.
- `public/app.js`:
  - wake probe, no-wake-phrase branch: when a spoken turn ended within the
    same 10 s post-speech window (`STOP_AFTER_SPEECH_MS`) as the stop
    fallback, a transcript that is a bare acknowledgment (full match, or
    trailing match + `hasLoudBurst` in the probe window) now ends the turn via
    `acknowledge()` — polite closing, brain skipped — and opens the follow-up
    command window after the closing, instead of "No wake phrase heard".
  - in-window path: the trailing match (burst-gated) is added next to the
    whole-utterance match, so an echo-merged "…answer words… Ok" gets the
    closing instead of a brain round trip.
  - `acknowledge()` resolves the closing kind through the same full-then-
    trailing match (defaulting to "general"), so an echo-merged transcript
    still picks the right closing line.

Tests:

- `tests/voice.test.mjs`: `a trailing acknowledgment inside an echoed
  transcript is recognized, commands are not` (EN + DE trailing matches,
  non-trailing stays strict, mid-command acknowledgments never match).
- `tests/pipeline.browser.mjs`: `an ok after the follow-up window closed still
  gets a butler closing in wake listening` — quiet 6 s loop fixture: wake +
  command, answer, the follow-up window aborts on 3 s of silence, then the
  next tone ("Ok", after the window closed) must still get the closing:
  exactly one brain prompt total, closing clauses spoken, no "No wake phrase
  heard" line in the log.

Unit **152/152**, browser **51 pass** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~15:37.**

- Backup first: `jarvis-code.bak-20261007_153735.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/app.js`, `public/voice.js`, `tests/voice.test.mjs`,
  `tests/pipeline.browser.mjs` and `README.md` to `/home/ubuntu/docker/jarvis`,
  then `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served `app.js`
  md5 matches the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: layout — graph and pipeline below the panels toggle, 250% taller Prompt/Answer

User request: move the Knowledge graph panel below the panels on/off button,
move the Pipeline section to the top below the panels on/off, and make the
Prompt/Answer panel 250% taller vertically — without touching the text size.

Implementation:

- `public/index.html`: the `.graph-panel` section moved from between the
  Prompt/Answer row and the panels toggle to right below the panels toggle
  (kept outside `#panelsBelow`, so it stays visible when the panels are off,
  exactly like before). The `.pipeline-panel` section moved from after the
  meter panel to the top of `#panelsBelow`. New visible order: hero,
  Prompt/Answer, panels toggle, Knowledge graph, Pipeline, meter panel,
  controls, settings, animation preview, wake word, voice, live log.
- `public/style.css`: `.transcript > div` min-height 160px → 560px (160 +
  250%) with `grid-template-rows: auto 1fr` so the text area fills the taller
  panel; `.transcript p` min-height 46px → 161px and max-height 182px → 637px
  (same 3.5× factor). No font-size or any other text-size property changed.
- `tests/graph.browser.mjs`: the 3D-overlap test asserted the panels toggle
  row starts below the graph panel (the old layout); it now asserts the
  panels area (`#panelsBelow`) starts below it — same intent (the canvas wrap
  must reserve the stage height), new element below.

Unit **152/152**, browser **51 pass** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~16:03.**

- Backup first: `jarvis-code.bak-20261007_160254.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/index.html`, `public/style.css`, `public/app.js` and
  `tests/graph.browser.mjs` to `/home/ubuntu/docker/jarvis`, then
  `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served
  `index.html` / `style.css` / `app.js` md5s match the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: taller panels toggle, knowledge graph joined the panels toggle

User report: the Panels off/on button's text overlaps its border, and the
Panels on/off toggle should hide/show the knowledge graph panel too.

Root cause (button): the pill switch was 122px wide with two 57px label
columns — "Panels off" (and "Text only" on the speak switch) wrapped to two
lines (~30px of text) inside a 27px box, so the second line painted over the
bottom border. Measured with a Playwright probe against the live CSS.

Implementation:

- `public/style.css`: `.lang-switch` width 122px → 148px (longest labels —
  "Panels off", "Text only" — stay on one line) and height 27px → 32px
  (vertical headroom for the line box). Applies to all three pill switches
  (panels, language, speak), which share the class and had the same latent
  wrap. Re-measured after the change: all labels single-line, text box fully
  inside the border with 4px clearance.
- `public/index.html`: the `.graph-panel` section moved from between the
  panels toggle and `#panelsBelow` into `#panelsBelow` as its first child
  (right below the toggle, still above the pipeline), so the Panels on/off
  toggle now hides and shows the knowledge graph with the other panels.
  Toggle title updated to list the knowledge graph.
- Safety: the 3D renderer already handles a hidden panel — `resize()` clamps
  to 1px, a `ResizeObserver` on the stage re-sizes it when the panel becomes
  visible again, and `tick()` skips rendering while `stage.hidden` — so a
  page that loads with panels off (persisted) renders correctly once panels
  are switched on.
- `tests/graph.browser.mjs`: the 3D-overlap assertion now checks the element
  actually below the graph panel (the pipeline panel) instead of `#panelsBelow`.
- `tests/audio.test.mjs`: pre-existing flaky assertion, found while running
  the suite for this change — "the capture clock still resolves on its timer"
  asserted elapsed >= 30 ms, but the timer's deadline is armed from tick's
  own later clock sample, so a near-zero-delay timer reads up to ~1-2 ms
  short (probe: 4/200 below 30, floor 29.08 ms). Lowered the bound to 25 ms
  with an explanatory comment; the assertion still discriminates the timer
  path (~30 ms) from an immediate resolve (~0 ms).

Unit **152/152**, browser **51 pass** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~16:26.**

- Backup first: `jarvis-code.bak-20261007_162542.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/index.html`, `public/style.css`, `public/app.js`,
  `tests/graph.browser.mjs` and `tests/audio.test.mjs` to
  `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served
  `index.html` / `style.css` / `app.js` md5s match the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: pipeline panel directly below the panels toggle

User request: the pipeline panel must sit at the top, directly below the
Panels on/off button (the knowledge graph goes below it).

Implementation: `public/index.html` — the two sections inside `#panelsBelow`
swapped; the pipeline panel is now the first panel (directly below the
toggle), the knowledge graph panel the second, then the meter panel and the
rest. Toggle title, the `graph-panel` CSS comment, the app.js graph comment
and the graph browser test's "element below the graph panel" assertion
(now the meter panel) updated to match.

Unit **152/152**, browser **51 pass** (2 skipped: the opt-in live tests).

**Rolled out 2026-10-07 ~16:39.**

- Backup first: `jarvis-code.bak-20261007_163839.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `public/index.html`, `public/style.css`, `public/app.js` and
  `tests/graph.browser.mjs` to `/home/ubuntu/docker/jarvis`, then
  `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served
  `index.html` / `style.css` / `app.js` md5s match the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07: butler farewell, graph disconnect policy, hero switches, conversation history

User request (five parts): (1) butler closings for informal thanks ("thx",
"tks", "ty", "thank u") and for session-ending farewells ("bye", "goodbye",
"that's all", "Tschüss", "Auf Wiedersehen", …); (2) stored graph policy — no
entity node without a relation (a bounded path of fact edges) to the user,
enforced after every ingestion and every entity deletion; (3) an enable /
disable Jarvis toggle in the hero, left of Sign out; (4) scrollable
conversation history with date-time stamps in the Prompt/Answer panels,
showing the last 24 days while the backend keeps everything; (5) the existing
Speak / Text only switch moved from the voice settings into the hero, left of
Sign out.

Implementation:

- `public/voice.js` — `ACKNOWLEDGMENTS.thanks` gained the informal thanks
  (also "thx jarvis", "danke jarvis"); new `ACKNOWLEDGMENTS.farewell` kind
  (en + de, jarvis/rocky variants included) and `CLOSING_LINES.farewell`
  closings that say goodbye instead of "standing by" ("It was my pleasure.
  Goodbye." / "Es war mir eine Freude. Auf Wiedersehen."); the English thanks
  line "It is my pleasure." became "It was my pleasure."; `acknowledgmentIn`
  walks all three kinds, whole-utterance and trailing-phrase alike.
- `graphdb.js` — exported `DISCONNECT_SWEEP` Cypher: an owned entity must
  reach the owner's `:User` node through a bounded (`*1..6`) undirected path
  of fact edges (`KNOWS` bookkeeping never counts), otherwise `DETACH DELETE`.
  The Neo4j `upsertTurn` runs one global sweep per user after the turn's
  upserts (a disconnected cluster dies in the same turn it is created);
  `removeEntity` captures the deleted entity's `owner`, sweeps for that user,
  and returns `{ deleted, name, orphansRemoved }` (a removal that frees an
  entity's last path sweeps the freed cluster); the memory store runs the
  same policy with a bounded 6-hop BFS. The seed graph (Rocky/Berlin/Kokoro
  for Mila, Coffee for Roman) is pre-policy legacy state, swept on that
  user's first ingestion or deletion.
- `mcp/graph.mjs` — the `delete-entity` tool runs the sweep after its delete
  and reports the swept names; tool description updated.
- `public/index.html` + `public/app.js` — hero `#enableSwitch` (left of Sign
  out): off = the normal stop path (mic released, Arm free), on = the normal
  arm flow; `aria-checked` mirrors the armed state via `syncEnableSwitch()`
  in `newSession()` and `stop()`. `#speakSwitch` (the pre-existing
  Speak / Text only switch) moved from the voice settings into the hero; the
  hero's controls sit in a `.user-controls` cluster, left to right: enable,
  speak, Sign out; the status line stays in the voice settings. No app.js
  logic changed for the move (all element access is by id).
- `server.js` — `conversationLogs` map (authenticated user → `[{ts, prompt,
  answer}]`, everything stored, 500 entries per user, oldest dropped);
  `GET /api/conversation` serves the last 24 days (`CONVERSATION_WINDOW_MS`);
  `POST /api/conversation` server-stamps the entry (400
  `prompt_and_answer_required` when a side is missing); per-user isolation
  like every other `/api` route. `public/app.js` — the panels are now
  scrollable `transcript-list`s: one `transcript-entry` (a `time` stamp plus
  the body) per panel per finished turn (brain answers, butler closings,
  manual prompts alike), an in-flight turn shows a pending "…" body, a failed
  one "Failed: …"; `recordTurn` posts fire-and-forget; `loadConversationHistory`
  refills both panels from the 24-day window on load ("No conversation yet."
  when empty).
- `public/style.css` — `.user-controls` cluster; `.transcript-list`
  (min-height 161px / max-height 637px, vertical scroll) with
  `.transcript-entry` / `.transcript-time` / `.transcript-body` (pending
  dimmed) / `.transcript-empty`; the transcript rows are `auto 1fr auto`
  (heading, history, manual-prompt form).

Tests: unit **153/153** (new server conversation-endpoint test; the ten
graph-policy fallout tests rewritten for the sweep semantics; voice tests
cover the informal thanks and the farewell kind, whole-utterance and
trailing). Browser **53 pass** (2 skipped: the opt-in live tests), including
the new "a bye after the answer ends the turn with a butler farewell" and
"the hero switches sit left of Sign out, and the panels keep the conversation
history" (placement, text-only mode speaks nothing, per-browser persistence
and the 24-day history across a reload).

**Rolled out 2026-10-07 ~18:11.**

- Backup first: `jarvis-code.bak-20261007_180755.tgz` under
  `/home/ubuntu/docker/` (code only, `.env` untouched).
- Synced `server.js`, `graphdb.js`, `mcp/graph.mjs`, `public/app.js`,
  `public/index.html`, `public/style.css`, `public/voice.js` and the four
  changed test files to `/home/ubuntu/docker/jarvis`, then
  `docker compose up -d --build` on vm104.
- Verified: container `healthy`, `/api/health` `ok: true`, served
  `index.html` / `style.css` / `app.js` / `voice.js` md5s and the live
  `server.js` / `graphdb.js` / `mcp/graph.mjs` md5s all match the source.

It is a static-asset change, so a **browser hard refresh** (Ctrl+Shift+R) is
required for clients to pick it up.

## 2026-10-07 — Vikunja task manager MCP (region-pinned service MCP)

The brain gained a third MCP server, **Vikunja** (`id: "vikunja"`): each
Jarvis user's brain acts as that user's own Vikunja account (their tasks,
projects, labels, lists) through the published `@eargollo/vikunja-mcp`
stdio package, and every service-MCP connection is **region-pinned** by
binding policy — a request entering through the nbg-1 gateway may only use
the nbg-1 Vikunja instance, vie-1 only vie-1 (see `AGENTS.md` and the
repo-root `vikunja-mcp.md` for the policy and the full design/implementation
record).

- **Gateway hosts** — on each gateway (nbg-1, vie-1): short-name `Roman` and
  `Mila` Vikunja users created (CLI `vikunja user create` via a pty wrapper;
  the CLI's TTY password prompt rejects plain pipes), one API token per
  (region, user) titled `jarvis` minted + verified (`GET /user`) by
  `/tmp/vk-jarvis-token.sh` (a `mcp-token-owner.sh` variant: no sidecar
  switch, no revoke). The parked `vikunja-mcp` sidecars stay as-is for now.
- **vm104 tunnels** — `jarvis-vikunja-tunnel-nbg1.service` /
  `-vie1.service` (systemd, `Restart=always`): `ssh -N` from vm104 to each
  gateway over the mesh (10.1.1.1 / 10.2.1.1, `HostKeyAlias` on the public
  IP) forwarding **`172.17.0.1:34561` → nbg-1 `172.29.0.2:3456`** and
  **`172.17.0.1:34562` → vie-1 `172.29.0.2:3456`**. The bind address is the
  host's docker0 gateway, not loopback: the container's own loopback cannot
  see the host's, and the container's `host.docker.internal` (compose
  `extra_hosts: host-gateway`) resolves to that docker0 gateway on this
  host. A loopback bind was tried first and failed with "connection
  refused" from inside the container (the brain reported it cleanly as
  "Vikunja is currently unreachable").
- **`server.js`** — `VIKUNJA_HOST_REGIONS` maps the two public Host names to
  regions (fallback `VIKUNJA_DEFAULT_REGION`, live `nbg-1`); the `/api/chat`
  handler passes `req.headers.host` into `chat()`. `VIKUNJA_URLS` /
  `VIKUNJA_TOKENS` are JSON env maps (region → URL; region → user → token);
  only a non-empty URL map advertises the switch in `/api/config`. One
  `McpClient` per (region, user) spawns `node /usr/local/bin/vikunja-mcp`
  with `VIKUNJA_URL`, `VIKUNJA_API_TOKEN`, `VIKUNJA_MCP_ALLOW_WRITE=1` (no
  delete tier; `VIKUNJA_MCP_SCRIPT` overrides for tests). New
  `McpClient.listTools()` feeds the brain the live `tools/list`; `runBrain`
  offers the Vikunja tools in the shared five-round budget and dispatches by
  the live tool-name set. The brain prompt line (switch on) tells it it acts
  as the user themself on that region's instance, no delete tool exists, and
  to confirm changes in plain language; OFF, no-token-for-region and
  unreachable each get their own prompt line.
- **`Dockerfile`** — `npm install -g @eargollo/vikunja-mcp@1.2.3` (pinned).
  **`.env.example`** — documents `VIKUNJA_URLS`, `VIKUNJA_TOKENS`,
  `VIKUNJA_DEFAULT_REGION`. **vm104 `.env`** — the two maps plus
  `VIKUNJA_DEFAULT_REGION=nbg-1` (URLs point at
  `http://host.docker.internal:34561/api/v1` / `:34562`).
- **UI** — no client change: the switch row is built from `/api/config`, so
  the **Vikunja** switch appears automatically (per-browser, like the other
  MCP switches).

Tests: unit **154/154** (new "vikunja is region-pinned per request and
scoped to the signed-in user": mock stdio server echoes the spawned
env so the test pins URL **and** token per (region, user) — Roman on nbg-1
vs vie-1, Mila on nbg-1 — plus the OFF line, the no-token-for-region line
(admin) and the config advertisement; the region is driven with a raw
`http.request` because undici's `fetch` replaces a custom `Host` header).
Browser **53 pass** (2 skipped: the opt-in live tests), with the MCP-switch
test now asserting a switch is built per advertised server and the
untouched Vikunja flag rides along as `false`.

**Rolled out 2026-10-07 ~19:35.**

- Backup first: `jarvis-code.bak-20261007_191340.tgz` under
  `/home/ubuntu/docker/` (code only; `.env` backed up to
  `jarvis/.env.bak-20261007_191340` before the `VIKUNJA_*` additions).
- Synced `server.js`, `Dockerfile` and `.env.example` to
  `/home/ubuntu/docker/jarvis`, then `docker compose up -d --build` on
  vm104 (image now carries `/usr/local/bin/vikunja-mcp`,
  `@eargollo/vikunja-mcp@1.2.3`).
- Verified: container `healthy`, `/api/health` `ok: true`, served static
  artifacts unchanged (md5s match the source — the UI is dynamic), and the
  live end-to-end path: login as Roman, `POST /api/chat` with
  `mcp: { vikunja: true }` and `Host: jarvis.gw-1-nbg-1-…` → the brain
  called `create_task` and the task landed on the **nbg-1** instance only
  (absent on vie-1 for the same user), then deleted again. All four
  (region, user) token combos return the right username from inside the
  container via the tunnels.

No static assets changed, so no browser hard refresh is needed (the new
switch appears on the next page load, as `/api/config` now advertises it).
