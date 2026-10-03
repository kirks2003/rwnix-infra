# Jarvis web assistant

First-version browser Jarvis for Chrome desktop and Android Chrome.

## What it does

- Shows every stage in the web UI: boot, wake listening, wake detected, recording, 1.5 s silence stop, Whisper upload, LLM prompt, TTS speaking, errors, and backend request details.
- Uses vm103 Whisper wake probes for the word `Rocky`; browser speech recognition is not used for wake or prompt STT.
- Captures mono PCM continuously with an `AudioWorklet` while armed. Overlapping voice probes are encoded as complete WAV files, without gaps while Whisper responds.
- After wake detection, waits for the utterance to finish and sends its complete audio to Whisper. This preserves commands spoken immediately after "Rocky". A wake word alone opens a separate command window with an audible beep.
- Sends audio to one or more self-hosted Whisper endpoints through the backend, so the browser never needs cross-origin access to Whisper.
- Sends the recognized prompt to an OpenAI-compatible self-hosted brain through the backend, so API keys never reach the browser.
- Speaks the answer with the selected voice and writes both prompt and answer on the page. **Browser voice** uses `speechSynthesis`; **HAL 9000** uses a self-hosted neural TTS backend through the server proxy.

## Browser limitations

**Arm Jarvis sends voice-containing wake probes to your configured Whisper server even before a wake phrase is detected.** It is server-side wake detection, not a local/private wake-word model. Silent windows are not uploaded. A bounded 45-second PCM buffer stays in browser memory; the backend does not save recordings.

Keep the HTTPS page in the foreground. Hiding it explicitly stops the microphone, speech output and pending requests; return and click **Arm Jarvis** again. Microphone denial or interrupted capture is shown as an error. Wake response time includes a roughly two-second probe interval plus Whisper latency. This consumes server inference capacity while armed; an on-device wake engine would be a future alternative, not a feature of this build.

The reactor and active pipeline step follow the actual operation, not independent display timers. The STT status distinguishes configured endpoints from the last response's endpoint and request ID. Only one pipeline runs per tab. **Stop** invalidates all callbacks, aborts requests, releases tracks and cancels TTS; **Manual prompt** is available only when disarmed.

Set **Your wake word** and click **Apply wake word** to override the server default (`Rocky`) for your browser. Applying stops any active session; click **Arm Jarvis** again. The setting is saved in local storage per browser profile and website origin (the NBG and VIE URLs have separate settings), not shared with other users. Use 1-60 characters: words/numbers, spaces, hyphens or apostrophes. If storage is blocked, the UI explicitly reports that the change applies only until reload.

The **Live log** prints `Wake probe recognized: "..."` and `Command recognized: "..."` for Whisper responses, including non-wake speech. Empty responses show `(no speech recognized)`. Endpoint, request ID and attempt metadata follow separately. These readable transcripts are displayed in this tab, not added to persistent Docker logs; Clear removes the visible log.

Commands end after `SILENCE_MS` silence, with a 10-second wait for initial speech and a 15-second command limit. Whisper upstream requests time out after 20 seconds per endpoint and brain requests after 45 seconds. TTS has a bounded watchdog that cancels speech and reports an error rather than pretending playback finished.

## Answer voice

Pick **Answer voice** in the UI; the choice is saved in local storage per browser profile and origin, like the wake word, and applies to the next answer. An answer that is already being spoken finishes in the old voice.

- **Browser voice** — unchanged `speechSynthesis` behaviour, one utterance per answer, no backend needed.
- **HAL 9000** — the answer is split into clauses on sentence punctuation. Each clause is synthesized by the TTS endpoints in `TTS_ENDPOINTS` (requested at `speed` 0.8), then played through a Web Audio chain that band-limits it to roughly 95-3800 Hz, lifts 220 Hz, compresses it flat and adds a short room tail, with a 420 ms pause between clauses. The next clause is fetched while the current one plays.

`TTS_ENDPOINTS` must speak the OpenAI `/v1/audio/speech` protocol. The deployed backend is the `speaches` container on gpu-1, which serves both `/v1/audio/speech` (Kokoro) and `/v1/audio/transcriptions` (Whisper large-v3) behind one API key — see `DEPLOYMENT.md`. Kokoro-FastAPI and openedai-speech (which can front Piper) are drop-in alternatives. The browser only talks to `/api/speak` on this backend, so `TTS_API_KEY` stays on the host.

Multiple endpoints are comma-separated and tried round-robin with failover, like Whisper. Each clause request times out after 20 seconds. Measured against gpu-1 over HTTPS: about 0.5 s per clause for synthesis and 1.0 s for a short command transcription.

**Answer text is sent to the configured TTS endpoints.** `/api/speak` truncates at 2000 characters and clamps speed to 0.5-2.

With `TTS_ENDPOINTS` empty, HAL 9000 is still selectable but degrades to `speechSynthesis` at rate 0.68 and pitch 0.5, preferring a deep English voice if the browser has one: the cadence survives, the filtering and reverb do not. The same fallback finishes the remaining clauses if the TTS backend fails part-way through an answer, and the live log says so rather than dropping the rest of the answer.

## Runtime configuration

Copy `.env.example` to `.env` on the Docker host and set:

```env
PORT=8094
PUBLIC_BASE_PATH=/
WAKE_PHRASE=Rocky
SILENCE_MS=1500
WHISPER_ENDPOINTS=https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/transcriptions
WHISPER_MODEL=Systran/faster-whisper-large-v3
WHISPER_LANGUAGE=en
WHISPER_VAD_FILTER=true
WHISPER_API_KEY=
BRAIN_BASE_URL=https://ds4-flash.gpu-2-de-fra-1-exo.csdc-nm.at/v1
BRAIN_MODEL=deepseek-v4-flash
BRAIN_API_KEY=
TTS_ENDPOINTS=https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/speech
TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX
TTS_VOICE=bm_george
TTS_API_KEY=
```

Multiple Whisper endpoints are comma-separated and are tried round-robin with failover.
`WHISPER_API_KEY` and `TTS_API_KEY` are sent as bearer tokens to the voice services and never reach the browser; leave them empty for a no-auth endpoint.
Leave `BRAIN_API_KEY` empty for a no-auth self-hosted OpenAI-compatible endpoint, or set it on the host if the brain requires bearer auth.

## Local run

```bash
node server.js
```

Open <http://127.0.0.1:8094>.

## Docker run

```bash
docker compose up -d --build
```

The compose file binds `192.168.54.111:8094` for vm104. Live STT uses the vm103 Whisper endpoint configured in `WHISPER_ENDPOINTS`.

## Regression tests

Requires Node 20+ (20.3+ for `AbortSignal.any`) and Chromium's system libraries:

```bash
npm ci
npm test
npx playwright install --with-deps --no-shell chromium
npm run test:browser
```

Browser tests use actual Chromium microphone capture and the production AudioWorklet/WAV encoder with synthetic audio. STT/brain responses and TTS callbacks are controlled for lifecycle tests; they are not proof of physical microphone or speaker quality. `tests/voice.test.mjs` covers clause splitting and HAL playback sequencing against Web Audio stubs; actual playback is covered by the Chromium tests.

Optional live vm103 speech test (supply a WAV saying "Rocky, what time is it?" followed by five seconds of silence; Chromium loops the fixture):

```bash
JARVIS_LIVE_STT_ENDPOINT=http://192.168.53.111:8003/v1/audio/transcriptions \
JARVIS_TEST_LANGUAGE=en JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='actual vm103' tests/pipeline.browser.mjs
```

To exercise an isolated deployment through its actual backend, Whisper and brain (only headless TTS playback is simulated):

```bash
JARVIS_LIVE_BACKEND=http://127.0.0.1:18095 \
JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='candidate backend' tests/pipeline.browser.mjs
```

Use a localhost tunnel or HTTPS origin for microphone access. These opt-in checks send the fixture audio and prompt to the configured services.
