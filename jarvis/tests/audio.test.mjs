import test from "node:test";
import assert from "node:assert/strict";
import { AudioBufferWindow, delay, wakeCommand, normalizeWakePhrase } from "../public/audio.js";

test("Whisper punctuation and case do not prevent wake detection", () => {
  assert.equal(wakeCommand("Hey, Jarvis! What's the time?", "hey jarvis"), "What's the time?");
  assert.equal(wakeCommand("HEY JARVIS.", "hey jarvis"), "");
  assert.equal(wakeCommand("hey jarvison do something", "hey jarvis"), null);
  assert.equal(wakeCommand("background speech", "hey jarvis"), null);
});

test("Rocky supports wake-only and inline commands without matching longer words", () => {
  assert.equal(wakeCommand("Rocky, what time is it?", "Rocky"), "what time is it?");
  assert.equal(wakeCommand("ROCKY!", "Rocky"), "");
  assert.equal(wakeCommand("rocky. Wie viel Uhr ist es?", "Rocky"), "Wie viel Uhr ist es?");
  assert.equal(wakeCommand("Rockyard", "Rocky"), null);
  assert.equal(wakeCommand("Hey Jarvis", "Rocky"), null);
});

test("personal wake phrases are normalized and validated", () => {
  assert.equal(normalizeWakePhrase("  Hey   Nova "), "Hey Nova");
  assert.equal(normalizeWakePhrase("R2-D2"), "R2-D2");
  for (const invalid of ["", "  ", "!", "<script>", "a".repeat(61)]) {
    assert.throws(() => normalizeWakePhrase(invalid), /1-60/);
  }
  const phrase = "\u00c9cho";
  assert.equal(normalizeWakePhrase(phrase), phrase);
  assert.equal(wakeCommand("\u00e9cho, hello", phrase), "hello");
  assert.equal(wakeCommand("super\u00e9cho, hello", phrase), null);
});

test("every overlapping audio snapshot has a complete WAV header and correct PCM", async () => {
  const buffer = new AudioBufferWindow(16000, 1);
  buffer.push(new Float32Array(16000).fill(0.5));
  buffer.push(new Float32Array(8000).fill(-0.5));
  const wav = await buffer.wav(12000, 20000).arrayBuffer();
  const header = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(header.getUint32(24, true), 16000);
  assert.equal(header.getUint32(40, true), 16000);
  assert.equal(header.getInt16(44, true), 16383);
  assert.equal(header.getInt16(44 + 4000 * 2, true), -16384);
  assert.throws(() => buffer.wav(0), /outside/);
  assert.equal(buffer.lastVoice, 24000);
  buffer.push(new Float32Array(100));
  assert.equal(buffer.lastVoice, 24000);
});

test("Stop cancels waits immediately", async () => {
  const controller = new AbortController();
  const waiting = delay(60000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
