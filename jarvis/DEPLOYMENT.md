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
| vm104 | `whisper` | `fedirz/faster-whisper-server:latest-cpu` | `http://192.168.54.111:8001` | legacy/not active |

Jarvis calls the vm103 Whisper service directly across the internal network at `192.168.53.111:8003`; the prior vm104-local `host.docker.internal:8001` endpoint is not the active Jarvis STT target.

## Public routes

Both routes point to `http://192.168.54.111:8094` and are protected by the existing global Authelia NPM configuration plus the `mesh-admin` NPM Basic Auth access list.

| Gateway | URL | NPM row | Certificate | Basic Auth file |
|---|---|---:|---:|---:|
| vie-1 | `https://jarvis.gw-1-vie-1-at-netcup.rwnix.net/` | `proxy_host.id=56` | `npm-24` | `/data/access/8` |
| nbg-1 | `https://jarvis.gw-1-nbg-1-de-netcup.rwnix.net/` | `proxy_host.id=44` | `npm-6` | `/data/access/1` |

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
- Voice services: deployed on `gpu-1` 2026-10-03 (see "gpu-1 voice services" below). The app defaults now point at `https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`, replacing the vm103 Whisper endpoint. **The vm104 `.env` and container still run the old code against vm103; update both together, because the new endpoint requires `WHISPER_API_KEY` and the old build cannot send it.**
- Wake word: `Rocky` (changed from `hey jarvis` on 2026-10-03 at the user's request; matching is case-insensitive)
- Personal wake override: the UI's **Your wake word** field persists locally per browser/origin. Apply aborts the active session; re-arm to use the new word. It does not change `.env` or other users' defaults.
- Wake engine: vm103 Whisper probes from continuous browser AudioWorklet PCM capture
- Command recording: complete mono WAV snapshots; capture continues during Whisper latency
- Auto-stop: `1500 ms` continuous silence
- STT: backend proxy to `WHISPER_ENDPOINTS`
- Brain: backend proxy to the OpenAI-compatible `a1-dsv4f` / `deepseek-v4-flash` endpoint
- Output: the selected answer voice plus prompt/result text in the UI
- Answer voice: the UI's **Answer voice** field persists locally per browser/origin. **Browser voice** uses `speechSynthesis`; **HAL 9000** proxies clauses through `/api/speak` to `TTS_ENDPOINTS` (OpenAI `/v1/audio/speech`) and shapes them in Web Audio. `TTS_ENDPOINTS` is unset in this deployment, so HAL 9000 currently falls back to `speechSynthesis` with HAL cadence only.
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

The replacement uses one sequential async pipeline per cancellable browser session and valid WAV snapshots from a bounded PCM ring. Stop/re-arm and tab hiding invalidate the session, cancel downstream fetches and release the mic. Voice probes overlap; command completion waits for silence. The UI distinguishes listening, checking wake audio, command capture, Whisper, brain, TTS and errors. The displayed last STT endpoint/request ID comes from the response rather than a hardcoded success label.

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

## Browser limitations and next improvements

- Browser speech recognition is not used. While armed, voice-containing ambient audio is sent to the configured vm103 service to check for wake words; this is not on-device wake detection.
- Android Chrome can stop capture when the tab is backgrounded, the device locks, or the OS throttles the browser. This build explicitly disarms on tab hiding.
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

Expected public route result without credentials is `401 Unauthorized` with `WWW-Authenticate: Basic realm="Authorization required"`.

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
