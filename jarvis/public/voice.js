// Voice output profiles. "browser" keeps the plain speechSynthesis voice; "hal9000"
// prefers the self-hosted neural TTS backend and shapes it into a slow, deadpan,
// band-limited delivery. Without a configured TTS backend, hal9000 degrades to
// speechSynthesis with HAL's cadence but none of the filtering.
// group drives the optgroups of the Answer-voice select ("basic",
// "character", "female", "male"); gender steers the browser-voice fallback;
// ttsVoice is the Kokoro voice id the backend maps the profile to (see
// profileVoices in server.js).
export const voiceProfiles = {
  browser: {
    id: "browser",
    label: "Browser voice",
    group: "basic",
    neural: false,
    rate: 1,
    pitch: 1,
    pauseMs: 0,
    chunkChars: 4000,
  },
  hal9000: {
    id: "hal9000",
    label: "HAL 9000",
    group: "character",
    gender: "male",
    neural: true,
    ttsVoice: "bm_george",
    // speechSynthesis fallback: slow and flat, the only HAL traits it can reproduce.
    rate: 0.88,
    pitch: 0.5,
    pauseMs: 300,
    chunkChars: 240,
    // Neural backend: 1.04 against the 0.96 playback rate lands near natural speed,
    // about 30% quicker than the original 0.8, while the detune keeps HAL's pitch.
    // The clause pause shrinks with it so the whole delivery scales together.
    speed: 1.04,
    playbackRate: 0.96,
    voiceHints: ["george", "lewis", "daniel", "arthur", "fable", "ryan", "alex", "david"],
    langHints: ["en-GB", "en-US", "en"],
  },
  // Character delivery profiles. The neural backend gives each its own Kokoro
  // voice (see profileVoices in server.js); the delivery fields below shape the
  // pace, pitch and clause pauses, and the voiceHints steer the browser-voice
  // fallback when no TTS backend is configured.
  commander: {
    id: "commander",
    label: "Commander",
    group: "character",
    gender: "male",
    neural: true,
    ttsVoice: "bm_daniel",
    rate: 0.85,
    pitch: 0.45,
    pauseMs: 400,
    chunkChars: 240,
    speed: 0.92,
    playbackRate: 0.9,
    voiceHints: ["daniel", "adam", "michael", "david"],
    langHints: ["en-GB", "en-US", "en"],
  },
  android: {
    id: "android",
    label: "Android",
    group: "character",
    gender: "male",
    neural: true,
    ttsVoice: "bm_lewis",
    rate: 0.95,
    pitch: 0.8,
    pauseMs: 250,
    chunkChars: 200,
    speed: 1.0,
    playbackRate: 1.0,
    voiceHints: ["lewis", "ryan", "daniel"],
    langHints: ["en-GB", "en-US", "en"],
  },
  wizard: {
    id: "wizard",
    label: "Wizard",
    group: "character",
    gender: "male",
    neural: true,
    ttsVoice: "bm_fable",
    rate: 0.82,
    pitch: 0.7,
    pauseMs: 450,
    chunkChars: 240,
    speed: 0.9,
    playbackRate: 0.92,
    voiceHints: ["arthur", "george", "david"],
    langHints: ["en-GB", "en-US", "en"],
  },
  newscaster: {
    id: "newscaster",
    label: "Newscaster",
    group: "character",
    gender: "male",
    neural: true,
    ttsVoice: "am_michael",
    rate: 1.12,
    pitch: 1.0,
    pauseMs: 150,
    chunkChars: 300,
    speed: 1.15,
    playbackRate: 1.05,
    voiceHints: ["michael", "ryan", "adam"],
    langHints: ["en-US", "en-GB", "en"],
  },
  // Named male/female voices: one Kokoro voice each, with a delivery shape and
  // browser-voice hints of the matching gender for the no-backend fallback.
  heart: {
    id: "heart",
    label: "Heart (female)",
    group: "female",
    gender: "female",
    neural: true,
    ttsVoice: "af_heart",
    rate: 1.05,
    pitch: 1.05,
    pauseMs: 180,
    chunkChars: 280,
    speed: 1.05,
    playbackRate: 1.0,
    voiceHints: ["samantha", "zira", "jenny", "aria", "sonia", "victoria", "karen", "amelie", "female"],
    langHints: ["en-US", "en-GB", "en"],
  },
  bella: {
    id: "bella",
    label: "Bella (female)",
    group: "female",
    gender: "female",
    neural: true,
    ttsVoice: "af_bella",
    rate: 0.95,
    pitch: 1.0,
    pauseMs: 220,
    chunkChars: 280,
    speed: 0.98,
    playbackRate: 1.0,
    voiceHints: ["bella", "samantha", "zira", "jenny", "aria", "sonia", "victoria", "female"],
    langHints: ["en-US", "en-GB", "en"],
  },
  nicole: {
    id: "nicole",
    label: "Nicole (female)",
    group: "female",
    gender: "female",
    neural: true,
    ttsVoice: "af_nicole",
    rate: 1.1,
    pitch: 1.0,
    pauseMs: 150,
    chunkChars: 300,
    speed: 1.1,
    playbackRate: 1.0,
    voiceHints: ["nicole", "samantha", "zira", "jenny", "aria", "victoria", "female"],
    langHints: ["en-US", "en-GB", "en"],
  },
  sarah: {
    id: "sarah",
    label: "Sarah (female)",
    group: "female",
    gender: "female",
    neural: true,
    ttsVoice: "af_sarah",
    rate: 1.0,
    pitch: 1.1,
    pauseMs: 200,
    chunkChars: 260,
    speed: 1.0,
    playbackRate: 1.0,
    voiceHints: ["sarah", "samantha", "zira", "aria", "sonia", "victoria", "female"],
    langHints: ["en-US", "en-GB", "en"],
  },
  adam: {
    id: "adam",
    label: "Adam (male)",
    group: "male",
    gender: "male",
    neural: true,
    ttsVoice: "am_adam",
    rate: 1.0,
    pitch: 0.9,
    pauseMs: 180,
    chunkChars: 280,
    speed: 1.0,
    playbackRate: 1.0,
    voiceHints: ["adam", "david", "mark", "george", "daniel", "male"],
    langHints: ["en-US", "en-GB", "en"],
  },
  eric: {
    id: "eric",
    label: "Eric (male)",
    group: "male",
    gender: "male",
    neural: true,
    ttsVoice: "am_eric",
    rate: 1.05,
    pitch: 0.85,
    pauseMs: 160,
    chunkChars: 280,
    speed: 1.05,
    playbackRate: 1.0,
    voiceHints: ["eric", "david", "mark", "george", "alex", "male"],
    langHints: ["en-US", "en-GB", "en"],
  },
  liam: {
    id: "liam",
    label: "Liam (male)",
    group: "male",
    gender: "male",
    neural: true,
    ttsVoice: "am_liam",
    rate: 0.95,
    pitch: 0.95,
    pauseMs: 220,
    chunkChars: 260,
    speed: 0.98,
    playbackRate: 0.98,
    voiceHints: ["liam", "daniel", "george", "james", "matthew", "male"],
    langHints: ["en-GB", "en-US", "en"],
  },
};

export function normalizeVoiceId(value) {
  const id = String(value || "").trim();
  if (!Object.hasOwn(voiceProfiles, id)) {
    throw new Error(`Unknown voice "${id}". Use one of: ${Object.keys(voiceProfiles).join(", ")}.`);
  }
  return id;
}

// While an answer is being spoken, saying the wake phrase plus one of these
// words cuts the speech instead of starting a brain round trip.
export const STOP_COMMANDS = [
  "stop", "stopp", "stop it", "halt", "still", "quiet", "enough",
  "genug", "genugsam", "das reicht", "reicht", "schweig", "schweigen",
  "hör auf", "lass es", "lass das", "genug schon",
];

export function isStopCommand(command) {
  const normalized = String(command || "").trim().toLowerCase().replace(/[.!?,;:]+$/g, "");
  return STOP_COMMANDS.includes(normalized);
}

// The same list as a word-boundary containment match: with speaker echo the
// probe window transcribes as the answer's own words plus the stop word, so
// the exact whole-window match never fires. Returns the matched command or
// null. With `trailing`, only a stop word at the very end of the text counts
// — a deliberate last utterance, not part of a longer sentence.
export function stopCommandIn(command, { trailing = false } = {}) {
  const normalized = String(command || "").trim().toLowerCase().replace(/[.!?,;:]+$/g, "");
  if (!normalized) return null;
  for (const word of STOP_COMMANDS) {
    if (trailing) {
      if (normalized === word || normalized.endsWith(` ${word}`)) return word;
      continue;
    }
    const escaped = word.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped.join("[\\s,;:.!?-]+")}(?![\\p{L}\\p{N}_])`, "u").test(normalized)) {
      return word;
    }
  }
  return null;
}

// The speech wake-watch cuts the audio while it plays; this is the fallback
// for the wake pipeline: a stop command heard within `windowMs` after the
// answer's speech finished (lastSpeechEndedAt, same clock as `now`) still
// counts as a speech stop and is not sent to the brain. The exact match covers
// the quiet window; an echoed window (the answer's own words around the stop
// word) counts only when the caller passes userBurst — the window's audio
// carried the user's voice louder than the echo.
export function isPostSpeechStop(command, lastSpeechEndedAt, now, windowMs, { userBurst = false } = {}) {
  if (lastSpeechEndedAt <= 0 || now - lastSpeechEndedAt >= windowMs) return false;
  if (isStopCommand(command)) return true;
  return userBurst && Boolean(stopCommandIn(command, { trailing: true }));
}

export const voiceSpeedRange = { min: 0.6, max: 1.6, step: 0.05, default: 1 };

// The slider is a multiplier on the profile's own speed, so "1.00" always means
// the profile as designed and the HAL character is preserved across the range.
export function normalizeVoiceSpeed(value) {
  // Blank or unparseable (missing storage key, empty input) means "as designed",
  // not the slider's slowest setting.
  const speed = Number(String(value ?? "").trim() || NaN);
  if (!Number.isFinite(speed)) return voiceSpeedRange.default;
  return Math.min(voiceSpeedRange.max, Math.max(voiceSpeedRange.min, Math.round(speed * 100) / 100));
}

// Keeps the engine request and the utterance rate inside what both ends accept:
// /api/speak clamps to 0.5-2 and SpeechSynthesisUtterance.rate is 0.1-10.
export function scaledRate(base, factor) {
  return Math.min(2, Math.max(0.5, Math.round(base * factor * 1000) / 1000));
}

// HAL speaks one measured clause at a time, so split on sentence punctuation and
// keep every chunk short enough for a single request/utterance.
export function splitForSpeech(text, maxChars = 240) {
  const sentences = String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?…:;])\s+/).filter(Boolean);
  const chunks = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(",", maxChars) + 1 || rest.lastIndexOf(" ", maxChars) + 1 || maxChars;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    const previous = chunks.at(-1);
    // Merge one-word fragments like "Yes." so the pause lands on a real clause boundary.
    if (previous && previous.length + rest.length + 1 <= maxChars && (previous.length < 10 || rest.length < 10)) {
      chunks[chunks.length - 1] = `${previous} ${rest}`;
    } else if (rest) {
      chunks.push(rest);
    }
  }
  return chunks;
}

// Browser voices rarely advertise a gender in their name, but the common ones
// do ("Microsoft Zira", "Google US English (female)", ...). The scoring below
// follows the profile's gender: the matching gender is boosted, the other is
// pushed out, so a female profile never lands on a male voice and vice versa.
const MALE_VOICE_RE = /\bmale\b|david\b|mark\b|george|daniel|james|matthew|thomas|fred\b|guy\b|alex\b|eric\b|adam\b|ryan\b/i;
const FEMALE_VOICE_RE = /female|woman|zira|samantha|jenny|aria|sonia|victoria|karen|amelie|heera|moira|tessa|libby|susan|catherine|joanna|ivy\b/i;

export function pickSynthesisVoice(voices, profile) {
  if (!profile.voiceHints) return null;
  const candidates = voices.filter((voice) => profile.langHints.some((lang) => voice.lang?.startsWith(lang.slice(0, 2))));
  const female = profile.gender === "female";
  const scored = (candidates.length ? candidates : voices).map((voice) => {
    const name = `${voice.name} ${voice.voiceURI || ""}`.toLowerCase();
    let score = 0;
    const hint = profile.voiceHints.findIndex((value) => name.includes(value));
    if (hint >= 0) score += 100 - hint;
    if (female) {
      if (FEMALE_VOICE_RE.test(name)) score += 40;
      if (MALE_VOICE_RE.test(name)) score -= 60;
    } else {
      if (MALE_VOICE_RE.test(name)) score += 40;
      if (FEMALE_VOICE_RE.test(name)) score -= 60;
    }
    score += Math.max(0, profile.langHints.length - profile.langHints.findIndex((lang) => voice.lang === lang)) * 5;
    return { voice, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.voice || null;
}

// German mode: the self-hosted TTS engine is English-only, so German answers
// are spoken by the browser voice. Prefer a German voice of the profile's
// gender by name (male by default, keeping the original behaviour), and
// always fall back to *some* German voice rather than the browser default,
// which may be English.
export const germanSynthesisHints = {
  male: ["conrad", "michael", "thomas", "markus", "stefan"],
  female: ["anna", "katrin", "vivienne", "hanna", "marlene", "female"],
};

export function pickGermanSynthesisVoice(voices, gender = "male") {
  const female = gender === "female";
  const hints = female ? germanSynthesisHints.female : germanSynthesisHints.male;
  const german = (voices || []).filter((voice) => (voice.lang || "").toLowerCase().startsWith("de"));
  if (!german.length) return null;
  const scored = german.map((voice) => {
    const name = `${voice.name} ${voice.voiceURI || ""}`.toLowerCase();
    let score = 0;
    const hint = hints.findIndex((value) => name.includes(value));
    if (hint >= 0) score += 100 - hint;
    if (female ? FEMALE_VOICE_RE.test(name) : /\bmale\b|conrad|michael|thomas|markus|stefan/.test(name)) score += 40;
    return { voice, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0].voice;
}

// The answer panel keeps the brain's text verbatim; the speaker gets plain
// spoken language only. Strip markdown, links, code markers and special
// signs before anything is sent to a TTS engine or speechSynthesis.
export function textForSpeech(text) {
  let spoken = String(text || "");
  spoken = spoken.replace(/```[\s\S]*?```/g, " "); // fenced code blocks
  spoken = spoken.replace(/`([^`]+)`/g, "$1"); // inline code
  spoken = spoken.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links keep their label
  spoken = spoken.replace(/https?:\/\/\S+|www\.[^\s]*/g, " "); // bare URLs
  spoken = spoken.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, ""); // list and quote markers
  spoken = spoken.replace(/[*_~#|>{}[\]]/g, ""); // leftover markup (no space: "**14:05**." keeps its period)
  spoken = spoken.replace(/[^\p{L}\p{N}\p{M} .,!?;:'"()\-–—…&%]/gu, " "); // keep plain language
  return spoken.replace(/\s+/g, " ").trim();
}

// Thrown when the neural backend fails part-way so the caller can finish the
// answer with speechSynthesis instead of dropping the rest of it.
export class VoiceError extends Error {
  constructor(message, remaining) {
    super(message);
    this.name = "VoiceError";
    this.remaining = remaining;
  }
}

export class NeuralVoice {
  constructor(signal, profile, { endpoint = "/api/speak", timeoutMs = 20000 } = {}) {
    this.signal = signal;
    this.profile = profile;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.context = new AudioContext();
    this.input = this.buildChain(this.context);
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  // 1960s mainframe speaker: band-limited, chest-heavy, evenly compressed, with a
  // small amount of room tail so the delivery sounds like it comes from a bulkhead.
  buildChain(context) {
    const highpass = new BiquadFilterNode(context, { type: "highpass", frequency: 95 });
    const lowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 3800, Q: 0.7 });
    const chest = new BiquadFilterNode(context, { type: "peaking", frequency: 220, Q: 0.8, gain: 4.5 });
    const presence = new BiquadFilterNode(context, { type: "peaking", frequency: 1800, Q: 1.1, gain: -2.5 });
    const compressor = new DynamicsCompressorNode(context, { threshold: -26, knee: 12, ratio: 7, attack: 0.004, release: 0.26 });
    const reverb = new ConvolverNode(context, { buffer: impulseResponse(context, 1.1) });
    const wet = new GainNode(context, { gain: 0.16 });
    const dry = new GainNode(context, { gain: 0.9 });
    const output = new GainNode(context, { gain: 1 });
    // Parallel tap on the shaped output: the waveform ring sees the agent's
    // voice exactly as the filters, compressor and reverb deliver it.
    this.analyser = new AnalyserNode(context, { fftSize: 512, smoothingTimeConstant: 0.5 });
    highpass.connect(lowpass).connect(chest).connect(presence).connect(compressor);
    compressor.connect(dry).connect(output);
    compressor.connect(reverb).connect(wet).connect(output);
    output.connect(context.destination);
    output.connect(this.analyser);
    return highpass;
  }

  async speak(text, { onChunk, speed = this.profile.speed } = {}) {
    const chunks = splitForSpeech(text, this.profile.chunkChars);
    this.signal.throwIfAborted();
    await this.context.resume();
    let pending = chunks.length ? this.request(chunks[0], speed) : null;
    for (let i = 0; i < chunks.length; i += 1) {
      const { buffer, error } = await pending;
      if (error) {
        this.signal.throwIfAborted();
        throw new VoiceError(error.message, chunks.slice(i));
      }
      const next = chunks[i + 1];
      // Fetch the next clause while this one plays; the pause hides the latency.
      pending = next ? this.request(next, speed) : null;
      onChunk?.(chunks[i], i, chunks.length);
      await this.play(buffer);
      if (next) await this.pause();
    }
  }

  // Settles into a result object so a prefetch that fails or is stopped mid-playback
  // never becomes an unhandled rejection.
  request(text, speed) {
    return this.fetchChunk(text, speed).then((buffer) => ({ buffer }), (error) => ({ error }));
  }

  async fetchChunk(text, speed = this.profile.speed) {
    this.signal.throwIfAborted();
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, profile: this.profile.id, speed }),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]),
      cache: "no-store",
    });
    const audio = await response.arrayBuffer();
    if (!response.ok) {
      const detail = new TextDecoder().decode(audio).slice(0, 300);
      throw new Error(`Neural TTS HTTP ${response.status}: ${detail}`);
    }
    if (!audio.byteLength) throw new Error("Neural TTS returned empty audio");
    return this.context.decodeAudioData(audio);
  }

  play(buffer) {
    return new Promise((resolve, reject) => {
      this.signal.throwIfAborted();
      const source = new AudioBufferSourceNode(this.context, { buffer, playbackRate: this.profile.playbackRate || 1 });
      const done = (error) => {
        this.signal.removeEventListener("abort", cancelled);
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Already stopped or never started; nothing to release beyond disconnect.
        }
        source.disconnect();
        if (error) reject(error);
        else resolve();
      };
      const cancelled = () => done(this.signal.reason);
      this.signal.addEventListener("abort", cancelled, { once: true });
      source.onended = () => done();
      source.connect(this.input);
      source.start();
    });
  }

  pause() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.signal.removeEventListener("abort", cancelled);
        resolve();
      }, this.profile.pauseMs);
      const cancelled = () => { clearTimeout(timer); reject(this.signal.reason); };
      this.signal.addEventListener("abort", cancelled, { once: true });
    });
  }

  close() {
    if (this.context.state !== "closed") {
      this.context.close().catch((error) => console.error("Voice context cleanup failed", error));
    }
  }
}

function impulseResponse(context, seconds) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.2;
    }
    // Early reflection off the opposite bulkhead, offset per channel for width.
    data[Math.floor(context.sampleRate * (0.021 + channel * 0.007))] += 0.35;
  }
  return buffer;
}
