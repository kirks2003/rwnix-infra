// Live circular spectrum around the core. Each bar reads one slice of the
// current stage's analyser (microphone while listening, shaped TTS output while
// speaking). Stages whose audio cannot be tapped - browser speechSynthesis has
// no Web Audio output - fall back to deterministic synthetic motion so the core
// stays alive without faking real levels.

export const WAVE_COUNT = 60;
export const WAVE_CENTER = 120;
export const WAVE_BASE_RADIUS = 52;
export const WAVE_MAX_LENGTH = 34;
export const WAVE_HOT = 0.78;

// Index 0 points at 12 o'clock; bars run clockwise, like the template's
// rotate(-90) group but without needing a transform on the container.
export function barGeometry(index, count, center = WAVE_CENTER, baseRadius = WAVE_BASE_RADIUS, extension = 0) {
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x1: center + baseRadius * cos,
    y1: center + baseRadius * sin,
    x2: center + (baseRadius + extension) * cos,
    y2: center + (baseRadius + extension) * sin,
  };
}

// One 0-1 value per bar from a 0-255 frequency-bin array. Voice energy lives in
// the low band, so only the first `coverage` fraction of the spectrum is read.
export function sampleSpectrum(data, count, coverage = 0.7) {
  const values = new Float32Array(count);
  const usable = Math.max(1, Math.floor(data.length * coverage));
  for (let i = 0; i < count; i += 1) {
    values[i] = data[Math.floor((i / count) * usable)] / 255;
  }
  return values;
}

// Fast attack, slow release: bars jump with the sound and decay like an
// equalizer needle.
export function smoothStep(previous, target, attack = 0.5, release = 0.12) {
  return previous + (target - previous) * (target > previous ? attack : release);
}

// Deterministic (no random) stage motion: idle breathing, a processing shimmer,
// and a syllable-burst pattern that reads as speech.
export function syntheticValues(mode, count, time) {
  const values = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let value;
    if (mode === "talk") {
      const syllable = 0.5 + 0.5 * Math.sin(time * 6.9 + i * 0.35);
      value = 0.15 + 0.85 * syllable * (0.75 + 0.25 * Math.sin(time * 23 + i * 1.7));
    } else if (mode === "shimmer") {
      value = 0.08 + 0.2 * (0.5 + 0.5 * Math.sin(time * 2.2 + i * 0.55)) * (0.6 + 0.4 * Math.sin(time * 5.1 + i));
    } else {
      value = 0.04 + 0.05 * (0.5 + 0.5 * Math.sin(time * 0.8 + i * 0.3));
    }
    values[i] = value;
  }
  return values;
}

const stageMode = {
  standby: "idle",
  prompting: "mic",
  listening: "mic",
  wake: "mic",
  recording: "mic",
  transcribing: "shimmer",
  thinking: "shimmer",
  computing: "shimmer",
  speaking: "voice",
  error: "idle",
};

export class CoreVisualizer {
  constructor(svg, core, options = {}) {
    const {
      count = WAVE_COUNT,
      center = WAVE_CENTER,
      baseRadius = WAVE_BASE_RADIUS,
      maxLength = WAVE_MAX_LENGTH,
      hotThreshold = WAVE_HOT,
    } = options;
    this.svg = svg;
    this.core = core;
    this.count = count;
    this.center = center;
    this.baseRadius = baseRadius;
    this.maxLength = maxLength;
    this.hotThreshold = hotThreshold;
    this.stage = "standby";
    this.pickAnalyser = () => null;
    this.display = new Float32Array(count);
    this.hot = new Array(count).fill(false);
    this.unit = [];
    const bars = [];
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      this.unit.push([Math.cos(angle), Math.sin(angle)]);
      const base = barGeometry(i, count, center, baseRadius);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", base.x1.toFixed(2));
      line.setAttribute("y1", base.y1.toFixed(2));
      line.setAttribute("x2", base.x1.toFixed(2));
      line.setAttribute("y2", base.y1.toFixed(2));
      svg.appendChild(line);
      bars.push(line);
    }
    this.bars = bars;
    this.raf = 0;
  }

  setStage(kind) {
    this.stage = kind;
  }

  start() {
    if (this.raf) return;
    const frame = (now) => {
      this.render(now / 1000);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  render(time) {
    const mode = stageMode[this.stage] || "idle";
    let targets;
    if (mode === "mic" || mode === "voice") {
      const analyser = this.pickAnalyser();
      if (analyser) {
        const bins = analyser.frequencyBinCount;
        if (!this.binData || this.binData.length !== bins) this.binData = new Uint8Array(bins);
        analyser.getByteFrequencyData(this.binData);
        targets = sampleSpectrum(this.binData, this.count);
      } else {
        targets = syntheticValues(mode === "voice" ? "talk" : "idle", this.count, time);
      }
    } else {
      targets = syntheticValues(mode, this.count, time);
    }
    let level = 0;
    for (let i = 0; i < this.count; i += 1) {
      const value = (this.display[i] = smoothStep(this.display[i], targets[i]));
      level += value;
      const [cos, sin] = this.unit[i];
      const outer = this.baseRadius + value * this.maxLength;
      this.bars[i].setAttribute("x2", (this.center + outer * cos).toFixed(2));
      this.bars[i].setAttribute("y2", (this.center + outer * sin).toFixed(2));
      const isHot = value > this.hotThreshold;
      if (isHot !== this.hot[i]) {
        this.hot[i] = isHot;
        this.bars[i].style.stroke = isHot ? "#ffffff" : "";
      }
    }
    this.core.style.setProperty("--audio-level", (level / this.count).toFixed(3));
  }
}
