// Voice output profiles. "browser" keeps the plain speechSynthesis voice; "hal9000"
// prefers the self-hosted neural TTS backend and shapes it into a slow, deadpan,
// band-limited delivery. Without a configured TTS backend, hal9000 degrades to
// speechSynthesis with HAL's cadence but none of the filtering.
export const voiceProfiles = {
  browser: {
    id: "browser",
    label: "Browser voice",
    neural: false,
    rate: 1,
    pitch: 1,
    pauseMs: 0,
    chunkChars: 4000,
  },
  hal9000: {
    id: "hal9000",
    label: "HAL 9000",
    neural: true,
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
};

export function normalizeVoiceId(value) {
  const id = String(value || "").trim();
  if (!Object.hasOwn(voiceProfiles, id)) {
    throw new Error(`Unknown voice "${id}". Use one of: ${Object.keys(voiceProfiles).join(", ")}.`);
  }
  return id;
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

export function pickSynthesisVoice(voices, profile) {
  if (!profile.voiceHints) return null;
  const candidates = voices.filter((voice) => profile.langHints.some((lang) => voice.lang?.startsWith(lang.slice(0, 2))));
  const scored = (candidates.length ? candidates : voices).map((voice) => {
    const name = `${voice.name} ${voice.voiceURI || ""}`.toLowerCase();
    let score = 0;
    const hint = profile.voiceHints.findIndex((value) => name.includes(value));
    if (hint >= 0) score += 100 - hint;
    if (/\bmale\b/.test(name)) score += 40;
    if (/female|woman|zira|samantha|karen|victoria/.test(name)) score -= 60;
    score += Math.max(0, profile.langHints.length - profile.langHints.findIndex((lang) => voice.lang === lang)) * 5;
    return { voice, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.voice || null;
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
    highpass.connect(lowpass).connect(chest).connect(presence).connect(compressor);
    compressor.connect(dry).connect(output);
    compressor.connect(reverb).connect(wet).connect(output);
    output.connect(context.destination);
    return highpass;
  }

  async speak(text, { onChunk } = {}) {
    const chunks = splitForSpeech(text, this.profile.chunkChars);
    this.signal.throwIfAborted();
    await this.context.resume();
    let pending = chunks.length ? this.request(chunks[0]) : null;
    for (let i = 0; i < chunks.length; i += 1) {
      const { buffer, error } = await pending;
      if (error) {
        this.signal.throwIfAborted();
        throw new VoiceError(error.message, chunks.slice(i));
      }
      const next = chunks[i + 1];
      // Fetch the next clause while this one plays; the pause hides the latency.
      pending = next ? this.request(next) : null;
      onChunk?.(chunks[i], i, chunks.length);
      await this.play(buffer);
      if (next) await this.pause();
    }
  }

  // Settles into a result object so a prefetch that fails or is stopped mid-playback
  // never becomes an unhandled rejection.
  request(text) {
    return this.fetchChunk(text).then((buffer) => ({ buffer }), (error) => ({ error }));
  }

  async fetchChunk(text) {
    this.signal.throwIfAborted();
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, profile: this.profile.id, speed: this.profile.speed }),
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
