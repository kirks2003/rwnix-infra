import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioBufferWindow } from "../public/audio.js";

let upstream, backend, origin, endpoint, speechEndpoint, base;
let mode = "success";
let receivedAuth;
let disconnected;
let received;
let logs = "";

// Session cookies per origin (the backend gates every /api route on login).
const authCookies = new Map();

// Log in as `user` (the password is the username) and cache the session
// cookie for that origin.
async function login(target, user = "Mila") {
  const response = await fetch(`${target}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: user }),
  });
  assert.equal(response.status, 200, `login as ${user} should succeed`);
  const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith("jarvis_session="));
  assert.ok(session, "login should issue a jarvis_session cookie");
  const cookie = session.split(";")[0];
  authCookies.set(target, cookie);
  return cookie;
}

// fetch() with the cached session cookie (logged in on demand); pass an
// explicit cookie to talk as a second user on the same origin.
async function auth(target, pathname, init = {}, cookie) {
  const value = cookie || (await login(target));
  return fetch(`${target}${pathname}`, { ...init, headers: { cookie: value, ...(init.headers || {}) } });
}
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
      if (mode === "graph-ingest") {
        // The brain answer and the post-turn extraction call both hit this
        // endpoint; the extraction one carries the EXTRACT_SYSTEM_PROMPT.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const isExtraction = String(body.messages?.[0]?.content || "").includes("knowledge-graph entities");
        res.end(isExtraction
          ? '{"choices":[{"message":{"content":"{\\"entities\\":[{\\"name\\":\\"Mila\\",\\"type\\":\\"person\\",\\"common\\":false},{\\"name\\":\\"Lego\\",\\"type\\":\\"thing\\",\\"common\\":true}],\\"relations\\":[{\\"from\\":\\"Mila\\",\\"to\\":\\"Lego\\",\\"type\\":\\"LIKES\\"}]}"}}]}'
          : '{"choices":[{"message":{"content":"Noted: Lego."}}]}');
        return;
      }
      res.end(mode === "empty-answer"
        ? '{"choices":[{"message":{"content":null},"finish_reason":"length"}]}'
        : '{"choices":[{"message":{"content":"Hello"}}]}');
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

async function transcribe(signal, path = "/api/transcribe") {
  const audio = new AudioBufferWindow(16000, 1);
  audio.push(new Float32Array(16000).fill(0.2));
  return auth(origin, path, {
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

test("the language switch reaches Whisper per request and invalid codes fall back", async () => {
  mode = "success";
  const languageOf = () => received.toString("latin1").match(/name="language"\r?\n\r?\n([a-z]{2})\r?\n/)[1];
  await transcribe();
  assert.equal(languageOf(), "en");
  await transcribe(undefined, "/api/transcribe?language=de");
  assert.equal(languageOf(), "de");
  // Well-formed codes are forwarded (Whisper rejects what it does not know);
  // malformed input falls back to the configured default.
  await transcribe(undefined, "/api/transcribe?language=fr");
  assert.equal(languageOf(), "fr");
  await transcribe(undefined, "/api/transcribe?language=english");
  assert.equal(languageOf(), "en");
});

test("the language switch overrides the brain answer language", async () => {
  mode = "success";
  const ask = (language) => auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: `lang-${language}`, language }),
  });
  assert.equal((await ask("de")).status, 200);
  assert.match(JSON.parse(received.toString("utf8")).messages[0].content, /Language override: answer in German \(Deutsch\)/);
  assert.equal((await ask("en")).status, 200);
  assert.match(JSON.parse(received.toString("utf8")).messages[0].content, /Language override: answer in English/);
});

test("chat accepts the per-server mcp flag map, ignores unknown ids and defaults to off", async () => {
  mode = "success";
  const config = await (await auth(origin, "/api/config")).json();
  assert.deepEqual(config.mcpServers, [
    { id: "websearch", label: "Web search" },
    { id: "graph", label: "Knowledge graph" },
  ]);
  const ask = (body) => auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const brainPrompt = () => JSON.parse(received.toString("utf8")).messages[0].content;
  await ask({ prompt: "Hello", sessionId: "mcp-map-off", mcp: { websearch: false } });
  assert.match(brainPrompt(), /Web search \(MCP web-search server\) is OFF/);
  await ask({ prompt: "Hello", sessionId: "mcp-map-unknown", mcp: { other: true } });
  assert.match(brainPrompt(), /Web search \(MCP web-search server\) is OFF/);
  // No flags at all means everything off (the legacy boolean is covered by
  // the MCP state test below).
  await ask({ prompt: "Hello", sessionId: "mcp-absent" });
  assert.match(brainPrompt(), /Web search \(MCP web-search server\) is OFF/);
});

test("finished chat turns are ingested into the knowledge graph", async (t) => {
  mode = "graph-ingest";
  t.after(() => { mode = "success"; });
  // The global backend runs without a graph store; GRAPH_MEMORY=1 swaps in
  // the in-memory graph so the ingest path is verifiable end to end.
  const graphBackend = await startBackend({ GRAPH_MEMORY: "1" });
  t.after(async () => { graphBackend.process.kill(); await once(graphBackend.process, "exit"); });
  const chat = await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "I like Lego." }),
  });
  assert.equal(chat.status, 200);
  // Ingestion is fire-and-forget: poll until the upsert has landed.
  let sub = { nodes: [], edges: [] };
  for (let i = 0; i < 40; i += 1) {
    sub = await (await auth(graphBackend.origin, "/api/graph/subgraph")).json();
    if ((sub.edges || []).some((edge) => edge.type === "LIKES")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(sub.nodes.some((node) => node.name === "Lego" && node.type === "thing"), JSON.stringify(sub.nodes));
  assert.ok(sub.edges.some((edge) => edge.type === "LIKES"), JSON.stringify(sub.edges));
});

test("the brain answers as the wake word's name, per request", async () => {
  mode = "success";
  const brainPrompt = () => JSON.parse(received.toString("utf8")).messages[0].content;
  const ask = (body) => auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await ask({ prompt: "Hello", sessionId: "wake-name-rocky", wakePhrase: "Hey Rocky" });
  assert.match(brainPrompt(), /Your name is Rocky/);
  await ask({ prompt: "Hello", sessionId: "wake-name-kaya", wakePhrase: "Kaya" });
  assert.match(brainPrompt(), /Your name is Kaya/);
  // Browsers that send no wake phrase fall back to the app name.
  await ask({ prompt: "Hello", sessionId: "wake-name-fallback" });
  assert.match(brainPrompt(), /Your name is Jarvis/);
});

test("the brain knows the signed-in user's first name and is honest about live data while web search is off", async () => {
  mode = "success";
  const brainPrompt = () => JSON.parse(received.toString("utf8")).messages[0].content;
  await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: "fname-roman" }),
  }, await login(origin, "Roman"));
  assert.match(brainPrompt(), /signed in as Roman/);
  await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "What is the weather?", sessionId: "fname-mila", mcp: { websearch: false } }),
  }, await login(origin, "Mila"));
  const prompt = brainPrompt();
  assert.match(prompt, /signed in as Mila/);
  assert.match(prompt, /Web search \(MCP web-search server\) is OFF/);
  // The brain must be told that live data (weather and friends) needs the toggle.
  assert.match(prompt, /weather/i);
  assert.match(prompt, /MCP web search toggle/);
});

test("the brain system prompt reports the MCP web-search state per request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mcp-mock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Mock MCP servers that speak the same stdio protocol; tools/call returns a
  // canned result (ok) or an isError result (failure) without any network.
  const mock = (isError) => `
    import readline from "node:readline";
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-websearch", version: "1.0.0" } };
      } else if (message.method === "tools/call") {
        result = { isError: ${isError}, content: [{ type: "text", text: "Mock web search result: 42." }] };
      } else {
        result = {};
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });
  `;
  const okScript = join(dir, "mcp-ok.mjs");
  const failScript = join(dir, "mcp-fail.mjs");
  await writeFile(okScript, mock(false));
  await writeFile(failScript, mock(true));
  const ask = (backendOrigin, body) => auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Toggle off: no MCP spawn at all; the brain is told the feature is off.
  mode = "success";
  await ask(origin, { prompt: "Can you search the web?", sessionId: "mcp-off", websearch: false });
  assert.match(JSON.parse(received.toString("utf8")).messages[0].content, /Web search \(MCP web-search server\) is OFF/);
  // Toggle on: a working search tells the brain it is on and delivers results;
  // a failed search tells it the feature is on but this search had no results.
  const cases = [
    [okScript, /Web search \(MCP web-search server\) is ON: the web was just searched/, /Mock web search result/],
    [failScript, /is ON, but the search for this prompt returned no results/, null],
  ];
  for (const [script, promptPattern, searchPattern] of cases) {
    const { process: child, origin: mcpOrigin } = await startBackend({ MCP_SEARCH_SCRIPT: script });
    t.after(async () => { child.kill(); await once(child, "exit"); });
    mode = "success";
    await ask(mcpOrigin, { prompt: "Can you search the web?", sessionId: `mcp-${script}`, websearch: true });
    const body = JSON.parse(received.toString("utf8"));
    assert.match(body.messages[0].content, promptPattern);
    if (searchPattern) assert.match(body.messages[1].content, searchPattern);
    else assert.equal(body.messages.length, 2, "no search-results message");
  }
});

test("the TTS proxy rejects non-English languages instead of mispronouncing", async () => {
  mode = "success";
  const response = await auth(origin, "/api/speak", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hallo", language: "de" }),
  });
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.error, "tts_language_unsupported");
  assert.equal(result.language, "de");
});

test("brain proxy still returns the upstream answer", async () => {
  mode = "success";
  const response = await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: "test" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer, "Hello");
});

test("brain requests carry a reasoning-safe token budget and an exhausted budget is reported clearly", async () => {
  mode = "success";
  const response = await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: "budget" }),
  });
  assert.equal(response.status, 200);
  // The brain is a reasoning model: max_tokens covers its thinking tokens too,
  // so an undersized budget comes back with empty content and finish_reason
  // "length" (the red pipeline error after "Wetter Wien" on 2026-10-04).
  assert.ok(JSON.parse(received.toString("utf8")).max_tokens >= 4096);
  mode = "empty-answer";
  const failed = await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", sessionId: "budget-exhausted" }),
  });
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).message, /token budget/);
  mode = "success";
});

test("TTS proxy returns upstream audio and reports configuration", async () => {
  mode = "success";
  const config = await (await auth(origin, "/api/config")).json();
  assert.equal(config.ttsConfigured, true);
  assert.deepEqual(config.ttsEndpoints, [speechEndpoint]);
  const response = await auth(origin, "/api/speak", {
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

test("each character profile maps to its own Kokoro voice, unknown ones fall back", async () => {
  mode = "success";
  const cases = {
    commander: "bm_daniel", android: "bm_lewis", wizard: "bm_fable", newscaster: "am_michael", hal9000: "bm_george",
    heart: "af_heart", bella: "af_bella", nicole: "af_nicole", sarah: "af_sarah", adam: "am_adam", eric: "am_eric", liam: "am_liam",
    default: "bm_george",
  };
  for (const [profile, voice] of Object.entries(cases)) {
    const response = await auth(origin, "/api/speak", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", profile, speed: 1 }),
    });
    assert.equal(response.status, 200, profile);
    assert.equal(JSON.parse(received.toString("utf8")).voice, voice, profile);
  }
});

test("TTS requests are validated and clamped before reaching the engine", async () => {
  mode = "success";
  const empty = await auth(origin, "/api/speak", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "missing_text");
  await auth(origin, "/api/speak", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello", speed: 99 }),
  });
  assert.equal(JSON.parse(received.toString("utf8")).speed, 2);
});

test("TTS upstream failure is HTTP 502 with attempt details, not silent audio", async () => {
  mode = "failure";
  const response = await auth(origin, "/api/speak", {
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
  assert.equal((await (await auth(plain, "/api/config")).json()).ttsConfigured, false);
  const response = await auth(plain, "/api/speak", {
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
  await auth(origin, "/api/speak", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  });
  assert.equal(receivedAuth, "Bearer tts-secret");
});

test("login issues a session cookie and rejects wrong credentials", async () => {
  const ok = await fetch(`${origin}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Mila", password: "Mila" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user, "Mila");
  assert.ok(ok.headers.getSetCookie().some((cookie) => cookie.startsWith("jarvis_session=")));
  // The password is the username itself; anything else, and every user that
  // is not in USERS at all, is rejected.
  for (const body of [
    { username: "Mila", password: "Roman" },
    { username: "Roman", password: "wrong" },
    { username: "Stranger", password: "Stranger" },
    { username: "", password: "" },
  ]) {
    const bad = await fetch(`${origin}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(bad.status, 403, JSON.stringify(body));
    await bad.json();
  }
});

test("api routes require the session cookie; health stays public", async () => {
  assert.equal((await fetch(`${origin}/api/config`)).status, 403);
  for (const [pathname, body] of [
    ["/api/chat", JSON.stringify({ prompt: "Hello" })],
    ["/api/speak", JSON.stringify({ text: "Hello" })],
    ["/api/transcribe", ""],
  ]) {
    const response = await fetch(`${origin}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 403, pathname);
    await response.json();
  }
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
});

test("repeated failed logins lock the address out", async (t) => {
  const { process: child, origin: localOrigin } = await startBackend({});
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const attempts = [];
  for (let i = 0; i < 5; i += 1) {
    const bad = await fetch(`${localOrigin}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Mila", password: "nope" }),
    });
    attempts.push(bad.status);
    await bad.json();
  }
  assert.deepEqual(attempts, [403, 403, 403, 403, 403]);
  // The sixth attempt is locked out even with the right password.
  const locked = await fetch(`${localOrigin}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Mila", password: "Mila" }),
  });
  assert.equal(locked.status, 429);
  await locked.json();
});

test("logout invalidates the session cookie", async (t) => {
  const { process: child, origin: localOrigin } = await startBackend({});
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const cookie = await login(localOrigin, "Roman");
  assert.equal((await auth(localOrigin, "/api/config", {}, cookie)).status, 200);
  const out = await fetch(`${localOrigin}/api/logout`, { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);
  assert.equal((await out.json()).user, "Roman");
  assert.equal((await fetch(`${localOrigin}/api/config`, { headers: { cookie } })).status, 403);
});

test("each user keeps an isolated prompt history", async () => {
  mode = "success";
  const mila = await login(origin, "Mila");
  const roman = await login(origin, "Roman");
  const ask = (cookie, prompt) => auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, sessionId: "isolated" }),
  }, cookie);
  const brainMessages = () => JSON.parse(received.toString("utf8")).messages;
  assert.equal((await ask(mila, "Mila secret plan")).status, 200);
  assert.equal((await ask(roman, "Roman weather question")).status, 200);
  const romanView = JSON.stringify(brainMessages());
  assert.ok(!romanView.includes("Mila secret plan"), "Roman must not see Mila's history");
  assert.ok(romanView.includes("Roman weather question"));
  assert.equal((await ask(mila, "Mila follow up")).status, 200);
  const milaAgain = JSON.stringify(brainMessages());
  assert.ok(milaAgain.includes("Mila secret plan"), "Mila's own history is still hers");
  assert.ok(!milaAgain.includes("Roman weather question"), "still no cross-user leakage");
});
