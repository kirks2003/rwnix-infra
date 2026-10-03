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

async function setup(t, transcribe, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const calls = { audio: [], prompts: [], speak: [] };
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
    await route.fulfill({ json: { answer: options.answer || "Done.", requestId: "brain-test" } });
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
  const { page, calls } = await setup(t, async () => ({ text: "Rocky, what time is it?" }), {
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
  const { page, calls } = await setup(t, async () => ({ text: "Rocky, what time is it?" }), {
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
  const { page, calls } = await setup(t, async () => ({ text: "Rocky, what time is it?" }), {
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
  const { page } = await setup(t, async () => ({ text: "Rocky, what time is it?" }), {
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
