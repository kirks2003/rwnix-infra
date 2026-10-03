import { Microphone, abortError, delay, wakeCommand, normalizeWakePhrase } from "./audio.js";

const el = Object.fromEntries([
  "core", "stageTitle", "stageDetail", "armButton", "stopButton", "testButton",
  "clearLogButton", "micLevel", "silenceLevel", "promptText", "answerText",
  "log", "steps", "promptDialog", "manualPrompt", "whisperStatus",
  "wakeWordForm", "wakeWordInput", "saveWakeWordButton", "wakeWordStatus",
].map((id) => [id, document.getElementById(id)]));
const steps = ["wake", "record", "vad", "whisper", "brain", "tts"];
const sessionId = crypto.randomUUID();
const wakeWordStorageKey = "jarvis.wakePhrase";
let config;
let current = null;
let sequence = 0;

function log(scope, message, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${scope}: ${message}`;
  el.log.textContent = `${el.log.textContent}${line}${data ? ` ${JSON.stringify(data)}` : ""}\n`.slice(-24000);
  el.log.scrollTop = el.log.scrollHeight;
}

function stage(kind, title, detail, active = null) {
  el.core.className = `core ${kind}`;
  el.stageTitle.textContent = title;
  el.stageDetail.textContent = detail;
  for (const item of el.steps.children) item.classList.remove("active");
  if (active) mark(active, "active");
  log("stage", `${title}: ${detail}`);
}

function mark(step, status) {
  el.steps.querySelector(`[data-step="${step}"]`).className = status;
}

function resetSteps() {
  for (const step of steps) mark(step, "");
}

function check(session) {
  session.signal.throwIfAborted();
  if (session !== current) throw abortError();
}

function stop(message = "Jarvis is disarmed.") {
  const old = current;
  current = null;
  old?.controller.abort(abortError());
  speechSynthesis.cancel();
  el.armButton.disabled = !config;
  el.testButton.disabled = !config;
  el.stopButton.disabled = true;
  el.micLevel.value = 0;
  el.silenceLevel.value = 0;
  stage("standby", "Stopped", message);
}

function newSession() {
  stop();
  const controller = new AbortController();
  const session = { controller, signal: controller.signal, id: ++sequence };
  current = session;
  el.armButton.disabled = true;
  el.testButton.disabled = true;
  el.stopButton.disabled = false;
  resetSteps();
  log("session", `Started ${session.id}`);
  return session;
}

async function request(session, url, options = {}) {
  check(session);
  const timeout = AbortSignal.timeout(60000);
  const signal = AbortSignal.any([session.signal, timeout]);
  const response = await fetch(url, { ...options, signal, cache: "no-store" });
  const data = await response.json();
  check(session);
  if (!response.ok || data.error) {
    log("backend", "Request failed", data);
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function transcribe(session, start, purpose) {
  check(session);
  const blob = session.mic.buffer.wav(start);
  stage("transcribing", purpose === "wake" ? "Checking wake word" : "Transcribing command",
    `Sending ${Math.round(blob.size / 1024)} KB to ${config.whisperEndpoints.join(", ")}`, purpose === "wake" ? "wake" : "whisper");
  const result = await request(session, "/api/transcribe", {
    method: "POST", headers: { "content-type": blob.type }, body: blob,
  });
  el.whisperStatus.textContent = `Last ${purpose}: ${result.endpoint} | request ${result.requestId}`;
  const { text, ...details } = result;
  log("whisper", `${purpose === "wake" ? "Wake probe" : "Command"} recognized: ${text ? JSON.stringify(text) : "(no speech recognized)"}`);
  log("whisper", "Response details", details);
  return result.text || "";
}

async function tick(session) {
  await delay(100, session.signal);
  check(session);
  session.mic.check();
  el.micLevel.value = Math.min(100, session.mic.buffer.level * 800);
}

async function waitForCommandEnd(session, start, needsSpeech) {
  const buffer = session.mic.buffer;
  const started = performance.now();
  stage(needsSpeech ? "prompting" : "recording", needsSpeech ? "Speak after the beep" : "Listening for command",
    `Stops after ${config.silenceMs} ms of silence. All speech goes to vm103 Whisper.`, "record");
  if (needsSpeech) session.mic.beep();
  const speechAfter = start + (needsSpeech ? buffer.sampleRate * 0.3 : 0);
  let heard = !needsSpeech;
  while (performance.now() - started < 15000) {
    await tick(session);
    if (buffer.lastVoice > speechAfter) heard = true;
    const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
    el.silenceLevel.value = heard ? Math.min(config.silenceMs, silentMs) : 0;
    if (heard) {
      mark("vad", "active");
      if (silentMs >= config.silenceMs) {
        mark("record", "done");
        mark("vad", "done");
        return;
      }
    } else if (performance.now() - started > 10000) {
      throw new Error("No command heard within 10 seconds. Returning to wake listening.");
    }
  }
  log("record", "15-second command limit reached; transcribing captured speech");
  mark("record", "done");
  mark("vad", "done");
}

async function listen(session) {
  let failures = 0;
  while (!session.signal.aborted) {
    check(session);
    resetSteps();
    const buffer = session.mic.buffer;
    const floor = buffer.end;
    let probedThrough = floor;
    stage("wake", "Wake listening", `Say "${config.wakePhrase}". Voice probes go to vm103 Whisper.`, "wake");
    try {
      for (;;) {
        await tick(session);
        if (buffer.end - probedThrough < buffer.sampleRate * 2 || buffer.lastVoice <= probedThrough) continue;
        // Overlap probes so a phrase crossing a probe boundary is not lost.
        const start = Math.max(floor, probedThrough - buffer.sampleRate * 2, buffer.end - buffer.sampleRate * 25);
        probedThrough = buffer.end;
        const text = await transcribe(session, start, "wake");
        failures = 0;
        if (wakeCommand(text, config.wakePhrase) === null) {
          stage("wake", "Wake listening", `No wake phrase heard. Say "${config.wakePhrase}".`, "wake");
          continue;
        }
        mark("wake", "done");
        log("wake", "Detected by vm103; completing the buffered utterance");
        // Capture continues during the Whisper request, including command tails.
        await waitForCommandEnd(session, start, false);
        const fullText = await transcribe(session, start, "command");
        let prompt = wakeCommand(fullText, config.wakePhrase);
        if (prompt === null) throw new Error("Whisper did not confirm the wake phrase in the completed utterance.");
        if (!prompt) {
          const commandStart = buffer.end;
          await waitForCommandEnd(session, commandStart, true);
          const commandText = await transcribe(session, commandStart, "command");
          prompt = wakeCommand(commandText, config.wakePhrase) ?? commandText.trim();
        } else {
          session.mic.beep();
        }
        if (!prompt) throw new Error("Whisper returned no command. Please speak after the beep.");
        mark("whisper", "done");
        await answer(session, prompt);
        // Exclude TTS and confirmation sounds from the next wake window.
        await delay(500, session.signal);
        break;
      }
    } catch (error) {
      check(session);
      log("error", error.message);
      el.steps.querySelector(".active")?.classList.add("error");
      stage("error", "Pipeline error", error.message);
      await delay(Math.min(15000, 2000 * 2 ** failures++), session.signal);
      session.mic.check();
    }
  }
}

async function answer(session, prompt) {
  check(session);
  el.promptText.textContent = prompt;
  el.answerText.textContent = "";
  stage("thinking", "Thinking", "Waiting for the configured self-hosted brain.", "brain");
  const result = await request(session, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
  });
  if (!result.answer) throw new Error("Brain returned no answer");
  log("brain", `Request ${result.requestId} completed`);
  mark("brain", "done");
  el.answerText.textContent = result.answer;
  stage("speaking", "Speaking", "Browser text-to-speech is reading the answer.", "tts");
  await speak(session, result.answer);
  check(session);
  mark("tts", "done");
}

function speak(session, text) {
  return new Promise((resolve, reject) => {
    check(session);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = config.whisperLanguage || navigator.language;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.signal.removeEventListener("abort", cancelled);
      utterance.onend = utterance.onerror = null;
      if (error) speechSynthesis.cancel();
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => finish(session.signal.reason);
    const timer = setTimeout(() => finish(new Error("Speech output timed out; audio was cancelled.")),
      Math.min(90000, Math.max(5000, text.length * 100 + 3000)));
    session.signal.addEventListener("abort", cancelled, { once: true });
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(`Speech output failed: ${event.error}`));
    try {
      speechSynthesis.cancel();
      speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    } catch (error) {
      finish(error);
    }
  });
}

function fatal(session, error) {
  if (session !== current || session.signal.aborted) return;
  stop();
  stage("error", "Stopped after error", error.message);
  log("error", error.stack || error.message);
}

el.armButton.addEventListener("click", async () => {
  if (!config || document.hidden) return;
  const session = newSession();
  stage("prompting", "Opening microphone", "Allow microphone access. Keep this tab in the foreground.");
  try {
    session.mic = new Microphone(session.signal);
    const unlock = new SpeechSynthesisUtterance("");
    speechSynthesis.speak(unlock);
    await session.mic.start();
    check(session);
    await listen(session);
  } catch (error) {
    fatal(session, error);
  }
});
el.stopButton.addEventListener("click", () => stop());
el.testButton.addEventListener("click", () => el.promptDialog.showModal());
el.promptDialog.addEventListener("close", async () => {
  const prompt = el.manualPrompt.value.trim();
  if (el.promptDialog.returnValue !== "send" || !prompt || current) return;
  el.manualPrompt.value = "";
  const session = newSession();
  for (const name of ["wake", "record", "vad", "whisper"]) mark(name, "skipped");
  try {
    await answer(session, prompt);
    check(session);
    stop("Manual prompt complete. Click Arm Jarvis for voice mode.");
  } catch (error) {
    fatal(session, error);
  }
});
el.clearLogButton.addEventListener("click", () => { el.log.textContent = ""; });
el.wakeWordInput.addEventListener("input", () => el.wakeWordInput.setCustomValidity(""));
el.wakeWordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!config) return;
  let phrase;
  try {
    phrase = normalizeWakePhrase(el.wakeWordInput.value);
  } catch (error) {
    el.wakeWordInput.setCustomValidity(error.message);
    el.wakeWordInput.reportValidity();
    el.wakeWordStatus.textContent = `Wake word unchanged. ${error.message}`;
    return;
  }
  stop(`Wake word changed to "${phrase}". Click Arm Jarvis to listen.`);
  config.wakePhrase = phrase;
  el.wakeWordInput.value = phrase;
  try {
    localStorage.setItem(wakeWordStorageKey, phrase);
    el.wakeWordStatus.textContent = `Saved for this browser: "${phrase}". Click Arm Jarvis to use it.`;
  } catch (error) {
    el.wakeWordStatus.textContent = `Using "${phrase}" for this tab only; browser storage is unavailable.`;
    log("settings", "Could not save wake word", { message: error.message });
  }
  log("settings", `Active wake word: ${JSON.stringify(phrase)}. Previous session stopped.`);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && current) stop("Tab hidden; microphone and pending requests stopped. Re-arm when ready.");
});
window.addEventListener("pagehide", () => stop());
el.armButton.disabled = el.testButton.disabled = true;
stage("standby", "Loading", "Loading runtime configuration.");
fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10000) })
  .then(async (response) => {
    if (!response.ok) throw new Error(`Configuration HTTP ${response.status}`);
    const value = await response.json();
    if (!value.whisperEndpoints?.length || !value.wakePhrase || !(value.silenceMs > 0)) {
      throw new Error("Invalid Whisper/wake configuration");
    }
    config = value;
    el.wakeWordStatus.textContent = `Server default: "${config.wakePhrase}". Apply a personal wake word for this browser.`;
    try {
      const saved = localStorage.getItem(wakeWordStorageKey);
      if (saved !== null) {
        config.wakePhrase = normalizeWakePhrase(saved);
        el.wakeWordStatus.textContent = `Personal wake word loaded for this browser: "${config.wakePhrase}".`;
      }
    } catch (error) {
      el.wakeWordStatus.textContent = `Could not load a saved wake word; using server default "${config.wakePhrase}".`;
      log("settings", "Could not load wake word", { message: error.message });
    }
    el.wakeWordInput.value = config.wakePhrase;
    el.wakeWordInput.disabled = el.saveWakeWordButton.disabled = false;
    el.silenceLevel.max = config.silenceMs;
    el.whisperStatus.textContent = `Configured STT: ${config.whisperEndpoints.join(", ")} (no request yet)`;
    el.armButton.disabled = el.testButton.disabled = false;
    stage("standby", "Standby", "Arm to send voice probes to vm103. Microphone audio stays local until a probe or command is sent.");
    log("build", "PCM lifecycle v2");
  })
  .catch((error) => stage("error", "Configuration failed", error.message));
