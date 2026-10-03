// Live circular spectrum around the core. Each bar reads one slice of the
// current stage's analyser (microphone while listening, shaped TTS output while
// speaking). Stages whose audio cannot be tapped - browser speechSynthesis has
// no Web Audio output - fall back to deterministic synthetic motion so the core
// stays alive without faking real levels. A level ring around the reactor and a
// numeric readout show the real-time RMS level at 60 fps.

export const WAVE_COUNT = 72;
export const WAVE_CENTER = 180;
export const WAVE_BASE_RADIUS = 100;
export const WAVE_MAX_LENGTH = 74;
export const WAVE_HOT = 0.78;
export const LEVEL_GAIN = 8;
export const LEVEL_RING_RADIUS = 74;

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

// RMS of a 0-255 time-domain buffer, scaled so ordinary speech fills the meter:
// speech RMS is typically 0.02-0.15, so gain 8 maps it onto 0.16-1.0.
export function timeDomainLevel(data, gain = LEVEL_GAIN) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * gain);
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
      value = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(time * 3.1 + i * 0.55)) * (0.6 + 0.4 * Math.sin(time * 7.3 + i));
    } else {
      value = 0.10 + 0.14 * (0.5 + 0.5 * Math.sin(time * 1.1 + i * 0.35)) * (0.7 + 0.3 * Math.sin(time * 0.53 + i * 0.12));
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
      levelRadius = LEVEL_RING_RADIUS,
    } = options;
    this.svg = svg;
    this.core = core;
    this.count = count;
    this.center = center;
    this.baseRadius = baseRadius;
    this.maxLength = maxLength;
    this.hotThreshold = hotThreshold;
    this.levelRadius = levelRadius;
    this.stage = "standby";
    this.pickAnalyser = () => null;
    this.onLevel = null;
    this.display = new Float32Array(count);
    this.hot = new Array(count).fill(false);
    this.level = 0;
    this.lastLevelAt = 0;
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
    this.circumference = 2 * Math.PI * levelRadius;
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("class", "level-ring");
    ring.setAttribute("cx", center);
    ring.setAttribute("cy", center);
    ring.setAttribute("r", levelRadius);
    ring.setAttribute("transform", `rotate(-90 ${center} ${center})`);
    ring.setAttribute("stroke-dasharray", this.circumference.toFixed(2));
    ring.setAttribute("stroke-dashoffset", this.circumference.toFixed(2));
    svg.appendChild(ring);
    this.levelRing = ring;
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

  resetLevel() {
    this.level = 0;
    this.levelRing.setAttribute("stroke-dashoffset", this.circumference.toFixed(2));
    this.core.style.setProperty("--level", "0");
  }

  render(time) {
    const mode = stageMode[this.stage] || "idle";
    const analyser = this.pickAnalyser();
    let targets;
    let levelTarget;
    if (analyser) {
      const bins = analyser.frequencyBinCount;
      if (!this.binData || this.binData.length !== bins) this.binData = new Uint8Array(bins);
      analyser.getByteFrequencyData(this.binData);
      // The time-domain RMS is the real-time level for every stage - during
      // transcribing/thinking it shows ambient mic input, while speaking it
      // shows the agent's own shaped output.
      if (!this.timeData || this.timeData.length !== bins) this.timeData = new Uint8Array(bins);
      analyser.getByteTimeDomainData(this.timeData);
      levelTarget = timeDomainLevel(this.timeData);
      if (mode === "mic" || mode === "voice") {
        targets = sampleSpectrum(this.binData, this.count);
      } else {
        targets = syntheticValues(mode, this.count, time);
      }
    } else {
      targets = syntheticValues(mode === "voice" ? "talk" : mode, this.count, time);
      let sum = 0;
      for (let i = 0; i < this.count; i += 1) sum += targets[i];
      levelTarget = sum / this.count;
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
    this.level = smoothStep(this.level, levelTarget);
    this.core.style.setProperty("--audio-level", (level / this.count).toFixed(3));
    this.core.style.setProperty("--level", this.level.toFixed(3));
    this.levelRing.setAttribute("stroke-dashoffset", (this.circumference * (1 - this.level)).toFixed(2));
    if (this.onLevel && time * 1000 - this.lastLevelAt >= 100) {
      this.lastLevelAt = time * 1000;
      this.onLevel(this.level);
    }
  }
}
