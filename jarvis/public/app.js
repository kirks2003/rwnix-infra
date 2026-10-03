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
  chunkTimes: [],
  silenceStartedAt: 0,
  recorderStartedAt: 0,
  wakeDetectedAt: 0,
  sessionId: crypto.randomUUID(),
  pipelineRunId: 0,
  wakeRunId: 0,
  wakeRestartTimer: null,
  wakeProbeTimer: null,
  pendingWakeTimer: null,
  pendingWakeCommand: "",
  speechWatchdog: null,
  beepContext: null,
  busy: false,
  commandMode: false,
  wakeProbeMode: false,
  voiceStartedAfterWake: false,
  discardRecording: false,
};

const rollingBufferMs = 12000;
const commandMaxMs = 12000;
const wakeProbeMs = 3500;

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
    fail("Audio or microphone unlock failed", error);
  }
}

function stopJarvis() {
  state.armed = false;
  state.busy = false;
  clearWakeRestart();
  clearWakeProbe();
  clearPendingWake();
  clearSpeechWatchdog();
  stopWakeRecognition();
  stopRecording({ discard: true });
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

async function startWakeRecognition() {
  if (!state.armed || state.busy) return;
  try {
    stopWakeRecognition();
    clearPendingWake();
    clearWakeRestart();
    clearWakeProbe();
    state.wakeProbeMode = true;
    startPipelineRun();
    setPipelineStage("wake", "Wake listening", `Listening through vm103 Whisper for "${state.config.wakePhrase}".`, "wake");
    log("wake", "Wake probe recording started; vm103 Whisper will check this audio for the wake phrase.");
    await startRollingRecorder();
    state.wakeProbeTimer = window.setTimeout(() => {
      state.wakeProbeTimer = null;
      log("wake", "Wake probe segment complete; uploading to vm103 Whisper.");
      stopRecording();
    }, wakeProbeMs);
  } catch (error) {
    state.wakeProbeMode = false;
    fail("Could not start vm103 Whisper wake probe", error);
  }
}

function stopWakeRecognition() {
  clearWakeProbe();
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

function clearWakeProbe() {
  if (state.wakeProbeTimer) window.clearTimeout(state.wakeProbeTimer);
  state.wakeProbeTimer = null;
}

function clearPendingWake() {
  if (state.pendingWakeTimer) window.clearTimeout(state.pendingWakeTimer);
  state.pendingWakeTimer = null;
  state.pendingWakeCommand = "";
}

async function startRollingRecorder() {
  if (state.recorder && state.recorder.state !== "inactive") return;
  try {
    state.discardRecording = false;
    state.commandMode = false;
    state.voiceStartedAfterWake = state.wakeProbeMode;
    state.recording = true;
    state.chunks = [];
    state.chunkTimes = [];
    state.recorderStartedAt = performance.now();
    log("record", "Rolling microphone recorder started; wake commands will be uploaded to vm103 Whisper.");

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
      if (!event.data.size) return;
      state.chunks.push(event.data);
      state.chunkTimes.push(performance.now());
      if (!state.commandMode) trimRollingBuffer();
    };
    state.recorder.onstop = onRecordingStopped;
    state.recorder.start(250);
    log("record", `MediaRecorder rolling (${mimeType})`);
    monitorVoiceActivity();
  } catch (error) {
    state.recording = false;
    state.busy = false;
    cleanupAudio();
    throw error;
  }
}

function beginCommandCapture() {
  if (!state.recorder || state.recorder.state === "inactive") {
    startRollingRecorder()
      .then(beginCommandCapture)
      .catch((error) => {
        state.busy = false;
        fail("Could not restart microphone recorder after wake", error);
        if (state.armed) restartWakeRecognition(1000);
      });
    return;
  }

  trimRollingBuffer();
  state.wakeProbeMode = false;
  state.commandMode = true;
  state.voiceStartedAfterWake = state.chunks.length > 0;
  state.silenceStartedAt = 0;
  state.wakeDetectedAt = performance.now();
  log("record", "Command capture active; this recording will be sent to vm103 Whisper.");
  setPipelineStage("recording", "Listening for prompt", `Speak now. Recording stops after ${state.config.silenceMs} ms of silence, then uploads to vm103 Whisper.`, "record");
}

function trimRollingBuffer() {
  const cutoff = performance.now() - rollingBufferMs;
  while (state.chunkTimes.length > 1 && state.chunkTimes[0] < cutoff) {
    state.chunkTimes.shift();
    state.chunks.shift();
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

    if (!state.commandMode) {
      state.vadFrame = requestAnimationFrame(tick);
      return;
    }

    if (average > threshold) {
      state.voiceStartedAfterWake = true;
      state.silenceStartedAt = 0;
      el.silenceLevel.value = 0;
      markStep("vad", "active");
      updateStepText("vad", "Voice detected; waiting for silence.");
    } else if (state.voiceStartedAfterWake) {
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
    } else {
      const waitingForVoice = performance.now() - state.wakeDetectedAt;
      markStep("vad", "active");
      updateStepText("vad", `Waiting for speech after wake (${Math.round(waitingForVoice)} ms).`);
      if (waitingForVoice >= commandMaxMs) {
        log("vad", "No speech detected after wake; stopping recorder");
        stopRecording();
        return;
      }
    }

    if (performance.now() - state.wakeDetectedAt >= commandMaxMs) {
      log("vad", "Command recording timeout reached; stopping recorder");
      stopRecording();
      return;
    }

    state.vadFrame = requestAnimationFrame(tick);
  };

  state.vadFrame = requestAnimationFrame(tick);
}

function stopRecording({ discard = false } = {}) {
  state.discardRecording = discard;
  clearWakeProbe();
  if (state.vadFrame) cancelAnimationFrame(state.vadFrame);
  state.vadFrame = null;
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
}

async function onRecordingStopped() {
  state.recording = false;
  const wasWakeProbe = state.wakeProbeMode && !state.commandMode;
  const shouldDiscard = state.discardRecording || (!state.commandMode && !wasWakeProbe);
  state.wakeProbeMode = false;
  state.commandMode = false;
  state.voiceStartedAfterWake = false;
  markStep("record", "done");
  cleanupAudio();

  const blob = new Blob(state.chunks, { type: state.chunks[0]?.type || "audio/webm" });
  state.chunks = [];
  state.chunkTimes = [];
  if (shouldDiscard) return;
  if (wasWakeProbe) {
    await processWakeProbe(blob);
    return;
  }
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

async function processWakeProbe(blob) {
  if (blob.size < 1200) {
    log("wake", `Wake probe too small (${blob.size} bytes); continuing vm103 Whisper wake listening.`);
    if (state.armed) restartWakeRecognition(100);
    return;
  }

  try {
    setPipelineStage("transcribing", "Checking wake word", "Uploading wake audio to vm103 Whisper.", "whisper");
    log("whisper", `Uploading ${blob.size} wake-probe bytes to backend`);
    const transcribed = await postBlob("/api/transcribe", blob);
    log("whisper", "Wake probe Whisper result", transcribed);

    const transcript = String(transcribed.text || "").trim();
    const wakePhrase = String(state.config.wakePhrase || "hey jarvis").toLowerCase();
    const wakeIndex = transcript.toLowerCase().indexOf(wakePhrase);
    if (wakeIndex < 0) {
      log("wake", transcript ? `No wake phrase in vm103 Whisper text: ${transcript}` : "No speech/wake phrase from vm103 Whisper.");
      state.busy = false;
      if (state.armed) restartWakeRecognition(100);
      return;
    }

    state.busy = true;
    markStep("wake", "done");
    markStep("whisper", "done");
    playWakeBeep();
    const inlineCommand = transcript.slice(wakeIndex + wakePhrase.length).replace(/^[,.;:!?\s]+/, "").trim();
    if (inlineCommand) {
      log("wake", `Wake and command were transcribed by vm103 Whisper: ${inlineCommand}`);
      markStep("record", "done");
      markStep("vad", "done");
      await processPrompt(inlineCommand, { source: "whisper-wake" });
      return;
    }

    log("wake", "Wake phrase transcribed by vm103 Whisper; opening command capture.");
    setPipelineStage("prompting", "Wake detected", "Beep. Speak your command; vm103 Whisper will transcribe it.", "record");
    await startRollingRecorder();
    beginCommandCapture();
  } catch (error) {
    log("wake", "Wake probe transcription failed; continuing vm103 Whisper wake listening", normalizeError(error));
    state.busy = false;
    if (state.armed) restartWakeRecognition(500);
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
