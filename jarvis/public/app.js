const state = {
  config: {
    wakePhrase: "hey jarvis",
    silenceMs: 1500,
  },
  armed: false,
  recording: false,
  wakeRecognition: null,
  recorder: null,
  audioStream: null,
  audioContext: null,
  analyser: null,
  vadFrame: null,
  chunks: [],
  silenceStartedAt: 0,
  sessionId: crypto.randomUUID(),
  pipelineRunId: 0,
  wakeRunId: 0,
  wakeRestartTimer: null,
  pendingWakeTimer: null,
  pendingWakeCommand: "",
  speechWatchdog: null,
  beepContext: null,
  busy: false,
};

const el = {
  core: document.getElementById("core"),
  stageTitle: document.getElementById("stageTitle"),
  stageDetail: document.getElementById("stageDetail"),
  armButton: document.getElementById("armButton"),
  stopButton: document.getElementById("stopButton"),
  testButton: document.getElementById("testButton"),
  clearLogButton: document.getElementById("clearLogButton"),
  micLevel: document.getElementById("micLevel"),
  silenceLevel: document.getElementById("silenceLevel"),
  promptText: document.getElementById("promptText"),
  answerText: document.getElementById("answerText"),
  log: document.getElementById("log"),
  steps: document.getElementById("steps"),
  promptDialog: document.getElementById("promptDialog"),
  manualPrompt: document.getElementById("manualPrompt"),
  sendManualButton: document.getElementById("sendManualButton"),
};

const stepOrder = ["wake", "record", "vad", "whisper", "brain", "tts"];
const stepLabels = {
  wake: "Wake word",
  record: "Record command",
  vad: "Stop after 1.5 s silence",
  whisper: "Whisper transcription",
  brain: "a1-deepseekv4flash brain",
  tts: "Browser speech output",
};

init();

async function init() {
  bindEvents();
  setPipelineStage("standby", "Standby", "Loading runtime configuration.");
  try {
    const config = await getJson("/api/config");
    state.config = { ...state.config, ...config };
    el.silenceLevel.max = String(state.config.silenceMs || 1500);
    log("config", "Runtime loaded", config);
    setPipelineStage("standby", "Standby", `Click Arm Jarvis, then say "${state.config.wakePhrase}".`);
  } catch (error) {
    fail("Could not load backend config", error);
  }
}

function waitForVoices() {
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length) {
      resolve(voices);
      return;
    }
    const timeout = window.setTimeout(() => {
      speechSynthesis.onvoiceschanged = null;
      resolve(speechSynthesis.getVoices());
    }, 800);
    speechSynthesis.onvoiceschanged = () => {
      window.clearTimeout(timeout);
      speechSynthesis.onvoiceschanged = null;
      resolve(speechSynthesis.getVoices());
    };
  });
}

function bindEvents() {
  el.armButton.addEventListener("click", armJarvis);
  el.stopButton.addEventListener("click", stopJarvis);
  el.testButton.addEventListener("click", () => el.promptDialog.showModal());
  el.clearLogButton.addEventListener("click", () => { el.log.textContent = ""; });
  el.promptDialog.addEventListener("close", () => {
    if (el.promptDialog.returnValue === "send") {
      const prompt = el.manualPrompt.value.trim();
      el.manualPrompt.value = "";
      if (prompt) processPrompt(prompt, { source: "manual" });
    }
  });
}

async function armJarvis() {
  try {
    await unlockAudio();
    state.armed = true;
    el.armButton.disabled = true;
    el.stopButton.disabled = false;
    startWakeRecognition();
  } catch (error) {
    fail("Audio unlock failed", error);
  }
}

function stopJarvis() {
  state.armed = false;
  state.busy = false;
  clearWakeRestart();
  clearPendingWake();
  clearSpeechWatchdog();
  stopWakeRecognition();
  stopRecording();
  resetPipeline();
  setPipelineStage("standby", "Stopped", "Jarvis is disarmed.");
  el.armButton.disabled = false;
  el.stopButton.disabled = true;
}

async function unlockAudio() {
  const utterance = new SpeechSynthesisUtterance("");
  speechSynthesis.speak(utterance);
  state.beepContext = state.beepContext || new AudioContext();
  if (state.beepContext.state === "suspended") await state.beepContext.resume();
  log("audio", "Browser audio unlocked by user gesture");
}

function playWakeBeep() {
  try {
    const context = state.beepContext || new AudioContext();
    state.beepContext = context;
    if (context.state === "suspended") context.resume();

    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    gain.connect(context.destination);

    for (const [offset, frequency] of [[0, 880], [0.09, 1320]]) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      oscillator.connect(gain);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.11);
    }
    log("audio", "Wake confirmation beep played");
  } catch (error) {
    log("audio", "Wake confirmation beep failed", normalizeError(error));
  }
}

function startWakeRecognition() {
  if (!state.armed || state.busy) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    fail("Wake listener unavailable", new Error("Chrome webkitSpeechRecognition is required for this first version."));
    return;
  }

  stopWakeRecognition();
  clearPendingWake();
  clearWakeRestart();
  const wakeRunId = ++state.wakeRunId;
  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    startPipelineRun();
    setPipelineStage("wake", "Wake listening", `Say "${state.config.wakePhrase}" to activate Jarvis.`, "wake");
    log("wake", "Wake recognition started");
  };

  recognition.onresult = (event) => {
    if (state.busy) return;
    const transcript = Array.from(event.results)
      .slice(event.resultIndex)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim()
      .toLowerCase();
    if (transcript) log("wake", `Heard: ${transcript}`);
    const wakePhrase = String(state.config.wakePhrase || "hey jarvis").toLowerCase();
    const wakeIndex = transcript.indexOf(wakePhrase);
    if (wakeIndex >= 0) {
      state.busy = true;
      clearPendingWake();
      clearWakeRestart();
      log("wake", "Wake phrase detected; locking wake listener and opening command recorder");
      playWakeBeep();
      setPipelineStage("prompting", "Wake detected", "Beep. Say your command now; Jarvis is opening the microphone.", "record");
      markStep("wake", "done");
      const inlineCommand = transcript.slice(wakeIndex + wakePhrase.length).replace(/^[,.;:!?\s]+/, "").trim();
      if (inlineCommand) {
        log("wake", `Ignored wake-recognition command tail so Whisper handles STT: ${inlineCommand}`);
      }
      stopWakeRecognition();
      log("record", "Opening command recorder; prompt text will be transcribed by vm103 Whisper.");
      setPipelineStage("prompting", "Waiting for prompt", "Jarvis is awake. Speak your command after the beep; vm103 Whisper will transcribe it.", "record");
      window.setTimeout(startCommandRecording, 300);
    }
  };

  recognition.onerror = (event) => {
    log("wake", `Wake recognition error: ${event.error}`, event);
    if (wakeRunId === state.wakeRunId && state.armed && !state.recording && !state.busy) restartWakeRecognition(1200);
  };

  recognition.onend = () => {
    log("wake", "Wake recognition ended");
    if (wakeRunId === state.wakeRunId && state.armed && !state.recording && !state.busy) restartWakeRecognition(500);
  };

  state.wakeRecognition = recognition;
  try {
    recognition.start();
  } catch (error) {
    log("wake", "Wake recognition start failed; retrying", normalizeError(error));
    if (state.armed && !state.busy) restartWakeRecognition(1200);
  }
}

function stopWakeRecognition() {
  if (!state.wakeRecognition) return;
  const recognition = state.wakeRecognition;
  state.wakeRecognition = null;
  recognition.onend = null;
  recognition.onerror = null;
  try {
    recognition.stop();
  } catch {
    recognition.abort();
  }
}

function restartWakeRecognition(delayMs = 500) {
  clearWakeRestart();
  if (!state.armed || state.busy) return;
  state.wakeRestartTimer = window.setTimeout(() => {
    state.wakeRestartTimer = null;
    startWakeRecognition();
  }, delayMs);
}

function clearWakeRestart() {
  if (state.wakeRestartTimer) window.clearTimeout(state.wakeRestartTimer);
  state.wakeRestartTimer = null;
}

function clearPendingWake() {
  if (state.pendingWakeTimer) window.clearTimeout(state.pendingWakeTimer);
  state.pendingWakeTimer = null;
  state.pendingWakeCommand = "";
}

async function startCommandRecording() {
  try {
    state.busy = true;
    state.recording = true;
    state.chunks = [];
    setPipelineStage("recording", "Listening for prompt", `Speak now. Recording stops after ${state.config.silenceMs} ms of silence.`, "record");
    log("record", "Command recorder is active; waiting for speech.");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    state.audioStream = stream;
    state.audioContext = new AudioContext();
    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 1024;
    source.connect(state.analyser);

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    state.recorder = new MediaRecorder(stream, { mimeType });
    state.recorder.ondataavailable = (event) => {
      if (event.data.size) state.chunks.push(event.data);
    };
    state.recorder.onstop = onRecordingStopped;
    state.recorder.start(250);
    log("record", `MediaRecorder started (${mimeType})`);
    monitorVoiceActivity();
  } catch (error) {
    state.recording = false;
    state.busy = false;
    fail("Could not start microphone recording", error);
    if (state.armed) restartWakeRecognition(1000);
  }
}

function monitorVoiceActivity() {
  const samples = new Uint8Array(state.analyser.frequencyBinCount);
  const threshold = 9;

  const tick = () => {
    if (!state.recording || !state.analyser) return;
    state.analyser.getByteFrequencyData(samples);
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const level = Math.min(100, Math.round(average * 2.4));
    el.micLevel.value = level;

    if (average > threshold) {
      state.silenceStartedAt = 0;
      el.silenceLevel.value = 0;
      markStep("vad", "active");
      updateStepText("vad", "Voice detected; waiting for silence.");
    } else {
      if (!state.silenceStartedAt) state.silenceStartedAt = performance.now();
      const silentFor = performance.now() - state.silenceStartedAt;
      el.silenceLevel.value = Math.min(state.config.silenceMs, silentFor);
      markStep("vad", "active");
      updateStepText("vad", `Silence ${Math.round(silentFor)} / ${state.config.silenceMs} ms.`);
      if (silentFor >= state.config.silenceMs) {
        log("vad", `${Math.round(silentFor)} ms silence detected; stopping recorder`);
        markStep("vad", "done");
        stopRecording();
        return;
      }
    }

    state.vadFrame = requestAnimationFrame(tick);
  };

  state.vadFrame = requestAnimationFrame(tick);
}

function stopRecording() {
  if (state.vadFrame) cancelAnimationFrame(state.vadFrame);
  state.vadFrame = null;
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
}

async function onRecordingStopped() {
  state.recording = false;
  markStep("record", "done");
  cleanupAudio();

  const blob = new Blob(state.chunks, { type: state.chunks[0]?.type || "audio/webm" });
  state.chunks = [];
  if (blob.size < 1200) {
    log("record", `Recording too small (${blob.size} bytes); returning to wake mode`);
    state.busy = false;
    if (state.armed) restartWakeRecognition(500);
    return;
  }

  try {
    setPipelineStage("transcribing", "Transcribing", "Sending command audio to the vm103 Whisper server.", "whisper");
    log("whisper", `Uploading ${blob.size} bytes to backend`);
    const transcribed = await postBlob("/api/transcribe", blob);
    log("whisper", "Whisper result", transcribed);

    if (!transcribed.text) throw new Error(transcribed.error || "Whisper returned empty text");
    markStep("whisper", "done");
    await processPrompt(transcribed.text, { source: "voice" });
  } catch (error) {
    state.busy = false;
    fail("Whisper transcription failed or no speech was detected", error);
    if (state.armed) restartWakeRecognition(1000);
  }
}

function cleanupAudio() {
  if (state.audioStream) state.audioStream.getTracks().forEach((track) => track.stop());
  if (state.audioContext) state.audioContext.close().catch(() => {});
  state.audioStream = null;
  state.audioContext = null;
  state.analyser = null;
  state.recorder = null;
  el.micLevel.value = 0;
  el.silenceLevel.value = 0;
}

async function processPrompt(prompt, meta = {}) {
  state.busy = true;
  if (meta.source === "manual") {
    stopWakeRecognition();
    startPipelineRun();
    markStep("wake", "skipped");
    markStep("record", "skipped");
    markStep("vad", "skipped");
    markStep("whisper", "skipped");
  }
  el.promptText.textContent = prompt;
  setPipelineStage("thinking", "Thinking", "Prompting the self-hosted a1-deepseekv4flash brain.", "brain");
  log("brain", `Prompt from ${meta.source || "unknown"}: ${prompt}`);

  try {
    const result = await postJson("/api/chat", { prompt, sessionId: state.sessionId });
    log("brain", "Brain result", result);
    markStep("brain", "done");
    el.answerText.textContent = result.answer || "No answer returned.";
    speak(result.answer || "No answer returned.");
  } catch (error) {
    state.busy = false;
    fail("Brain request failed", error);
    if (state.armed) restartWakeRecognition(1000);
  }
}

async function speak(text) {
  setPipelineStage("speaking", "Speaking", "Browser text-to-speech is reading the answer.", "tts");
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = await waitForVoices();
  let speechFinished = false;
  const completeSpeech = (reason) => {
    if (speechFinished) return;
    speechFinished = true;
    clearSpeechWatchdog();
    log("tts", `Speech finished (${reason})`);
    markStep("tts", "done");
    state.busy = false;
    finishPipelineSoon();
    if (state.armed) restartWakeRecognition(1200);
    else setPipelineStage("standby", "Standby", "Jarvis is disarmed.");
  };
  utterance.voice = voices.find((voice) => /british|uk|english/i.test(`${voice.name} ${voice.lang}`)) || voices[0] || null;
  utterance.rate = 0.96;
  utterance.pitch = 0.92;
  utterance.onend = () => completeSpeech("onend");
  utterance.onerror = (event) => {
    clearSpeechWatchdog();
    state.busy = false;
    fail("Speech synthesis failed", event.error || event);
    if (state.armed) restartWakeRecognition(1000);
  };
  speechSynthesis.cancel();
  speechSynthesis.resume();
  speechSynthesis.speak(utterance);
  state.speechWatchdog = window.setTimeout(() => completeSpeech("watchdog"), estimateSpeechMs(text));
  window.setTimeout(() => speechSynthesis.resume(), 250);
}

function estimateSpeechMs(text) {
  return Math.min(30000, Math.max(3500, String(text || "").length * 85 + 1500));
}

function clearSpeechWatchdog() {
  if (state.speechWatchdog) window.clearTimeout(state.speechWatchdog);
  state.speechWatchdog = null;
}

function setStage(kind, title, detail) {
  el.core.className = `core ${kind}`;
  el.stageTitle.textContent = title;
  el.stageDetail.textContent = detail;
  log("stage", `${title}: ${detail}`);
}

function setPipelineStage(kind, title, detail, activeStep = null) {
  setStage(kind, title, detail);
  if (activeStep) markStep(activeStep, "active");
}

function startPipelineRun() {
  state.pipelineRunId += 1;
  resetPipeline();
}

function resetPipeline() {
  for (const step of stepOrder) {
    markStep(step, "");
    updateStepText(step, stepLabels[step]);
  }
}

function markStep(name, status) {
  const item = el.steps.querySelector(`[data-step="${name}"]`);
  if (!item) return;
  item.classList.remove("active", "done", "skipped", "error");
  if (status) item.classList.add(status);
}

function updateStepText(name, text) {
  const item = el.steps.querySelector(`[data-step="${name}"]`);
  if (item) item.textContent = text;
}

function finishPipelineSoon() {
  window.setTimeout(() => {
    if (state.armed) {
      setPipelineStage("wake", "Wake listening", `Say "${state.config.wakePhrase}" to activate Jarvis.`, "wake");
    }
  }, 1000);
}

function fail(message, error) {
  console.error(error);
  const active = el.steps.querySelector("li.active");
  if (active) active.classList.add("error");
  setPipelineStage("error", "Error", message);
  log("error", message, normalizeError(error));
}

function log(scope, message, data) {
  const line = `[${new Date().toLocaleTimeString()}] ${scope.toUpperCase()} ${message}`;
  el.log.textContent += `${line}${data ? `\n${JSON.stringify(data, null, 2)}` : ""}\n`;
  el.log.scrollTop = el.log.scrollHeight;
}

function normalizeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return error;
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  return response.json();
}

async function postBlob(url, blob) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || `${url} failed with HTTP ${response.status}`);
  return data;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || `${url} failed with HTTP ${response.status}`);
  return data;
}
