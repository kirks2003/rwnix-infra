import { Microphone, abortError, delay, wakeCommand, normalizeWakePhrase } from "./audio.js";
import { voiceProfiles, normalizeVoiceId, normalizeVoiceSpeed, scaledRate, splitForSpeech,
  pickSynthesisVoice, pickGermanSynthesisVoice, voiceSpeedRange, NeuralVoice, VoiceError } from "./voice.js";
import { CoreVisualizer } from "./visualizer.js";

const el = Object.fromEntries([
  "core", "waveform", "stageTitle", "stageDetail", "armButton", "stopButton", "testButton",
  "clearLogButton", "micLevel", "silenceLevel", "promptText", "answerText",
  "log", "steps", "promptDialog", "manualPrompt",
  "wakeWordForm", "wakeWordInput", "saveWakeWordButton", "wakeWordStatus",
  "voiceForm", "voiceSelect", "saveVoiceButton", "voiceStatus", "voiceSpeed", "voiceSpeedValue",
  "languageSwitch", "languageStatus",
].map((id) => [id, document.getElementById(id)]));
const steps = ["wake", "record", "vad", "whisper", "brain", "tts"];
const sessionId = crypto.randomUUID();
const wakeWordStorageKey = "jarvis.wakePhrase";
const voiceStorageKey = "jarvis.voice";
const voiceSpeedStorageKey = "jarvis.voiceSpeed";
const languageStorageKey = "jarvis.language";
let config;
let voiceId = "browser";
let voiceSpeed = voiceSpeedRange.default;
let language = "en";
let current = null;
let sequence = 0;

const visualizer = new CoreVisualizer(el.waveform, el.core);
visualizer.pickAnalyser = () => {
  const session = current;
  if (!session) return null;
  // Speaking shows the agent's own voice when it is tappable; the microphone
  // drives every other armed stage.
  return visualizer.stage === "speaking" ? session.voice?.analyser ?? null : session.mic?.analyser ?? null;
};
visualizer.start();

// Animation preview: click a pipeline stage without arming. The live pipeline
// owns the core while a session runs, so the buttons are disabled then.
const previewButtons = [...document.querySelectorAll("#stagePreview [data-stage]")];
const stagePreview = {
  standby: ["Standby", "Idle breathing. Arm Jarvis for the live pipeline.", null],
  wake: ["Wake listening", "Preview: slow ring spin. The waveform follows the live mic when armed.", "wake"],
  recording: ["Recording command", "Preview: fast spin while the VAD waits for 1.5 s of silence.", "record"],
  transcribing: ["Transcribing", "Preview: flicker while audio goes to Whisper.", "whisper"],
  thinking: ["Thinking", "Preview: fast flicker while the brain computes.", "brain"],
  speaking: ["Speaking", "Preview: pulse. The waveform runs a synthetic speech pattern.", "tts"],
  error: ["Pipeline error", "Preview: shake. The next live stage takes over from here.", null],
};
for (const button of previewButtons) {
  button.addEventListener("click", () => {
    const [title, detail, active] = stagePreview[button.dataset.stage];
    stage(button.dataset.stage, title, detail, active);
  });
}

// Language switch (English/Deutsch). One click flips the whole pipeline -
// Whisper, brain and spoken output - from the next request on, without
// stopping a running session.
function setLanguage(value, persist) {
  language = value === "de" ? "de" : "en";
  const label = language === "de" ? "Deutsch" : "English";
  el.languageSwitch.setAttribute("aria-checked", String(language === "de"));
  el.languageSwitch.setAttribute("aria-label", `Language: ${label}`);
  if (persist) {
    try {
      localStorage.setItem(languageStorageKey, language);
      el.languageStatus.textContent = `Saved: ${label}.`;
    } catch (error) {
      el.languageStatus.textContent = `${label} for this tab only; storage unavailable.`;
      log("settings", "Could not save language", { message: error.message });
    }
  } else {
    el.languageStatus.textContent = `Active: ${label}.`;
  }
  log("settings", `Language: ${language}`);
}
el.languageSwitch.addEventListener("click", () => {
  if (el.languageSwitch.disabled) return;
  setLanguage(language === "de" ? "en" : "de", true);
});

function log(scope, message, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${scope}: ${message}`;
  el.log.textContent = `${el.log.textContent}${line}${data ? ` ${JSON.stringify(data)}` : ""}\n`.slice(-24000);
  el.log.scrollTop = el.log.scrollHeight;
}

function stage(kind, title, detail, active = null) {
  el.core.className = `core ${kind}`;
  visualizer.setStage(kind);
  // Only a manual preview (no live session) highlights its button.
  for (const button of previewButtons) {
    button.classList.toggle("active", !current && button.dataset.stage === kind);
  }
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
  for (const button of previewButtons) button.disabled = !config;
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
  for (const button of previewButtons) button.disabled = true;
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
  const result = await request(session, `/api/transcribe?language=${language}`, {
    method: "POST", headers: { "content-type": blob.type }, body: blob,
  });
  log("stt", `Last ${purpose}: ${result.endpoint} | request ${result.requestId}`);
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
  let shown = 0;
  while (performance.now() - started < 15000) {
    await tick(session);
    if (buffer.lastVoice > speechAfter) heard = true;
    const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
    el.silenceLevel.value = heard ? Math.min(config.silenceMs, silentMs) : 0;
    // This stage can hold for up to 15 s on a noisy microphone that never goes
    // quiet, so count down in place rather than looking frozen. Updated without
    // stage() so the live log is not flooded.
    const elapsed = performance.now() - started;
    if (elapsed - shown >= 500) {
      shown = elapsed;
      el.stageDetail.textContent = heard
        ? `Recording: ${(elapsed / 1000).toFixed(1)} s. Stops after ${Math.max(0, Math.round(config.silenceMs - silentMs))} ms more silence, or at the 15 s limit.`
        : `Waiting for speech: ${(elapsed / 1000).toFixed(1)} s of 10 s. Mic level ${Math.round(buffer.level * 1000) / 10}%.`;
    }
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
    let speechFrom = null;
    stage("wake", "Wake listening", `Say "${config.wakePhrase}". Voice probes go to vm103 Whisper.`, "wake");
    try {
      for (;;) {
        await tick(session);
        if (buffer.lastVoice <= probedThrough) continue;
        // Probe on the trailing edge of speech, not on a fixed interval: a window
        // that ends mid-word comes back from Whisper empty, so the phrase is only
        // heard one probe cycle later. Hold until the talker stops; if speech runs
        // on, probe anyway once this burst reaches the cap. The cap counts speech,
        // not wall time, so leading silence cannot trip it mid-word.
        speechFrom ??= buffer.lastVoice;
        const settled = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000 >= 350;
        if (!settled && buffer.end - speechFrom < buffer.sampleRate * 3) continue;
        // Overlap probes so a phrase crossing a probe boundary is not lost.
        const start = Math.max(floor, probedThrough - buffer.sampleRate * 2, buffer.end - buffer.sampleRate * 25);
        probedThrough = buffer.end;
        speechFrom = null;
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
    body: JSON.stringify({ prompt, sessionId, language }),
  });
  if (!result.answer) throw new Error("Brain returned no answer");
  log("brain", `Request ${result.requestId} completed`);
  mark("brain", "done");
  el.answerText.textContent = result.answer;
  stage("speaking", "Speaking", `${voiceProfiles[voiceId].label} is reading the answer at ${voiceSpeed.toFixed(2)}x.`, "tts");
  await speak(session, result.answer);
  check(session);
  mark("tts", "done");
}

async function speak(session, text) {
  const profile = voiceProfiles[voiceId];
  if (language === "de") {
    // The self-hosted engine (Kokoro) has no German voices, so German is
    // spoken by the browser voice in the selected profile's cadence.
    log("tts", `German selected: the self-hosted TTS engine is English-only; ${profile.label} falls back to the browser voice.`);
    await speakWithSynthesis(session, splitForSpeech(text, profile.chunkChars), profile);
    return;
  }
  if (profile.neural && config.ttsConfigured) {
    session.voice ??= new NeuralVoice(session.signal, profile);
    try {
      await session.voice.speak(text, {
        speed: scaledRate(profile.speed, voiceSpeed),
        onChunk: (chunk, index, total) => log("tts", `${profile.label} clause ${index + 1}/${total}`, { chars: chunk.length }),
      });
      return;
    } catch (error) {
      if (!(error instanceof VoiceError)) throw error;
      log("tts", `Self-hosted TTS failed; finishing the answer with the browser voice: ${error.message}`);
      await speakWithSynthesis(session, error.remaining, profile);
      return;
    }
  }
  if (profile.neural) log("tts", `No TTS backend configured; using the browser voice at ${profile.label} cadence.`);
  await speakWithSynthesis(session, splitForSpeech(text, profile.chunkChars), profile);
}

async function speakWithSynthesis(session, chunks, baseProfile) {
  const profile = { ...baseProfile, rate: scaledRate(baseProfile.rate, voiceSpeed) };
  const voice = language === "de"
    ? pickGermanSynthesisVoice(speechSynthesis.getVoices())
    : (profile.voiceHints ? pickSynthesisVoice(speechSynthesis.getVoices(), profile) : null);
  if (voice) log("tts", `Browser voice selected: ${voice.name} (${voice.lang})`);
  for (const [index, chunk] of chunks.entries()) {
    await utter(session, chunk, profile, voice);
    if (profile.pauseMs && index < chunks.length - 1) await delay(profile.pauseMs, session.signal);
  }
}

function utter(session, text, profile, voice) {
  return new Promise((resolve, reject) => {
    check(session);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice?.lang || language || navigator.language;
    utterance.rate = profile.rate;
    utterance.pitch = profile.pitch;
    if (voice) utterance.voice = voice;
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
      Math.min(90000, Math.max(5000, text.length * 100 / profile.rate + 3000)));
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
el.voiceSpeed.addEventListener("input", () => {
  voiceSpeed = normalizeVoiceSpeed(el.voiceSpeed.value);
  el.voiceSpeedValue.textContent = `${voiceSpeed.toFixed(2)}x`;
});
el.voiceSpeed.addEventListener("change", () => {
  applyVoiceSpeed(el.voiceSpeed.value, true);
});
el.voiceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!config) return;
  applyVoice(el.voiceSelect.value, true);
});
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
function applyVoiceSpeed(value, persist) {
  voiceSpeed = normalizeVoiceSpeed(value);
  el.voiceSpeed.value = String(voiceSpeed);
  el.voiceSpeedValue.textContent = `${voiceSpeed.toFixed(2)}x`;
  const profile = voiceProfiles[voiceId];
  const effective = profile.neural && config.ttsConfigured
    ? `engine speed ${scaledRate(profile.speed, voiceSpeed)}`
    : `utterance rate ${scaledRate(profile.rate, voiceSpeed)}`;
  el.voiceStatus.textContent = `Voice: ${profile.label} at ${voiceSpeed.toFixed(2)}x (${effective}). Applies to the next answer.`;
  if (!persist) return;
  try {
    localStorage.setItem(voiceSpeedStorageKey, String(voiceSpeed));
  } catch (error) {
    el.voiceStatus.textContent = `Speed ${voiceSpeed.toFixed(2)}x for this tab only; browser storage is unavailable.`;
    log("settings", "Could not save speaking speed", { message: error.message });
  }
  log("settings", `Speaking speed ${voiceSpeed.toFixed(2)}x`);
}

function applyVoice(value, persist) {
  let id;
  try {
    id = normalizeVoiceId(value);
  } catch (error) {
    el.voiceStatus.textContent = `Voice unchanged. ${error.message}`;
    log("settings", "Could not apply voice", { message: error.message });
    return;
  }
  voiceId = id;
  el.voiceSelect.value = id;
  const profile = voiceProfiles[id];
  const detail = !profile.neural ? "Plain browser speech synthesis."
    : config.ttsConfigured ? `Self-hosted TTS: ${config.ttsModel} / ${config.ttsVoice}, shaped in the browser.`
      : "No TTS backend configured, so the browser voice is used at HAL cadence only.";
  el.voiceStatus.textContent = `Voice: ${profile.label}. ${detail} Applies to the next answer.`;
  if (!persist) return;
  try {
    localStorage.setItem(voiceStorageKey, id);
  } catch (error) {
    el.voiceStatus.textContent = `Voice: ${profile.label} for this tab only; browser storage is unavailable.`;
    log("settings", "Could not save voice", { message: error.message });
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && current) stop("Tab hidden; microphone and pending requests stopped. Re-arm when ready.");
});
window.addEventListener("pagehide", () => stop());
el.armButton.disabled = el.testButton.disabled = true;
for (const button of previewButtons) button.disabled = true;
el.languageSwitch.disabled = true;
el.voiceSelect.replaceChildren(...Object.values(voiceProfiles).map((profile) => {
  const option = document.createElement("option");
  option.value = profile.id;
  option.textContent = profile.label;
  return option;
}));
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
    let savedVoice = null;
    try {
      savedVoice = localStorage.getItem(voiceStorageKey);
    } catch (error) {
      log("settings", "Could not load voice", { message: error.message });
    }
    applyVoice(savedVoice ?? voiceId, false);
    let savedSpeed = null;
    try {
      savedSpeed = localStorage.getItem(voiceSpeedStorageKey);
    } catch (error) {
      log("settings", "Could not load speaking speed", { message: error.message });
    }
    applyVoiceSpeed(savedSpeed ?? voiceSpeed, false);
    el.voiceSelect.disabled = el.saveVoiceButton.disabled = el.voiceSpeed.disabled = false;
    let savedLanguage = null;
    try {
      savedLanguage = localStorage.getItem(languageStorageKey);
    } catch (error) {
      log("settings", "Could not load language", { message: error.message });
    }
    // The saved choice wins; otherwise the server default (WHISPER_LANGUAGE).
    setLanguage(savedLanguage || config.whisperLanguage || "en", false);
    el.languageSwitch.disabled = false;
    el.silenceLevel.max = config.silenceMs;
    log("stt", `Configured STT: ${config.whisperEndpoints.join(", ")} (no request yet)`);
    el.armButton.disabled = el.testButton.disabled = false;
    for (const button of previewButtons) button.disabled = false;
    stage("standby", "Standby", "Arm to send voice probes to vm103. Microphone audio stays local until a probe or command is sent.");
    log("build", "PCM lifecycle v2");
  })
  .catch((error) => stage("error", "Configuration failed", error.message));
