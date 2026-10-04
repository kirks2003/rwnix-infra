import test from "node:test";
import assert from "node:assert/strict";
import { voiceProfiles, normalizeVoiceId, normalizeVoiceSpeed, scaledRate, splitForSpeech, pickSynthesisVoice, pickGermanSynthesisVoice, NeuralVoice, textForSpeech, isStopCommand, stopCommandIn, isPostSpeechStop, STOP_COMMANDS } from "../public/voice.js";

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

test("German mode picks a male German voice and never an English one", () => {
  const voices = [
    { name: "Google US English", lang: "en-US" },
    { name: "Google Deutsch", lang: "de-DE" },
    { name: "Microsoft Conrad - German (Germany)", lang: "de-DE" },
  ];
  assert.equal(pickGermanSynthesisVoice(voices).name, "Microsoft Conrad - German (Germany)");
  assert.equal(pickGermanSynthesisVoice([voices[1], voices[0]]).name, "Google Deutsch");
  assert.equal(pickGermanSynthesisVoice([voices[0]]), null);
});

test("character profiles are neural and keep distinct delivery", () => {
  for (const id of ["commander", "android", "wizard", "newscaster"]) {
    assert.equal(voiceProfiles[id].neural, true, id);
    assert.ok(voiceProfiles[id].speed > 0 && voiceProfiles[id].chunkChars > 0, id);
    assert.ok(voiceProfiles[id].voiceHints.length > 0, id);
  }
  // Distinct paces keep the characters audible apart even on the browser fallback.
  assert.notEqual(voiceProfiles.commander.speed, voiceProfiles.newscaster.speed);
  assert.notEqual(voiceProfiles.commander.pitch, voiceProfiles.newscaster.pitch);
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

test("named male and female profiles exist with matching Kokoro voices", () => {
  for (const [id, gender, ttsVoice] of [
    ["heart", "female", "af_heart"], ["bella", "female", "af_bella"],
    ["nicole", "female", "af_nicole"], ["sarah", "female", "af_sarah"],
    ["adam", "male", "am_adam"], ["eric", "male", "am_eric"], ["liam", "male", "am_liam"],
  ]) {
    assert.equal(voiceProfiles[id].gender, gender, id);
    assert.equal(voiceProfiles[id].ttsVoice, ttsVoice, id);
    assert.equal(voiceProfiles[id].neural, true, id);
    assert.ok(voiceProfiles[id].voiceHints.length > 0, id);
    assert.equal(voiceProfiles[id].group, gender, id);
  }
});

test("female profiles pick a female browser voice, male profiles a male one", () => {
  const voices = [
    { name: "Microsoft George - English (United States)", lang: "en-US" },
    { name: "Microsoft Zira - English (United States)", lang: "en-US" },
  ];
  assert.equal(pickSynthesisVoice(voices, voiceProfiles.heart).name, "Microsoft Zira - English (United States)");
  assert.equal(pickSynthesisVoice(voices, voiceProfiles.adam).name, "Microsoft George - English (United States)");
  // With only a voice of the wrong gender available, no hint-matched fallback wins.
  assert.equal(pickSynthesisVoice([voices[0]], voiceProfiles.nicole), null);
  assert.equal(pickSynthesisVoice([voices[1]], voiceProfiles.eric), null);
});

test("German mode picks a female German voice for female profiles", () => {
  const voices = [
    { name: "Google US English", lang: "en-US" },
    { name: "Microsoft Conrad - German (Germany)", lang: "de-DE" },
    { name: "Microsoft Katrin - German (Germany)", lang: "de-DE" },
  ];
  assert.equal(pickGermanSynthesisVoice(voices, "female").name, "Microsoft Katrin - German (Germany)");
  assert.equal(pickGermanSynthesisVoice(voices, "male").name, "Microsoft Conrad - German (Germany)");
  assert.equal(pickGermanSynthesisVoice(voices).name, "Microsoft Conrad - German (Germany)");
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
  globalThis.AnalyserNode = Node;
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

test("voice commands that cut spoken answers are recognized, everything else is a follow-up", () => {
  for (const command of STOP_COMMANDS) assert.equal(isStopCommand(command), true, command);
  assert.equal(isStopCommand("  STOP. "), true);
  assert.equal(isStopCommand("Stopp!"), true);
  assert.equal(isStopCommand("Das reicht."), true);
  for (const command of ["", null, "hello", "what time is it?", "stop the car", "genug ist genug", "stop it now"]) {
    assert.equal(isStopCommand(command), false, JSON.stringify(command));
  }
});

test("a stop command right after the spoken answer stays out of the brain", () => {
  assert.equal(isPostSpeechStop("stop", 1000, 9999, 10000), true, "inside the window");
  assert.equal(isPostSpeechStop("  STOP. ", 1000, 5000, 10000), true, "punctuation");
  assert.equal(isPostSpeechStop("stop", 1000, 11000, 10000), false, "outside the window");
  assert.equal(isPostSpeechStop("stop", 0, 5000, 10000), false, "no speech has ended");
  assert.equal(isPostSpeechStop("what time is it?", 1000, 5000, 10000), false, "not a stop command");
});

test("the stop word is found inside an echoed transcript, not inside longer words", () => {
  assert.equal(stopCommandIn("Stopp."), "stopp");
  assert.equal(stopCommandIn("Der Regen bleibt bis morgen. Stopp"), "stopp");
  assert.equal(stopCommandIn("Hör auf bitte!"), "hör auf");
  assert.equal(stopCommandIn("Lass das, danke."), "lass das");
  assert.equal(stopCommandIn("Das reicht, danke"), "das reicht");
  // Word boundaries: the stop word must stand alone, not inside another word.
  assert.equal(stopCommandIn("Die Stoppuhr läuft weiter"), null);
  assert.equal(stopCommandIn("Halten Sie die Tür"), null);
  assert.equal(stopCommandIn("genugsam ist genug"), "genug");
  assert.equal(stopCommandIn(""), null);
  assert.equal(stopCommandIn(null), null);
});

test("trailing stop words are only accepted at the very end of the text", () => {
  assert.equal(stopCommandIn("Der Regen bleibt bis morgen. Stopp", { trailing: true }), "stopp");
  assert.equal(stopCommandIn("Stopp", { trailing: true }), "stopp");
  assert.equal(stopCommandIn("Genug, was ist das Wetter?", { trailing: true }), null);
  assert.equal(stopCommandIn("Genug", { trailing: true }), "genug");
});

test("an echoed stop right after the spoken answer needs a user burst in the window", () => {
  assert.equal(isPostSpeechStop("Regen bis morgen. Stopp", 1000, 9999, 10000), false, "pure echo cannot self-trigger");
  assert.equal(isPostSpeechStop("Regen bis morgen. Stopp", 1000, 9999, 10000, { userBurst: true }), true, "user burst unlocks the match");
  assert.equal(isPostSpeechStop("Genug, was ist das Wetter?", 1000, 9999, 10000, { userBurst: true }), false, "the stop word must end the utterance");
  assert.equal(isPostSpeechStop("Regen bis morgen. Stopp", 1000, 11000, 10000, { userBurst: true }), false, "outside the window");
});

test("the speaker gets plain language without markdown or special signs", () => {
  assert.equal(textForSpeech("It is **14:05**."), "It is 14:05.");
  assert.equal(textForSpeech("Use `npm test` and [the docs](https://example.com/docs)"), "Use npm test and the docs");
  assert.equal(textForSpeech("- first\n- second"), "first second");
  assert.equal(textForSpeech("1. one\n2. two"), "one two");
  assert.equal(textForSpeech("See https://example.com/path for details"), "See for details");
  assert.equal(textForSpeech("# Heading\nBody text"), "Heading Body text");
  assert.equal(textForSpeech("50% done, right? — Yes!"), "50% done, right? — Yes!");
  assert.equal(textForSpeech("café, Straße, naïve"), "café, Straße, naïve");
  assert.equal(textForSpeech("```\ncode block\n```"), "");
  assert.equal(textForSpeech("a * b | c > d"), "a b c d");
  assert.equal(textForSpeech(""), "");
  assert.equal(textForSpeech(null), "");
});
