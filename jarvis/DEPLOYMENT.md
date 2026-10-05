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
   and the speech output (answer text known). Aborts (Stop, tab hidden)
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
