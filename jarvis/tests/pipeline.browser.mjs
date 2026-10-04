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

test("real Chromium capture completes three wake cycles with fresh valid audio", { timeout: 45000 }, async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "Rocky! What time is it?" }));
  await page.waitForFunction(() => window.savedUtterances.length >= 3, null, { timeout: 35000 });
  await page.click("#stopButton");
  assert.equal(calls.prompts.length, 3);
  assert.deepEqual(calls.prompts, Array(3).fill("What time is it?"));
  assert.equal(calls.audio.length, 6);
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "ended")));
  assert.match(await page.textContent("#log"), /stt-6/);
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
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Wake listening",
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
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Wake listening",
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
  // The answer speaks and finishes on its own (25 ms mock). The next wake
  // cycle then hears "Rocky stop"; inside the post-speech window it must be
  // treated as a speech stop, not as a prompt for the brain.
  const { page, calls } = await setup(t, async (n) => ({
    text: n <= 2 ? "Rocky! What time is it?" : "Rocky stop",
  }));
  await page.waitForFunction(() => document.getElementById("log").textContent.includes("after the spoken answer"),
    null, { timeout: 20000 });
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(await page.textContent("#stageTitle"), "Wake listening");
  await page.click("#stopButton");
});

test("wake-only response waits for new speech, then transcribes the command", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky." : "What time is it?" }));
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Speak after the beep");
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 18000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(calls.audio.length, 3);
});

test("an empty completed utterance after a wake probe asks for the command instead of erroring", { timeout: 30000 }, async (t) => {
  // The probe heard the wake word but the completed-utterance transcription
  // came back empty (the VAD filter drops short bursts). The pipeline must
  // treat that as wake-only and take the command after the beep, not fail.
  const { page, calls } = await setup(t, async (n) => ({
    text: n === 1 ? "Rocky" : n === 2 ? "" : "What time is it?",
  }));
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 25000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
});

test("an empty command window after the beep returns to wake listening without an error", { timeout: 30000 }, async (t) => {
  // The user spoke the command with the wake word and transcription lost it;
  // nothing comes after the beep. The old behaviour was a dead-end red error
  // ("Whisper returned no command"); now the pipeline returns to wake
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

test("silence makes no Whisper calls and hiding the tab releases capture", async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "" }), { silent: true });
  await page.waitForTimeout(4500);
  assert.equal(calls.audio.length, 0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
  assert.ok(await page.evaluate(() => testTracks.every((track) => track.readyState === "ended")));
});

test("MCP web-search toggle is saved, restored and sent with brain requests", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async () => ({ text: "", noSpeech: true }), {
    silent: true,
    config: { mcpServers: [{ id: "websearch", label: "Web search" }] },
  });
  assert.match(await page.textContent("#mcpStatus-websearch"), /web search off/i);
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
  assert.deepEqual(calls.mcp, { websearch: true });
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
  assert.equal(await page.textContent("#answerText"), "Done.");
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
  assert.equal(await page.textContent("#answerText"), "Done.");
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
