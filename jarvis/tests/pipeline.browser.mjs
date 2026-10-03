import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioBufferWindow } from "../public/audio.js";

let browser, server, origin, temp, fixture;
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

async function setup(t, transcribe, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const calls = { audio: [], prompts: [] };
  await page.addInitScript(() => {
    window.testTracks = [];
    window.ttsEvents = [];
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
      if (!window.hangTTS) setTimeout(() => utterance.onend?.(), 25);
    };
    speechSynthesis.cancel = () => window.ttsEvents.push("cancel");
    speechSynthesis.resume = () => {};
  });
  await page.route("**/api/config", (route) => route.fulfill({ json: {
    wakePhrase: "Rocky", silenceMs: process.env.JARVIS_LIVE_STT_ENDPOINT ? 1500 : 250,
    whisperLanguage: process.env.JARVIS_TEST_LANGUAGE || "en",
    whisperEndpoints: [process.env.JARVIS_LIVE_STT_ENDPOINT || "http://vm103.test/v1/audio/transcriptions"],
  } }));
  await page.route("**/api/transcribe", async (route) => {
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
  });
  await page.route("**/api/chat", async (route) => {
    calls.prompts.push(route.request().postDataJSON().prompt);
    await route.fulfill({ json: { answer: "Done.", requestId: "brain-test" } });
  });
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById("armButton").disabled);
  if (options.hangTTS) await page.evaluate(() => { window.hangTTS = true; });
  await page.evaluate((value) => {
    window.silentInput = value.silent;
    window.denyMicrophone = value.denied;
    window.delayPermission = value.delayedPermission;
  }, options);
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
  assert.match(await page.textContent("#whisperStatus"), /stt-6/);
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

test("Whisper errors are visible, then recover without parallel requests", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async (n) => n === 1
    ? { status: 502, error: "vm103 unavailable" }
    : { text: "Rocky recovered" });
  await page.waitForFunction(() => document.getElementById("core").classList.contains("error"));
  assert.match(await page.textContent("#stageDetail"), /vm103 unavailable/);
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 20000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["recovered"]);
});

test("missing TTS onend cancels speech before the next wake", { timeout: 30000 }, async (t) => {
  const { page } = await setup(t, async () => ({ text: "Rocky hello" }), { hangTTS: true });
  await page.waitForFunction(() => document.getElementById("stageDetail").textContent.includes("Speech output timed out"), null, { timeout: 18000 });
  assert.equal(await page.evaluate(() => ttsEvents.at(-1)), "cancel");
  await page.click("#stopButton");
  await page.evaluate(() => savedUtterances[0].onend?.());
  assert.equal(await page.textContent("#stageTitle"), "Stopped");
});

test("wake-only response waits for new speech, then transcribes the command", { timeout: 30000 }, async (t) => {
  const { page, calls } = await setup(t, async (n) => ({ text: n <= 2 ? "Rocky." : "What time is it?" }));
  await page.waitForFunction(() => document.getElementById("stageTitle").textContent === "Speak after the beep");
  await page.waitForFunction(() => window.savedUtterances.length === 1, null, { timeout: 18000 });
  await page.click("#stopButton");
  assert.deepEqual(calls.prompts, ["What time is it?"]);
  assert.equal(calls.audio.length, 3);
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
