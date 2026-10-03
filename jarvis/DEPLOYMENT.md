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

- Wake phrase: `hey jarvis`
- First-version wake engine: Chrome `webkitSpeechRecognition` in the foreground tab
- Command recording: `MediaRecorder` with Web Audio level monitoring
- Auto-stop: `1500 ms` continuous silence
- STT: backend proxy to `WHISPER_ENDPOINTS`
- Brain: backend proxy to the OpenAI-compatible `a1-dsv4f` / `deepseek-v4-flash` endpoint
- Output: browser `speechSynthesis` plus prompt/result text in the UI
- Observability: browser live log and backend JSON logs via `docker logs jarvis`

The frontend exposes progress at each small step:

1. Wake listening
2. Wake phrase detected
3. Microphone recording
4. Voice activity / silence tracking
5. Whisper upload and transcription
6. Brain request
7. Browser speech output
8. Error states and backend request IDs

The backend intentionally proxies Whisper and brain requests so browser clients never receive service keys and do not need direct CORS access to internal endpoints.

## Whisper and pipeline finding: ZDF subtitle hallucination

Live config uses vm103's `voice-gpu` Whisper service through `http://192.168.53.111:8003/v1/audio/transcriptions` with model `deepdml/faster-whisper-large-v3-turbo-ct2`, language `de`, and `WHISPER_VAD_FILTER=true`. The underlying container is `voice-gpu` (`python:3.12-slim`) published on `192.168.53.111:8003` and serving `/v1/audio/transcriptions` plus `/health`.

When the user said `hey jarvis, what's the time`, the original browser flow detected only the wake phrase, then started a new recording after the command had already been spoken. That second recording mostly contained silence/background audio, and faster-whisper hallucinated `Untertitelung des ZDF, 2020`, a common no-speech/subtitle artifact. The bad transcript was then sent to the brain, whose response had `content: null` because `max_tokens` was too low and the model spent the budget on reasoning, so the browser had no answer to speak.

Fixes applied:

- If Chrome wake recognition hears words after `hey jarvis` in the same utterance, those words are logged and ignored. The command must be recorded after the wake beep so vm103 Whisper performs all prompt STT.
- Whisper requests now send `vad_filter=true` and `temperature=0`.
- Known no-speech hallucinations such as `Untertitelung des ZDF` and Amara subtitle phrases are rejected and shown as no-speech errors instead of prompting the brain.
- Brain requests now include the current server timestamp, use a larger token budget, and answer time/date questions from that timestamp.
- Browser TTS now waits briefly for voices and resumes `speechSynthesis` before speaking to improve Chrome/Android reliability.

## Brain configuration finding

The `deepseek-v4-flash` endpoint requires bearer authentication. Leaving `BRAIN_API_KEY` empty makes the backend support no-auth self-hosted endpoints, but this live deployment needed the `a1-dsv4f` provider key from the existing kandev104 opencode configuration. The key was written only to `/home/ubuntu/docker/jarvis/.env` on vm104 and is not committed.

Initial testing with the wrong provider key returned:

```text
Brain HTTP 401: {"error":"Unauthorized"}
```

After using the `a1-dsv4f` / `ds4-flash` key, `/api/chat` returned the expected answer.

## Browser limitations and next improvements

- `webkitSpeechRecognition` is a first-version foreground wake listener, not a true low-power wake-word engine.
- Android Chrome can stop listening when the tab is backgrounded, the device locks, or the OS throttles the browser.
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
