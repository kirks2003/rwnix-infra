import { Microphone, abortError, delay, wakeCommand, normalizeWakePhrase } from "./audio.js";
import { voiceProfiles, normalizeVoiceId, normalizeVoiceSpeed, scaledRate, splitForSpeech,
  pickSynthesisVoice, pickGermanSynthesisVoice, voiceSpeedRange, NeuralVoice, VoiceError,
  textForSpeech, isStopCommand } from "./voice.js";
import { CoreVisualizer } from "./visualizer.js";

const el = Object.fromEntries([
  "core", "waveform", "levelReadout", "stageTitle", "stageDetail", "armButton", "stopButton",
  "clearLogButton", "micLevel", "micLevelValue", "silenceLevel", "silenceValue", "promptText", "answerText",
  "log", "steps", "pipelineStatus", "manualPromptForm", "manualPrompt", "sendManualButton",
  "wakeWordForm", "wakeWordInput", "saveWakeWordButton", "wakeWordStatus",
  "voiceForm", "voiceSelect", "saveVoiceButton", "voiceStatus", "voiceSpeed", "voiceSpeedValue",
  "languageSwitch", "languageStatus",
  "mcpSwitches",
  "speakSwitch", "speakStatus",
  "panelsToggle", "panelsBelow",
  "loginPanel", "loginForm", "loginUsername", "loginPassword", "loginButton", "loginStatus",
  "userLine", "signOutButton",
].map((id) => [id, document.getElementById(id)]));
const steps = ["wake", "record", "vad", "whisper", "brain", "tts"];
const sessionId = crypto.randomUUID();
const wakeWordStorageKey = "jarvis.wakePhrase";
const voiceStorageKey = "jarvis.voice";
const voiceSpeedStorageKey = "jarvis.voiceSpeed";
const languageStorageKey = "jarvis.language";
const speakEnabledStorageKey = "jarvis.speakEnabled";
const panelsStorageKey = "jarvis.panelsVisible";
let config;
let authedUser = null;
let voiceId = "browser";
let voiceSpeed = voiceSpeedRange.default;
let language = "en";
let speakEnabled = true;
let panelsVisible = true;
const mcpServers = [];
const mcpFlags = {};
let current = null;
let sequence = 0;
// Live state for the pipeline panel's status line and per-step timings.
let stageTitleNow = "Standby";
let probeCount = 0;
let pipelineStatusOverride = null;
const stepTimers = new Map();

// The hero shows a short caption about what is running — never endpoint
// URLs, host names or payload sizes. Those stay in the Live log and the
// pipeline status line.
const stageCaptions = {
  standby: "Arm Jarvis to unlock audio and start wake listening.",
  prompting: "Opening the microphone.",
  wake: "Listening for the wake word.",
  recording: "Recording your command.",
  transcribing: "Transcribing your words.",
  thinking: "The brain is working on an answer.",
  speaking: "Speaking the answer.",
  error: "Something went wrong. See the Live log for details.",
};

// The capture voice threshold in audio.js: below it, sound is not tracked
// as voice. Used for the post-answer settle so the assistant's own voice
// (speaker echo) dies down before the next wake window starts.
const VOICE_THRESHOLD = 0.012;
// While an answer is being spoken, a parallel watch listens for the wake
// phrase; saying wake word + "stop" (or another command) cuts the speech.
// The settle is longer than the main probe (350 ms) so it does not fire on
// the short gaps between TTS clauses.
const SPEECH_WATCH_SETTLE_MS = 800;
const speechStopped = Symbol("speech stopped by voice");

const visualizer = new CoreVisualizer(el.waveform, el.core);
visualizer.pickAnalyser = () => {
  const session = current;
  if (!session) return null;
  // Speaking shows the agent's own voice when it is tappable; the microphone
  // drives every other armed stage.
  return visualizer.stage === "speaking" ? session.voice?.analyser ?? null : session.mic?.analyser ?? null;
};
// Numeric readout under the core; the visualizer throttles to ~10 updates/s.
visualizer.onLevel = (level) => {
  el.levelReadout.textContent = `LEVEL ${Math.round(level * 100)}%`;
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

// One switch per MCP server (the backend advertises the list in /api/config).
// Each flag is sent with every /api/chat request as `mcp: { id: bool }` and is
// saved in local storage per server.
function buildMcpSwitches() {
  el.mcpSwitches.replaceChildren(...mcpServers.map((server) => {
    const wrap = document.createElement("div");
    wrap.className = "language-control";
    const button = document.createElement("button");
    button.id = `mcpSwitch-${server.id}`;
    button.className = "lang-switch";
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", "false");
    button.disabled = true;
    button.title = `${server.label}: for every prompt the backend runs this MCP server and gives the brain its results as context. Saved in this browser only.`;
    const off = document.createElement("span");
    off.className = "lang-option";
    off.textContent = "off";
    const on = document.createElement("span");
    on.className = "lang-option";
    on.textContent = "on";
    const knob = document.createElement("span");
    knob.className = "lang-knob";
    knob.setAttribute("aria-hidden", "true");
    button.append(off, on, knob);
    const status = document.createElement("p");
    status.id = `mcpStatus-${server.id}`;
    status.setAttribute("role", "status");
    status.textContent = `Loading ${server.label.toLowerCase()} settings.`;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      setMcpFlag(server.id, !mcpFlags[server.id], true);
    });
    wrap.append(button, status);
    return wrap;
  }));
}

function setMcpFlag(id, value, persist) {
  const server = mcpServers.find((entry) => entry.id === id);
  if (!server) return;
  mcpFlags[id] = Boolean(value);
  const state = mcpFlags[id] ? "on" : "off";
  const button = document.getElementById(`mcpSwitch-${id}`);
  const status = document.getElementById(`mcpStatus-${id}`);
  button.setAttribute("aria-checked", String(mcpFlags[id]));
  button.setAttribute("aria-label", `${server.label}: ${state}`);
  if (persist) {
    try {
      localStorage.setItem(`jarvis.mcp.${id}`, String(mcpFlags[id]));
      status.textContent = `Saved: ${server.label} ${state}.`;
    } catch (error) {
      status.textContent = `${server.label} ${state} for this tab only; storage unavailable.`;
      log("settings", `Could not save ${server.label} setting`, { message: error.message });
    }
  } else {
    status.textContent = `Active: ${server.label} ${state}.`;
  }
  log("settings", `${server.label} (MCP): ${state}`);
}

// Speak answers on/off. Off means the answer is written to the Answer panel
// as text only; the wake pipeline itself keeps running.
function setSpeakEnabled(value, persist) {
  speakEnabled = Boolean(value);
  el.speakSwitch.setAttribute("aria-checked", String(speakEnabled));
  el.speakSwitch.setAttribute("aria-label", `Answer voice: ${speakEnabled ? "speaking" : "text only"}`);
  syncVoiceControls();
  if (persist) {
    try {
      localStorage.setItem(speakEnabledStorageKey, String(speakEnabled));
      el.speakStatus.textContent = `Saved: answers ${speakEnabled ? "are spoken" : "are text only"}.`;
    } catch (error) {
      el.speakStatus.textContent = `Answers ${speakEnabled ? "are spoken" : "are text only"} for this tab only; storage unavailable.`;
      log("settings", "Could not save voice output setting", { message: error.message });
    }
  } else {
    el.speakStatus.textContent = `Active: answers ${speakEnabled ? "are spoken" : "are text only"}.`;
  }
  log("settings", `Voice output: ${speakEnabled ? "on" : "off (text only)"}`);
}
el.speakSwitch.addEventListener("click", () => {
  if (el.speakSwitch.disabled) return;
  setSpeakEnabled(!speakEnabled, true);
});

function syncVoiceControls() {
  const enabled = Boolean(config) && speakEnabled;
  el.voiceSelect.disabled = !enabled;
  el.saveVoiceButton.disabled = !enabled;
  el.voiceSpeed.disabled = !enabled;
}

// Show/hide every panel below the Prompt/Answer row. Refused while a session
// runs, because the Stop button lives in the hidden area.
function setPanelsVisible(value, persist) {
  if (!value && current) {
    el.panelsToggle.setAttribute("aria-checked", "true");
    log("settings", "Panels stay visible while a session runs; stop it first.");
    return;
  }
  panelsVisible = Boolean(value);
  el.panelsBelow.hidden = !panelsVisible;
  el.panelsToggle.setAttribute("aria-checked", String(panelsVisible));
  if (persist) {
    try {
      localStorage.setItem(panelsStorageKey, String(panelsVisible));
    } catch (error) {
      log("settings", "Could not save panels setting", { message: error.message });
    }
  }
}
el.panelsToggle.addEventListener("click", () => setPanelsVisible(!panelsVisible, true));

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
  // Standby keeps its message (stop reasons, settings changes); every other
  // stage gets the short caption. Operational details stay in log + status.
  el.stageDetail.textContent = (kind === "standby" && detail) ? detail : (stageCaptions[kind] || "");
  for (const item of el.steps.children) item.classList.remove("active");
  if (active) mark(active, "active");
  stageTitleNow = title;
  pipelineStatusOverride = kind === "error" ? `Error: ${detail}` : null;
  el.pipelineStatus.textContent = pipelineStatus();
  log("stage", `${title}: ${detail}`);
}

function pipelineStatus() {
  if (pipelineStatusOverride) return pipelineStatusOverride;
  if (!current) return "Idle. Arm Jarvis to start.";
  const elapsed = Math.floor((performance.now() - current.startedAt) / 1000);
  const probes = `${probeCount} ${probeCount === 1 ? "probe" : "probes"} sent`;
  return `${stageTitleNow} · ${elapsed} s armed · ${probes}`;
}

// The li keeps its status as its only class (tests read className directly),
// so the state label lives in a child span that mark() keeps in sync.
function mark(step, status) {
  const item = el.steps.querySelector(`[data-step="${step}"]`);
  item.className = status;
  const state = item.querySelector(".step-state");
  if (!state) return;
  if (status === "active") {
    stepTimers.set(step, performance.now());
    state.textContent = "running";
  } else if (status === "done") {
    const started = stepTimers.get(step);
    stepTimers.delete(step);
    state.textContent = started
      ? `done in ${((performance.now() - started) / 1000).toFixed(1)} s`
      : "done";
  } else if (status === "skipped") {
    state.textContent = "skipped";
  } else if (status === "error") {
    state.textContent = "error";
  } else {
    stepTimers.delete(step);
    state.textContent = "waiting";
  }
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
  el.sendManualButton.disabled = !config;
  el.stopButton.disabled = true;
  for (const button of previewButtons) button.disabled = !config;
  el.micLevel.value = 0;
  el.micLevelValue.textContent = "0%";
  el.silenceLevel.value = 0;
  el.silenceValue.textContent = "0 ms";
  visualizer.resetLevel();
  el.levelReadout.textContent = "LEVEL 0%";
  stage("standby", "Stopped", message);
}

function newSession() {
  stop();
  const controller = new AbortController();
  const session = { controller, signal: controller.signal, id: ++sequence, startedAt: performance.now() };
  current = session;
  probeCount = 0;
  pipelineStatusOverride = null;
  el.armButton.disabled = true;
  el.sendManualButton.disabled = true;
  el.stopButton.disabled = false;
  for (const button of previewButtons) button.disabled = true;
  resetSteps();
  el.pipelineStatus.textContent = pipelineStatus();
  log("session", `Started ${session.id}`);
  return session;
}

async function request(session, url, options = {}) {
  check(session);
  const { signal: external, ...rest } = options;
  const timeout = AbortSignal.timeout(60000);
  const signals = [session.signal, timeout];
  if (external) signals.push(external);
  const signal = AbortSignal.any(signals);
  const response = await fetch(url, { ...rest, signal, cache: "no-store" });
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
  if (purpose === "wake") probeCount += 1;
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
  el.micLevelValue.textContent = `${Math.round(el.micLevel.value)}%`;
  const status = pipelineStatus();
  if (status !== el.pipelineStatus.textContent) el.pipelineStatus.textContent = status;
}

// The silence meter shows live trailing silence during wake listening, so
// speaking the wake word is visible: the bar fills after the last voice and
// the probe fires once speech settles for 350 ms.
function updateWakeSilenceMeter(session) {
  const buffer = session.mic.buffer;
  const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
  el.silenceLevel.value = Math.min(config.silenceMs, silentMs);
  el.silenceValue.textContent = `${Math.round(el.silenceLevel.value)} ms`;
}

async function waitForCommandEnd(session, start, needsSpeech) {
  const buffer = session.mic.buffer;
  const started = performance.now();
  stage(needsSpeech ? "prompting" : "recording", needsSpeech ? "Speak after the beep" : "Listening for command",
    `Stops after ${config.silenceMs} ms of silence.`, "record");
  if (needsSpeech) session.mic.beep();
  const speechAfter = start + (needsSpeech ? buffer.sampleRate * 0.3 : 0);
  let heard = !needsSpeech;
  let shown = 0;
  while (performance.now() - started < 15000) {
    await tick(session);
    if (buffer.lastVoice > speechAfter) heard = true;
    const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
    el.silenceLevel.value = heard ? Math.min(config.silenceMs, silentMs) : 0;
    el.silenceValue.textContent = `${Math.round(el.silenceLevel.value)} ms`;
    // This stage can hold for up to 15 s on a noisy microphone that never goes
    // quiet, so count down in the pipeline status line rather than looking
    // frozen. Updated without stage() so the live log is not flooded.
    const elapsed = performance.now() - started;
    if (elapsed - shown >= 500) {
      shown = elapsed;
      pipelineStatusOverride = heard
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

// After an answer, let the assistant's own voice (speaker echo) die down
// before the next wake window, so the first probe of the new cycle is not
// contaminated. Bounded, so a never-quiet microphone only delays the cycle.
async function waitForQuiet(session, maxMs, quietMs) {
  const deadline = performance.now() + maxMs;
  let quietFor = 0;
  while (performance.now() < deadline) {
    quietFor = session.mic.buffer.level < VOICE_THRESHOLD ? quietFor + 100 : 0;
    if (quietFor >= quietMs) return;
    await delay(100, session.signal);
  }
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
    stage("wake", "Wake listening", `Say "${config.wakePhrase}".`, "wake");
    try {
      for (;;) {
        await tick(session);
        updateWakeSilenceMeter(session);
        if (buffer.lastVoice <= probedThrough) continue;
        // Probe on the trailing edge of speech, not on a fixed interval: a window
        // that ends mid-word comes back from Whisper empty, so the phrase is only
        // heard one probe cycle later. Hold until the talker stops; if speech runs
        // on, probe anyway once this burst reaches the cap. The cap counts speech,
        // not wall time, so leading silence cannot trip it mid-word.
        speechFrom ??= buffer.lastVoice;
        const settled = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000 >= 350;
        const forced = !settled && buffer.end - speechFrom >= buffer.sampleRate * 3;
        if (!settled && !forced) continue;
        // Settled probes overlap the previous window by 2 s so a phrase crossing
        // the boundary is not lost. A forced probe (3 s of unbroken speech, e.g.
        // a noisy microphone that never settles) covers everything since the last
        // probe, so a short wake phrase cannot fall into the gap between probes.
        const start = settled
          ? Math.max(floor, probedThrough - buffer.sampleRate * 2, buffer.end - buffer.sampleRate * 25)
          : Math.max(floor, probedThrough, buffer.end - buffer.sampleRate * 25);
        probedThrough = buffer.end;
        speechFrom = null;
        log("wake", forced ? "Probe triggered by the 3 s speech cap (microphone never settled)" : "Probe triggered after speech settled");
        const text = await transcribe(session, start, "wake");
        failures = 0;
        if (wakeCommand(text, config.wakePhrase) === null) {
          stage("wake", "Wake listening", `No wake phrase heard. Say "${config.wakePhrase}".`, "wake");
          continue;
        }
        mark("wake", "done");
        log("wake", "Detected; completing the buffered utterance");
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
        // Let the spoken answer die down, then exclude confirmation sounds from
        // the next wake window.
        await waitForQuiet(session, 1000, 200);
        await delay(300, session.signal);
        break;
      }
    } catch (error) {
      check(session);
      log("error", error.message);
      const failed = el.steps.querySelector(".active");
      if (failed) {
        failed.classList.add("error");
        failed.querySelector(".step-state")?.replaceChildren("error");
      }
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
    body: JSON.stringify({ prompt, sessionId, language, mcp: mcpFlags }),
  });
  if (!result.answer) throw new Error("Brain returned no answer");
  log("brain", `Request ${result.requestId} completed`);
  mark("brain", "done");
  el.answerText.textContent = result.answer;
  if (!speakEnabled) {
    mark("tts", "skipped");
    log("tts", "Voice output is switched off; the answer stays text only.");
    return;
  }
  stage("speaking", "Speaking", `${voiceProfiles[voiceId].label} is reading the answer at ${voiceSpeed.toFixed(2)}x.`, "tts");
  const speech = new AbortController();
  session.speech = speech;
  try {
    const followUp = await speak(session, result.answer, speech.signal);
    check(session);
    if (followUp === null) {
      mark("tts", "done");
      return;
    }
    // The user interrupted the speech by voice (wake word + command).
    if (isStopCommand(followUp)) {
      log("tts", `Speech stopped by voice command "${followUp}".`);
      mark("tts", "skipped");
      session.mic.beep();
      return;
    }
    log("tts", `Speech interrupted by voice command: ${JSON.stringify(followUp)}`);
    mark("tts", "skipped");
    await answer(session, followUp);
    return;
  } finally {
    session.speech = null;
  }
}

async function speak(session, text, speechSignal) {
  const profile = voiceProfiles[voiceId];
  // The printed answer stays verbatim; only the speaker gets plain language
  // without special signs.
  const spoken = textForSpeech(text);
  const signal = AbortSignal.any([session.signal, speechSignal]);
  const watch = watchForVoiceCommand(session, signal, speechSignal);
  try {
    if (language === "de") {
      // The self-hosted engine (Kokoro) has no German voices, so German is
      // spoken by the browser voice in the selected profile's cadence.
      log("tts", `German selected: the self-hosted TTS engine is English-only; ${profile.label} falls back to the browser voice.`);
      await speakWithSynthesis(session, splitForSpeech(spoken, profile.chunkChars), profile, signal);
      return null;
    }
    if (profile.neural && config.ttsConfigured) {
      const voice = new NeuralVoice(signal, profile);
      session.voice = voice;
      try {
        await voice.speak(spoken, {
          speed: scaledRate(profile.speed, voiceSpeed),
          onChunk: (chunk, index, total) => log("tts", `${profile.label} clause ${index + 1}/${total}`, { chars: chunk.length }),
        });
        return null;
      } catch (error) {
        if (!(error instanceof VoiceError)) throw error;
        // error.remaining is already split from the sanitized spoken text.
        log("tts", `Self-hosted TTS failed; finishing the answer with the browser voice: ${error.message}`);
        await speakWithSynthesis(session, error.remaining, profile, signal);
        return null;
      } finally {
        voice.close();
        session.voice = null;
      }
    }
    if (profile.neural) log("tts", `No TTS backend configured; using the browser voice at ${profile.label} cadence.`);
    await speakWithSynthesis(session, splitForSpeech(spoken, profile.chunkChars), profile, signal);
    return null;
  } catch (error) {
    if (error === speechStopped) return watch.command;
    throw error;
  } finally {
    watch.stop();
  }
}

// Parallel wake watch for the duration of the speech: on a trailing edge
// (800 ms of silence) it transcribes the window and, if the wake phrase is in
// there, aborts the speech with `speechStopped` and keeps the command. Probe
// failures are swallowed: a bad probe must not kill the answer.
function watchForVoiceCommand(session, signal, speechSignal) {
  let command = null;
  let watching = true;
  // The manual-prompt flow has no microphone, so the watch is a no-op there.
  let probedThrough = session.mic ? session.mic.buffer.end : 0;
  const runner = (async () => {
    if (!session.mic) return;
    while (watching && !signal.aborted) {
      await delay(150, signal).catch(() => {});
      if (!watching || signal.aborted) return;
      const buffer = session.mic.buffer;
      if (buffer.lastVoice <= probedThrough) continue;
      const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
      if (silentMs < SPEECH_WATCH_SETTLE_MS) continue;
      probedThrough = buffer.end;
      const start = Math.max(probedThrough - buffer.sampleRate * 2, buffer.end - buffer.sampleRate * 15);
      try {
        const blob = buffer.wav(start);
        const result = await request(session, `/api/transcribe?language=${language}`, {
          method: "POST", headers: { "content-type": blob.type }, body: blob, signal,
        });
        const detected = wakeCommand(result.text || "", config.wakePhrase);
        if (detected !== null) {
          command = detected;
          log("wake", `Wake phrase heard while speaking: ${JSON.stringify(result.text || "")}`);
          speechSignal.abort(speechStopped);
          return;
        }
      } catch (error) {
        if (error === speechStopped || signal.aborted) return;
      }
    }
  })();
  runner.catch(() => {});
  return { stop: () => { watching = false; }, get command() { return command; } };
}

async function speakWithSynthesis(session, chunks, baseProfile, signal) {
  const profile = { ...baseProfile, rate: scaledRate(baseProfile.rate, voiceSpeed) };
  const voice = language === "de"
    ? pickGermanSynthesisVoice(speechSynthesis.getVoices(), profile.gender)
    : (profile.voiceHints ? pickSynthesisVoice(speechSynthesis.getVoices(), profile) : null);
  if (voice) log("tts", `Browser voice selected: ${voice.name} (${voice.lang})`);
  for (const [index, chunk] of chunks.entries()) {
    await utter(session, chunk, profile, voice, signal);
    if (profile.pauseMs && index < chunks.length - 1) await delay(profile.pauseMs, signal);
  }
}

function utter(session, text, profile, voice, signal) {
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
      signal.removeEventListener("abort", cancelled);
      utterance.onend = utterance.onerror = null;
      if (error) speechSynthesis.cancel();
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Speech output timed out; audio was cancelled.")),
      Math.min(90000, Math.max(5000, text.length * 100 / profile.rate + 3000)));
    signal.addEventListener("abort", cancelled, { once: true });
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

// Direct prompt input in the Prompt panel: same flow as the old manual prompt
// dialog, available only while disarmed.
el.manualPromptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = el.manualPrompt.value.trim();
  if (!prompt || current) return;
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
    : config.ttsConfigured ? `Self-hosted TTS: ${config.ttsModel} / ${profile.ttsVoice || config.ttsVoice}, shaped in the browser.`
      : "No TTS backend configured, so a matching browser voice is used at the profile's cadence only.";
  el.voiceStatus.textContent = `Voice: ${profile.label}. ${detail} Applies to the next answer.`;
  if (!persist) return;
  try {
    localStorage.setItem(voiceStorageKey, id);
  } catch (error) {
    el.voiceStatus.textContent = `Voice: ${profile.label} for this tab only; browser storage is unavailable.`;
    log("settings", "Could not save voice", { message: error.message });
  }
}

// --- Multi-user login -------------------------------------------------------
// The backend gates every /api route on an HttpOnly session cookie. A 401 on
// /api/config means "not signed in", so the login panel takes over the shell.
// Each user's prompt history is keyed by their account on the server, so
// Mila and Roman never share a conversation.
function showLogin(message) {
  authedUser = null;
  document.body.classList.remove("authenticated");
  el.loginPanel.hidden = false;
  el.loginStatus.classList.remove("error");
  el.loginStatus.textContent = message || "The password is your username.";
  el.userLine.textContent = "";
  stop("Signed out.");
  stage("standby", "Sign in", "Enter your name and password to open your shell.");
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = el.loginUsername.value.trim();
  const password = el.loginPassword.value;
  if (!username || !password) return;
  el.loginButton.disabled = true;
  el.loginStatus.classList.remove("error");
  el.loginStatus.textContent = "Signing in...";
  let response;
  try {
    response = await fetch("/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }), cache: "no-store",
    });
  } catch (error) {
    el.loginStatus.classList.add("error");
    el.loginStatus.textContent = `Could not reach the server: ${error.message}`;
    el.loginButton.disabled = false;
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    el.loginStatus.classList.add("error");
    el.loginStatus.textContent = response.status === 429
      ? "Too many failed attempts; wait a moment and try again."
      : "Wrong username or password.";
    el.loginPassword.value = "";
    el.loginButton.disabled = false;
    return;
  }
  el.loginPassword.value = "";
  el.loginButton.disabled = false;
  await loadConfig(data.user);
});

el.signOutButton.addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST", cache: "no-store" });
  } catch {
    // Local sign-out still applies; the session just stays valid server-side.
  }
  log("session", "Signed out.");
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && current) stop("Tab hidden; microphone and pending requests stopped. Re-arm when ready.");
});
window.addEventListener("pagehide", () => stop());
el.armButton.disabled = el.sendManualButton.disabled = true;
for (const button of previewButtons) button.disabled = true;
el.languageSwitch.disabled = true;
el.speakSwitch.disabled = true;
// The select is grouped Basic / Character / Female / Male so a male or female
// voice is a two-level choice; the stored value is still the flat profile id.
const voiceGroups = [
  ["basic", "Basic"],
  ["character", "Character voices"],
  ["female", "Female voices"],
  ["male", "Male voices"],
];
el.voiceSelect.replaceChildren(...voiceGroups.map(([group, label]) => {
  const optgroup = document.createElement("optgroup");
  optgroup.label = label;
  for (const profile of Object.values(voiceProfiles)) {
    if (profile.group !== group) continue;
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.label;
    optgroup.append(option);
  }
  return optgroup;
}));
async function loadConfig(userFromLogin) {
  stage("standby", "Loading", "Loading runtime configuration.");
  const response = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (response.status === 401) {
    showLogin();
    return;
  }
  if (!response.ok) throw new Error(`Configuration HTTP ${response.status}`);
  const value = await response.json();
  // A 200 means the server accepts our session (or runs without login), so the
  // app shell becomes visible and the login panel goes away.
  authedUser = userFromLogin || value.user || authedUser;
  document.body.classList.add("authenticated");
  el.loginPanel.hidden = true;
  el.userLine.textContent = authedUser ? `Signed in as ${authedUser}` : "";
    if (!value.whisperEndpoints?.length || !value.wakePhrase || !(value.silenceMs > 0)) {
      throw new Error("Invalid Whisper/wake configuration");
    }
    config = value;
    // The pipeline panel names reflect the actual configuration.
    el.steps.querySelector('[data-step="vad"] .step-name').textContent =
      `Stop after ${(config.silenceMs / 1000).toFixed(1).replace(/\.0$/, "")} s silence`;
    el.steps.querySelector('[data-step="brain"] .step-name').textContent =
      config.brainModel ? `${config.brainModel} brain` : "Brain";
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
    let savedSpeakEnabled = null;
    try {
      savedSpeakEnabled = localStorage.getItem(speakEnabledStorageKey);
    } catch (error) {
      log("settings", "Could not load voice output setting");
    }
    setSpeakEnabled(savedSpeakEnabled === null ? true : savedSpeakEnabled === "true", false);
    el.speakSwitch.disabled = false;
    let savedLanguage = null;
    try {
      savedLanguage = localStorage.getItem(languageStorageKey);
    } catch (error) {
      log("settings", "Could not load language", { message: error.message });
    }
    // The saved choice wins; otherwise English is the default.
    setLanguage(savedLanguage || "en", false);
    el.languageSwitch.disabled = false;
    mcpServers.push(...(value.mcpServers || []));
    buildMcpSwitches();
    for (const server of mcpServers) {
      let saved = null;
      try {
        saved = localStorage.getItem(`jarvis.mcp.${server.id}`);
      } catch (error) {
        log("settings", `Could not load ${server.label} setting`);
      }
      setMcpFlag(server.id, saved === "true", false);
      document.getElementById(`mcpSwitch-${server.id}`).disabled = false;
    }
    let savedPanels = null;
    try {
      savedPanels = localStorage.getItem(panelsStorageKey);
    } catch (error) {
      log("settings", "Could not load panels setting");
    }
    setPanelsVisible(savedPanels === null ? true : savedPanels === "true", false);
    el.silenceLevel.max = config.silenceMs;
    log("stt", `Configured STT: ${config.whisperEndpoints.join(", ")} (no request yet)`);
    el.armButton.disabled = el.sendManualButton.disabled = false;
    for (const button of previewButtons) button.disabled = false;
    stage("standby", "Standby", "Arm Jarvis to start wake listening. Microphone audio stays local until a probe or command is sent.");
    log("build", "PCM lifecycle v3");
}

loadConfig().catch((error) => stage("error", "Configuration failed", error.message));
