# Jarvis web assistant

First-version browser Jarvis for Chrome desktop and Android Chrome.

## What it does

- Shows every stage in the web UI: boot, wake listening, wake detected, recording, 1.5 s silence stop, Whisper upload, LLM prompt, TTS speaking, errors, and backend request details.
- Uses a Chrome-compatible wake listener for the phrase `Hey Jarvis`.
- Starts a rolling `MediaRecorder` when Jarvis is armed. When the wake phrase is detected, the active recording switches into command mode, stops after `SILENCE_MS` of silence, and uploads to Whisper.
- Sends audio to one or more self-hosted Whisper endpoints through the backend, so the browser never needs cross-origin access to Whisper.
- Sends the recognized prompt to an OpenAI-compatible self-hosted brain through the backend, so API keys never reach the browser.
- Speaks the answer with browser `speechSynthesis` and writes both prompt and answer on the page.

## Browser limitations

The wake listener uses Chrome's `webkitSpeechRecognition` as the first-version wake-word engine. It works in foreground tabs after the user clicks **Arm Jarvis**, but Android/Chrome can pause it when the screen locks, the tab is backgrounded, or the OS throttles the browser. A production wake word should replace this with an on-device WASM wake-word engine such as Porcupine or a custom model.

## Runtime configuration

Copy `.env.example` to `.env` on the Docker host and set:

```env
PORT=8094
PUBLIC_BASE_PATH=/
WAKE_PHRASE=hey jarvis
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
