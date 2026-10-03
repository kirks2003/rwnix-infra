# Jarvis web assistant

First-version browser Jarvis for Chrome desktop and Android Chrome.

## What it does

- Shows every stage in the web UI: boot, wake listening, wake detected, recording, 1.5 s silence stop, Whisper upload, LLM prompt, TTS speaking, errors, and backend request details.
- Uses vm103 Whisper wake probes for the word `Rocky`; browser speech recognition is not used for wake or prompt STT.
- Captures mono PCM continuously with an `AudioWorklet` while armed. Overlapping voice probes are encoded as complete WAV files, without gaps while Whisper responds.
- After wake detection, waits for the utterance to finish and sends its complete audio to Whisper. This preserves commands spoken immediately after "Rocky". A wake word alone opens a separate command window with an audible beep.
- Sends audio to one or more self-hosted Whisper endpoints through the backend, so the browser never needs cross-origin access to Whisper.
- Sends the recognized prompt to an OpenAI-compatible self-hosted brain through the backend, so API keys never reach the browser.
- Speaks the answer with browser `speechSynthesis` and writes both prompt and answer on the page.

## Browser limitations

**Arm Jarvis sends voice-containing wake probes to your configured Whisper server even before a wake phrase is detected.** It is server-side wake detection, not a local/private wake-word model. Silent windows are not uploaded. A bounded 45-second PCM buffer stays in browser memory; the backend does not save recordings.

Keep the HTTPS page in the foreground. Hiding it explicitly stops the microphone, speech output and pending requests; return and click **Arm Jarvis** again. Microphone denial or interrupted capture is shown as an error. Wake response time includes a roughly two-second probe interval plus Whisper latency. This consumes server inference capacity while armed; an on-device wake engine would be a future alternative, not a feature of this build.

The reactor and active pipeline step follow the actual operation, not independent display timers. The STT status distinguishes configured endpoints from the last response's endpoint and request ID. Only one pipeline runs per tab. **Stop** invalidates all callbacks, aborts requests, releases tracks and cancels TTS; **Manual prompt** is available only when disarmed.

Set **Your wake word** and click **Apply wake word** to override the server default (`Rocky`) for your browser. Applying stops any active session; click **Arm Jarvis** again. The setting is saved in local storage per browser profile and website origin (the NBG and VIE URLs have separate settings), not shared with other users. Use 1-60 characters: words/numbers, spaces, hyphens or apostrophes. If storage is blocked, the UI explicitly reports that the change applies only until reload.

The **Live log** prints `Wake probe recognized: "..."` and `Command recognized: "..."` for Whisper responses, including non-wake speech. Empty responses show `(no speech recognized)`. Endpoint, request ID and attempt metadata follow separately. These readable transcripts are displayed in this tab, not added to persistent Docker logs; Clear removes the visible log.

Commands end after `SILENCE_MS` silence, with a 10-second wait for initial speech and a 15-second command limit. Whisper upstream requests time out after 20 seconds per endpoint and brain requests after 45 seconds. TTS has a bounded watchdog that cancels speech and reports an error rather than pretending playback finished.

## Runtime configuration

Copy `.env.example` to `.env` on the Docker host and set:

```env
PORT=8094
PUBLIC_BASE_PATH=/
WAKE_PHRASE=Rocky
SILENCE_MS=1500
WHISPER_ENDPOINTS=http://192.168.53.111:8003/v1/audio/transcriptions
WHISPER_MODEL=deepdml/faster-whisper-large-v3-turbo-ct2
WHISPER_LANGUAGE=de
WHISPER_VAD_FILTER=true
BRAIN_BASE_URL=https://ds4-flash.gpu-2-de-fra-1-exo.csdc-nm.at/v1
BRAIN_MODEL=deepseek-v4-flash
BRAIN_API_KEY=
```

Multiple Whisper endpoints are comma-separated and are tried round-robin with failover.
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

Browser tests use actual Chromium microphone capture and the production AudioWorklet/WAV encoder with synthetic audio. STT/brain responses and TTS callbacks are controlled for lifecycle tests; they are not proof of physical microphone or speaker quality.

Optional live vm103 speech test (supply a WAV saying "Rocky, what time is it?" followed by five seconds of silence; Chromium loops the fixture):

```bash
JARVIS_LIVE_STT_ENDPOINT=http://192.168.53.111:8003/v1/audio/transcriptions \
JARVIS_TEST_LANGUAGE=de JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='actual vm103' tests/pipeline.browser.mjs
```

To exercise an isolated deployment through its actual backend, Whisper and brain (only headless TTS playback is simulated):

```bash
JARVIS_LIVE_BACKEND=http://127.0.0.1:18095 \
JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='candidate backend' tests/pipeline.browser.mjs
```

Use a localhost tunnel or HTTPS origin for microphone access. These opt-in checks send the fixture audio and prompt to the configured services.
