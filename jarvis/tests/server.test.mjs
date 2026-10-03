import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AudioBufferWindow } from "../public/audio.js";

let upstream, backend, origin, endpoint, speechEndpoint, base;
let mode = "success";
let receivedAuth;
let disconnected;
let received;
let logs = "";
before(async () => {
  upstream = createServer(async (req, res) => {
    receivedAuth = req.headers.authorization || "";
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    if (mode === "slow") {
      res.on("close", () => disconnected?.());
      return;
    }
    if (req.url.endsWith("audio/speech") && mode !== "failure") {
      res.writeHead(200, { "content-type": "audio/wav" }).end(await wavBuffer(0.2));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (mode === "failure") {
      res.writeHead(503).end('{"error":"unavailable"}');
    } else if (req.url.endsWith("chat/completions")) {
      res.end('{"choices":[{"message":{"content":"Hello"}}]}');
    } else {
      res.end(JSON.stringify({ text: mode === "silence" ? "" : mode === "hallucination" ? "Untertitelung des ZDF, 2020" : mode === "thanks" ? "Thank you." : "Hey, Jarvis. What time is it?" }));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${upstream.address().port}`;
  endpoint = `${base}/v1/audio/transcriptions`;
  speechEndpoint = `${base}/v1/audio/speech`;
  ({ process: backend, origin } = await startBackend({ TTS_ENDPOINTS: speechEndpoint, WHISPER_API_KEY: "stt-secret", TTS_API_KEY: "tts-secret" }));
});
after(async () => {
  if (backend) { backend.kill(); await once(backend, "exit"); }
  if (upstream) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
});

// Boots server.js on a free port and resolves once it logs its listening address.
async function startBackend(extraEnv) {
  let output = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: "0", WHISPER_ENDPOINTS: endpoint, BRAIN_BASE_URL: base, BRAIN_API_KEY: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { output += data; logs += data; });
  child.stderr.on("data", (data) => { output += data; logs += data; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output)), 5000);
    child.stdout.on("data", () => {
      const match = output.match(/listening on 0.0.0.0:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  return { process: child, origin: `http://127.0.0.1:${port}` };
}

async function wavBuffer(seconds) {
  const audio = new AudioBufferWindow(16000, Math.max(1, Math.ceil(seconds)));
  audio.push(new Float32Array(Math.round(16000 * seconds)).fill(0.1));
  return Buffer.from(await audio.wav(0).arrayBuffer());
}

async function transcribe(signal) {
  const audio = new AudioBufferWindow(16000, 1);
  audio.push(new Float32Array(16000).fill(0.2));
  return fetch(`${origin}/api/transcribe`, {
    method: "POST", headers: { "content-type": "audio/wav" }, body: audio.wav(0), signal,
  });
}

test("backend forwards a valid WAV and reports the actual endpoint and request ID", async () => {
  mode = "success";
  const response = await transcribe();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.endpoint, endpoint);
  assert.equal(result.noSpeech, false);
  assert.match(received.toString("latin1"), /filename="jarvis-command.wav"/);
  assert.ok(received.includes(Buffer.from("RIFF")));
  assert.ok(logs.includes(result.requestId));
});

test("valid silence and hallucinations are no-speech, not transport success with fake words", async () => {
  for (const value of ["silence", "hallucination", "thanks"]) {
    mode = value;
    const response = await transcribe();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.text, "");
    assert.equal(result.noSpeech, true);
  }
});

test("upstream failure is HTTP 502 with attempt details", async () => {
  mode = "failure";
  const response = await transcribe();
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.error, "all_whisper_endpoints_failed");
  assert.match(result.attempts[0].error, /503/);
});

test("Stop/disconnect cancels the backend Whisper fetch", { timeout: 5000 }, async () => {
  mode = "slow";
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const controller = new AbortController();
  const pending = transcribe(controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { name: "AbortError" });
  await closed;
});

test("hung Whisper returns a bounded timeout instead of blocking forever", { timeout: 25000 }, async () => {
  mode = "slow";
  const start = Date.now();
  const response = await transcribe();
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.match(result.attempts[0].error, /timeout/i);
  assert.ok(Date.now() - start < 24000);
});

test("brain proxy still returns the upstream answer", async () => {
  mode = "success";
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: "test" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer, "Hello");
});

test("TTS proxy returns upstream audio and reports configuration", async () => {
  mode = "success";
  const config = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(config.ttsConfigured, true);
  assert.deepEqual(config.ttsEndpoints, [speechEndpoint]);
  const response = await fetch(`${origin}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "I am completely operational.", profile: "hal9000", speed: 0.8 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const audio = Buffer.from(await response.arrayBuffer());
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  const request = JSON.parse(received.toString("utf8"));
  assert.equal(request.input, "I am completely operational.");
  assert.equal(request.response_format, "wav");
  assert.equal(request.speed, 0.8);
  assert.equal(request.voice, "bm_george");
});

test("TTS requests are validated and clamped before reaching the engine", async () => {
  mode = "success";
  const empty = await fetch(`${origin}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "missing_text");
  await fetch(`${origin}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello", speed: 99 }),
  });
  assert.equal(JSON.parse(received.toString("utf8")).speed, 2);
});

test("TTS upstream failure is HTTP 502 with attempt details, not silent audio", async () => {
  mode = "failure";
  const response = await fetch(`${origin}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  });
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.error, "all_tts_endpoints_failed");
  assert.match(result.attempts[0].error, /503/);
});

test("without TTS endpoints the backend reports it instead of pretending to speak", async (t) => {
  const { process: child, origin: plain } = await startBackend({ TTS_ENDPOINTS: "" });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  assert.equal((await (await fetch(`${plain}/api/config`)).json()).ttsConfigured, false);
  const response = await fetch(`${plain}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "tts_not_configured");
});

test("upstream voice services receive their configured bearer keys", async () => {
  mode = "success";
  await transcribe();
  assert.equal(receivedAuth, "Bearer stt-secret");
  await fetch(`${origin}/api/speak`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  });
  assert.equal(receivedAuth, "Bearer tts-secret");
});
