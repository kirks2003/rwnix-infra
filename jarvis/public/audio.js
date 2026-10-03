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
    const data = new ArrayBuffer(44 + (end - start) * 2);
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
    for (let i = start; i < end; i++) {
      const sample = Math.max(-1, Math.min(1, this.samples[i % this.samples.length]));
      view.setInt16(44 + (i - start) * 2, sample * (sample < 0 ? 32768 : 32767), true);
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
    this.node = new AudioWorkletNode(this.context, "jarvis-capture");
    this.node.onprocessorerror = () => { this.failure = new Error("Audio capture processor failed"); };
    this.node.port.onmessage = ({ data }) => {
      if (this.signal.aborted) return;
      this.buffer.push(data);
      this.lastBlockAt = performance.now();
    };
    this.source.connect(this.node);
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

  close() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context.state !== "closed") {
      this.context.close().catch((error) => console.error("Audio context cleanup failed", error));
    }
  }
}

export function wakeCommand(text, phrase) {
  const words = phrase.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(`\\b${words.join("[\\s,;:.!?-]+")}\\b[\\s,;:.!?-]*`, "i").exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : null;
}
