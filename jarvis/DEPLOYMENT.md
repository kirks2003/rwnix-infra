# Jarvis deployment

## Live service

- Docker host: `vm104` (`192.168.54.111`) on pve14
- App directory: `/home/ubuntu/docker/jarvis`
- Container: `jarvis`
- Internal/public host bind: `192.168.54.111:8094`
- Compose file: `jarvis/docker-compose.yml`
- Health endpoint: `http://192.168.54.111:8094/api/health`
- Browser UI: served directly by the Node backend from `jarvis/public/`

The host already had Docker and an existing faster-whisper container:

| Container | Image | Published endpoint |
|---|---|---|
| `whisper` | `fedirz/faster-whisper-server:latest-cpu` | `http://192.168.54.111:8001` |
| `jarvis` | locally built from `jarvis/Dockerfile` | `http://192.168.54.111:8094` |

The Jarvis container uses `host.docker.internal` through Docker's `host-gateway` mapping so it can call the host-published Whisper endpoint from inside the container.

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

- `node --check jarvis/server.js`
- `node --check jarvis/public/app.js`
- `docker ps --filter name=jarvis` reported `Up ... (healthy)`
- `/api/health` returned `brainConfigured: true`
- `/api/chat` with `Say only: Jarvis online` returned `Jarvis online`
- Both public routes returned the expected Basic Auth challenge before credentials
