import test from "node:test";
import assert from "node:assert/strict";
import {
  barGeometry, sampleSpectrum, smoothStep, syntheticValues, timeDomainLevel,
  WAVE_COUNT, WAVE_CENTER, WAVE_BASE_RADIUS,
} from "../public/visualizer.js";

test("bars point radially outward, index 0 at 12 o'clock, clockwise order", () => {
  const top = barGeometry(0, 60, WAVE_CENTER, WAVE_BASE_RADIUS, 10);
  assert.ok(Math.abs(top.x1 - WAVE_CENTER) < 1e-9);
  assert.equal(top.y1, WAVE_CENTER - WAVE_BASE_RADIUS);
  assert.equal(top.y2, WAVE_CENTER - WAVE_BASE_RADIUS - 10);
  const right = barGeometry(15, 60, WAVE_CENTER, WAVE_BASE_RADIUS, 10);
  assert.ok(Math.abs(right.y1 - WAVE_CENTER) < 1e-9);
  assert.ok(right.x2 > right.x1);
  const bottom = barGeometry(30, 60, WAVE_CENTER, WAVE_BASE_RADIUS, 10);
  assert.ok(Math.abs(bottom.x1 - WAVE_CENTER) < 1e-9);
  assert.equal(bottom.y2, WAVE_CENTER + WAVE_BASE_RADIUS + 10);
  const left = barGeometry(45, 60, WAVE_CENTER, WAVE_BASE_RADIUS, 10);
  assert.ok(Math.abs(left.y1 - WAVE_CENTER) < 1e-9);
  assert.ok(left.x2 < left.x1);
});

test("every bar sits on the base radius and a zero extension collapses it", () => {
  for (let i = 0; i < WAVE_COUNT; i += 1) {
    const point = barGeometry(i, WAVE_COUNT, WAVE_CENTER, WAVE_BASE_RADIUS, 0);
    assert.ok(Math.abs(Math.hypot(point.x1 - WAVE_CENTER, point.y1 - WAVE_CENTER) - WAVE_BASE_RADIUS) < 1e-9);
    assert.equal(point.x1, point.x2);
    assert.equal(point.y1, point.y2);
  }
});

test("spectrum sampling normalises to 0-1 and stays inside the low band", () => {
  const data = new Uint8Array(256);
  for (let i = 0; i < data.length; i += 1) data[i] = i;
  const values = sampleSpectrum(data, 60, 0.7);
  assert.equal(values.length, 60);
  assert.ok(values.every((value) => value >= 0 && value <= 1));
  const usable = Math.floor(256 * 0.7);
  assert.equal(values[0], 0);
  assert.ok(values[59] <= usable / 255);
});

test("bins above the coverage cutoff never reach the bars", () => {
  const data = new Uint8Array(256);
  data[255] = 255;
  assert.ok(sampleSpectrum(data, 60, 0.7).every((value) => value === 0));
});

test("smoothing attacks fast, releases slow, and converges", () => {
  const up = smoothStep(0.1, 0.9, 0.5, 0.12);
  const down = smoothStep(0.9, 0.1, 0.5, 0.12);
  // Same 0.8 gap: the upward step must cover far more of it than the downward one.
  assert.ok(Math.abs(up - 0.5) < 1e-9);
  assert.ok(Math.abs(down - 0.804) < 1e-9);
  assert.ok(up - 0.1 > 0.9 - down);
  let value = 0;
  for (let i = 0; i < 200; i += 1) value = smoothStep(value, 1, 0.5, 0.12);
  assert.ok(value > 0.999);
});

test("time-domain level is 0 for silence, tracks amplitude, and clamps at 1", () => {
  assert.equal(timeDomainLevel(new Uint8Array(512).fill(128)), 0);
  const tone = (amplitude) => {
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i += 1) data[i] = Math.round(128 + amplitude * Math.sin((i / 512) * 20 * Math.PI));
    return data;
  };
  const loud = timeDomainLevel(tone(40)); // RMS 0.22 * gain 8 -> clamped to 1
  const quiet = timeDomainLevel(tone(4)); // RMS 0.016 * gain 8 -> ~0.12
  assert.equal(loud, 1);
  assert.ok(quiet > 0 && quiet < 0.3);
  assert.ok(loud > quiet);
});

test("synthetic motion stays in the unit interval and modes differ in energy", () => {
  for (const mode of ["idle", "shimmer", "talk"]) {
    for (const time of [0, 1.7, 4.2, 9.9]) {
      const values = syntheticValues(mode, 60, time);
      assert.equal(values.length, 60);
      assert.ok(values.every((value) => value >= 0 && value <= 1.0001));
    }
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(syntheticValues("talk", 60, 2.3)) > mean(syntheticValues("idle", 60, 2.3)));
});
