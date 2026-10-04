export function abortError() {
  return new DOMException("Session stopped", "AbortError");
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export class AudioBufferWindow {
  constructor(sampleRate, seconds = 45) {
    this.sampleRate = sampleRate;
    this.samples = new Float32Array(sampleRate * seconds);
    this.end = 0;
    this.lastVoice = 0;
    this.level = 0;
  }

  push(block) {
    let energy = 0;
    for (const sample of block) {
      this.samples[this.end++ % this.samples.length] = sample;
      energy += sample * sample;
    }
    this.level = Math.sqrt(energy / block.length);
    if (this.level >= 0.012) this.lastVoice = this.end;
  }

  wav(start, end = this.end) {
    start = Math.max(0, Math.floor(start));
    end = Math.floor(end);
    if (start < this.end - this.samples.length || end > this.end || end <= start) {
      throw new Error("Requested audio is outside the capture buffer");
    }
    const length = end - start;
    const data = new ArrayBuffer(44 + length * 2);
    const view = new DataView(data);
    const text = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, data.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, data.byteLength - 44, true);
    // One typed-array store per sample instead of a DataView call keeps a 25 s
    // window (up to ~9.6 MB at a 192 kHz AudioContext) under a meter tick, so
    // the mic/silence bars keep moving while a probe is being prepared.
    // Little-endian hosts only, like every target browser (x86/ARM).
    const pcm = new Int16Array(data, 44, length);
    const wrap = this.samples.length;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, this.samples[(start + i) % wrap]));
      pcm[i] = sample * (sample < 0 ? 32768 : 32767);
    }
    return new Blob([data], { type: "audio/wav" });
  }
}

export class Microphone {
  constructor(signal) {
    this.signal = signal;
    this.context = new AudioContext();
    this.buffer = new AudioBufferWindow(this.context.sampleRate);
    this.lastBlockAt = performance.now();
    this.failure = null;
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  async start() {
    await this.context.resume();
    this.signal.throwIfAborted();
    // A permission prompt cannot be aborted. Release any stream granted after Stop.
    const pending = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((stream) => {
      if (this.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        throw this.signal.reason;
      }
      this.stream = stream;
      stream.getTracks().forEach((track) => {
        track.onended = () => { this.failure = new Error("Microphone disconnected"); };
      });
    });
    await pending;
    await this.context.audioWorklet.addModule("/capture-worklet.js");
    this.signal.throwIfAborted();
    this.source = this.context.createMediaStreamSource(this.stream);
    // Bus into the capture worklet, tapped for the waveform ring.
     this.inputMix = this.context.createGain();
    this.source.connect(this.inputMix);
    // Parallel tap for the waveform ring: the analyser is a sink, so capture
    // through the worklet is untouched.
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.5;
    this.inputMix.connect(this.analyser);
    this.node = new AudioWorkletNode(this.context, "jarvis-capture");
    this.node.onprocessorerror = () => { this.failure = new Error("Audio capture processor failed"); };
    this.node.port.onmessage = ({ data }) => {
      if (this.signal.aborted) return;
      this.buffer.push(data);
      this.lastBlockAt = performance.now();
    };
    this.inputMix.connect(this.node);
    this.node.connect(this.context.destination);
    this.lastBlockAt = performance.now();
  }

  check() {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.context.state !== "running" || performance.now() - this.lastBlockAt > 3000) {
      throw new Error("Microphone capture paused. Keep this tab in the foreground and re-arm.");
    }
  }

  // Audible pipeline feedback, each a distinct tone:
  //  - beep():       880->1320 Hz sweep, "I heard the wake word" (or: speak now)
  //  - probeBeep():  soft 660 Hz tick, a wake-probe window was just sent to Whisper
  //  - sentBeep():   higher 1760 Hz ping, the command audio was sent, transcription starts
  beep() {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1320, now + 0.09);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  }

  probeBeep() {
    this.tone(660, 0.09, 0.035);
  }

  sentBeep() {
    this.tone(1760, 0.12, 0.06);
  }

  tone(frequency, seconds, peakGain) {
    if (this.context.state === "closed") return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + seconds);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(now);
    oscillator.stop(now + seconds + 0.02);
  }

  close() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.inputMix?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context.state !== "closed") {
      this.context.close().catch((error) => console.error("Audio context cleanup failed", error));
    }
  }
}

export function wakeCommand(text, phrase) {
  const words = phrase.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${words.join("[\\s,;:.!?-]+")}(?![\\p{L}\\p{N}_])[\\s,;:.!?-]*`, "iu").exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : null;
}

export function normalizeWakePhrase(value) {
  const phrase = value.trim().replace(/\s+/g, " ");
  if (phrase.length > 60 || !/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(phrase)) {
    throw new Error("Use 1-60 characters: words or numbers separated by spaces, hyphens or apostrophes.");
  }
  return phrase;
}

// True when the window holds a contiguous run of at least minBurstMs whose
// per-100 ms block RMS is at least burstGain times the median of the window's
// voice blocks and at least absoluteFloor: the user's own voice standing out
// against a quieter speaker echo. A uniform recording (pure echo, or the user
// speaking the whole window at one level) has no such run, so neither can
// self-trigger a voice command.
export function hasLoudBurst(samples, start, end, sampleRate, options = {}) {
  const { voiceThreshold = 0.012, burstGain = 1.5, minBurstMs = 200, absoluteFloor = 0.02 } = options;
  const wrap = samples.length;
  const block = Math.max(1, Math.floor(sampleRate * 0.1));
  start = Math.max(0, Math.floor(start));
  end = Math.floor(end);
  if (end - start < block * 5) return false;
  const levels = [];
  for (let from = start; from + block <= end; from += block) {
    let energy = 0;
    for (let i = 0; i < block; i++) {
      const sample = samples[(from + i) % wrap];
      energy += sample * sample;
    }
    levels.push(Math.sqrt(energy / block));
  }
  const voice = levels.filter((level) => level >= voiceThreshold).sort((a, b) => a - b);
  if (voice.length < 3) return false;
  const floor = Math.max(absoluteFloor, voice[Math.floor(voice.length / 2)] * burstGain);
  const minRun = Math.max(2, Math.round(minBurstMs / 100));
  let run = 0;
  for (const level of levels) {
    if (level >= floor) {
      run += 1;
      if (run >= minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}
