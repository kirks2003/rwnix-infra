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
- Voice services: deployed on `gpu-1` 2026-10-03 (see "gpu-1 voice services" below). STT and TTS both run there now, reached at `https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at`; the vm103 Whisper endpoint is no longer used. vm104 was updated in the same step, because the new endpoint requires `WHISPER_API_KEY` and the previous build could not send it.
- Wake word: `Hey Rocky` (changed from `Rocky` on 2026-10-03 at the user's request, earlier from `hey jarvis`; matching is case-insensitive)
- Personal wake override: the UI's **Your wake word** field persists locally per browser/origin. Apply aborts the active session; re-arm to use the new word. It does not change `.env` or other users' defaults.
- Wake engine: self-hosted Whisper probes from continuous browser AudioWorklet PCM capture, triggered on the trailing edge of speech (~350 ms after the talker stops, 3 s speech cap). Measured against the gpu-1 service with four isolated "Rocky" utterances: the old fixed-interval trigger cut two of eight probe windows mid-word and returned empty for them; the trailing-edge trigger recognized all six of its probes and detected the phrase about 0.9 s sooner.
- Command recording: complete mono WAV snapshots; capture continues during Whisper latency
- Auto-stop: `1500 ms` continuous silence
- STT: backend proxy to `WHISPER_ENDPOINTS`
- Brain: backend proxy to the OpenAI-compatible `a1-dsv4f` / `deepseek-v4-flash` endpoint
- Output: the selected answer voice plus prompt/result text in the UI
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

A batch of user-reported fixes plus the web search becoming multi-engine. Not yet
rolled out to vm104 at the time of writing; the usual file-copy + `docker compose up
-d --build` procedure applies (copy `server.js`, `mcp/`, `public/`, `tests/`, docs;
`.env` untouched — no new `.env` entries).

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
