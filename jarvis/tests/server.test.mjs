import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AudioBufferWindow } from "../public/audio.js";

let upstream, backend, origin, endpoint;
let mode = "success";
let disconnected;
let received;
let logs = "";
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    if (mode === "slow") {
      res.on("close", () => disconnected?.());
      return;
    }
    res.setHeader("content-type", "application/json");
    if (mode === "failure") {
      res.writeHead(503).end('{"error":"unavailable"}');
    } else if (req.url.endsWith("chat/completions")) {
      res.end('{"choices":[{"message":{"content":"Hello"}}]}');
    } else {
      res.end(JSON.stringify({ text: mode === "silence" ? "" : mode === "hallucination" ? "Untertitelung des ZDF, 2020" : "Hey, Jarvis. What time is it?" }));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  endpoint = `${base}/v1/audio/transcriptions`;
  backend = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: "0", WHISPER_ENDPOINTS: endpoint, BRAIN_BASE_URL: base, BRAIN_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (data) => { logs += data; });
  backend.stderr.on("data", (data) => { logs += data; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(logs)), 5000);
    backend.stdout.on("data", () => {
      const match = logs.match(/listening on 0.0.0.0:(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (backend) { backend.kill(); await once(backend, "exit"); }
  if (upstream) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
});

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
  for (const value of ["silence", "hallucination"]) {
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
