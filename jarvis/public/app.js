import { Microphone, abortError, delay, wakeCommand, normalizeWakePhrase, hasLoudBurst, heldVoiceAfterEcho } from "./audio.js";
import { voiceProfiles, normalizeVoiceId, normalizeVoiceSpeed, scaledRate, splitForSpeech,
  pickSynthesisVoice, pickGermanSynthesisVoice, voiceSpeedRange, NeuralVoice, VoiceError,
  textForSpeech, isStopCommand, stopCommandIn, isPostSpeechStop,
  acknowledgmentKind, acknowledgmentIn, pickClosing } from "./voice.js";
import { CoreVisualizer } from "./visualizer.js";
import { createGraph3D } from "./graph3d.js";
import { renderGraph2d } from "./graph2d.js";

const el = Object.fromEntries([
  "core", "waveform", "levelReadout", "stageTitle", "stageDetail", "armButton", "stopButton",
  "clearLogButton", "micLevel", "micLevelValue", "silenceLevel", "silenceValue",
  "silenceDelay", "silenceDelayValue", "silenceDelayStatus",
  "commandWait", "commandWaitValue", "commandWaitStatus",
  "promptText", "answerText",
  "historyDays", "historyDaysValue", "historyDaysStatus",
  "log", "steps", "pipelineStatus", "manualPromptForm", "manualPrompt", "sendManualButton",
  "wakeWordForm", "wakeWordInput", "saveWakeWordButton", "wakeWordStatus",
  "voiceForm", "voiceSelect", "saveVoiceButton", "voiceStatus", "voiceSpeed", "voiceSpeedValue",
  "languageSwitch", "languageStatus",
  "aiProfileSelect", "aiProfileStatus", "whisperProfileSelect", "whisperProfileStatus",
  "mcpSwitches",
  "speakSwitch", "speakStatus",
  "graphPanel", "graphStatus", "graphRefreshButton", "graphRemoveButton", "graphCanvas", "graph3dStage",
  "graphView2dButton", "graphView3dButton", "graphSchema", "graphActivity",
  "graphNodeSize", "graphNodeSizeValue", "graphTextSize", "graphTextSizeValue",
  "panelsToggle", "panelsBelow",
  "loginPanel", "loginForm", "loginUsername", "loginPassword", "loginButton", "loginStatus",
  "userLine", "enableSwitch", "signOutButton",
].map((id) => [id, document.getElementById(id)]));
const steps = ["wake", "record", "vad", "whisper", "brain", "tts"];
const sessionId = crypto.randomUUID();
const wakeWordStorageKey = "jarvis.wakePhrase";
const voiceStorageKey = "jarvis.voice";
const voiceSpeedStorageKey = "jarvis.voiceSpeed";
const languageStorageKey = "jarvis.language";
const speakEnabledStorageKey = "jarvis.speakEnabled";
const panelsStorageKey = "jarvis.panelsVisible";
const graphSizesStorageKey = "jarvis.graphSizes";
const silenceStorageKey = "jarvis.silenceMs";
const commandWaitStorageKey = "jarvis.commandWaitMs";
const historyDaysStorageKey = "jarvis.historyDays";
const aiProfileStorageKey = "jarvis.aiProfile";
const whisperProfileStorageKey = "jarvis.whisperProfile";
let config;
let authedUser = null;
let voiceId = "browser";
let voiceSpeed = voiceSpeedRange.default;
let language = "en";
let speakEnabled = true;
let silenceMs = 1500;
let panelsVisible = true;
let aiProfileId = "";
let whisperProfileId = "";
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
  standby: "Arm Jarvis to unlock audio and start wake listening. It keeps listening if you minimize the window.",
  prompting: "Opening the microphone.",
  wake: "Listening for the wake word.",
  // applyCommandWait keeps this in sync with the Command wait slider.
  command: "Waiting for your command. 3 s of silence returns to wake listening.",
  recording: "Recording your command.",
  transcribing: "Transcribing your words.",
  thinking: "The brain is working on an answer.",
  speaking: "Speaking.",
  error: "Something went wrong. See the Live log for details.",
};

// While an answer is being spoken, a parallel watch listens for the wake
// phrase; saying wake word + "stop" (or another command) cuts the speech.
// Like the wake probes it fires on the trailing edge of mic voice (350 ms
// settle) and on the 3 s forced speech cap, so a stop command does not wait
// longer than 3 s even when the speaker echo keeps the microphone active.
const speechStopped = Symbol("speech stopped by voice");
// A stop command heard within this window after an answer's speech finished
// still counts as a speech stop: the wake pipeline is the fallback for the
// cut the speech wake-watch could not make while the audio was playing.
const STOP_AFTER_SPEECH_MS = 10000;
// The command window after a wake word alone opens with a spoken greeting
// ("Yes, <name>."); this much silence without a command closes it again and
// returns to wake listening instead of waiting out the old 10 s. The
// Command wait slider (COMMAND_WAIT_MIN_MS-COMMAND_WAIT_MAX_MS) overrides it
// per browser.
const COMMAND_WAIT_SILENCE_MS = 3000;
let commandWaitMs = COMMAND_WAIT_SILENCE_MS;
// How many days of the stored conversation the Prompt/Answer panels show. The
// backend keeps everything; the History slider (1..90) picks the window the
// panels render, per browser.
const HISTORY_DAYS_MIN = 1;
const HISTORY_DAYS_MAX = 90;
const HISTORY_DAYS_DEFAULT = 24;
let historyDays = HISTORY_DAYS_DEFAULT;

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

function selectOptions(profiles, describe) {
  return profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = describe(profile);
    if (profile.configured === false) option.disabled = true;
    return option;
  });
}

function setAiProfile(value, persist) {
  const profiles = config?.aiProfiles || [];
  const profile = profiles.find((entry) => entry.id === value && entry.configured !== false)
    || profiles.find((entry) => entry.id === config?.brainProfileDefault && entry.configured !== false)
    || profiles.find((entry) => entry.configured !== false);
  if (!profile) {
    el.aiProfileStatus.textContent = "No AI endpoint profile is configured on this server.";
    el.aiProfileSelect.disabled = true;
    return;
  }
  aiProfileId = profile.id;
  el.aiProfileSelect.value = aiProfileId;
  el.aiProfileStatus.textContent = `Active: ${profile.label} (${profile.profile || profile.model}).`;
  if (persist) {
    try {
      localStorage.setItem(aiProfileStorageKey, aiProfileId);
    } catch (error) {
      el.aiProfileStatus.textContent = `${profile.label} for this tab only; storage unavailable.`;
      log("settings", "Could not save AI endpoint profile", { message: error.message });
    }
  }
  const active = profiles.find((entry) => entry.id === aiProfileId);
  el.steps.querySelector('[data-step="brain"] .step-name').textContent =
    active?.model ? `${active.model} brain` : "Brain";
  log("settings", `AI endpoint: ${profile.label}`);
}

function setWhisperProfile(value, persist) {
  const profiles = config?.whisperProfiles || [];
  const profile = profiles.find((entry) => entry.id === value) || profiles[0];
  if (!profile) {
    el.whisperProfileStatus.textContent = "No Whisper server is configured on this server.";
    el.whisperProfileSelect.disabled = true;
    return;
  }
  whisperProfileId = profile.id;
  el.whisperProfileSelect.value = whisperProfileId;
  el.whisperProfileStatus.textContent = `Active: ${profile.label} (${profile.model}).`;
  if (persist) {
    try {
      localStorage.setItem(whisperProfileStorageKey, whisperProfileId);
    } catch (error) {
      el.whisperProfileStatus.textContent = `${profile.label} for this tab only; storage unavailable.`;
      log("settings", "Could not save Whisper server", { message: error.message });
    }
  }
  log("settings", `Whisper server: ${profile.label}`);
}

el.aiProfileSelect.addEventListener("change", () => setAiProfile(el.aiProfileSelect.value, true));
el.whisperProfileSelect.addEventListener("change", () => setWhisperProfile(el.whisperProfileSelect.value, true));

// Silence-stop slider: how long the microphone must stay quiet before a
// recorded command is sent to Whisper. The server default (SILENCE_MS) is only
// the initial value; the per-browser slider wins and applies live, even while
// a command is already being recorded (the VAD reads the value on every tick).
const SILENCE_MIN_MS = 100;
const SILENCE_MAX_MS = 5000;

function normalizeSilenceMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms)
    ? Math.round(Math.min(SILENCE_MAX_MS, Math.max(SILENCE_MIN_MS, ms)))
    : 1500;
}

function silenceStopLabel(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

function applySilenceDelay(value, persist) {
  silenceMs = normalizeSilenceMs(value);
  el.silenceDelay.value = String(silenceMs);
  el.silenceDelayValue.textContent = silenceStopLabel(silenceMs);
  // The green silence bar fills to the stop point, so its scale follows.
  el.silenceLevel.max = silenceMs;
  el.steps.querySelector('[data-step="vad"] .step-name').textContent =
    `Stop after ${silenceStopLabel(silenceMs)} silence`;
  if (persist) {
    try {
      localStorage.setItem(silenceStorageKey, String(silenceMs));
      el.silenceDelayStatus.textContent = `Saved: commands stop after ${silenceStopLabel(silenceMs)} of silence.`;
    } catch (error) {
      el.silenceDelayStatus.textContent = `Silence stop ${silenceStopLabel(silenceMs)} for this tab only; browser storage is unavailable.`;
      log("settings", "Could not save silence stop", { message: error.message });
    }
  } else {
    el.silenceDelayStatus.textContent = `Active: commands stop after ${silenceStopLabel(silenceMs)} of silence.`;
  }
  log("settings", `Silence stop ${silenceStopLabel(silenceMs)}`);
}
el.silenceDelay.addEventListener("input", () => {
  silenceMs = normalizeSilenceMs(el.silenceDelay.value);
  el.silenceDelayValue.textContent = silenceStopLabel(silenceMs);
  el.silenceLevel.max = silenceMs;
});
el.silenceDelay.addEventListener("change", () => applySilenceDelay(el.silenceDelay.value, true));

// Command wait slider: how long the post-greeting command window stays open
// before returning to wake listening when no command came. The 3 s default is
// the built-in abort; the per-browser value wins, applies from the next
// greeting on (the window counts it down live) and persists per browser.
const COMMAND_WAIT_MIN_MS = 500;
const COMMAND_WAIT_MAX_MS = 15000;

function normalizeCommandWaitMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms)
    ? Math.round(Math.min(COMMAND_WAIT_MAX_MS, Math.max(COMMAND_WAIT_MIN_MS, ms)))
    : COMMAND_WAIT_SILENCE_MS;
}

function applyCommandWait(value, persist) {
  commandWaitMs = normalizeCommandWaitMs(value);
  el.commandWait.value = String(commandWaitMs);
  el.commandWaitValue.textContent = silenceStopLabel(commandWaitMs);
  // The hero caption carries the current wait, so it follows the slider.
  stageCaptions.command = `Waiting for your command. ${silenceStopLabel(commandWaitMs)} of silence returns to wake listening.`;
  if (persist) {
    try {
      localStorage.setItem(commandWaitStorageKey, String(commandWaitMs));
      el.commandWaitStatus.textContent = `Saved: wake listening returns after ${silenceStopLabel(commandWaitMs)} without a command.`;
    } catch (error) {
      el.commandWaitStatus.textContent = `Command wait ${silenceStopLabel(commandWaitMs)} for this tab only; browser storage is unavailable.`;
      log("settings", "Could not save command wait", { message: error.message });
    }
  } else {
    el.commandWaitStatus.textContent = `Active: wake listening returns after ${silenceStopLabel(commandWaitMs)} without a command.`;
  }
  log("settings", `Command wait ${silenceStopLabel(commandWaitMs)}`);
}
el.commandWait.addEventListener("input", () => {
  commandWaitMs = normalizeCommandWaitMs(el.commandWait.value);
  el.commandWaitValue.textContent = silenceStopLabel(commandWaitMs);
});
el.commandWait.addEventListener("change", () => applyCommandWait(el.commandWait.value, true));

// History days slider: how far back the Prompt/Answer panels reach into the
// stored conversation. The backend keeps every turn; the slider picks the
// window (1..90 days) the panels render, saved per browser. Moving it
// re-fetches the window and re-renders both panels.
function normalizeHistoryDays(value) {
  const days = Number(value);
  return Number.isInteger(days) ? Math.min(HISTORY_DAYS_MAX, Math.max(HISTORY_DAYS_MIN, days)) : HISTORY_DAYS_DEFAULT;
}

function historyDaysLabel(days) {
  return `${days} day${days === 1 ? "" : "s"}`;
}

function applyHistoryDays(value, persist) {
  historyDays = normalizeHistoryDays(value);
  el.historyDays.value = String(historyDays);
  el.historyDaysValue.textContent = historyDaysLabel(historyDays);
  if (persist) {
    try {
      localStorage.setItem(historyDaysStorageKey, String(historyDays));
      el.historyDaysStatus.textContent = `Saved: the panels show the last ${historyDaysLabel(historyDays)} of conversation.`;
    } catch (error) {
      el.historyDaysStatus.textContent = `History ${historyDaysLabel(historyDays)} for this tab only; browser storage is unavailable.`;
      log("settings", "Could not save history days", { message: error.message });
    }
  } else {
    el.historyDaysStatus.textContent = `Active: the panels show the last ${historyDaysLabel(historyDays)} of conversation.`;
  }
  log("settings", `History ${historyDaysLabel(historyDays)}`);
  loadConversationHistory();
}
el.historyDays.addEventListener("input", () => {
  historyDays = normalizeHistoryDays(el.historyDays.value);
  el.historyDaysValue.textContent = historyDaysLabel(historyDays);
});
el.historyDays.addEventListener("change", () => applyHistoryDays(el.historyDays.value, true));

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

// --- Knowledge graph panel ---------------------------------------------------
// Second panel inside #panelsBelow, right under the pipeline panel (the
// pipeline sits directly below the panels toggle) — shown and hidden with the
// other panels (the 3D stage resizes via ResizeObserver when the panel
// becomes visible again). Display only: the backend is read-only against the
// graph, and the brain can only run read-only Cypher through the MCP graph
// server.

let graphCenter = null;
let graphView = "3d"; // "3d" is the default; "2d" is the static SVG view.
let graph3d = null; // created lazily on first switch to the 3D view
let graph3dFailed = false; // WebGL unavailable -> stick to 2D
let lastSubgraph = null; // kept so the 3D scene can be (re)filled on view switch

// Display scales for the graph views, from the two sliders (50–200%):
// node size (entities + their names) and link-text size. Both views apply
// them live; the values are persisted per browser. The 3D label layer and
// the 2D edge labels read the scales as CSS custom properties; the 2D node
// geometry (and the 3D spheres) is scaled in JS.
const graphScales = { node: 1, text: 1 };

function applyGraphScales() {
  el.graphPanel.style.setProperty("--graph-node-scale", String(graphScales.node));
  el.graphPanel.style.setProperty("--graph-text-scale", String(graphScales.text));
  el.graphNodeSizeValue.textContent = `${Math.round(graphScales.node * 100)}%`;
  el.graphTextSizeValue.textContent = `${Math.round(graphScales.text * 100)}%`;
  if (graph3d) graph3d.setNodeScale(graphScales.node);
  // The 2D view renders the node geometry from the scale at draw time:
  // re-render the current world (deterministic layout -> no position jump).
  if (lastSubgraph && !el.graphCanvas.hasAttribute("hidden")) renderGraph(lastSubgraph);
}

function onGraphScaleInput() {
  graphScales.node = Number(el.graphNodeSize.value) / 100;
  graphScales.text = Number(el.graphTextSize.value) / 100;
  try {
    localStorage.setItem(graphSizesStorageKey, JSON.stringify({ node: el.graphNodeSize.value, text: el.graphTextSize.value }));
  } catch {
    // Storage unavailable (private mode): the sliders still work for the
    // session.
  }
  applyGraphScales();
}

el.graphNodeSize.addEventListener("input", onGraphScaleInput);
el.graphTextSize.addEventListener("input", onGraphScaleInput);

function setGraphView(view) {
  graphView = view;
  const use3d = view === "3d" && !graph3dFailed && Boolean(config?.graphConfigured);
  // toggleAttribute, not the .hidden property: on SVG elements the property
  // does not reflect the attribute, so the [hidden] CSS would never lift.
  el.graph3dStage.toggleAttribute("hidden", !use3d);
  el.graphCanvas.toggleAttribute("hidden", use3d);
  el.graphView3dButton.classList.toggle("active", use3d);
  el.graphView2dButton.classList.toggle("active", !use3d);
  el.graphView3dButton.disabled = !config?.graphConfigured || graph3dFailed;
  el.graphView2dButton.disabled = !config?.graphConfigured;
  if (use3d && !graph3d) {
    graph3d = createGraph3D(el.graph3dStage, {
      userName: config?.user || null,
      nodeScale: graphScales.node,
      onNodeClick: (nodeId) => loadGraph(nodeId),
      onFallback: () => {
        // No WebGL in this browser: fall back to the static 2D view.
        graph3dFailed = true;
        if (graph3d) { graph3d.dispose(); graph3d = null; }
        el.graphView3dButton.disabled = true;
        el.graphView3dButton.title = "WebGL is not available in this browser";
        setGraphView("2d");
      },
    });
  }
  // Fill the active view with the newest data (the other view is stale or
  // empty until its next loadGraph).
  if (lastSubgraph) {
    if (use3d && graph3d) graph3d.update(lastSubgraph);
    else if (!use3d) renderGraph(lastSubgraph);
  }
}

// The activity entry counts what the write actually stored, not what the
// extractor emitted: a mention of a registered user is their account node,
// not an entity, so the feed must say so instead of "stored N entities".
function ingestLine(entry) {
  const entities = entry.entities || 0;
  const links = entry.relations || 0;
  const skipped = entry.skippedUsers || 0;
  const unconnected = entry.skippedUnconnected || 0;
  const orphans = entry.orphansRemoved || 0;
  // The end-of-ingest check is worth seeing when it fires: it means an
  // entity no fact touched was removed, not just skipped.
  const swept = orphans > 0 ? ` · removed ${orphans} unconnected` : "";
  if (entities > 0) return `stored ${entities} entit${entities === 1 ? "y" : "ies"}${links ? ` + ${links} link${links === 1 ? "" : "s"}` : ""}${swept}`;
  if (unconnected > 0) return `${unconnected} mention${unconnected === 1 ? "" : "s"} without a fact — nothing stored${swept}`;
  if (skipped > 0) return `${skipped} user-account mention${skipped === 1 ? "" : "s"} — nothing stored as an entity${swept}`;
  if (links > 0) return `updated ${links} link${links === 1 ? "" : "s"}${swept}`;
  return `no new graph data${swept}`;
}

async function loadGraph(center) {
  if (center !== undefined) graphCenter = center;
  if (!config) return;
  if (!config.graphConfigured) {
    el.graphStatus.textContent = "Not configured on this server";
    el.graphCanvas.replaceChildren();
    el.graph3dStage.hidden = true;
    el.graphSchema.textContent = "The backend has no NEO4J_* settings, so the panel is idle.";
    el.graphActivity.replaceChildren();
    el.graphRemoveButton.toggleAttribute("hidden", true);
    return;
  }
  try {
    const [status, subgraph, schema, activity] = await Promise.all([
      fetch("/api/graph/status", { cache: "no-store" }).then((response) => response.json()),
      fetch(`/api/graph/subgraph?limit=60${graphCenter ? `&center=${encodeURIComponent(graphCenter)}` : ""}`, { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/graph/schema", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/graph/activity", { cache: "no-store" }).then((response) => response.json()),
    ]);
    if (status.error) {
      el.graphStatus.textContent = status.error === "graph_unavailable" ? `Unreachable: ${status.message || "database down"}` : "Not available";
      el.graphRemoveButton.toggleAttribute("hidden", true);
      return;
    }
    el.graphStatus.textContent = `${status.nodes} nodes · ${status.edges} links${graphCenter ? " · neighbourhood" : ""}`;
    lastSubgraph = subgraph;
    updateRemoveButton(subgraph);
    if (graphView === "3d" && graph3d) graph3d.update(subgraph);
    else renderGraph(subgraph);
    el.graphSchema.textContent = [
      schema.labels?.length ? `Labels: ${schema.labels.join(", ")}` : "",
      schema.relTypes?.length ? `Links: ${schema.relTypes.join(", ")}` : "",
    ].filter(Boolean).join(" · ") || "Empty graph.";
    const entries = (activity.entries || []).slice(0, 8);
    if (entries.length) {
      el.graphActivity.replaceChildren(...entries.map((entry) => {
        const item = document.createElement("li");
        const when = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        item.textContent = entry.kind === "ingest"
          ? `${when} · ${ingestLine(entry)}`
          : entry.kind === "delete"
            ? `${when} · removed ${entry.name || "entity"}`
            : entry.kind === "brain_write"
              ? `${when} · brain ${entry.ok === false ? "write failed" : "wrote"} ${entry.detail || entry.tool}`
              : `${when} · brain ${entry.ok ? "read" : "failed"} ${entry.tool}${entry.detail ? `: ${entry.detail}` : entry.error ? `: ${entry.error}` : ""}`;
        return item;
      }));
    } else {
      const item = document.createElement("li");
      item.textContent = "No activity yet.";
      el.graphActivity.replaceChildren(item);
    }
  } catch (error) {
    el.graphStatus.textContent = `Unreachable: ${error.message}`;
  }
}

// The Remove button acts on the centred node. A typed node is an entity
// (type-less nodes are :User accounts, never deletable); a regular user may
// only remove entities they own — which is every entity in their view — while
// the admin (global view) may remove any entity, owner included.
function updateRemoveButton(subgraph) {
  const node = (subgraph.nodes || []).find((candidate) => candidate.id === graphCenter);
  const deletable = Boolean(node && node.type) && (config?.admin === true || node.owner === config?.user);
  el.graphRemoveButton.toggleAttribute("hidden", !deletable);
  if (deletable) {
    const owner = config?.admin === true && node.owner !== config?.user ? ` owned by ${node.owner}` : "";
    el.graphRemoveButton.textContent = `Remove ${node.name}`;
    el.graphRemoveButton.title = `Delete "${node.name}"${owner} and its links from the knowledge graph. Cannot be undone.`;
  }
}

el.graphRemoveButton.addEventListener("click", async () => {
  const node = (lastSubgraph?.nodes || []).find((candidate) => candidate.id === graphCenter);
  if (!node) return;
  const owner = config?.admin === true && node.owner !== config?.user ? ` owned by ${node.owner}` : "";
  const sure = window.confirm(`Remove "${node.name}"${owner} from the knowledge graph?\nThis deletes the entity and its links and cannot be undone.`);
  if (!sure) return;
  let response;
  try {
    response = await fetch(`/api/graph/entity?id=${encodeURIComponent(node.id)}`, { method: "DELETE", cache: "no-store" });
  } catch (error) {
    log("graph", `Could not remove ${node.name}`, { message: error.message });
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    log("graph", `Removed ${node.name} from the knowledge graph.`);
    graphCenter = null;
    await loadGraph();
  } else if (response.status === 404) {
    // Gone already (or not ours): just show the current world again.
    log("graph", `"${node.name}" is no longer in the knowledge graph.`);
    graphCenter = null;
    await loadGraph();
  } else {
    log("graph", `Could not remove ${node.name}`, { message: data.message || data.error || `HTTP ${response.status}` });
  }
});

// The 2D view: the shared renderer draws into the panel's SVG (viewBox
// 640x320), scaled by the "Entities" slider.
function renderGraph(subgraph) {
  renderGraph2d(el.graphCanvas, subgraph, {
    nodeScale: graphScales.node,
    userName: config?.user ?? null,
    onNodeClick: (nodeId) => loadGraph(nodeId),
  });
}

// Refresh resets to the full (newest) view; the background poll keeps the
// current centre (e.g. after clicking a node) stable.
el.graphRefreshButton.addEventListener("click", () => loadGraph(null));
el.graphView3dButton.addEventListener("click", () => setGraphView("3d"));
el.graphView2dButton.addEventListener("click", () => setGraphView("2d"));

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

// A failed pipeline step is retried with the material already captured (the
// recorded audio window, the prompt, the answer text) up to MAX_STEP_ATTEMPTS
// times instead of returning to wake listening and making the user speak the
// input again. Only transient failures (upstream errors, timeouts) are
// retried: aborts from Stop / leaving the page propagate immediately, and once the
// attempts are exhausted the error reaches the pipeline's usual error stage.
const MAX_STEP_ATTEMPTS = 3;
const STEP_RETRY_DELAY_MS = 1000;

async function withStepRetries(session, label, run) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
    check(session);
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError" || error === speechStopped) throw error;
      if (attempt >= MAX_STEP_ATTEMPTS) throw error;
      log("retry", `${label} failed (attempt ${attempt}/${MAX_STEP_ATTEMPTS}): ${error.message}; retrying in ${STEP_RETRY_DELAY_MS} ms`);
      pipelineStatusOverride = `${label}: retry ${attempt + 1}/${MAX_STEP_ATTEMPTS} after failure (${error.message})`;
      el.pipelineStatus.textContent = pipelineStatus();
      await delay(STEP_RETRY_DELAY_MS, session.signal);
    }
  }
  throw lastError;
}

// The hero's enable/disable toggle mirrors the armed state: "Jarvis on"
// while a session runs, "Jarvis off" once stopped. Every path that arms or
// disarms (arm click, manual prompt, Stop, error, page hide) funnels through
// newSession()/stop(), so syncing there covers all of them.
function syncEnableSwitch() {
  el.enableSwitch.setAttribute("aria-checked", current ? "true" : "false");
}

function stop(message = "Jarvis is disarmed.") {
  const old = current;
  current = null;
  stopMeters();
  old?.controller.abort(abortError());
  speechSynthesis.cancel();
  el.armButton.disabled = !config;
  el.sendManualButton.disabled = !config;
  el.stopButton.disabled = true;
  syncEnableSwitch();
  for (const button of previewButtons) button.disabled = !config;
  el.micLevel.value = 0;
  el.micLevelValue.textContent = "0%";
  el.silenceLevel.value = 0;
  el.silenceValue.textContent = "0 ms";
  visualizer.resetLevel();
  el.levelReadout.textContent = "LEVEL 0%";
  // A disarmed pipeline has no running session, so every step returns to
  // waiting instead of keeping its last done/skipped/error highlight.
  resetSteps();
  stage("standby", "Stopped", message);
}

function newSession() {
  stop();
  const controller = new AbortController();
  const session = { controller, signal: controller.signal, id: ++sequence, startedAt: performance.now(), commandHeard: false };
  current = session;
  probeCount = 0;
  pipelineStatusOverride = null;
  el.armButton.disabled = true;
  el.sendManualButton.disabled = true;
  el.stopButton.disabled = false;
  syncEnableSwitch();
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
  const whisperProfile = config.whisperProfiles?.find((profile) => profile.id === whisperProfileId);
  stage("transcribing", purpose === "wake" ? "Checking wake word" : "Transcribing command",
    `Sending ${Math.round(blob.size / 1024)} KB to ${whisperProfile?.label || "Whisper"}`, purpose === "wake" ? "wake" : "whisper");
  // Audible feedback that the captured audio left the browser and the
  // transcription is starting: a soft tick for wake probes, a higher ping for
  // the command.
  if (purpose === "wake") session.mic.probeBeep();
  else session.mic.sentBeep();
  const result = await request(session, `/api/transcribe?language=${language}&whisperProfile=${encodeURIComponent(whisperProfileId)}`, {
    method: "POST", headers: { "content-type": blob.type }, body: blob,
  });
  log("stt", `Last ${purpose}: ${result.endpoint} | request ${result.requestId}`);
  const { text, ...details } = result;
  log("whisper", `${purpose === "wake" ? "Wake probe" : "Command"} recognized: ${text ? JSON.stringify(text) : "(no speech recognized)"}`);
  log("whisper", "Response details", details);
  return result.text || "";
}

async function tick(session) {
  // Paced by capture blocks rather than a bare timer, so the loop keeps its
  // 100 ms cadence while the window is minimized; see Microphone.tick.
  await session.mic.tick(100, session.signal);
  check(session);
  session.mic.check();
}

// The mic level and the silence bar are driven by their own 100 ms interval,
// not by the pipeline loop: the loop is suspended for the whole Whisper/brain
// round trip, so loop-owned meters froze at their last value (usually ~400 ms
// of silence) and then jumped straight to full when the round trip returned.
// The dedicated timer keeps both bars filling in real time while audio is in
// flight, and the silence bar tracks trailing silence during wake listening,
// so speaking the wake word is visible (the probe fires once speech settles
// for 350 ms).
let meterTimer = 0;
function startMeters() {
  stopMeters();
  meterTimer = setInterval(updateMeters, 100);
}
function stopMeters() {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = 0;
}
function updateMeters() {
  const session = current;
  if (!session || !session.mic) return;
  const buffer = session.mic.buffer;
  el.micLevel.value = Math.min(100, buffer.level * 800);
  el.micLevelValue.textContent = `${Math.round(el.micLevel.value)}%`;
  const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
  // Trailing silence while wake listening and while recording a command once
  // voice has been heard; while the command window waits for the user after a
  // wake word alone the bar fills toward the command-wait abort (counted
  // from the greeting's end) instead of sitting flat, and it stays flat while
  // the answer speaks or the pipeline is idle.
  const kind = visualizer.stage;
  let silence = 0;
  if (kind === "wake" || kind === "transcribing" || kind === "thinking"
    || ((kind === "recording" || kind === "prompting") && session.commandHeard)) {
    silence = Math.min(silenceMs, silentMs);
  } else if (kind === "command") {
    silence = session.commandHeard
      ? Math.min(silenceMs, silentMs)
      : (session.commandWaitStartedAt ? Math.min(commandWaitMs, performance.now() - session.commandWaitStartedAt) : 0);
  }
  // The bar's scale follows the active cap so both fills reach 100% at their
  // own trigger point.
  const barMax = kind === "command" && !session.commandHeard ? commandWaitMs : silenceMs;
  if (Number(el.silenceLevel.max) !== barMax) el.silenceLevel.max = barMax;
  el.silenceLevel.value = silence;
  el.silenceValue.textContent = `${Math.round(silence)} ms`;
  const status = pipelineStatus();
  if (status !== el.pipelineStatus.textContent) el.pipelineStatus.textContent = status;
}

// The signed-in account's name, so the command window opens with "Yes, Mila."
// rather than a bare beep.
function greetingText() {
  const name = authedUser || "there";
  return language === "de" ? `Ja, ${name}.` : `Yes, ${name}.`;
}

// When the user's command merged into the greeting's echo event, the command
// window's audio starts at the greeting's end and its transcript can open
// with the echoed name (or a "yes"/"ja" plus the name). Drop that prefix so
// the brain gets the command, not the greeting's tail.
function stripGreetingEcho(text) {
  const name = (authedUser || "").trim().toLowerCase();
  const words = text.trim().split(/\s+/);
  const plain = (word) => word.toLowerCase().replace(/[^a-zäöüß0-9]/g, "");
  let drop = 0;
  if (name) {
    if (["yes", "yeah", "yep", "ja"].includes(plain(words[0] || "")) && plain(words[1] || "") === name) drop = 2;
    else if (plain(words[0] || "") === name) drop = 1;
  }
  return words.slice(drop).join(" ");
}

// The command window opens with the spoken greeting, so the user hears that
// the assistant is listening. The beep keeps that cue when the voice output
// is switched off or the TTS fails.
async function announceCommandWindow(session) {
  if (!speakEnabled) {
    session.mic.beep();
    log("tts", "Voice output is off; the command window opens with a beep.");
    return;
  }
  try {
    await speakText(session, greetingText(), session.signal);
  } catch (error) {
    if (session.signal.aborted) throw error;
    log("tts", `Greeting failed (${error.message}); falling back to the beep.`);
    session.mic.beep();
  }
}

// Waits for the command to end and returns the sample offset its audio starts
// at (false closes the window instead). The mode decides how the window
// opens:
//
// "greeting" — the wake word was spoken alone: the window opens with the
// spoken greeting and its transcript starts where the greeting ends, so the
// user's command is captured whenever it comes — even over the greeting's
// echo tail. That first voice event is the echo, or the user's command merged
// into it: when it ends, a level hold past the echo's decay
// (heldVoiceAfterEcho) marks it as command audio, and a voice event that
// starts separately afterwards is the command by construction.
// "post-speech" — the window opens right where a spoken answer (or a
// stop-acknowledged turn) ended: the record stage and its abort clock start
// at once, so the user can chain the next command without the wake word. The
// echo phase sorts out the answer's speaker tail exactly like the greeting's.
// "inline" — the command was already spoken with the wake word; only its end
// is awaited (no abort clock).
//
// For the two post-speech modes, commandWaitMs (the Command wait slider,
// 3 s default) without a command closes the window and returns to wake
// listening. The clock runs from the window's opening, not from the last mic
// voice, because browser echo cancellation can keep the spoken audio out of
// the capture entirely — then the last voice is the wake word or some older
// event and the silence clock would already be spent when the window opens.
// Once speech has started, the silence stop ends it like any other command.
async function waitForCommandEnd(session, start, mode) {
  const buffer = session.mic.buffer;
  const started = performance.now();
  let speechAfter = start;
  let eventStart = 0;
  let openAt = 0;
  let phase = "";
  const postSpeech = mode !== "inline";
  // Safety net for a never-quiet microphone; a long command wait must stay
  // open past the old 15 s, so the cap follows the wait.
  const capMs = postSpeech ? Math.max(15000, commandWaitMs) + 5000 : 15000;
  if (mode === "greeting") {
    // The greeting is spoken before the command window opens: the record
    // stage, its silence bar and its abort clock all start when the greeting
    // ends, so the full command wait runs after the user has heard it —
    // nothing counts down while "Yes, <name>." is still playing.
    session.commandHeard = false;
    stage("speaking", "Speaking", "Saying the greeting.", "tts");
    await announceCommandWindow(session);
    check(session);
    // The transcript starts where the spoken greeting ends: everything the
    // user says from here on is in the window. The greeting's echo tail
    // shares that opening with a fast command, so it is sorted out below
    // instead of waiting it out (which used to exclude commands spoken right
    // after the greeting).
    speechAfter = buffer.end;
  }
  if (postSpeech) {
    // The window opens where the last speech ended (greeting or answer);
    // everything from there is command audio.
    session.commandHeard = false;
    session.commandWaitStartedAt = performance.now();
    stage("command", "Waiting for command",
      `Say your command now. ${silenceStopLabel(commandWaitMs)} of silence returns to wake listening.`, "record");
    phase = "echo";
  } else {
    stage("recording", "Listening for command", `Stops after ${silenceStopLabel(silenceMs)} of silence.`, "record");
    session.commandHeard = true;
  }
  let shown = 0;
  while (performance.now() - started < capMs) {
    await tick(session);
    const silentMs = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000;
    if (postSpeech) {
      if (phase === "echo" && silentMs >= silenceMs) {
        // The first voice event (echo tail, or a command merged into it) has
        // ended; the window is open for a separate command.
        phase = "open";
        openAt = buffer.end;
        const source = mode === "greeting" ? "greeting's" : "answer's";
        if (heldVoiceAfterEcho(buffer.samples, speechAfter, buffer.end, buffer.sampleRate)) {
          // The user talked over the echo: the whole window is command audio
          // and closes on this event's silence, transcribed from where the
          // opening speech ended.
          session.commandHeard = true;
          log("vad", `Command heard over the ${source} echo`);
        }
      } else if (phase === "open" && !session.commandHeard && buffer.lastVoice > openAt) {
        // A voice event that started after the echo settled is the command.
        phase = "speaking";
        eventStart = Math.max(speechAfter, buffer.lastVoice - buffer.sampleRate * 0.4);
        session.commandHeard = true;
        log("vad", mode === "greeting" ? "Command heard after the greeting" : "Command heard after the answer");
      }
      if (session.commandHeard) {
        mark("vad", "active");
        if (silentMs >= silenceMs) {
          mark("record", "done");
          mark("vad", "done");
          return eventStart || speechAfter;
        }
      } else if (silentMs >= silenceMs && performance.now() - session.commandWaitStartedAt >= commandWaitMs) {
        // No command after the opening speech: let the caller return to wake
        // listening instead of surfacing a dead-end pipeline error. The wait
        // also needs the mic actually quiet, so a command that starts in the
        // last moment of the wait is not cut off at the deadline — it just
        // ends on the silence stop like any other command.
        log("record", `No command after ${silenceStopLabel(commandWaitMs)} of silence; returning to wake listening.`);
        return false;
      }
    } else {
      if (buffer.lastVoice > speechAfter) session.commandHeard = true;
      if (session.commandHeard) {
        mark("vad", "active");
        if (silentMs >= silenceMs) {
          mark("record", "done");
          mark("vad", "done");
          return speechAfter;
        }
      }
    }
    // This stage can hold for up to the command limit on a noisy microphone
    // that never goes quiet, so count down in the pipeline status line
    // rather than looking frozen. Updated without stage() so the live log is
    // not flooded. The post-speech windows count from their own start, so
    // the elapsed seconds never include the opening speech.
    const elapsed = postSpeech
      ? performance.now() - session.commandWaitStartedAt
      : performance.now() - started;
    if (elapsed - shown >= 500) {
      shown = elapsed;
      pipelineStatusOverride = session.commandHeard
        ? `Recording: ${(elapsed / 1000).toFixed(1)} s. Stops after ${Math.max(0, Math.round(silenceMs - silentMs))} ms more silence, or at the limit.`
        : `Waiting for command: ${(elapsed / 1000).toFixed(1)} s. ${Math.max(1, Math.ceil((commandWaitMs - (performance.now() - session.commandWaitStartedAt)) / 1000))} s of silence returns to wake listening. Mic level ${Math.round(buffer.level * 1000) / 10}%.`;
      el.pipelineStatus.textContent = pipelineStatus();
    }
  }
  log("record", "Command limit reached; transcribing captured speech");
  mark("record", "done");
  mark("vad", "done");
  return eventStart || speechAfter;
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
      // True once a turn ended in spoken output (an answered command or an
      // acknowledged stop word): the follow-up command window then opens
      // instead of returning straight to wake listening.
      let turnEndedWithSpeech = false;
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
        const text = await withStepRetries(session, "wake probe", () => transcribe(session, start, "wake"));
        failures = 0;
        if (wakeCommand(text, config.wakePhrase) === null) {
          // A bare acknowledgment ("ok", "thank you") right after a spoken
          // turn — the follow-up window already closed — is the same polite
          // ending as inside the window: full match anywhere, or a trailing
          // match over the answer's echo gated by a loud user burst, exactly
          // like the post-speech stop fallback (same 10 s window).
          const ackKind = session.lastSpeechEndedAt > 0 &&
              performance.now() - session.lastSpeechEndedAt < STOP_AFTER_SPEECH_MS
            ? acknowledgmentIn(text) ??
              (hasLoudBurst(buffer.samples, start, buffer.end, buffer.sampleRate) &&
               acknowledgmentIn(text, { trailing: true }))
            : null;
          if (ackKind) {
            log("wake", `Acknowledgment ${JSON.stringify(text.trim())} after the spoken turn; a polite closing is spoken instead of the brain.`);
            await acknowledge(session, text.trim());
            turnEndedWithSpeech = true;
            break;
          }
          stage("wake", "Wake listening", `No wake phrase heard. Say "${config.wakePhrase}".`, "wake");
          continue;
        }
        mark("wake", "done");
        log("wake", "Detected; completing the buffered utterance");
        // Capture continues during the Whisper request, including command tails.
        await waitForCommandEnd(session, start, "inline");
        const fullText = await withStepRetries(session, "command transcription", () => transcribe(session, start, "command"));
        let prompt = wakeCommand(fullText, config.wakePhrase);
        // The probe heard the wake phrase but the completed-utterance
        // transcription came back empty (the VAD filter drops short bursts):
        // treat it as a wake-only utterance and ask for the command after the
        // greeting instead of failing the pipeline.
        if (prompt === null && !fullText.trim()) {
          log("wake", "Completed utterance came back empty; waiting for the command after the greeting.");
          prompt = "";
        }
        if (prompt === null) {
          // A bare stop word right after the spoken answer (no wake phrase)
          // is the same escape hatch as the wake-word stop: acknowledge it
          // and stay in wake listening instead of erroring. With speaker echo
          // the window's transcript is the answer's own words plus the stop
          // word, so the match needs a loud user burst in the window's audio.
      if (isPostSpeechStop(fullText, session.lastSpeechEndedAt, performance.now(), STOP_AFTER_SPEECH_MS,
               { userBurst: hasLoudBurst(buffer.samples, start, buffer.end, buffer.sampleRate) })) {
            log("tts", `Stop word ${Math.round((performance.now() - session.lastSpeechEndedAt) / 100) / 10}s after the spoken answer without a wake phrase; opening the follow-up command window.`);
            session.mic.beep();
            turnEndedWithSpeech = true;
            break;
          }
          throw new Error("Whisper did not confirm the wake phrase in the completed utterance.");
        }
        if (!prompt) {
          // The window starts where the spoken greeting ends; a command that
          // merged into the greeting's echo is transcribed with it, so the
          // echoed name is stripped from the front of the result.
          const commandWindow = await waitForCommandEnd(session, buffer.end, "greeting");
          if (commandWindow) {
            const rawCommand = await withStepRetries(session, "command transcription", () => transcribe(session, commandWindow, "command"));
            const commandText = stripGreetingEcho(rawCommand);
            prompt = wakeCommand(commandText, config.wakePhrase) ?? commandText.trim();
          }
        } else {
          session.mic.beep();
        }
        if (!prompt) {
          // The command was spoken with the wake word and transcription lost
          // it, or nothing came after the greeting: a red error here is a
          // dead end, so return to wake listening and let the next attempt
          // retry.
          log("wake", "No command captured with or after the wake word; returning to wake listening.");
          break;
        }
        mark("whisper", "done");
        // A stop command heard shortly after a spoken answer is not a prompt
        // for the brain; it just confirms the speech is over. The burst-gated
        // match covers the echoed window, exactly like the wake pipeline above.
     if (isPostSpeechStop(prompt, session.lastSpeechEndedAt, performance.now(), STOP_AFTER_SPEECH_MS,
             { userBurst: hasLoudBurst(buffer.samples, start, buffer.end, buffer.sampleRate) })) {
          log("tts", `Stop command ${Math.round((performance.now() - session.lastSpeechEndedAt) / 100) / 10}s after the spoken answer; opening the follow-up command window.`);
          session.mic.beep();
          turnEndedWithSpeech = true;
          break;
        }
        if (acknowledgmentKind(prompt)) {
          // Nothing for the brain to answer: end the turn politely. The
          // closing is spoken output, so the follow-up command window opens
          // after it like after any answer.
          await acknowledge(session, prompt);
          turnEndedWithSpeech = true;
          break;
        }
        await answer(session, prompt);
        turnEndedWithSpeech = true;
        break;
      }
      // After an answered or stop-acknowledged turn the next command can come
      // without the wake word: the record-command window opens where the
      // speech ended (its echo phase sorts out the speaker tail) and only a
      // full command wait of silence returns to wake listening.
      if (turnEndedWithSpeech) {
        for (;;) {
          check(session);
          const commandWindow = await waitForCommandEnd(session, buffer.end, "post-speech");
          if (!commandWindow) break;
          const rawCommand = await withStepRetries(session, "command transcription", () => transcribe(session, commandWindow, "command"));
          const followUp = wakeCommand(rawCommand, config.wakePhrase) ?? rawCommand.trim();
          if (!followUp) {
            log("wake", "No command after the answer; returning to wake listening.");
            break;
          }
          mark("whisper", "done");
          // A stop word inside the follow-up window is the same escape hatch
          // (the user cut the answer and then says "stop" again, or the
          // window's audio carries the stop over the answer's echo):
          // acknowledge it and keep the window open instead of prompting the
          // brain. lastSpeechEndedAt stays fresh, so the 10 s post-speech
          // window still applies.
          if (isPostSpeechStop(followUp, session.lastSpeechEndedAt, performance.now(), STOP_AFTER_SPEECH_MS,
              { userBurst: hasLoudBurst(buffer.samples, commandWindow, buffer.end, buffer.sampleRate) })) {
            log("tts", "Stop word after the spoken answer; keeping the command window open.");
            session.mic.beep();
            continue;
          }
          // The trailing match (burst-gated, like the stop fallback) covers
          // the echo-merged window: the answer's own last words plus the
          // user's "Ok" transcribe as one utterance.
          const ackKind = acknowledgmentIn(followUp) ??
            (hasLoudBurst(buffer.samples, commandWindow, buffer.end, buffer.sampleRate) &&
             acknowledgmentIn(followUp, { trailing: true }));
          if (ackKind) {
            // Polite closing instead of a brain round trip; the closing is
            // spoken output, so the window re-opens after it.
            await acknowledge(session, followUp);
            continue;
          }
          await answer(session, followUp);
        }
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

// The Prompt/Answer panels hold the conversation history, not just the
// latest turn: every finished turn (brain answer, butler closing, manual
// prompt) appends one entry per panel with a timestamp. The backend stores
// the whole conversation in SQLite under the signed-in user and serves it
// windowed to ?days=N (see /api/conversation in server.js); the History
// slider picks N per browser and the panels are the scrollable view over
// the window. A turn in flight shows a pending answer entry until it
// completes or fails.
function formatTranscriptTime(ts) {
  return new Date(ts).toLocaleString(language === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function transcriptEntry(text, ts) {
  const entry = document.createElement("div");
  entry.className = "transcript-entry";
  const time = document.createElement("time");
  time.className = "transcript-time";
  time.dateTime = new Date(ts).toISOString();
  time.textContent = formatTranscriptTime(ts);
  const body = document.createElement("p");
  body.className = "transcript-body";
  body.textContent = text;
  entry.append(time, body);
  return entry;
}

function scrollTranscripts() {
  for (const list of [el.promptText, el.answerText]) list.scrollTop = list.scrollHeight;
}

function beginTurn(prompt) {
  for (const list of [el.promptText, el.answerText]) {
    for (const empty of list.querySelectorAll(".transcript-empty")) empty.remove();
  }
  const ts = Date.now();
  el.promptText.append(transcriptEntry(prompt, ts));
  const pending = transcriptEntry("…", ts);
  pending.querySelector(".transcript-body").classList.add("pending");
  el.answerText.append(pending);
  scrollTranscripts();
  return pending;
}

function completeTurn(pending, answer) {
  const body = pending.querySelector(".transcript-body");
  body.classList.remove("pending");
  body.textContent = answer;
  scrollTranscripts();
}

function failTurn(pending, message) {
  const body = pending.querySelector(".transcript-body");
  body.classList.remove("pending");
  body.textContent = `Failed: ${message}`;
  scrollTranscripts();
}

// Fire-and-forget: the backend stores the turn under the signed-in user, so
// the panels can show it after a reload; a failed post never blocks the
// pipeline (the turn already happened).
function recordTurn(prompt, answer) {
  fetch("/api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  }).catch(() => {});
}

async function loadConversationHistory() {
  try {
    const response = await fetch(`/api/conversation?days=${historyDays}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return;
    const data = await response.json();
    el.promptText.replaceChildren();
    el.answerText.replaceChildren();
    const entries = data.entries || [];
    for (const entry of entries) {
      const ts = Date.parse(entry.ts) || Date.now();
      el.promptText.append(transcriptEntry(entry.prompt, ts));
      el.answerText.append(transcriptEntry(entry.answer, ts));
    }
    if (!entries.length) {
      for (const list of [el.promptText, el.answerText]) {
        const empty = document.createElement("p");
        empty.className = "transcript-empty";
        empty.textContent = "No conversation yet.";
        list.append(empty);
      }
    }
    scrollTranscripts();
  } catch {
    // History is a convenience; a failed load leaves the panels empty.
  }
}

async function answer(session, prompt) {
  check(session);
  const pending = beginTurn(prompt);
  try {
    const result = await withStepRetries(session, "brain", async () => {
      stage("thinking", "Thinking", "Waiting for the configured self-hosted brain.", "brain");
      const data = await request(session, "/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        // The brain answers as the wake word's name, so the active phrase
        // (server default or personal override) travels with every request.
        body: JSON.stringify({ prompt, sessionId, language, mcp: mcpFlags, wakePhrase: config.wakePhrase, brainProfile: aiProfileId }),
      });
      if (!data.answer) throw new Error("Brain returned no answer");
      return data;
    });
    log("brain", `Request ${result.requestId} completed`);
    mark("brain", "done");
    completeTurn(pending, result.answer);
    recordTurn(prompt, result.answer);
    // Ingestion of this turn runs server-side after the response; give it a
    // moment, then refresh the graph panel so the new facts show up.
    if (mcpFlags.graph) setTimeout(() => loadGraph(), 4000);
    await speakAnswer(session, result.answer);
  } catch (error) {
    failTurn(pending, error.message);
    throw error;
  }
}

// The spoken part of a turn, shared by brain answers and the butler
// closings: the TTS stage, the stop/interruption watch and the retryable
// speech output, all on the normal TTS path.
async function speakAnswer(session, text) {
  if (!speakEnabled) {
    mark("tts", "skipped");
    log("tts", "Voice output is switched off; the answer stays text only.");
    return;
  }
  stage("speaking", "Speaking", `${voiceProfiles[voiceId].label} is reading the answer at ${voiceSpeed.toFixed(2)}x.`, "tts");
  // The controller (not just its signal) goes to speak(): the speech watch
  // needs it to abort the speech with `speechStopped` mid-answer.
  const speech = new AbortController();
  session.speech = speech;
  try {
    const followUp = await withStepRetries(session, "speech output", () => speak(session, text, speech));
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

// An acknowledgment ("ok", "thank you", …) has nothing for the brain to
// answer: pick a polite butler closing in the active language and speak it
// on the normal TTS path (stop and interruption included). The brain step is
// marked skipped and no brain request or graph ingestion happens.
async function acknowledge(session, prompt) {
  check(session);
  const pending = beginTurn(prompt);
  // The prompt may be a full transcript whose last phrase is the
  // acknowledgment (echo-merged window), so the trailing match resolves the
  // kind when the full command is not one on its own.
  const kind = acknowledgmentKind(prompt) ?? acknowledgmentIn(prompt, { trailing: true }) ?? "general";
  const closing = pickClosing(language, kind);
  log("brain", `Acknowledgment "${prompt}"; the brain is skipped — a polite closing is spoken instead.`);
  mark("brain", "skipped");
  completeTurn(pending, closing);
  // Butler closings are conversation too: the panels (and the 24-day backend
  // history) keep them next to the brain's answers.
  recordTurn(prompt, closing);
  await speakAnswer(session, closing);
}

async function speak(session, text, speech) {
  const signal = AbortSignal.any([session.signal, speech.signal]);
  const watch = watchForVoiceCommand(session, signal, speech);
  try {
    return await speakText(session, text, signal, watch);
  } finally {
    watch.stop();
    // Timestamps the end of the spoken answer (natural or cut) so the wake
    // pipeline can still treat a following "stop" command as a speech stop.
    session.lastSpeechEndedAt = performance.now();
  }
}

// The voice playback itself, shared by answers (speak) and the command
// window's spoken greeting (announceCommandWindow, without a speech watch).
// Returns the interrupting command when the speech was cut by voice, else
// null.
async function speakText(session, text, signal, watch = null) {
  const profile = voiceProfiles[voiceId];
  // The printed answer stays verbatim; only the speaker gets plain language
  // without special signs.
  const spoken = textForSpeech(text);
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
    if (error === speechStopped) return watch?.command ?? null;
    throw error;
  }
}

// Parallel wake watch for the duration of the speech: like the wake probes it
// fires on the trailing edge of mic voice (350 ms of silence) and, when voice
// never settles (speaker echo plus the user talking), on the 3 s forced speech
// cap. It transcribes the window and, if the wake phrase is in there with a
// non-empty command after it, aborts the speech with `speechStopped` and keeps
// the command. A stop word heard the same way — exact over the window, or
// contained in the echoed transcript when the window's audio carries a loud
// user burst — cuts the speech instead. Probe failures are swallowed: a bad
// probe must not kill the answer. Every probe's transcript lands in the Live
// log, so a stop that does not trigger is debuggable from the page alone.
// `speech` is the per-answer AbortController (answer()), so the watch can
// abort it with the speechStopped reason; its signal feeds the composite.
function watchForVoiceCommand(session, signal, speech) {
  let command = null;
  let watching = true;
  // The manual-prompt flow has no microphone, so the watch is a no-op there.
  let probedThrough = session.mic ? session.mic.buffer.end : 0;
  let speechFrom = null;
  const runner = (async () => {
    if (!session.mic) return;
    while (watching && !signal.aborted) {
      // Audio-clocked like the wake loop, so a spoken "stop" is still caught
      // promptly while the window is minimized.
      await session.mic.tick(150, signal).catch(() => {});
      if (!watching || signal.aborted) return;
      const buffer = session.mic.buffer;
      if (buffer.lastVoice <= probedThrough) continue;
      speechFrom ??= buffer.lastVoice;
      const settled = (buffer.end - buffer.lastVoice) / buffer.sampleRate * 1000 >= 350;
      const forced = !settled && buffer.end - speechFrom >= buffer.sampleRate * 3;
      if (!settled && !forced) continue;
      probedThrough = buffer.end;
      speechFrom = null;
      // Settled probes overlap the previous window by 2 s so a phrase crossing
      // the boundary is not lost; a forced probe covers everything since the
      // last probe, so a short stop command cannot fall into the gap.
      const start = settled
        ? Math.max(probedThrough - buffer.sampleRate * 2, buffer.end - buffer.sampleRate * 15)
        : Math.max(probedThrough, buffer.end - buffer.sampleRate * 15);
      try {
        const blob = buffer.wav(start);
        const result = await request(session, `/api/transcribe?language=${language}&whisperProfile=${encodeURIComponent(whisperProfileId)}`, {
          method: "POST", headers: { "content-type": blob.type }, body: blob, signal,
        });
        const text = result.text || "";
        const detected = wakeCommand(text, config.wakePhrase);
        // The assistant's own text may contain the wake phrase without a
        // command after it; only a non-empty command interrupts the speech.
        if (detected && detected.trim()) {
          command = detected;
          log("wake", `Wake phrase heard while speaking: ${JSON.stringify(text)}`);
          speech.abort(speechStopped);
          return;
        }
        // A stop word, without the wake phrase, also cuts the speech: the
        // escape hatch for answers that run too long. The exact whole-window
        // match covers the quiet case; with speaker echo the window
        // transcribes as the answer's own words plus the stop word, so a loud
        // user burst in the window's audio unlocks the containment match —
        // and keeps a pure-echo window from self-triggering on an answer that
        // merely ends on a stop word.
        const userBurst = hasLoudBurst(buffer.samples, start, buffer.end, buffer.sampleRate);
        const stopText = isStopCommand(text) ? text.trim() : userBurst ? stopCommandIn(text) : null;
        if (stopText) {
          command = stopText;
          log("wake", `Stop word heard while speaking: ${JSON.stringify(text)}`);
          speech.abort(speechStopped);
          return;
        }
        log("wake", `Speech watch probe: ${JSON.stringify(text)}`);
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
  if (!config) return;
  const session = newSession();
  stage("prompting", "Opening microphone", "Allow microphone access. You can minimize the window once armed.");
  try {
    session.mic = new Microphone(session.signal);
    const unlock = new SpeechSynthesisUtterance("");
    speechSynthesis.speak(unlock);
    await session.mic.start();
    check(session);
    startMeters();
    await listen(session);
  } catch (error) {
    fatal(session, error);
  }
});
el.stopButton.addEventListener("click", () => stop());
// The hero's enable/disable toggle: the second face of Arm/Stop. Disabling
// while armed runs the normal stop path; enabling runs the normal arm path
// (mic unlock, wake listening, error handling all stay in one place).
el.enableSwitch.addEventListener("click", () => {
  if (!config) return;
  if (current) {
    stop();
    return;
  }
  el.armButton.click();
});

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
// The backend gates every /api route on an HttpOnly session cookie. A 403 on
// /api/config means "not signed in", so the login panel takes over the shell
// (the backend answers 403, not 401, so the browser does not mistake it for a
// rejection of the gateway's Basic Auth credentials).
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

// Minimizing the window or switching tab must not disarm Jarvis: the whole
// point of a wake word is that it is heard while you are doing something else.
// An armed session therefore survives going hidden — capture, wake probes and
// speech all continue, and the pipeline loop is clocked off the audio thread
// (see Microphone.tick) so background timer throttling cannot slow it down.
// Only Stop, an error or leaving the page releases the microphone. The browser
// keeps showing its recording indicator throughout, so the mic is never live
// without the user being able to see it.
document.addEventListener("visibilitychange", () => {
  if (!current) return;
  if (document.hidden) {
    log("session", "Window hidden; still armed and listening for the wake word.");
    return;
  }
  // Some browsers suspend the audio graph across a minimize; nudge it back so
  // the first probe after returning is not cut short.
  current.mic?.context.resume().catch(() => {});
  log("session", "Window visible again; still armed.");
});
window.addEventListener("pagehide", () => stop());
el.armButton.disabled = el.sendManualButton.disabled = true;
el.enableSwitch.disabled = true;
for (const button of previewButtons) button.disabled = true;
el.languageSwitch.disabled = true;
el.speakSwitch.disabled = true;
el.aiProfileSelect.disabled = true;
el.whisperProfileSelect.disabled = true;
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
  if (response.status === 403) {
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
    value.whisperProfiles ||= (value.whisperEndpoints || []).length ? [{
      id: "default",
      label: "Default Whisper",
      endpoints: value.whisperEndpoints,
      model: value.whisperModel || "configured model",
    }] : [];
    value.aiProfiles ||= [{
      id: "default",
      label: "Default AI",
      profile: "server default",
      baseUrl: value.brainBaseUrl,
      model: value.brainModel,
      configured: value.brainConfigured !== false,
    }];
    value.brainProfileDefault ||= value.aiProfiles.find((profile) => profile.configured !== false)?.id || value.aiProfiles[0]?.id || "default";
    if (!value.whisperProfiles?.length || !value.wakePhrase || !(value.silenceMs > 0)) {
      throw new Error("Invalid Whisper/wake configuration");
    }
    config = value;
    el.aiProfileSelect.replaceChildren(...selectOptions(config.aiProfiles || [], (profile) =>
      `${profile.label} — ${profile.profile || profile.model}${profile.configured === false ? " (not configured)" : ""}`));
    el.whisperProfileSelect.replaceChildren(...selectOptions(config.whisperProfiles || [], (profile) =>
      `${profile.label} — ${profile.model}`));
    let savedAiProfile = null;
    let savedWhisperProfile = null;
    try {
      savedAiProfile = localStorage.getItem(aiProfileStorageKey);
      savedWhisperProfile = localStorage.getItem(whisperProfileStorageKey);
    } catch (error) {
      log("settings", "Could not load endpoint selector settings", { message: error.message });
    }
    setAiProfile(savedAiProfile || config.brainProfileDefault, false);
    setWhisperProfile(savedWhisperProfile || "gpu-1", false);
    el.aiProfileSelect.disabled = false;
    el.whisperProfileSelect.disabled = false;
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
    let savedSilence = null;
    try {
      savedSilence = localStorage.getItem(silenceStorageKey);
    } catch (error) {
      log("settings", "Could not load silence stop", { message: error.message });
    }
    // The saved per-browser value wins over the server default (SILENCE_MS);
    // applySilenceDelay also sets the vad step name and the silence bar scale.
    applySilenceDelay(savedSilence ?? config.silenceMs, false);
    el.silenceDelay.disabled = false;
    let savedCommandWait = null;
    try {
      savedCommandWait = localStorage.getItem(commandWaitStorageKey);
    } catch (error) {
      log("settings", "Could not load command wait", { message: error.message });
    }
    // No server default: the saved per-browser value wins over the 3 s built-in.
    applyCommandWait(savedCommandWait ?? commandWaitMs, false);
    el.commandWait.disabled = false;
    let savedHistoryDays = null;
    try {
      savedHistoryDays = localStorage.getItem(historyDaysStorageKey);
    } catch (error) {
      log("settings", "Could not load history days");
    }
    // The saved per-browser value wins over the 24-day default; applying it
    // also fetches the window and renders both panels.
    applyHistoryDays(savedHistoryDays ?? historyDays, false);
    el.historyDays.disabled = false;
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
    // The graph size sliders: restore the persisted values (50–200) before
    // the 3D view is created, so the first render already uses them.
    let savedGraphSizes = null;
    try {
      savedGraphSizes = JSON.parse(localStorage.getItem(graphSizesStorageKey) || "null");
    } catch (error) {
      log("settings", "Could not load graph sizes setting");
    }
    if (savedGraphSizes) {
      for (const [key, slider] of [["node", el.graphNodeSize], ["text", el.graphTextSize]]) {
        const value = Number(savedGraphSizes[key]);
        if (Number.isFinite(value) && value >= 50 && value <= 200) slider.value = String(value);
      }
    }
    graphScales.node = Number(el.graphNodeSize.value) / 100;
    graphScales.text = Number(el.graphTextSize.value) / 100;
    applyGraphScales();
    el.graphRefreshButton.disabled = false;
    setGraphView("3d"); // the live 3D view is the default panel view
    loadGraph();
    setInterval(() => { if (!document.hidden) loadGraph(); }, 15000);
    // The conversation history the Prompt/Answer panels scroll over is loaded
    // by applyHistoryDays above (the saved window wins over the 24-day
    // default); the History slider re-fetches on every change.
    let savedPanels = null;
    try {
      savedPanels = localStorage.getItem(panelsStorageKey);
    } catch (error) {
      log("settings", "Could not load panels setting");
    }
    setPanelsVisible(savedPanels === null ? true : savedPanels === "true", false);
    log("stt", `Configured STT profiles: ${config.whisperProfiles.map((profile) => `${profile.label} ${profile.endpoints.join(", ")}`).join(" | ")} (no request yet)`);
    el.armButton.disabled = el.sendManualButton.disabled = false;
    el.enableSwitch.disabled = false;
    for (const button of previewButtons) button.disabled = false;
    stage("standby", "Standby", "Arm Jarvis to start wake listening. Microphone audio stays local until a probe or command is sent.");
    log("build", "PCM lifecycle v3");
}

loadConfig().catch((error) => stage("error", "Configuration failed", error.message));
