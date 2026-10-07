import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioBufferWindow } from "../public/audio.js";

let browser, server, origin, temp, fixture, speechAudio;
before(async () => {
  temp = await mkdtemp(join(tmpdir(), "jarvis-browser-"));
  fixture = join(temp, "microphone.wav");
  const rate = 48000;
  const audio = new AudioBufferWindow(rate, 12);
  const samples = new Float32Array(rate * 12);
  for (let i = 0; i < samples.length; i++) {
    if (i / rate % 4 < 1.2) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  audio.push(samples);
  await writeFile(fixture, Buffer.from(await audio.wav(0).arrayBuffer()));
  const speech = new AudioBufferWindow(rate, 1);
  const spoken = new Float32Array(Math.round(rate * 0.25));
  for (let i = 0; i < spoken.length; i++) spoken[i] = 0.25 * Math.sin(i * Math.PI * 2 * 180 / rate);
  speech.push(spoken);
  speechAudio = Buffer.from(await speech.wav(0).arrayBuffer());
  server = createServer(async (req, res) => {
    try {
      const file = req.url === "/" ? "index.html" : req.url.slice(1);
      const body = await readFile(new URL(`../public/${file}`, import.meta.url));
      res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    channel: "chromium", headless: true,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${process.env.JARVIS_SPEECH_FIXTURE || fixture}`],
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function launchWithFixture(t, path) {
  // A second browser whose fake microphone plays a custom fixture, for tests
  // that need specific loudness patterns (echo plus user burst) in the
  // capture buffer. The shared browser's 4 s loop tone is uniform and can
  // never produce one.
  const instance = await chromium.launch({
    channel: "chromium", headless: true,
    args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${path}`],
  });
  t.after(() => instance.close());
  return instance;
}

async function setup(t, transcribe, options = {}, pageBrowser = browser) {
  const page = await pageBrowser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const calls = { audio: [], prompts: [], speak: [], mcp: undefined, wakePhrase: undefined, maxInFlight: 0 };
  let inFlight = 0;
  await page.addInitScript(() => {
    window.testTracks = [];
    window.ttsEvents = [];
    window.failNextTTS = 0;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      if (window.denyMicrophone) throw new DOMException("Permission denied", "NotAllowedError");
      const stream = await getUserMedia(...args);
      window.testTracks.push(...stream.getTracks());
      if (window.silentInput) stream.getTracks().forEach((track) => { track.enabled = false; });
      if (window.delayPermission) await new Promise((resolve) => { window.grantPermission = resolve; });
      return stream;
    };
    window.savedUtterances = [];
    speechSynthesis.speak = (utterance) => {
      if (!utterance.text) return;
      window.savedUtterances.push(utterance);
      window.ttsEvents.push("speak");
      if (window.failNextTTS > 0) {
        window.failNextTTS -= 1;
        setTimeout(() => utterance.onerror?.({ error: "synthesis-failed" }), 25);
        return;
      }
      if (!window.hangTTS) setTimeout(() => utterance.onend?.(), 25);
    };
    speechSynthesis.cancel = () => window.ttsEvents.push("cancel");
    speechSynthesis.resume = () => {};
  });
  await page.route("**/api/config", (route) => route.fulfill({ json: {
    wakePhrase: "Rocky", silenceMs: process.env.JARVIS_LIVE_STT_ENDPOINT ? 1500 : 250,
    whisperLanguage: process.env.JARVIS_TEST_LANGUAGE || "en",
    whisperEndpoints: [process.env.JARVIS_LIVE_STT_ENDPOINT || "http://vm103.test/v1/audio/transcriptions"],
    ...options.config,
  } }));
  await page.route("**/api/speak", async (route) => {
    const payload = route.request().postDataJSON();
    calls.speak.push(payload.text);
    const result = options.speak ? await options.speak(calls.speak.length, payload) : { status: 503 };
    await route.fulfill(result.status && result.status !== 200
      ? { status: result.status, json: { error: "tts_unavailable" } }
      : { status: 200, contentType: "audio/wav", body: speechAudio }).catch((error) => {
      if (!page.isClosed()) throw error;
    });
  });
  // The app sends the spoken language as a query parameter; Playwright globs
  // match the full URL, so the pattern must keep matching past the "?".
  await page.route("**/api/transcribe*", async (route) => {
    // The pipeline is strictly sequential; track the overlap so a regression
    // to parallel requests (e.g. a retry firing while the first is in flight)
    // fails every test that uses this harness.
    inFlight += 1;
    calls.maxInFlight = Math.max(calls.maxInFlight, inFlight);
    try {
      const body = route.request().postDataBuffer();
      assert.equal(body.toString("ascii", 0, 4), "RIFF");
      assert.equal(body.toString("ascii", 8, 12), "WAVE");
      assert.equal(body.readUInt32LE(40), body.length - 44);
      assert.ok(body.length > 20000);
      calls.audio.push(body);
      const result = await transcribe(calls.audio.length, body);
      await route.fulfill({ status: result.status || 200, json: {
        endpoint: "http://vm103.test/v1/audio/transcriptions", requestId: `stt-${calls.audio.length}`,
        ...result,
      } }).catch((error) => {
        if (!page.isClosed()) throw error;
      });
    } finally {
      inFlight -= 1;
    }
  });
  await page.route("**/api/chat", async (route) => {
    const payload = route.request().postDataJSON();
    calls.prompts.push(payload.prompt);
    calls.mcp = payload.mcp;
    calls.wakePhrase = payload.wakePhrase;
    const result = options.chat
      ? await options.chat(calls.prompts.length, payload)
      : { answer: options.answer || "Done.", requestId: "brain-test" };
    await route.fulfill(result.status && result.status !== 200
      ? { status: result.status, json: { error: result.error || "brain_unavailable" } }
      : { json: { answer: result.answer, requestId: result.requestId || "brain-test" } }).catch((error) => {
      if (!page.isClosed()) throw error;
    });
  });
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  if (options.voice) {
    await page.selectOption("#voiceSelect", options.voice);
    await page.click("#saveVoiceButton");
  }
  if (options.hangTTS) await page.evaluate(() => { window.hangTTS = true; });
  await page.evaluate((value) => {
    window.silentInput = value.silent;
    window.denyMicrophone = value.denied;
    window.delayPermission = value.delayedPermission;
  }, { silent: options.silent, denied: options.denied, delayedPermission: options.delayedPermission });
  await page.click("#armButton");
  return { page, calls };
}

test("real Chromium capture completes three answered turns with fresh valid audio", { timeout: 45000 }, async (t) => {
  // The first turn comes through the wake word; after each spoken answer the
  // follow-up command window opens, so the next turns chain without the wake
  // word: one probe + completed utterance, then two command transcriptions.
  const { page, calls } = await setup(t, async () => ({ text: "Rocky! What time is it?" }));
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 35000 });
  await page.click("#stopButton");
  assert.equal(calls.prompts.length, 3);
  assert.deepEqual(calls.prompts, Array(3).fill("What time is it?"));
  assert.equal(calls.audio.length, 4);
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "ended")));
  assert.match(await page.textContent("#log"), /stt-4/);
});

test("Stop ignores late Whisper responses and allows a clean re-arm", { timeout: 30000 }, async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { page, calls } = await setup(t, async (n) => {
    if (n === 1) await blocked;
    return { text: "Rocky tell me the time" };
  });
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Checking wake word");
  await page.click("#stopButton");
  release();
  await page.waitForTimeout(300);
  assert.equal(calls.prompts.length, 0);
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
  await page.click("#armButton");
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 15000 });
  await page.click("#stopButton");
  assert.equal(calls.prompts.length, 1);
});

test("an exhausted Whisper retry is a visible error, then recovers sequentially", { timeout: 45000 }, async (t) => {
  // The first wake probe fails on all three bounded attempts, which is the
  // visible pipeline error; the next probe recovers and the user does not
  // have to speak anything again.
  const { page, calls } = await setup(t, async (n) => n <= 3
    ? { status: 502, error: "vm103 unavailable" }
    : { text: "Rocky recovered" });
  await page.waitForFunction(() => document.getElementById("core").classList.contains("error"));
  // The hero only shows the short error caption; server details live in the log.
  assert.match(await page.textContent("#log"), /vm103 unavailable/);
  // Two "retrying" lines plus the error stage prove all three attempts ran.
  assert.match(await page.textContent("#log"), /wake probe failed \(attempt 1\/3\)/);
  assert.match(await page.textContent("#log"), /wake probe failed \(attempt 2\/3\)/);
  assert.match(await page.textContent("#log"), /Pipeline error/);
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["recovered"]);
  // The pipeline is strictly sequential: no two transcribe requests in flight.
  assert.equal(calls.maxInFlight, 1);
});

test("a transient Whisper failure recovers on the bounded retry without an error stage", { timeout: 30000 }, async (t) => {
  // One failed attempt is retried with the same captured window; the retry
  // succeeds, so no pipeline error stage appears at all.
  const { page, calls } = await setup(t, async (n) => n === 1
    ? { status: 502, error: "vm103 unavailable" }
    : { text: "Rocky, what time is it?" });
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 20000 });
  await page.click("#stopButton");
  const log = await page.textContent("#log");
  assert.match(log, /wake probe failed \(attempt 1\/3\): vm103 unavailable; retrying in 1000 ms/);
  assert.doesNotMatch(log, /Pipeline error/);
  assert.equal(await page.evaluate(() => document.getElementById("core").classList.contains("error")), false);
  assert.deepEqual(calls.prompts, ["what time is it?"]);
  assert.equal(calls.maxInFlight, 1);
});

test("missing TTS onend cancels speech before the next wake", { timeout: 30000 }, async (t) => {
  // While the hung TTS is active the speech wake-watch probes the mic; the
  // fixture tone keeps playing, so only the first two calls may carry the
  // wake phrase or the watch would interrupt the very speech under test.
  const { page } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky hello" : "background noise" }), { hangTTS: true });
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Speech output timed out"), null, { timeout: 18000 });
  assert.equal(await page.evaluate(() => ttsEvents.at(-1)), "cancel");
  await page.click("#stopButton");
  await page.evaluate(() => savedUtterances[0].onend?.());
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
});

test("wake word plus stop cuts a speaking answer before it finishes", { timeout: 30000 }, async (t) => {
  // The answer is left hanging (hangTTS), so the speech wake-watch is the
  // only thing that can end it: it probes the fixture tone, hears the stop
  // command and must cut the speech without a second brain round trip.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : "Rocky stop",
  }), { hangTTS: true });
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Speech stopped by voice command"),
    null, { timeout: 20000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  // The hung utterance was cancelled by the cut, not left to the TTS watchdog.
  assert.equal(await page.evaluate(() => ttsEvents.at(-1)), "cancel");
  // After a stop the follow-up command window opens, not wake listening.
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Waiting for command",
    null, { timeout: 10000 });
  await page.click("#stopButton");
});

test("a bare stop word without the wake phrase cuts a speaking answer", { timeout: 30000 }, async (t) => {
  // The escape hatch for answers that run too long: the user says just the
  // stop word (no wake phrase) while the answer is still speaking, and the
  // speech wake-watch must cut the audio on it without a second brain round
  // trip.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : "stop",
  }), { hangTTS: true });
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Speech stopped by voice command"),
    null, { timeout: 20000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  // The hung utterance was cancelled by the cut, not left to the TTS watchdog.
  assert.equal(await page.evaluate(() => ttsEvents.at(-1)), "cancel");
  // After a stop the follow-up command window opens, not wake listening.
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Waiting for command",
    null, { timeout: 10000 });
  await page.click("#stopButton");
});

test("a stop word inside the echoed window cuts a speaking answer on a loud user burst", { timeout: 45000 }, async (t) => {
  // The speaker echo puts the answer's own words into the probe window, so the
  // transcript is the echo plus the stop word, never a bare "stop". The
  // fixture plays a 0.2 s loud burst (the user) against a quieter 1.2 s tone
  // (the echo) per 6 s loop, and the slowed brain starts the speaking phase
  // mid-loop: the watch's settled probe covers the last 2 s, so its window
  // carries the burst as a clear minority of voice blocks; the loud-burst
  // gate opens and the containment match cuts the speech before the TTS
  // watchdog without a second brain round trip. (The inverse — an echoed stop word in a window without a
  // user burst — is covered by the unit tests for hasLoudBurst and
  // isPostSpeechStop; the fake capture's audio processing decays a steady
  // echo tone below the voice threshold, so it cannot hold such a window.)
  const rate = 48000;
  const fixturePath = join(temp, "echo-burst-microphone.wav");
  const loop = new AudioBufferWindow(rate, 6);
  const samples = new Float32Array(rate * 6);
  for (let i = 0; i < samples.length; i++) {
    const inLoop = (i / rate) % 6;
    const amplitude = inLoop < 0.2 ? 0.3 : inLoop < 1.4 ? 0.035 : 0;
    samples[i] = amplitude * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : n === 3 ? "Der Regen bleibt bis morgen. Stopp" : "",
  }), {
    hangTTS: true,
    chat: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { answer: "Done.", requestId: "brain-test" };
    },
  }, instance);
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("Speech stopped by voice command"),
    null, { timeout: 30000 });
  const log = await page.textContent("#log");
  assert.match(log, /Stop word heard while speaking: "Der Regen bleibt bis morgen\. Stopp"/);
  assert.match(log, /Speech stopped by voice command "stopp"/);
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"], "the stop word must not start a brain round trip");
});

test("a stop command right after the spoken answer is not sent to the brain", { timeout: 30000 }, async (t) => {
  // The answer speaks and finishes on its own (25 ms mock), then the
  // follow-up command window opens. The next burst is transcribed as
  // "Rocky stop": inside the post-speech window it must be treated as a
  // speech stop (acknowledged, window stays open), not as a prompt for the
  // brain.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : "Rocky stop",
  }));
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("after the spoken answer"),
    null, { timeout: 20000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  // The acknowledged stop keeps the command window open, not wake listening.
  assert.equal(await page.textContent("#stageTitle"), "Waiting for command");
  await page.click("#stopButton");
});

test("wake-only response greets with the user's name, then transcribes the command", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky." : "What time is it?" }), {
    config: { user: "Mila" },
  });
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Waiting for command");
  // Utterance 1 is the spoken greeting naming the signed-in user, utterance
  // 2 is the answer.
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 18000 });
  await page.click("#stopButton");
  assert.equal(await page.evaluate(() => savedUtterances[0].text), "Yes, Mila.");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(calls.audio.length, 3);
});

test("three seconds of silence after the greeting returns to wake listening", { timeout: 40000 }, async (t) => {
  // The fixture tone plays 1 s per 6 s loop, so the wake probe fires once and
  // the command window then sees only silence: the 3 s silence rule must
  // close the window (and must not wait out the old 10 s).
  const rate = 48000;
  const fixturePath = join(temp, "quiet-after-wake-microphone.wav");
  const loop = new AudioBufferWindow(rate, 6);
  const samples = new Float32Array(rate * 6);
  for (let i = 0; i < samples.length; i++) {
    if (i / rate < 1) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({ text: n === 1 ? "Rocky" : "" }), {
    config: { user: "Roman" },
  }, instance);
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    if (title !== "Waiting for command") return false;
    window.commandWaitStartedAt = performance.now();
    return true;
  });
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    if (title !== "Wake listening") return false;
    window.commandWaitMs = performance.now() - (window.commandWaitStartedAt || 0);
    return true;
  }, null, { timeout: 15000 });
  const waitMs = await page.evaluate(() => window.commandWaitMs);
  assert.ok(waitMs < 8000, `greeting + 3 s silence took ${waitMs} ms`);
  assert.equal(await page.evaluate(() => savedUtterances[0]?.text), "Yes, Roman.");
  assert.match(await page.textContent("#log"), /No command after 3 s of silence/);
  assert.deepEqual(calls.prompts, []);
  await page.click("#stopButton");
});

test("the command wait slider sets the abort delay and persists per browser", { timeout: 60000 }, async (t) => {
  // One tone per 6 s loop, so every wake cycle ends in the command window's
  // abort: cycle 1 at the 3 s default, cycle 2 after the slider drops to
  // 0.5 s mid-page. The abort clock runs from the greeting's end, so the
  // wait is the greeting plus the slider value either way.
  const rate = 48000;
  const fixturePath = join(temp, "command-wait-slider-microphone.wav");
  const loop = new AudioBufferWindow(rate, 6);
  const samples = new Float32Array(rate * 6);
  for (let i = 0; i < samples.length; i++) {
    if (i / rate < 1) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({ text: n % 2 === 1 ? "Rocky" : "" }), {
    config: { user: "Roman" },
  }, instance);
  assert.equal(await page.inputValue("#commandWait"), "3000");
  assert.equal(await page.textContent("#commandWaitValue"), "3 s");
  // Edge-detect each entry into the command stage: cycle 1 runs the 3 s
  // default, and entering cycle 2 drops the slider to 0.5 s.
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    if (title === "Waiting for command" && window.lastStage !== "Waiting for command") {
      window.lastStage = "Waiting for command";
      window.commandWaitCycles = (window.commandWaitCycles || 0) + 1;
      window[`wait${window.commandWaitCycles}Start`] = performance.now();
      if (window.commandWaitCycles === 2) {
        const slider = document.getElementById("commandWait");
        slider.value = "500";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      window.lastStage = title;
    }
    return (window.commandWaitCycles || 0) >= 2;
  }, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    window.lastStage = title;
    if (title === "Wake listening" && (window.commandWaitCycles || 0) >= 2) {
      window.wait2Ms = performance.now() - window.wait2Start;
      return true;
    }
    return false;
  }, null, { timeout: 15000 });
  const wait2Ms = await page.evaluate(() => window.wait2Ms);
  await page.click("#stopButton");
  // The 0.5 s wait is greeting plus half a second; the 3 s default would take
  // roughly six times as long.
  assert.ok(wait2Ms < 2000, `0.5 s command wait took ${wait2Ms} ms`);
  assert.match(await page.textContent("#log"), /No command after 500 ms of silence/);
  assert.match(await page.textContent("#log"), /No command after 3 s of silence/);
  assert.equal(await page.textContent("#commandWaitValue"), "500 ms");
  assert.match(await page.textContent("#commandWaitStatus"), /Saved/);
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.commandWaitMs")), "500");
  assert.deepEqual(calls.prompts, []);

  // The saved value survives a reload (per browser, like the wake word). The
  // reloaded page is in standby (the session was stopped above), so there is
  // nothing left to stop.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.inputValue("#commandWait"), "500");
  assert.equal(await page.textContent("#commandWaitValue"), "500 ms");
});

test("a command spoken right after the greeting over the echo is captured, not lost", { timeout: 30000 }, async (t) => {
  // The user's first command attempt rides the recording window and the
  // completed-utterance transcription drops it (the VAD filter), so the
  // greeting plays; the user then repeats the command as soon as the greeting
  // ends, over its echo tail. The old code armed the window only after the
  // echo's quiet, so a command like that landed before the transcript start
  // and the window closed on the 3 s rule with nothing captured.
  const rate = 48000;
  const fixturePath = join(temp, "fast-command-microphone.wav");
  const loop = new AudioBufferWindow(rate, 12);
  const samples = new Float32Array(rate * 12);
  for (let i = 0; i < samples.length; i++) {
    const pos = i / rate;
    if (pos < 1.2) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
    else if (pos >= 1.65 && pos < 2.85) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 880 / rate);
    else if (pos >= 3.6 && pos < 4.8) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 880 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "" : "What time is it?",
  }), { config: { user: "Roman" } }, instance);
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Waiting for command");
  // Utterance 1 is the spoken greeting, utterance 2 the answer to the repeated
  // command.
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 20000 });
  await page.click("#stopButton");
  assert.equal(await page.evaluate(() => savedUtterances[0].text), "Yes, Roman.");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(calls.audio.length, 3);
  // The command window's audio starts at the greeting's end and carries the
  // user's 880 Hz command tone — and not the 440 Hz wake tone.
  const wav = calls.audio[2];
  const sampleRate = wav.readUInt32LE(24);
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
  const goertzel = (freq) => {
    const k = Math.floor(0.5 + (pcm.length * freq) / sampleRate);
    const w = (2 * Math.PI * k) / pcm.length;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s0 = pcm[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / pcm.length;
  };
  assert.ok(goertzel(880) > 1000, `command window lacks the user's 880 Hz tone (got ${goertzel(880).toFixed(1)})`);
  assert.ok(goertzel(440) < 1000, `command window carries the 440 Hz wake tone (got ${goertzel(440).toFixed(1)})`);
});

test("a follow-up command right after the answer is captured without the wake word", { timeout: 40000 }, async (t) => {
  // The fixture tone repeats every 4 s: the first burst wakes Jarvis, the
  // second becomes the command after the greeting, the answer speaks, and the
  // third burst — with no wake word in between — must be captured by the
  // follow-up command window that opens where the answer ends.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky." : n === 3 ? "What time is it?" : "What was the second option?",
  }), { config: { user: "Roman" } });
  // Utterance 1 is the spoken greeting, utterances 2 and 3 the two answers.
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.equal(await page.evaluate(() => savedUtterances[0].text), "Yes, Roman.");
  assert.deepEqual(calls.prompts, ["What time is it?", "What was the second option?"]);
  assert.equal(calls.audio.length, 4);
});

test("silence after the answer waits the full command wait before returning to wake listening", { timeout: 40000 }, async (t) => {
  // One tone per 6 s loop: the wake cycle gets its command from the completed
  // utterance, the answer speaks, and the follow-up command window then sees
  // only silence: it must hold for the full 3 s command wait (not return
  // immediately, and not wait out the 6 s loop) before wake listening.
  const rate = 48000;
  const fixturePath = join(temp, "quiet-after-answer-microphone.wav");
  const loop = new AudioBufferWindow(rate, 6);
  const samples = new Float32Array(rate * 6);
  for (let i = 0; i < samples.length; i++) {
    if (i / rate < 1) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "Rocky, what time is it?" : "",
  }), { config: { user: "Roman" } }, instance);
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    if (title !== "Waiting for command") return false;
    window.commandWaitStartedAt = performance.now();
    return true;
  });
  await page.waitForFunction(() => {
    const title = document.getElementById("stageTitle").textContent;
    if (title !== "Wake listening") return false;
    window.commandWaitMs = performance.now() - (window.commandWaitStartedAt || 0);
    return true;
  }, null, { timeout: 15000 });
  const waitMs = await page.evaluate(() => window.commandWaitMs);
  assert.ok(waitMs < 8000, `follow-up wait took ${waitMs} ms`);
  assert.ok(waitMs >= 2500, `follow-up wait returned before the 3 s wait elapsed (${waitMs} ms)`);
  assert.deepEqual(calls.prompts, ["what time is it?"]);
  assert.match(await page.textContent("#log"), /No command after 3 s of silence/);
  await page.click("#stopButton");
});

test("a thank-you after the answer gets a butler closing instead of a brain round trip", { timeout: 40000 }, async (t) => {
  // The 4 s loop fixture: burst 1 wakes and carries the command in one
  // breath, the answer speaks, and burst 2 is "Thank you" in the follow-up
  // command window — an acknowledgment with nothing to answer. Jarvis must
  // speak the butler closing instead of round-tripping it to the brain.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : n === 3 ? "Thank you" : "",
  }));
  // Deterministic closing: the fixed random source picks the first line.
  await page.evaluate(() => { Math.random = () => 0; });
  // Utterance 1 is the answer; the closing is spoken as its clauses
  // ("You are most welcome." + "Standing by."), so the full closing is the
  // join of everything after the answer.
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(await page.evaluate(() => savedUtterances.slice(1).map((u) => u.text).join(" ")),
    "You are most welcome. Standing by.");
  assert.match(await page.textContent("#log"), /Acknowledgment "Thank you"/);
});

test("a bye after the answer ends the turn with a butler farewell", { timeout: 40000 }, async (t) => {
  // The same 4 s loop fixture, but burst 2 is "Bye" — a session-ending
  // word. The butler answers with the farewell closing (goodbye, not just
  // "standing by") and no brain round trip.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : n === 3 ? "Bye" : "",
  }));
  // Deterministic closing: the fixed random source picks the first line.
  await page.evaluate(() => { Math.random = () => 0; });
  // Utterance 1 is the answer; the farewell "It was my pleasure. Goodbye."
  // speaks as a single clause (the one-word "Goodbye." merges into it), so
  // the full farewell is utterance 2.
  await page.waitForFunction(() => window.savedUtterances.length >= 2, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(await page.evaluate(() => savedUtterances.slice(1).map((u) => u.text).join(" ")),
    "It was my pleasure. Goodbye.");
  assert.match(await page.textContent("#log"), /Acknowledgment "Bye"/);
});

test("an ok after the follow-up window closed still gets a butler closing in wake listening", { timeout: 40000 }, async (t) => {
  // One tone per 6 s loop: the wake cycle gets its command, the answer
  // speaks, the follow-up command window sees only silence and aborts after
  // the 3 s command wait — back in wake listening. The next tone (the user's
  // "Ok", said after the window already closed) must still end the turn with
  // the polite butler closing: not a brain round trip, and not dropped as
  // "no wake phrase heard".
  const rate = 48000;
  const fixturePath = join(temp, "ok-after-window-closed-microphone.wav");
  const loop = new AudioBufferWindow(rate, 6);
  const samples = new Float32Array(rate * 6);
  for (let i = 0; i < samples.length; i++) {
    if (i / rate < 1) samples[i] = 0.3 * Math.sin(i * Math.PI * 2 * 440 / rate);
  }
  loop.push(samples);
  await writeFile(fixturePath, Buffer.from(await loop.wav(0).arrayBuffer()));
  const instance = await launchWithFixture(t, fixturePath);
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "Rocky, what time is it?" : n === 3 ? "Ok" : "",
  }), { config: { user: "Roman" } }, instance);
  // Deterministic closing: the fixed random source picks the first line.
  await page.evaluate(() => { Math.random = () => 0; });
  // Utterance 1 is the answer; the closing is spoken as its clauses
  // ("Very good." + "Standing by."), so the full closing is the join of
  // everything after the answer.
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["what time is it?"]);
  assert.equal(await page.evaluate(() => savedUtterances.slice(1).map((u) => u.text).join(" ")),
    "Very good. Standing by.");
  const logText = await page.textContent("#log");
  assert.match(logText, /Acknowledgment "Ok" after the spoken turn/);
  assert.doesNotMatch(logText, /No wake phrase heard/);
});

test("an ok after the greeting gets a butler closing without any brain round trip", { timeout: 40000 }, async (t) => {
  // The wake word comes alone, so the greeting plays; the user then says
  // just "Ok" in the command window — a polite closing, and no brain call
  // at all.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky." : n === 3 ? "Ok" : "",
  }), { config: { user: "Roman" } });
  await page.evaluate(() => { Math.random = () => 0; });
  // Utterance 1 is the spoken greeting; the closing is spoken as its
  // clauses, so the full closing is the join of everything after it.
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 30000 });
  await page.click("#stopButton");
  assert.equal(await page.evaluate(() => savedUtterances[0].text), "Yes, Roman.");
  assert.equal(await page.evaluate(() => savedUtterances.slice(1).map((u) => u.text).join(" ")),
    "Very good. Standing by.");
  assert.deepEqual(calls.prompts, []);
  assert.match(await page.textContent("#log"), /Acknowledgment "Ok"/);
});

test("an empty completed utterance after a wake probe asks for the command instead of erroring", { timeout: 30000 }, async (t) => {
  // The probe heard the wake word but the completed-utterance transcription
  // came back empty (the VAD filter drops short bursts). The pipeline must
  // treat that as wake-only and take the command after the greeting, not fail.
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "" : "What time is it?",
  }));
  // Utterance 1 is the spoken greeting, utterance 2 the answer.
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 25000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
});

test("an empty command window after the greeting returns to wake listening without an error", { timeout: 30000 }, async (t) => {
  // The user spoke the command with the wake word and transcription lost it;
  // nothing comes after the greeting. The old behaviour was a dead-end red
  // error ("Whisper returned no command"); now the pipeline returns to wake
  // listening and the next attempt retries.
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "Rocky." : "",
  }));
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("No command captured"),
    null, { timeout: 25000 });
  const logText = await page.textContent("#log");
  assert.doesNotMatch(logText, /Whisper returned no command/);
  assert.equal(await page.evaluate(() => document.getElementById("core").classList.contains("error")), false);
  assert.equal(await page.textContent("#stageTitle"), "Wake listening");
  assert.deepEqual(calls.prompts, []);
  await page.click("#stopButton");
});

test("silence makes no Whisper calls and hiding the tab keeps the session armed", async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "" }), { silent: true });
  await page.waitForTimeout(4500);
  assert.equal(calls.audio.length, 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Minimizing the window must not disarm: the wake word has to be heard while
  // the user is doing something else.
  assert.equal(await page.textContent("#stageTitle"), "Wake listening");
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "live")));
  assert.match(await page.textContent("#log"), /still armed and listening/);
  // The pipeline loop is clocked off capture blocks, so it keeps running while
  // hidden: capture must still be alive after the stale-block watchdog window.
  await page.waitForTimeout(3500);
  assert.equal(await page.textContent("#stageTitle"), "Wake listening");
  await page.click("#stopButton");
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "ended")));
});

test("MCP web-search toggle is saved, restored and sent with brain requests", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "", noSpeech: true }), {
    silent: true,
    // A second advertised server (Vikunja) checks the dynamic switch build:
    // one switch per entry of /api/config, no code change needed per server.
    config: { mcpServers: [{ id: "websearch", label: "Web search" }, { id: "vikunja", label: "Vikunja" }] },
  });
  assert.match(await page.textContent("#mcpStatus-websearch"), /web search off/i);
  assert.ok(await page.$("#mcpSwitch-vikunja"), "a switch is built for every advertised MCP server");
  await page.click("#stopButton");
  await page.click("#mcpSwitch-websearch");
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.mcp.websearch")), "true");
  assert.match(await page.textContent("#mcpStatus-websearch"), /Saved/);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.getAttribute("#mcpSwitch-websearch", "aria-checked"), "true");
  // page.fill is unstable in minimal containers (see the wake-word tests);
  // set the value directly.
  await page.evaluate((value) => {
    const input = document.getElementById("manualPrompt");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, "What time is it?");
  await page.click("#sendManualButton");
  await page.waitForFunction(() => window.savedUtterances.length >= 1, null, { timeout: 15000 });
  // The manual-prompt flow stops itself, so the Stop button is disabled.
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped",
    null, { timeout: 15000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  // Every advertised flag is sent with the request; the untouched Vikunja
  // switch rides along as false.
  assert.deepEqual(calls.mcp, { websearch: true, vikunja: false });
});

test("chat requests carry the active wake phrase so the brain answers as its name", { timeout: 20000 }, async (t) => {
  // The brain's name is the wake word's name, and personal wake words are
  // per-browser: the /api/chat body must carry the active phrase (server
  // default, then the personal override) for the server to inject
  // "Your name is ...".
  const { page, calls } = await setup(t, async () => ({ text: "", noSpeech: true }), { silent: true });
  await page.click("#stopButton");
  const ask = async (text) => {
    // page.fill is unstable in minimal containers (see the wake-word tests);
    // set the value directly.
    await page.evaluate((value) => {
      const input = document.getElementById("manualPrompt");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await page.click("#sendManualButton");
    // The manual-prompt flow stops itself, so the Stop button is disabled.
    await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped",
      null, { timeout: 15000 });
  };
  await ask("Who are you?");
  await page.waitForFunction(() => window.savedUtterances.length >= 1, null, { timeout: 15000 });
  assert.equal(calls.wakePhrase, "Rocky");
  await page.fill("#wakeWordInput", "Kaya");
  await page.click("#saveWakeWordButton");
  await ask("Who are you?");
  await page.waitForFunction(() => window.savedUtterances.length >= 2, null, { timeout: 15000 });
  assert.equal(calls.wakePhrase, "Kaya");
});

test("manual prompt returns the pipeline icons to waiting after the answer speaks", { timeout: 20000 }, async (t) => {
  // The disarmed manual flow skips the audio steps and completes brain + tts.
  // When it auto-stops, no step may keep its done (green) or skipped
  // highlight: every icon must reset to waiting like a fresh idle pipeline.
  const { page, calls } = await setup(t, async () => ({ text: "", noSpeech: true }), { silent: true });
  await page.click("#stopButton");
  // page.fill is unstable in minimal containers (see the wake-word tests);
  // set the value directly.
  await page.evaluate((value) => {
    const input = document.getElementById("manualPrompt");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, "What time is it?");
  await page.click("#sendManualButton");
  await page.waitForFunction(() => window.savedUtterances.length >= 1, null, { timeout: 15000 });
  // The manual-prompt flow stops itself, so the Stop button is disabled.
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped",
    null, { timeout: 15000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("#steps li")].map((item) => item.className));
  assert.deepEqual(classes, ["", "", "", "", "", ""]);
});

test("microphone denial leaves an actionable error and enabled Arm button", async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "" }), { denied: true });
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped after error");
  assert.equal(await page.isDisabled("#armButton"), false);
  assert.equal(calls.audio.length, 0);
});

test("permission granted after Stop cannot resurrect the old session", async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "" }), { delayedPermission: true });
  await page.waitForFunction(() => !!window.grantPermission);
  await page.click("#stopButton");
  await page.evaluate(() => window.grantPermission());
  await page.waitForFunction(() => testTracks.every((track) => track.readyState === "ended"));
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
  assert.equal(calls.audio.length, 0);
});

test("personal wake word is saved, restored after reload and used by the pipeline", { timeout: 25000 }, async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "Nova, hello there" }));
  await page.fill("#wakeWordInput", "  Nova  ");
  assert.equal(await page.inputValue("#wakeWordInput"), "  Nova  ");
  await page.click("#saveWakeWordButton");
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.wakePhrase")), "Nova");
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "ended")));
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.inputValue("#wakeWordInput"), "Nova");
  await page.click("#armButton");
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 15000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["hello there"]);
});

test("invalid personal wake words do not stop or change the active session", async (t) => {
  const { page } = await setup(t, async () => ({ text: "" }));
  await page.fill("#wakeWordInput", "!!!");
  await page.click("#saveWakeWordButton");
  assert.match(await page.textContent("#wakeWordStatus"), /Wake word unchanged/);
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.wakePhrase")), null);
  assert.equal(await page.isDisabled("#stopButton"), false);
  await page.fill("#wakeWordInput", "Echo");
  await page.click("#saveWakeWordButton");
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.wakePhrase")), "Echo");
});

test("Whisper log shows readable wake and command text, including empty results", { timeout: 25000 }, async (t) => {
  const { page } = await setup(t, async (n) => ({
    text: n === 1 ? "" : n === 2 ? "background conversation" : "Rocky, hello",
    noSpeech: n === 1,
  }));
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 20000 });
  await page.click("#stopButton");
  const log = await page.textContent("#log");
  assert.match(log, /Wake probe recognized: \(no speech recognized\)/);
  assert.match(log, /Wake probe recognized: "background conversation"/);
  assert.match(log, /Command recognized: "Rocky, hello"/);
  assert.match(log, /Response details.*stt-/);
});

test("blocked local storage is reported without falsely claiming persistence", async (t) => {
  const { page } = await setup(t, async () => ({ text: "" }));
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError"); };
  });
  await page.fill("#wakeWordInput", "Echo");
  await page.click("#saveWakeWordButton");
  assert.match(await page.textContent("#wakeWordStatus"), /this tab only/);
  assert.match(await page.textContent("#stageDetail"), /Echo/);
});

test("actual vm103 transcription of browser-captured speech", {
  skip: !process.env.JARVIS_LIVE_STT_ENDPOINT || !process.env.JARVIS_SPEECH_FIXTURE, timeout: 60000,
}, async (t) => {
  const { page, calls } = await setup(t, async (_, body) => {
    const form = new FormData();
    form.append("file", new Blob([body], { type: "audio/wav" }), "browser.wav");
    form.append("language", process.env.JARVIS_TEST_LANGUAGE || "en");
    const response = await fetch(process.env.JARVIS_LIVE_STT_ENDPOINT, {
      method: "POST", body: form, signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    console.log("vm103 actual speech transcript:", data.text);
    return { ...data, endpoint: process.env.JARVIS_LIVE_STT_ENDPOINT };
  });
  await page.waitForFunction(() => window.savedUtterances.length >= 2, null, { timeout: 50000 });
  await page.click("#stopButton");
  assert.equal(calls.prompts.length, 2);
  assert.ok(calls.prompts.every((prompt) => /time/i.test(prompt)), JSON.stringify(calls.prompts));
});

test("candidate backend completes two real vm103 and brain cycles", {
  skip: !process.env.JARVIS_LIVE_BACKEND || !process.env.JARVIS_SPEECH_FIXTURE, timeout: 90000,
}, async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const results = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (/\/api\/(transcribe|chat)$/.test(response.url())) {
      const data = await response.json();
      results.push({ url: response.url(), status: response.status(), data });
      console.log("Live backend result:", JSON.stringify(data));
    }
  });
  // Headless Chromium has no installed speech voices. Only playback is simulated.
  await page.addInitScript(() => {
    window.spoken = [];
    speechSynthesis.speak = (utterance) => {
      if (utterance.text) {
        window.spoken.push(utterance.text);
        setTimeout(() => utterance.onend?.(), 50);
      }
    };
    speechSynthesis.cancel = () => {};
    speechSynthesis.resume = () => {};
  });
  // The backend requires a login; the cookie lands in the page's cookie jar,
  // so the following goto loads an authenticated shell.
  const loginResponse = await page.request.post(`${process.env.JARVIS_LIVE_BACKEND}/api/login`, {
    data: { username: "Mila", password: "Mila" },
  });
  assert.equal(loginResponse.status(), 200);
  await page.goto(process.env.JARVIS_LIVE_BACKEND);
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  await page.click("#armButton");
  await page.waitForFunction(() => window.spoken.length >= 2, null, { timeout: 75000 });
  await page.click("#stopButton");
  assert.deepEqual(errors, []);
  const stt = results.filter((result) => result.url.endsWith("/transcribe"));
  const chats = results.filter((result) => result.url.endsWith("/chat"));
  assert.ok(stt.length >= 4);
  assert.ok(stt.every((result) => result.status === 200 && result.data.endpoint === "http://192.168.53.111:8003/v1/audio/transcriptions"));
  assert.equal(chats.length, 2);
  assert.ok(chats.every((result) => result.status === 200 && result.data.answer));
});

test("HAL 9000 plays self-hosted TTS clauses instead of the browser voice", { timeout: 30000 }, async (t) => {
  // The speech wake-watch probes the mic while TTS plays; the fixture tone
  // keeps playing, so only the first two calls may carry the wake phrase.
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky, what time is it?" : "background noise" }), {
    voice: "hal9000",
    config: { ttsConfigured: true, ttsModel: "kokoro", ttsVoice: "bm_george" },
    answer: "It is 14:05. I am completely operational.",
    speak: async () => ({ status: 200 }),
  });
  await page.waitForFunction(() => document.getElementById("steps").querySelector('[data-step="tts"]').className === "done",
    null, { timeout: 25000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.speak, ["It is 14:05.", "I am completely operational."]);
  assert.equal(await page.evaluate(() => window.savedUtterances.length), 0);
  assert.match(await page.textContent("#log"), /HAL 9000 clause 2\/2/);
  assert.match(await page.textContent("#voiceStatus"), /kokoro \/ bm_george/);
});

test("HAL 9000 finishes the answer with the browser voice when self-hosted TTS fails", { timeout: 30000 }, async (t) => {
  // The speech wake-watch probes the mic while TTS plays; the fixture tone
  // keeps playing, so only the first two calls may carry the wake phrase.
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky, what time is it?" : "background noise" }), {
    voice: "hal9000",
    config: { ttsConfigured: true },
    answer: "It is 14:05. I am completely operational.",
    speak: async (n) => ({ status: n === 1 ? 200 : 502 }),
  });
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 25000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.speak, ["It is 14:05.", "I am completely operational."]);
  assert.equal(await page.evaluate(() => savedUtterances[0].text), "I am completely operational.");
  // The HAL fallback keeps its own cadence rather than the browser default.
  // The API stores these as 32-bit floats, so compare with a tolerance.
  const [rate, pitch] = await page.evaluate(() => [savedUtterances[0].rate, savedUtterances[0].pitch]);
  assert.ok(Math.abs(rate - 0.88) < 1e-6, `rate ${rate}`);
  assert.ok(Math.abs(pitch - 0.5) < 1e-6, `pitch ${pitch}`);
  assert.match(await page.textContent("#log"), /finishing the answer with the browser voice/);
});

test("HAL 9000 without a TTS backend keeps its cadence on the browser voice", { timeout: 30000 }, async (t) => {
  // The speech wake-watch probes the mic while TTS plays; the fixture tone
  // keeps playing, so only the first two calls may carry the wake phrase.
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky, what time is it?" : "background noise" }), {
    voice: "hal9000",
    answer: "It is 14:05. I am completely operational.",
  });
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 25000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.speak, []);
  assert.deepEqual(await page.evaluate(() => savedUtterances.map((utterance) => utterance.text)),
    ["It is 14:05.", "I am completely operational."]);
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.voice")), "hal9000");
  assert.match(await page.textContent("#voiceStatus"), /No TTS backend configured/);
});

// Guards the trailing-edge probe trigger: a window that ends mid-word comes back
// from Whisper empty, so the wake phrase is only heard a probe cycle later.
function tailLevel(body) {
  const rate = body.readUInt32LE(24);
  const samples = body.readUInt32LE(40) / 2;
  const tail = Math.min(samples, Math.round(rate * 0.2));
  let energy = 0;
  for (let i = samples - tail; i < samples; i += 1) energy += (body.readInt16LE(44 + i * 2) / 32768) ** 2;
  return Math.sqrt(energy / tail);
}

test("wake probes end in silence rather than cutting a word in half", { timeout: 40000 }, async (t) => {
  const tails = [];
  const { page } = await setup(t, async (n, body) => {
    tails.push(tailLevel(body));
    return { text: "unrelated conversation" };
  });
  await page.waitForFunction(() => document.getElementById("log").textContent.split("Wake probe recognized").length > 3,
    null, { timeout: 35000 });
  await page.click("#stopButton");
  assert.ok(tails.length >= 2, `probes: ${tails.length}`);
  // 0.012 is the capture voice threshold in audio.js.
  for (const level of tails) assert.ok(level < 0.012, `probe tail level ${level.toFixed(4)} should be silence`);
});

test("the speed slider scales the request and persists per browser", { timeout: 30000 }, async (t) => {
  const speeds = [];
  // The speech wake-watch probes the mic while TTS plays; the fixture tone
  // keeps playing, so only the first two calls may carry the wake phrase.
  const { page } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky, what time is it?" : "background noise" }), {
    voice: "hal9000",
    config: { ttsConfigured: true },
    answer: "It is 14:05.",
    speak: async (_, payload) => { speeds.push(payload.speed); return { status: 200 }; },
  });
  await page.evaluate(() => {
    const slider = document.getElementById("voiceSpeed");
    slider.value = "1.5";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.textContent("#voiceSpeedValue"), "1.50x");
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.voiceSpeed")), "1.5");
  await page.waitForFunction(() => document.getElementById("steps").querySelector('[data-step="tts"]').className === "done",
    null, { timeout: 25000 });
  // Stop overwrites the stage detail, so read the speaking stage from the log.
  assert.match(await page.textContent("#log"), /Speaking: HAL 9000 is reading the answer at 1\.50x/);
  await page.click("#stopButton");
  // 1.04 profile speed scaled by 1.5, within the 0.5-2.0 the backend accepts.
  assert.deepEqual(speeds, [1.56]);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.inputValue("#voiceSpeed"), "1.5");
  assert.match(await page.textContent("#voiceStatus"), /1\.50x/);
});

// The Answer panel is a conversation list; read the body of its last entry.
async function lastAnswerBody(page) {
  return page.evaluate(() => {
    const bodies = document.querySelectorAll("#answerText .transcript-body");
    return bodies.length ? bodies[bodies.length - 1].textContent : null;
  });
}

// page.fill is unstable in minimal containers (see the wake-word tests);
// set the value directly.
async function typeManualPrompt(page, text) {
  await page.evaluate((value) => {
    const input = document.getElementById("manualPrompt");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.click("#sendManualButton");
}

test("a failed brain request is retried with the captured prompt", { timeout: 30000 }, async (t) => {
  // The prompt was already captured, so a failed brain round trip must be
  // retried with the same prompt instead of sending the user back to wake
  // listening to speak it again.
  const { page, calls } = await setup(t, async () => ({ text: "", noSpeech: true }), {
    silent: true,
    chat: async (n) => (n === 1 ? { status: 502, error: "brain unavailable" } : { answer: "Done.", requestId: "brain-test" }),
  });
  await page.click("#stopButton");
  await typeManualPrompt(page, "What time is it?");
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped",
    null, { timeout: 25000 });
  await page.waitForFunction(() => window.savedUtterances.length >= 1, null, { timeout: 15000 });
  assert.deepEqual(calls.prompts, ["What time is it?", "What time is it?"]);
  const log = await page.textContent("#log");
  assert.match(log, /brain failed \(attempt 1\/3\): brain unavailable; retrying in 1000 ms/);
  assert.doesNotMatch(log, /Pipeline error/);
  // The Answer panel is the conversation history: the finished turn's body is
  // the last entry.
  assert.equal(await lastAnswerBody(page), "Done.");
});

test("a failed speech output is retried and still speaks the answer", { timeout: 30000 }, async (t) => {
  // The answer text is already known, so a failed speech output must be
  // retried instead of discarding the answer and requiring the input again.
  const { page } = await setup(t, async () => ({ text: "", noSpeech: true }), { silent: true });
  await page.click("#stopButton");
  await page.evaluate(() => { window.failNextTTS = 1; });
  await typeManualPrompt(page, "What time is it?");
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Stopped",
    null, { timeout: 25000 });
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 15000 });
  const log = await page.textContent("#log");
  assert.match(log, /speech output failed \(attempt 1\/3\): Speech output failed: synthesis-failed/);
  assert.doesNotMatch(log, /Pipeline error/);
  assert.equal(await lastAnswerBody(page), "Done.");
});

test("the hero switches sit left of Sign out, and the panels keep the conversation history", { timeout: 45000 }, async (t) => {
  // The harness intercepts every /api route, so the conversation endpoint is
  // intercepted too, backed by this test's own array (the in-memory backend
  // store).
  const { page } = await setup(t, async () => ({ text: "", noSpeech: true }), { silent: true });
  // The hero row, left to right: Jarvis on/off, Speak / Text only, Sign out.
  assert.deepEqual(await page.evaluate(() =>
    [...document.querySelectorAll(".user-row .user-controls button")].map((button) => button.id)),
    ["enableSwitch", "speakSwitch", "signOutButton"]);
  // The toggle mirrors the armed state: setup armed the session, so it reads
  // "Jarvis on" (aria-checked true) and the Arm button is taken.
  assert.equal(await page.getAttribute("#enableSwitch", "aria-checked"), "true");
  assert.equal(await page.isDisabled("#armButton"), true);
  // Disable: the normal stop path (mic released, Arm back).
  await page.click("#enableSwitch");
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.getAttribute("#enableSwitch", "aria-checked"), "false");
  // Enable: the normal arm path (mic unlocked, Arm taken while running).
  await page.click("#enableSwitch");
  await page.waitForFunction(() => document.getElementById("armButton").disabled);
  assert.equal(await page.getAttribute("#enableSwitch", "aria-checked"), "true");
  // Back to disarmed for the manual prompt below.
  await page.click("#enableSwitch");
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  // The conversation store: POSTs append, GETs serve what was stored.
  const stored = [];
  await page.route("**/api/conversation", (route) => {
    if (route.request().method() === "POST") {
      const entry = route.request().postDataJSON();
      stored.push(entry);
      return route.fulfill({ json: { entry: { ts: new Date().toISOString(), ...entry } } });
    }
    return route.fulfill({ json: { entries: stored.map((entry) => ({ ts: new Date().toISOString(), ...entry })) } });
  });
  // A finished manual prompt (voice on) lands in BOTH panels with a
  // date-time stamp, and in the backend store.
  const spokenBeforeFirst = await page.evaluate(() => window.savedUtterances.length);
  await typeManualPrompt(page, "What time is it?");
  await page.waitForFunction(() => {
    const bodies = document.querySelectorAll("#answerText .transcript-body");
    return bodies.length >= 1 && bodies[bodies.length - 1].textContent === "Done.";
  }, null, { timeout: 25000 });
  // The answer's own utterance (the greeting's are already counted in the
  // baseline).
  await page.waitForFunction((baseline) => window.savedUtterances.length > baseline, spokenBeforeFirst,
    { timeout: 15000 });
  const spokenAfterFirst = await page.evaluate(() => window.savedUtterances.length);
  assert.deepEqual(stored, [{ prompt: "What time is it?", answer: "Done." }], JSON.stringify(stored));
  // Speak off: the next answer stays in the panel, and nothing is spoken.
  assert.equal(await page.getAttribute("#speakSwitch", "aria-checked"), "true");
  await page.click("#speakSwitch");
  assert.equal(await page.getAttribute("#speakSwitch", "aria-checked"), "false");
  await typeManualPrompt(page, "What is two plus two?");
  await page.waitForFunction(() => {
    const bodies = document.querySelectorAll("#answerText .transcript-body");
    return bodies.length >= 2 && bodies[bodies.length - 1].textContent === "Done.";
  }, null, { timeout: 25000 });
  assert.equal(await page.evaluate(() => window.savedUtterances.length), spokenAfterFirst,
    "text-only mode speaks nothing");
  assert.deepEqual(stored, [
    { prompt: "What time is it?", answer: "Done." },
    { prompt: "What is two plus two?", answer: "Done." },
  ], JSON.stringify(stored));
  const panel = await page.evaluate(() => ({
    prompts: [...document.querySelectorAll("#promptText .transcript-entry")].map((entry) => entry.textContent),
    answers: [...document.querySelectorAll("#answerText .transcript-entry")].map((entry) => entry.textContent),
    times: document.querySelectorAll("#promptText .transcript-time").length,
  }));
  assert.equal(panel.prompts.length, 2, JSON.stringify(panel));
  assert.ok(panel.prompts[0].includes("What time is it?"), JSON.stringify(panel));
  assert.ok(panel.prompts[1].includes("What is two plus two?"), JSON.stringify(panel));
  assert.equal(panel.answers.length, 2, JSON.stringify(panel));
  assert.ok(panel.answers[0].includes("Done."), JSON.stringify(panel));
  assert.ok(panel.answers[1].includes("Done."), JSON.stringify(panel));
  assert.equal(panel.times, 2, "every prompt entry carries its date-time");
  // After a reload the panels come back from the stored conversation, and the
  // per-browser voice-output setting stays off.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  assert.equal(await page.getAttribute("#speakSwitch", "aria-checked"), "false");
  assert.equal(await lastAnswerBody(page), "Done.", "the history survives the reload");
  assert.deepEqual(await page.evaluate(() =>
    [...document.querySelectorAll("#promptText .transcript-entry")].map((entry) => entry.textContent).length),
    2, "the prompt history survives the reload");
});

test("the silence slider adjusts the live stop delay and persists per browser", { timeout: 75000 }, async (t) => {
  // The fixture tone plays 1.2 s and pauses 2.8 s (4 s period). With the
  // 250 ms test default a recorded command ends at the first pause.
  // n=1 probe + n=2 completed utterance (first cycle), n=3 probe + n=4
  // completed utterance (second cycle after re-arm); later calls are the
  // speech wake-watch probes during TTS, which must not match the wake word.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 4 ? "Rocky, what time is it?" : "background noise",
  }));
  assert.equal(await page.inputValue("#silenceDelay"), "250");
  assert.equal(await page.textContent("#silenceDelayValue"), "250 ms");
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("request stt-2"),
    null, { timeout: 30000 });
  await page.click("#stopButton");
  const before = calls.audio.length;

  // Raise the stop to the 5 s maximum: the fixture's 2.8 s pauses are shorter
  // than the stop, so after re-arming only the wake probe may have been sent
  // while the command recording is still running.
  await page.evaluate(() => {
    const slider = document.getElementById("silenceDelay");
    slider.value = "5000";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.textContent("#silenceDelayValue"), "5 s");
  assert.equal(await page.getAttribute("#silenceLevel", "max"), "5000");
  assert.match(await page.textContent("#steps [data-step='vad'] .step-name"), /Stop after 5 s silence/);
  assert.match(await page.textContent("#silenceDelayStatus"), /Saved/);
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.silenceMs")), "5000");
  await page.click("#armButton");
  await page.waitForTimeout(9000);
  assert.equal(calls.audio.length, before + 1, "5 s stop: the 2.8 s pauses must not end the command");

  // Live adjust mid-recording: dropping the stop to 250 ms ends the pending
  // command at the next pause — no re-arm and no re-speaking.
  await page.evaluate(() => {
    const slider = document.getElementById("silenceDelay");
    slider.value = "250";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction((n) => document.getElementById("log").textContent.includes(`request stt-${n}`),
    before + 2, { timeout: 25000 });
  await page.waitForFunction(() => window.savedUtterances.length === 2, null, { timeout: 20000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["what time is it?", "what time is it?"]);
  assert.equal(await page.evaluate(() => localStorage.getItem("jarvis.silenceMs")), "250");

  // The saved value survives a reload (per browser, like the wake word).
  const restored = await setup(t, async () => ({ text: "" }), { silent: true });
  assert.equal(await restored.page.inputValue("#silenceDelay"), "250");
  assert.equal(await restored.page.textContent("#silenceDelayValue"), "250 ms");
  await restored.page.click("#stopButton");
});
