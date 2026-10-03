import test from "node:test";
import assert from "node:assert/strict";
import { voiceProfiles, normalizeVoiceId, normalizeVoiceSpeed, scaledRate, splitForSpeech, pickSynthesisVoice, NeuralVoice } from "../public/voice.js";

test("answers are split into speakable clauses without losing text", () => {
  assert.deepEqual(splitForSpeech("It is 14:05. Shall I continue?"), ["It is 14:05.", "Shall I continue?"]);
  assert.deepEqual(splitForSpeech("  Yes.\n I can do that. "), ["Yes. I can do that."]);
  assert.deepEqual(splitForSpeech(""), []);
  assert.deepEqual(splitForSpeech("   "), []);
  const long = `${"word ".repeat(40)}end, ${"tail ".repeat(20)}stop.`;
  const chunks = splitForSpeech(long, 120);
  assert.ok(chunks.every((chunk) => chunk.length <= 120), JSON.stringify(chunks));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " ").trim());
});

test("only known voice profiles are accepted", () => {
  assert.equal(normalizeVoiceId("hal9000"), "hal9000");
  assert.equal(normalizeVoiceId(" browser "), "browser");
  for (const invalid of ["", null, "HAL9000", "constructor", "__proto__", "toString"]) {
    assert.throws(() => normalizeVoiceId(invalid), /Unknown voice/);
  }
  assert.ok(voiceProfiles.hal9000.neural);
  assert.equal(voiceProfiles.browser.neural, false);
});

test("the HAL profile prefers a deep English voice over a default female one", () => {
  const voices = [
    { name: "Microsoft Zira - English (United States)", lang: "en-US" },
    { name: "Google Deutsch", lang: "de-DE" },
    { name: "Daniel", lang: "en-GB" },
  ];
  assert.equal(pickSynthesisVoice(voices, voiceProfiles.hal9000).name, "Daniel");
  assert.equal(pickSynthesisVoice(voices.slice(0, 2), voiceProfiles.hal9000), null);
  assert.equal(pickSynthesisVoice(voices, voiceProfiles.browser), null);
});

test("the speed slider is clamped and applied as a multiplier", () => {
  assert.equal(normalizeVoiceSpeed("1.25"), 1.25);
  assert.equal(normalizeVoiceSpeed(9), 1.6);
  assert.equal(normalizeVoiceSpeed(0.1), 0.6);
  for (const invalid of ["", null, "fast", NaN]) assert.equal(normalizeVoiceSpeed(invalid), 1);
  // 1.00x must leave the profile exactly as designed.
  assert.equal(scaledRate(voiceProfiles.hal9000.speed, 1), voiceProfiles.hal9000.speed);
  assert.equal(scaledRate(1.04, 1.5), 1.56);
  // Stays inside what /api/speak and SpeechSynthesisUtterance accept.
  assert.equal(scaledRate(1.6, 1.6), 2);
  assert.equal(scaledRate(0.6, 0.6), 0.5);
});

// Chromium covers actual playback (tests/pipeline.browser.mjs). These stubs cover the
// request/playback sequencing: prefetching, stop and partial-failure handover.
function installWebAudioStubs(played) {
  class Node {
    connect(target) { return target; }
    disconnect() {}
  }
  globalThis.BiquadFilterNode = Node;
  globalThis.DynamicsCompressorNode = Node;
  globalThis.ConvolverNode = Node;
  globalThis.GainNode = Node;
  globalThis.AudioBufferSourceNode = class extends Node {
    constructor(context, { buffer }) { super(); this.buffer = buffer; }
    start() {
      played.push(this.buffer);
      this.timer = setTimeout(() => this.onended?.(), 10);
    }
    stop() { clearTimeout(this.timer); }
  };
  globalThis.AudioContext = class {
    constructor() { this.sampleRate = 48000; this.state = "running"; this.destination = new Node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
    async resume() {}
    async close() { this.state = "closed"; }
    async decodeAudioData(audio) { return new TextDecoder().decode(audio); }
  };
}

function stubSpeakFetch(responses) {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body.text);
    const status = responses(requests.length);
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () => new TextEncoder().encode(status === 200 ? `audio:${body.text}` : "engine down"),
    };
  };
  return requests;
}

test("HAL playback speaks every clause in order and prefetches the next one", async () => {
  const played = [];
  installWebAudioStubs(played);
  const requests = stubSpeakFetch(() => 200);
  const speeds = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (url, options) => { speeds.push(JSON.parse(options.body).speed); return fetchOriginal(url, options); };
  const voice = new NeuralVoice(new AbortController().signal, voiceProfiles.hal9000);
  const spoken = [];
  await voice.speak("It is 14:05. I am completely operational. Shall I continue?", {
    speed: 1.3,
    onChunk: (chunk, index, total) => spoken.push(`${index + 1}/${total} ${chunk}`),
  });
  assert.deepEqual(requests, ["It is 14:05.", "I am completely operational.", "Shall I continue?"]);
  assert.deepEqual(played, requests.map((text) => `audio:${text}`));
  assert.deepEqual(spoken, [
    "1/3 It is 14:05.", "2/3 I am completely operational.", "3/3 Shall I continue?",
  ]);
  assert.deepEqual(speeds, [1.3, 1.3, 1.3], "every clause carries the requested speed");
});

test("a failing clause surfaces the unspoken remainder for the browser voice", async () => {
  const played = [];
  installWebAudioStubs(played);
  const requests = stubSpeakFetch((n) => (n === 1 ? 200 : 502));
  const voice = new NeuralVoice(new AbortController().signal, voiceProfiles.hal9000);
  await assert.rejects(
    voice.speak("It is 14:05. I am completely operational. Shall I continue?"),
    (error) => {
      assert.equal(error.name, "VoiceError");
      assert.match(error.message, /502/);
      assert.deepEqual(error.remaining, ["I am completely operational.", "Shall I continue?"]);
      return true;
    });
  assert.deepEqual(played, ["audio:It is 14:05."]);
  assert.equal(requests.length, 2);
});

test("Stop ends HAL playback and releases its audio context", async () => {
  const played = [];
  installWebAudioStubs(played);
  stubSpeakFetch(() => 200);
  const controller = new AbortController();
  const voice = new NeuralVoice(controller.signal, voiceProfiles.hal9000);
  const speaking = voice.speak("It is 14:05. I am completely operational.");
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new DOMException("Session stopped", "AbortError"));
  await assert.rejects(speaking, { name: "AbortError" });
  assert.equal(played.length, 1);
  assert.equal(voice.context.state, "closed");
});
