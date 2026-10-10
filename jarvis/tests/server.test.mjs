import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AudioBufferWindow } from "../public/audio.js";

let upstream, backend, origin, endpoint, speechEndpoint, base;
let mode = "success";
// Captured by the history-tool / history-seed mock modes above.
const historyToolOffers = [];
const historyToolResults = [];
const historySeedMessages = [];
// Extra arguments the mock brain adds to its search_history call, so a test
// can make it ask for more than the user's panel allows.
let historyToolArgs = {};
// The fake embedding endpoint above: "down" makes it fail, so the degraded
// keyword-only path is testable.
let embeddingMode = "up";
const embeddingCalls = [];
let receivedAuth;
let disconnected;
let received;
let lastBrain;
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

// POST /api/chat with an explicit Host header: undici's fetch() replaces a
// custom host with the actual target, and the Vikunja region is resolved from
// exactly that header (the public gateway name), so a raw request pins it.
function postChatWithHost(target, host, body, cookie) {
  const url = new URL(`${target}/api/chat`);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        cookie,
        host,
      },
    }, resolve);
    request.on("error", reject);
    request.end(payload);
  });
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
    if (req.url.endsWith("/embeddings")) {
      // A deterministic stand-in for the embedding model: each text maps to
      // counts over three concept groups, so words that MEAN the same thing
      // (car / Tesla / Wagen) share a dimension and unrelated texts are
      // orthogonal. That is enough to exercise ranking, the score floor and
      // the keyword/semantic union without a real model in the test.
      res.setHeader("content-type", "application/json");
      if (embeddingMode === "down") return res.writeHead(503).end('{"error":"embeddings unavailable"}');
      const groups = [
        ["car", "cars", "tesla", "wagen", "park", "parked", "parkt", "garage", "tiefgarage"],
        ["vikunja", "token", "env"],
        ["weather", "sunny", "wetter"],
      ];
      const body = JSON.parse(received.toString("utf8") || "{}");
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      embeddingCalls.push(inputs);
      return res.writeHead(200).end(JSON.stringify({
        object: "list",
        data: inputs.map((input, index) => {
          const words = String(input).toLowerCase().match(/[a-zäöüß]+/g) || [];
          return { object: "embedding", index, embedding: groups.map((group) => words.filter((word) => group.includes(word)).length) };
        }),
      }));
    }
    res.setHeader("content-type", "application/json");
    if (mode === "failure") {
      res.writeHead(503).end('{"error":"unavailable"}');
    } else    if (req.url.endsWith("chat/completions")) {
      // The brain request, kept separately from `received` (the last
      // upstream call of any kind): post-turn ingestion calls the same
      // endpoint after the answer is sent, so it would otherwise race the
      // brain body out of `received`.
      const parsedBody = JSON.parse(received.toString("utf8") || "{}");
      if (!String(parsedBody.messages?.[0]?.content || "").includes("knowledge-graph entities")) lastBrain = parsedBody;
      if (mode === "graph-ingest") {
        // The brain answer and the post-turn extraction call both hit this
        // endpoint; the extraction one carries the EXTRACT_SYSTEM_PROMPT.
        // A "trading news list" prompt gets a WATCHES extraction, a
        // "TradingMonitor List" prompt gets a named-list extraction (list
        // entity + PART_OF membership), instead of the canned LIKES one.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const isExtraction = String(body.messages?.[0]?.content || "").includes("knowledge-graph entities");
        const turnText = isExtraction ? String(body.messages?.[1]?.content || "") : "";
        const isWatchTurn = turnText.includes("trading news list");
        const isListTurn = turnText.includes("TradingMonitor List");
        res.end(isListTurn
          ? '{"choices":[{"message":{"content":"{\\"entities\\":[{\\"name\\":\\"Mila\\",\\"type\\":\\"person\\"},{\\"name\\":\\"Trump\\",\\"type\\":\\"person\\"},{\\"name\\":\\"TradingMonitor List\\",\\"type\\":\\"thing\\"}],\\"relations\\":[{\\"from\\":\\"Mila\\",\\"to\\":\\"Trump\\",\\"type\\":\\"WATCHES\\"},{\\"from\\":\\"Trump\\",\\"to\\":\\"TradingMonitor List\\",\\"type\\":\\"PART_OF\\"}]}"}}]}'
          : isWatchTurn
            ? '{"choices":[{"message":{"content":"{\\"entities\\":[{\\"name\\":\\"Mila\\",\\"type\\":\\"person\\"},{\\"name\\":\\"Gold\\",\\"type\\":\\"topic\\"},{\\"name\\":\\"Nvidia\\",\\"type\\":\\"organization\\"}],\\"relations\\":[{\\"from\\":\\"Mila\\",\\"to\\":\\"Gold\\",\\"type\\":\\"WATCHES\\"},{\\"from\\":\\"Mila\\",\\"to\\":\\"Nvidia\\",\\"type\\":\\"WATCHES\\"}]}"}}]}'
            : isExtraction
              ? '{"choices":[{"message":{"content":"{\\"entities\\":[{\\"name\\":\\"Mila\\",\\"type\\":\\"person\\"},{\\"name\\":\\"Lego\\",\\"type\\":\\"thing\\"}],\\"relations\\":[{\\"from\\":\\"Mila\\",\\"to\\":\\"Lego\\",\\"type\\":\\"LIKES\\"}]}"}}]}'
              : '{"choices":[{"message":{"content":"Noted."}}]}');
        return;
      }
      if (mode === "web-tools") {
        // The mock brain asks for the web_news tool on the first round (tools
        // offered, no tool result yet) and answers once the result arrives —
        // exercising the server-side web tool loop end to end.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
        if (body.tools && !hasToolResult) {
          return res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_news", type: "function", function: { name: "web_news", arguments: JSON.stringify({ topic: "technik" }) } }],
              },
            }],
          }));
        }
        return res.end(JSON.stringify({ choices: [{ message: { content: "Fresh news delivered." } }] }));
      }
      if (mode === "web-fetch") {
        // The mock brain asks for the web_fetch tool on the first round (the
        // exact Google Finance URL from the user report) and answers once the
        // result arrives — exercising the browser-fetch tool loop end to end.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
        if (body.tools && !hasToolResult) {
          return res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://www.google.com/finance/quote/NVD:FRA" }) } }],
              },
            }],
          }));
        }
        return res.end(JSON.stringify({ choices: [{ message: { content: "Fetched the quote page." } }] }));
      }
      if (mode === "history-tool") {
        // The mock brain asks for search_history on the first round and
        // answers from the hit once the result arrives — exercising the
        // conversation-search tool loop end to end. The tool result is echoed
        // into the answer so the test can assert the brain actually saw the
        // stored turn.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const toolResult = (body.messages || []).find((message) => message.role === "tool");
        if (body.tools && !toolResult) {
          historyToolOffers.push((body.tools || []).map((tool) => tool.function?.name));
          // Search what the user actually asked, the way a real brain would,
          // so each test picks its own query through the prompt it sends.
          const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === "user");
          return res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_history", type: "function", function: { name: "search_history", arguments: JSON.stringify({ query: String(lastUser?.content || ""), days: 90, ...historyToolArgs }) } }],
              },
            }],
          }));
        }
        historyToolResults.push(String(toolResult?.content || ""));
        return res.end(JSON.stringify({ choices: [{ message: { content: `Found it: ${String(toolResult?.content || "").slice(0, 200)}` } }] }));
      }
      if (mode === "history-seed") {
        // No tool call: the test only wants the messages the backend built,
        // to check the brain's short-term memory was rebuilt from the store.
        historySeedMessages.push(JSON.parse(received.toString("utf8") || "{}").messages || []);
        return res.end(JSON.stringify({ choices: [{ message: { content: "Noted." } }] }));
      }
      if (mode === "vikunja-tools") {
        // The mock brain asks for list_tasks on the first round (the vikunja
        // tools offered, no tool result yet) and answers once the result
        // arrives — exercising the server-side Vikunja tool loop end to end.
        const body = JSON.parse(received.toString("utf8") || "{}");
        const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
        if (body.tools && !hasToolResult) {
          return res.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_vikunja", type: "function", function: { name: "list_tasks", arguments: "{}" } }],
              },
            }],
          }));
        }
        return res.end(JSON.stringify({ choices: [{ message: { content: "Tasks checked." } }] }));
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
    env: {
      ...process.env,
      PORT: "0",
      WHISPER_ENDPOINTS: endpoint,
      WHISPER_VM103_ENDPOINTS: endpoint,
      WHISPER_OVHCLOUD_ENDPOINTS: endpoint,
      WHISPER_OVHCLOUD_API_KEY: "test-ovh-stt",
      BRAIN_BASE_URL: base,
      BRAIN_OPENROUTER_BASE_URL: base,
      BRAIN_OPENROUTER_API_KEY: "test-openrouter",
      BRAIN_OVHCLOUD_BASE_URL: base,
      BRAIN_OVHCLOUD_API_KEY: "test-ovh",
      BRAIN_A1_QWEN_BASE_URL: base,
      BRAIN_A1_QWEN_API_KEY: "test-qwen",
      BRAIN_CLAUDECODE_BASE_URL: base,
      BRAIN_CLAUDECODE_API_KEY: "test-claude",
      BRAIN_API_KEY: "",
      ...extraEnv,
    },
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

test("config advertises AI and Whisper selectors from the local profiles", async () => {
  const config = await (await auth(origin, "/api/config")).json();
  assert.ok(config.aiProfiles.some((profile) => profile.id === "ovhcloud" && profile.profile === "rw_ovhcloud-qwen3.6-27b"));
  assert.ok(config.aiProfiles.some((profile) => profile.id === "openrouter" && profile.profile === "rw_openrouter-qwen3.8-27b"));
  assert.ok(config.aiProfiles.some((profile) => profile.id === "claudecode" && profile.profile === "rw-claude-Opus5.5"));
  assert.ok(config.aiProfiles.some((profile) => profile.id === "a1-qwen" && profile.profile === "a1-qwen38-27b"));
  assert.ok(config.aiProfiles.some((profile) => profile.id === "a1-deepseek" && profile.profile === "a1-deepseek-v4.0-flash"));
  assert.deepEqual(config.whisperProfiles.map((profile) => profile.id), ["gpu-1", "vm103", "ovhcloud"]);
});

test("BRAIN_PROFILES restricts the advertised AI profiles to the allowlist", async (t) => {
  const { process: child, origin: demo } = await startBackend({
    BRAIN_PROFILES: "a1-deepseek,a1-qwen",
    BRAIN_PROFILE_DEFAULT: "a1-qwen",
  });
  t.after(() => { child.kill(); });
  const config = await (await auth(demo, "/api/config")).json();
  // The private profiles are absent entirely — no selector entries at all —
  // while the a1 profiles stay. The allowed default is preserved.
  assert.deepEqual(config.aiProfiles.map((profile) => profile.id), ["a1-deepseek", "a1-qwen"]);
  assert.equal(config.brainProfileDefault, "a1-qwen");
});

test("BRAIN_PROFILES excludes the default profile, the default falls back to a visible one", async (t) => {
  const { process: child, origin: demo } = await startBackend({
    BRAIN_PROFILES: "a1-qwen",
    BRAIN_PROFILE_DEFAULT: "claudecode",
  });
  t.after(() => { child.kill(); });
  const config = await (await auth(demo, "/api/config")).json();
  assert.deepEqual(config.aiProfiles.map((profile) => profile.id), ["a1-qwen"]);
  assert.equal(config.brainProfileDefault, "a1-qwen");
});

test("the default deployment serves index.html byte-identical (no brand injection)", async () => {
  const served = await (await fetch(`${origin}/`)).text();
  const onDisk = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal(served, onDisk);
});

test("BRAND=a1 injects the a1 theme and logo into index.html only", async (t) => {
  const { process: child, origin: a1 } = await startBackend({ BRAND: "a1" });
  t.after(() => { child.kill(); });
  const html = await (await fetch(`${a1}/`)).text();
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">\s*<link rel="stylesheet" href="\/theme-a1\.css">/);
  assert.match(html, /<img class="brand-logo" src="\/logo-a1\.png" alt="a1"/);
  const theme = await fetch(`${a1}/theme-a1.css`);
  assert.equal(theme.status, 200);
  assert.match(theme.headers.get("content-type"), /text\/css/);
  const logo = await fetch(`${a1}/logo-a1.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type"), /image\/png/);
  // The on-disk file is never modified: the same request on the unbranded
  // deployment stays byte-identical.
  const onDisk = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(onDisk, /theme-a1\.css/);
});

test("the Whisper selector routes a request to the requested server profile", async () => {
  mode = "success";
  const response = await transcribe(undefined, "/api/transcribe?language=en&whisperProfile=vm103");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.profile, "vm103");
  assert.equal(result.profileLabel, "vm103 on pve103");
  assert.match(received.toString("latin1"), /name="model"\r?\n\r?\ndeepdml\/faster-whisper-large-v3-turbo-ct2\r?\n/);
});

test("the Whisper selector can route transcription to OVHcloud whisper-large-v3", async () => {
  mode = "success";
  const response = await transcribe(undefined, "/api/transcribe?language=en&whisperProfile=ovhcloud");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.profile, "ovhcloud");
  assert.equal(result.profileLabel, "OVHcloud Whisper");
  assert.equal(receivedAuth, "Bearer test-ovh-stt");
  const body = received.toString("latin1");
  assert.match(body, /name="model"\r?\n\r?\nwhisper-large-v3\r?\n/);
  assert.doesNotMatch(body, /name="vad_filter"/);
});

test("the AI selector routes chat to the requested profile", async () => {
  mode = "success";
  const response = await auth(origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Hello", brainProfile: "openrouter" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.brainProfile, "openrouter");
  assert.equal(JSON.parse(received.toString("utf8")).model, "qwen/qwen3.8-27b");
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

test("finished chat turns with the graph toggle on are ingested into the knowledge graph", async (t) => {
  mode = "graph-ingest";
  t.after(() => { mode = "success"; });
  // The global backend runs without a graph store; GRAPH_MEMORY=1 swaps in
  // the in-memory graph so the ingest path is verifiable end to end. The
  // automatic storage only runs with the Knowledge graph MCP toggle on
  // (stored policy), so the turn sends it.
  const graphBackend = await startBackend({ GRAPH_MEMORY: "1" });
  t.after(async () => { graphBackend.process.kill(); await once(graphBackend.process, "exit"); });
  const chat = await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "I like Lego.", mcp: { graph: true } }),
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
  // The extraction request is the last upstream call of the turn. It goes to
  // the same reasoning model as the brain, so it needs the same
  // reasoning-safe budget: with 1200 tokens the model spent the budget on
  // thinking and the JSON never came back (content: null), so live turns
  // stored nothing even though the panel query was ready to show it.
  const extraction = JSON.parse(received.toString("utf8"));
  assert.match(extraction.messages[0].content, /knowledge-graph entities/);
  assert.ok(extraction.max_tokens >= 4096);
});

test("save/track instructions land as WATCHES facts and the brain is told the graph auto-saves", async (t) => {
  mode = "graph-ingest";
  t.after(() => { mode = "success"; });
  const graphBackend = await startBackend({ GRAPH_MEMORY: "1" });
  t.after(async () => { graphBackend.process.kill(); await once(graphBackend.process, "exit"); });
  const chat = await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Add Gold, Nvidia to my trading news list.", sessionId: "watch-list", mcp: { graph: true } }),
  });
  assert.equal(chat.status, 200);
  // Ingestion is fire-and-forget: poll until the upsert has landed.
  let sub = { nodes: [], edges: [] };
  for (let i = 0; i < 40; i += 1) {
    sub = await (await auth(graphBackend.origin, "/api/graph/subgraph")).json();
    if ((sub.edges || []).some((edge) => edge.type === "WATCHES")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(sub.nodes.some((node) => node.name === "Gold" && node.type === "topic"), JSON.stringify(sub.nodes));
  assert.ok(sub.nodes.some((node) => node.name === "Nvidia" && node.type === "organization"), JSON.stringify(sub.nodes));
  assert.equal(sub.edges.filter((edge) => edge.type === "WATCHES").length, 2, JSON.stringify(sub.edges));
  // The extraction request (the last upstream call of the turn) is what the
  // production extractor LLM reads: it must be taught that save/track
  // instructions are facts to store as WATCHES.
  const extraction = JSON.parse(received.toString("utf8"));
  assert.match(extraction.messages[0].content, /WATCHES/);
  assert.match(extraction.messages[0].content, /Instructions to save, remember, track or add topics/);
  // The next turn has a non-empty graph context: the brain's system prompt
  // tells it the graph is updated automatically after every answer, so it
  // confirms save requests instead of claiming it cannot write.
  mode = "success";
  await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Remember Silver for my news list.", sessionId: "watch-confirm", mcp: { graph: true } }),
  });
  // lastBrain (not received): this turn's own ingestion would race the brain
  // body out of received.
  const brainPrompt = lastBrain.messages[0].content;
  assert.match(brainPrompt, /updated automatically after every answer/);
  assert.match(brainPrompt, /confirm that it is done/);
});

test("assigning a topic to a named list stores the list entity and its PART_OF membership", async (t) => {
  mode = "graph-ingest";
  t.after(() => { mode = "success"; });
  const graphBackend = await startBackend({ GRAPH_MEMORY: "1" });
  t.after(async () => { graphBackend.process.kill(); await once(graphBackend.process, "exit"); });
  const chat = await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Assign Trump to my TradingMonitor List.", sessionId: "watch-list-assign", mcp: { graph: true } }),
  });
  assert.equal(chat.status, 200);
  // Ingestion is fire-and-forget: poll until the upsert has landed.
  let sub = { nodes: [], edges: [] };
  for (let i = 0; i < 40; i += 1) {
    sub = await (await auth(graphBackend.origin, "/api/graph/subgraph")).json();
    if ((sub.edges || []).some((edge) => edge.type === "PART_OF")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // The list is its own entity (so it shows up in the graph view), the
  // topic is a member of it, and the user watches the topic.
  const listNode = sub.nodes.find((node) => node.name === "TradingMonitor List");
  assert.ok(listNode, JSON.stringify(sub.nodes));
  assert.equal(listNode.type, "thing");
  assert.ok(sub.nodes.some((node) => node.name === "Trump"), JSON.stringify(sub.nodes));
  const partOf = sub.edges.find((edge) => edge.type === "PART_OF");
  assert.ok(partOf, JSON.stringify(sub.edges));
  const names = (id) => sub.nodes.find((node) => node.id === id)?.name;
  assert.equal(names(partOf.source), "Trump");
  assert.equal(names(partOf.target), "TradingMonitor List");
  assert.ok(sub.edges.some((edge) => edge.type === "WATCHES"), JSON.stringify(sub.edges));
  // The extraction prompt the production LLM reads pins the named-list rule.
  const extraction = JSON.parse(received.toString("utf8"));
  assert.match(extraction.messages[0].content, /Named lists the user maintains/);
  assert.match(extraction.messages[0].content, /PART_OF/);
  // The next turn's brain prompt names the list path (assign-to-list
  // confirmations are stored, not denied).
  mode = "success";
  await auth(graphBackend.origin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "What is in my TradingMonitor List?", sessionId: "watch-list-read", mcp: { graph: true } }),
  });
  const brainPrompt = lastBrain.messages[0].content;
  assert.match(brainPrompt, /assign X to my TradingMonitor list/);
  assert.match(brainPrompt, /PART_OF/);
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

test("the brain gets web_search and web_news tools and can fetch live news", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-web-tools-mock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The mock MCP server echoes the tool name and the full arguments it
  // received, so the test can pin the backend's per-call lang injection
  // without any network.
  const script = join(dir, "mcp-web-tools.mjs");
  await writeFile(script, `
    import readline from "node:readline";
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-websearch", version: "1.0.0" } };
      } else if (message.method === "tools/call") {
        result = { isError: false, content: [{ type: "text", text: "Mock " + message.params.name + " result: 42. args=" + JSON.stringify(message.params.arguments || {}) }] };
      } else {
        result = {};
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });
  `);
  const { process: child, origin: toolsOrigin } = await startBackend({ MCP_SEARCH_SCRIPT: script });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  mode = "web-tools";
  const response = await auth(toolsOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Gib mir die letzten News.", sessionId: "web-news-loop", language: "de", websearch: true }),
  });
  const result = await response.json();
  assert.equal(result.answer, "Fresh news delivered.");
  // The final request (after the tool round) still offers all three web
  // tools...
  const body = JSON.parse(received.toString("utf8"));
  // search_history rides along on every chat (the user's own stored
  // conversation, no toggle); the web toggle adds exactly these three.
  assert.deepEqual(body.tools.map((tool) => tool.function.name),
    ["web_search", "web_news", "web_fetch", "search_history"]);
  // ...and the tool round landed: the brain's web_news call got the mock
  // result, the backend injected the answer language (lang) per call, and
  // the brain only supplied the topic — the MCP never sees a brain-chosen
  // locale.
  const toolMessage = body.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the tool result is in the final request");
  assert.match(toolMessage.content, /Mock web_news result: 42/);
  assert.match(toolMessage.content, /"topic":"technik"/);
  assert.match(toolMessage.content, /"lang":"de"/);
  // The system prompt tells the brain about the news tool and the areas.
  assert.match(body.messages[0].content, /web_news/);
  assert.match(body.messages[0].content, /technik, it, finance, geek, nerd/);
  // ...and about the browser-fetch tool for specific pages.
  assert.match(body.messages[0].content, /web_fetch/);
  mode = "success";
});

test("the brain gets the web_fetch tool and can open a page in the browser", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-web-fetch-mock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Same mock MCP as the news test: it echoes the tool name and the full
  // arguments, so the backend's per-call lang injection is pinned without any
  // network or real browser.
  const script = join(dir, "mcp-web-fetch.mjs");
  await writeFile(script, `
    import readline from "node:readline";
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-websearch", version: "1.0.0" } };
      } else if (message.method === "tools/call") {
        result = { isError: false, content: [{ type: "text", text: "Mock " + message.params.name + " result: 42. args=" + JSON.stringify(message.params.arguments || {}) }] };
      } else {
        result = {};
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });
  `);
  const { process: child, origin: toolsOrigin } = await startBackend({ MCP_SEARCH_SCRIPT: script });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  mode = "web-fetch";
  const response = await auth(toolsOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Pull the Nvidia quote from Google Finance.", sessionId: "web-fetch-loop", language: "de", websearch: true }),
  });
  const result = await response.json();
  assert.equal(result.answer, "Fetched the quote page.");
  const body = JSON.parse(received.toString("utf8"));
  // The web_fetch tool is offered to the brain...
  const offered = body.tools.map((tool) => tool.function.name);
  assert.ok(offered.includes("web_fetch"), "web_fetch is in the offered tools");
  // ...the system prompt describes it, and the tool round landed with the
  // exact URL the brain chose plus the injected answer language.
  assert.match(body.messages[0].content, /web_fetch/);
  const toolMessage = body.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the tool result is in the final request");
  assert.match(toolMessage.content, /Mock web_fetch result: 42/);
  assert.match(toolMessage.content, /"url":"https:\/\/www\.google\.com\/finance\/quote\/NVD:FRA"/);
  assert.match(toolMessage.content, /"lang":"de"/);
  mode = "success";
});

test("vikunja is region-pinned per request and scoped to the signed-in user", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-vikunja-mock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Mock @eargollo/vikunja-mcp: tools/list offers a few tools, and tools/call
  // echoes the VIKUNJA_URL/VIKUNJA_API_TOKEN env the backend spawned it with,
  // so the (region, user) routing is pinned without any network.
  const script = join(dir, "mcp-vikunja.mjs");
  await writeFile(script, `
    import readline from "node:readline";
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock-vikunja", version: "1.0.0" } };
      } else if (message.method === "tools/list") {
        result = { tools: [
          { name: "list_projects", description: "List projects.", inputSchema: { type: "object", properties: {} } },
          { name: "list_tasks", description: "List tasks.", inputSchema: { type: "object", properties: { status: { type: "string" } } } },
          { name: "create_task", description: "Create a task.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
        ] };
      } else if (message.method === "tools/call") {
        result = { isError: false, content: [{ type: "text", text: "Mock " + message.params.name + ": url=" + process.env.VIKUNJA_URL + " token=" + process.env.VIKUNJA_API_TOKEN }] };
      } else {
        result = {};
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });
  `);
  const { process: child, origin: vikunjaOrigin } = await startBackend({
    VIKUNJA_URLS: JSON.stringify({ "nbg-1": "http://127.0.0.1:34561/api/v1", "vie-1": "http://127.0.0.1:34562/api/v1" }),
    VIKUNJA_TOKENS: JSON.stringify({
      "nbg-1": { Roman: "tk-nbg-roman", Mila: "tk-nbg-mila" },
      "vie-1": { Roman: "tk-vie-roman", Mila: "tk-vie-mila" },
    }),
    VIKUNJA_MCP_SCRIPT: script,
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  // The backend advertises the Vikunja switch in /api/config (the UI builds
  // one switch per advertised server); without VIKUNJA_URLS it stays off.
  const config = await (await auth(vikunjaOrigin, "/api/config")).json();
  assert.ok(config.mcpServers.some((server) => server.id === "vikunja" && server.label === "Vikunja"), "vikunja switch advertised");
  // Toggle off: the brain is told Vikunja is off and no MCP child is spawned.
  mode = "success";
  const romanCookie = await login(vikunjaOrigin, "Roman");
  await auth(vikunjaOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "What are my tasks?", sessionId: "vikunja-off", mcp: { vikunja: false } }),
  });
  assert.match(JSON.parse(received.toString("utf8")).messages[0].content, /Vikunja \(the task manager\) is OFF/);
  // Toggle on: the region comes from the request's public Host header and the
  // spawned child carries that region's URL plus the signed-in user's OWN
  // token for that region — nbg-1 entry -> nbg-1 instance, never cross-region.
  const ask = (host, cookie, session) => postChatWithHost(vikunjaOrigin, host, {
    prompt: "What are my tasks?", sessionId: session, mcp: { vikunja: true },
  }, cookie);
  mode = "vikunja-tools";
  await ask("jarvis.gw-1-nbg-1-de-netcup.rwnix.net", romanCookie, "vikunja-nbg-roman");
  let body = JSON.parse(received.toString("utf8"));
  assert.ok(body.tools.map((tool) => tool.function.name).includes("list_tasks"), "the live vikunja tool list is offered");
  let toolMessage = body.messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /url=http:\/\/127\.0\.0\.1:34561\/api\/v1 token=tk-nbg-roman/);
  assert.match(body.messages[0].content, /on the nbg-1 instance/);
  await ask("jarvis.gw-1-vie-1-at-netcup.rwnix.net", romanCookie, "vikunja-vie-roman");
  body = JSON.parse(received.toString("utf8"));
  toolMessage = body.messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /url=http:\/\/127\.0\.0\.1:34562\/api\/v1 token=tk-vie-roman/);
  // Per-user on the same region: Mila on nbg-1 gets her own token (a second
  // child, one per (region, user)).
  const milaCookie = await login(vikunjaOrigin, "Mila");
  await ask("jarvis.gw-1-nbg-1-de-netcup.rwnix.net", milaCookie, "vikunja-nbg-mila");
  body = JSON.parse(received.toString("utf8"));
  toolMessage = body.messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /url=http:\/\/127\.0\.0\.1:34561\/api\/v1 token=tk-nbg-mila/);
  // A user without a token for the region (admin) gets no Vikunja access.
  const adminCookie = await login(vikunjaOrigin, "admin");
  mode = "success";
  await ask("jarvis.gw-1-nbg-1-de-netcup.rwnix.net", adminCookie, "vikunja-admin");
  assert.match(JSON.parse(received.toString("utf8")).messages[0].content, /no Vikunja account configured/);
  mode = "success";
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

test("per-user passwords: name:password entries and legacy parity", async (t) => {
  const { process: child, origin: localOrigin } = await startBackend({ USERS: "admin:sekrit,Mila" });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  // The explicit-password entry accepts only its own password (case-sensitive).
  const ok = await fetch(`${localOrigin}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "sekrit" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user, "admin");
  for (const body of [
    { username: "admin", password: "admin" },
    { username: "admin", password: "SEKRIT" },
    { username: "admin", password: "wrong" },
    { username: "Stranger", password: "wrong" },
  ]) {
    const bad = await fetch(`${localOrigin}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(bad.status, 403, JSON.stringify(body));
    await bad.json();
  }
  // A bare-name entry in the same list keeps the legacy password = name rule.
  const legacy = await fetch(`${localOrigin}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Mila", password: "Mila" }),
  });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).user, "Mila");
  // The hint reflects the explicit-password deployment.
  const config403 = await fetch(`${localOrigin}/api/config`);
  assert.equal(config403.status, 403);
  assert.equal((await config403.json()).loginHint, "Enter your username and password.");
});

test("an explicitly empty WHISPER_*_ENDPOINTS disables that profile", async (t) => {
  const { process: child, origin: localOrigin } = await startBackend({
    WHISPER_VM103_ENDPOINTS: "",
    WHISPER_OVHCLOUD_ENDPOINTS: "",
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const health = await (await fetch(`${localOrigin}/api/health`)).json();
  assert.equal(health.whisperEndpoints, 1);
  const cookie = await login(localOrigin, "Mila");
  const config = await (await fetch(`${localOrigin}/api/config`, { headers: { cookie } })).json();
  assert.deepEqual(config.whisperProfiles.map((profile) => profile.id), ["gpu-1"]);
});

test("loginHint advertises the legacy convention on the default deployment", async () => {
  const config403 = await fetch(`${origin}/api/config`);
  assert.equal(config403.status, 403);
  assert.equal((await config403.json()).loginHint, "The password is your username.");
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

test("the conversation log stores finished turns per user, windowed to 24 days", async () => {
  const mila = await login(origin, "Mila");
  const roman = await login(origin, "Roman");
  const post = (cookie, prompt, answer) => auth(origin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
  }, cookie);
  // A turn needs both sides: the panels show prompt AND answer.
  const bad = await post(mila, "only a prompt", "");
  assert.equal(bad.status, 400);
  await bad.json();
  // A stored turn comes back with a server timestamp...
  const stored = await post(mila, "what time is it?", "It is 14:05.");
  assert.equal(stored.status, 200);
  const entry = (await stored.json()).entry;
  assert.equal(entry.prompt, "what time is it?");
  assert.ok(Date.parse(entry.ts) > 0, JSON.stringify(entry));
  // ...and appears in the owner's GET, newest last.
  const milaLog = await (await auth(origin, "/api/conversation", {}, mila)).json();
  assert.deepEqual(milaLog.entries.at(-1), entry, JSON.stringify(milaLog.entries));
  // ...and never in another user's view.
  const romanLog = await (await auth(origin, "/api/conversation", {}, roman)).json();
  assert.ok(!romanLog.entries.some((candidate) => candidate.prompt === "what time is it?"), "no cross-user leakage");
  // The served view is windowed to the last 24 days (older entries stay
  // stored, out of the panel's view): a fresh entry is inside the window and
  // the only entry Mila has, so the served list is exactly it.
  assert.ok(Date.now() - Date.parse(entry.ts) < 24 * 60 * 60 * 1000, "a fresh turn is inside the window");
  assert.equal(milaLog.entries.length, 1, JSON.stringify(milaLog.entries));
});

test("the brain can search the user's stored conversation, scoped to that user", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  const mila = await login(backendOrigin, "Mila");
  const post = (cookie, prompt, answer) => auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
  }, cookie);
  await post(roman, "where is my Vikunja token stored?", "In the .env on vm104, Roman.");
  await post(roman, "what is the weather", "Sunny.");
  // Mila's turn matches the same words: it must never reach Roman's brain.
  await post(mila, "my Vikunja token is secret", "Noted, Mila.");

  mode = "history-tool";
  historyToolOffers.length = 0;
  historyToolResults.length = 0;
  const response = await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "what did I ask you about the Vikunja token?" }),
  }, roman);
  assert.equal(response.status, 200);
  const answer = (await response.json()).answer;

  // The tool is offered with no MCP toggle on: it reads the user's own
  // stored conversation, so there is no switch to forget.
  assert.ok(historyToolOffers[0].includes("search_history"), JSON.stringify(historyToolOffers));
  const toolResult = historyToolResults[0];
  assert.match(toolResult, /where is my Vikunja token stored\?/);
  assert.match(toolResult, /In the \.env on vm104, Roman\./);
  // Every hit is dated: the dates are how the user recognises the turn.
  assert.match(toolResult, /\[\d{4}-\d{2}-\d{2}T/);
  // The non-matching turn is not padding the result.
  assert.doesNotMatch(toolResult, /Sunny/);
  // Mila's matching turn is invisible to Roman's brain.
  assert.doesNotMatch(toolResult, /Noted, Mila/);
  assert.doesNotMatch(toolResult, /my Vikunja token is secret/);
  assert.match(answer, /Found it:/);
  mode = "success";
});

test("history search is semantic: it finds the turn that means the same thing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-semantic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  const mila = await login(backendOrigin, "Mila");
  const post = (cookie, prompt, answer) => auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
  }, cookie);
  // Not one word of the query appears in this turn — keyword search cannot
  // find it, which is the whole point of the feature.
  await post(roman, "my Tesla is in the garage", "Noted, Roman.");
  await post(roman, "what is the weather", "Sunny.");
  // The same meaning, in German: a multilingual embedding finds it too.
  await post(roman, "wo parkt der Wagen", "In der Tiefgarage.");
  // Mila's turn means the same thing: it must still never cross over.
  await post(mila, "my car is parked in the garage", "Noted, Mila.");
  // The POSTs embed in the background; give the fire-and-forget calls a beat.
  await setTimeoutPromise(500);

  mode = "history-tool";
  historyToolResults.length = 0;
  await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "where did I park my car?" }),
  }, roman);
  const result = historyToolResults[0];
  // Found by meaning alone, and labelled as such with its similarity.
  assert.match(result, /my Tesla is in the garage/, result);
  assert.match(result, /matched by meaning, similarity \d\.\d\d/, result);
  // Across languages too.
  assert.match(result, /wo parkt der Wagen/, result);
  // The unrelated turn stays out: the score floor is doing its job.
  assert.doesNotMatch(result, /Sunny/, result);
  // And the semantic half is owner-scoped like the keyword half.
  assert.doesNotMatch(result, /Noted, Mila/, result);
  mode = "success";
});

test("the History search panel's parameters reach the search, clamped to the backend limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-params-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");

  // The panel builds its sliders from this, so the limits must be advertised.
  const config = await (await auth(backendOrigin, "/api/config", {}, roman)).json();
  assert.deepEqual(Object.keys(config.historySearch).sort(),
    ["days", "maxResults", "memoryTurns", "minScore", "snippetChars", "strongScore"]);
  for (const [key, spec] of Object.entries(config.historySearch)) {
    assert.ok(Number.isFinite(spec.min) && Number.isFinite(spec.max) && Number.isFinite(spec.step)
      && Number.isFinite(spec.default), `${key} needs min/max/step/default: ${JSON.stringify(spec)}`);
    assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${key} default is outside its own range`);
  }
  assert.equal(typeof config.embeddingConfigured, "boolean");

  const post = (prompt, answer) => auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
  }, roman);
  await post("the car is in the garage", "A".repeat(300));
  await post("the car is on the street", "B".repeat(300));
  await post("the car is at the shop", "C".repeat(300));
  await setTimeoutPromise(600);

  const ask = (historySearch) => auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the car", historySearch }),
  }, roman);

  // Max results caps the hits...
  mode = "history-tool";
  historyToolResults.length = 0;
  await ask({ maxResults: 1 });
  assert.equal((historyToolResults[0].match(/\[\d{4}-/g) || []).length, 1, historyToolResults[0]);
  // ...and raising it brings the others back.
  historyToolResults.length = 0;
  await ask({ maxResults: 10 });
  assert.equal((historyToolResults[0].match(/\[\d{4}-/g) || []).length, 3, historyToolResults[0]);
  // The snippet length truncates the quoted text.
  historyToolResults.length = 0;
  await ask({ maxResults: 1, snippetChars: 100 });
  // Newest first, so the single hit is the "at the shop" turn: its 300-char
  // answer comes back cut to exactly 100 characters plus the ellipsis.
  assert.match(historyToolResults[0], /C{100}…/, historyToolResults[0]);
  assert.doesNotMatch(historyToolResults[0], /C{101}/, historyToolResults[0]);
  // A semantic floor above 1.0 can match nothing, so only word hits remain —
  // proof the slider reaches the ranking.
  historyToolResults.length = 0;
  await ask({ minScore: 0.9, maxResults: 10 });
  assert.doesNotMatch(historyToolResults[0], /matched by meaning/, historyToolResults[0]);
  // Out-of-range values are clamped, not rejected: the turn still succeeds.
  historyToolResults.length = 0;
  const silly = await ask({ days: 999999, maxResults: 9999, minScore: 42, snippetChars: -5, memoryTurns: 0 });
  assert.equal(silly.status, 200);
  assert.ok(historyToolResults[0].length > 0);
  mode = "success";
});

test("the panel's max results is a ceiling the brain cannot widen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-ceiling-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  for (const index of [1, 2, 3, 4, 5]) {
    await auth(backendOrigin, "/api/conversation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: `the car note ${index}`, answer: `answer ${index}` }),
    }, roman);
  }
  await setTimeoutPromise(600);
  mode = "history-tool";
  // A real brain sends max_results and days of its own; they must not be able
  // to climb above the user's sliders.
  historyToolArgs = { max_results: 20, days: 365 };
  t.after(() => { historyToolArgs = {}; });
  historyToolResults.length = 0;
  await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the car", historySearch: { maxResults: 2, days: 1 } }),
  }, roman);
  assert.equal((historyToolResults[0].match(/\[\d{4}-/g) || []).length, 2,
    `the brain asked for 20, the panel allows 2: ${historyToolResults[0]}`);
  // And the brain may still narrow it.
  historyToolArgs = { max_results: 1 };
  historyToolResults.length = 0;
  await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the car", historySearch: { maxResults: 5 } }),
  }, roman);
  assert.equal((historyToolResults[0].match(/\[\d{4}-/g) || []).length, 1, historyToolResults[0]);
  mode = "success";
});

test("the short-term memory slider sets how many stored turns ride in the prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "conversations.db");
  const { process: first, origin: firstOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  const firstExit = new Promise((resolve) => first.once("exit", resolve));
  t.after(async () => { first.kill(); await firstExit; });
  const roman = await login(firstOrigin, "Roman");
  for (const index of [1, 2, 3, 4]) {
    await auth(firstOrigin, "/api/conversation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: `memory turn ${index}`, answer: `answer ${index}` }),
    }, roman);
  }
  // A cold process, so the memory comes from the store and the slider decides
  // how much of it is rebuilt.
  first.kill();
  await firstExit;
  const { process: second, origin: secondOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  t.after(async () => { second.kill(); await once(second, "exit"); });
  const romanAgain = await login(secondOrigin, "Roman");
  mode = "history-seed";
  historySeedMessages.length = 0;
  await auth(secondOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "and now?", historySearch: { memoryTurns: 2 } }),
  }, romanAgain);
  const carried = (historySeedMessages[0] || []).filter((message) => /^memory turn /.test(String(message.content)));
  assert.deepEqual(carried.map((message) => message.content), ["memory turn 3", "memory turn 4"],
    JSON.stringify(historySeedMessages[0]?.map((message) => String(message.content).slice(0, 40))));
  mode = "success";
});

test("turns stored back-to-back all get embedded, none dropped by the backfill guard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-burst-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "conversations.db");
  const { process: child, origin: backendOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  // A burst: each POST kicks off a fire-and-forget embedding run, so all but
  // the first land while one is already running. They used to be dropped and
  // stay unembedded until the next restart (measured live: 6 of 8).
  await Promise.all(Array.from({ length: 8 }, (_, index) => auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: `burst turn ${index} about the car`, answer: `answer ${index}` }),
  }, roman)));
  // Let the coalesced runs drain.
  await setTimeoutPromise(1500);
  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());
  const turns = db.prepare("SELECT COUNT(*) AS n FROM conversations").get().n;
  const embedded = db.prepare("SELECT COUNT(*) AS n FROM conversation_embeddings").get().n;
  assert.equal(turns, 8);
  assert.equal(embedded, 8, `every stored turn needs a vector, got ${embedded}/${turns}`);
});

test("a failing embedding endpoint degrades to keyword search instead of failing the turn", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-degrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  await auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the Vikunja token is in the env", answer: "Stored." }),
  }, roman);
  await setTimeoutPromise(300);
  embeddingMode = "down";
  t.after(() => { embeddingMode = "up"; });
  mode = "history-tool";
  historyToolResults.length = 0;
  const response = await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the Vikunja token" }),
  }, roman);
  // The turn still succeeds, the word match still comes back, and the brain
  // is told the meaning half was unavailable rather than silently losing it.
  assert.equal(response.status, 200);
  assert.match(historyToolResults[0], /the Vikunja token is in the env/);
  assert.match(historyToolResults[0], /meaning-based matching was unavailable/);
  mode = "success";
});

test("without an embedding endpoint the search is keyword-only and says so", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-nokey-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
    EMBEDDING_BASE_URL: "", BRAIN_OVHCLOUD_BASE_URL: "",
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  await auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the Vikunja token is in the env", answer: "Stored." }),
  }, roman);
  mode = "history-tool";
  historyToolResults.length = 0;
  await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "the Vikunja token" }),
  }, roman);
  assert.match(historyToolResults[0], /the Vikunja token is in the env/);
  assert.match(historyToolResults[0], /meaning-based matching is not configured/);
  mode = "success";
});

test("turns stored before the feature are embedded by the startup backfill", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-backfill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "conversations.db");
  // First backend: no embedding endpoint, so the turn is stored with no vector
  // — exactly the state of the live database before this feature shipped.
  const { process: first, origin: firstOrigin } = await startBackend({
    CONVERSATION_DB_PATH: dbPath, EMBEDDING_BASE_URL: "", BRAIN_OVHCLOUD_BASE_URL: "",
  });
  const firstExit = new Promise((resolve) => first.once("exit", resolve));
  t.after(async () => { first.kill(); await firstExit; });
  const roman = await login(firstOrigin, "Roman");
  await auth(firstOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "my Tesla is in the garage", answer: "Noted, Roman." }),
  }, roman);
  first.kill();
  await firstExit;
  // Second backend, same db, embeddings configured: the backfill picks the
  // old row up and it becomes findable by meaning.
  const { process: second, origin: secondOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  t.after(async () => { second.kill(); await once(second, "exit"); });
  const romanAgain = await login(secondOrigin, "Roman");
  await setTimeoutPromise(700);
  mode = "history-tool";
  historyToolResults.length = 0;
  await auth(secondOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "where did I park my car?" }),
  }, romanAgain);
  assert.match(historyToolResults[0], /my Tesla is in the garage/, historyToolResults[0]);
  assert.match(historyToolResults[0], /matched by meaning/, historyToolResults[0]);
  mode = "success";
});

test("a history search with no hits says so instead of inventing one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-miss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { process: child, origin: backendOrigin } = await startBackend({
    CONVERSATION_DB_PATH: join(dir, "conversations.db"),
  });
  t.after(async () => { child.kill(); await once(child, "exit"); });
  const roman = await login(backendOrigin, "Roman");
  await auth(backendOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "unrelated", answer: "unrelated" }),
  }, roman);
  mode = "history-tool";
  historyToolResults.length = 0;
  await auth(backendOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "what about the Vikunja token?" }),
  }, roman);
  // The miss is explicit about both halves having been tried.
  assert.match(historyToolResults[0], /Nothing in this user's last 90 days of conversation matches .*by words or by meaning/);
  mode = "success";
});

test("the brain's short-term memory is rebuilt from the store after a restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-history-seed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "conversations.db");
  const { process: first, origin: firstOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  const firstExit = new Promise((resolve) => first.once("exit", resolve));
  t.after(async () => { first.kill(); await firstExit; });
  const roman = await login(firstOrigin, "Roman");
  await auth(firstOrigin, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "my favourite colour is cyan", answer: "Noted, Roman." }),
  }, roman);
  // Restart: the in-process cache is gone, which is exactly the state that
  // made the brain claim it had never spoken to the user before.
  first.kill();
  await firstExit;
  const { process: second, origin: secondOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  t.after(async () => { second.kill(); await once(second, "exit"); });
  const romanAgain = await login(secondOrigin, "Roman");
  mode = "history-seed";
  historySeedMessages.length = 0;
  await auth(secondOrigin, "/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "what is my favourite colour?" }),
  }, romanAgain);
  const messages = historySeedMessages[0] || [];
  assert.ok(messages.some((message) => message.role === "user" && message.content === "my favourite colour is cyan"),
    JSON.stringify(messages.map((message) => [message.role, String(message.content).slice(0, 60)])));
  assert.ok(messages.some((message) => message.role === "assistant" && message.content === "Noted, Roman."),
    JSON.stringify(messages.map((message) => [message.role, String(message.content).slice(0, 60)])));
  // And the brain is told the tool exists, so it looks back instead of
  // saying it has no history.
  assert.match(String(messages[0].content), /search_history/);
  mode = "success";
});

test("the conversation store is a database: ?days= windows it and it survives a restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-conversation-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "conversations.db");
  const { process: first, origin: firstOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  // The test body kills `first` mid-test (the restart check), so the exit
  // promise is shared: awaiting an already-emitted 'exit' event would hang.
  const firstExit = new Promise((resolve) => first.once("exit", resolve));
  t.after(async () => { first.kill(); await firstExit; });
  const mila = await login(firstOrigin, "Mila");
  const post = (origin_, cookie, prompt, answer) => auth(origin_, "/api/conversation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, answer }),
  }, cookie);
  await post(firstOrigin, mila, "first question", "first answer");
  await post(firstOrigin, mila, "second question", "second answer");
  // The History slider's ?days= parameter: a fresh entry is inside any
  // window, and invalid values are rejected (the slider is 1..31, the
  // backend clamps 1..365).
  const days = (daysParam) => auth(firstOrigin, `/api/conversation${daysParam}`, {}, mila);
  const oneDay = await (await days("?days=1")).json();
  assert.equal(oneDay.entries.length, 2, JSON.stringify(oneDay.entries));
  const badDays = await days("?days=0");
  assert.equal(badDays.status, 400);
  assert.equal((await badDays.json()).error, "invalid_days");
  const notDays = await days("?days=abc");
  assert.equal(notDays.status, 400);
  // Restart with the SAME db file: the stored turns come back (the panels'
  // history must survive container rebuilds, which is the whole point of the
  // database).
  first.kill();
  await firstExit;
  const { process: second, origin: secondOrigin } = await startBackend({ CONVERSATION_DB_PATH: dbPath });
  t.after(async () => { second.kill(); await once(second, "exit"); });
  const milaAgain = await login(secondOrigin, "Mila");
  const survived = await (await auth(secondOrigin, "/api/conversation?days=90", {}, milaAgain)).json();
  assert.deepEqual(
    survived.entries.map((candidate) => candidate.prompt),
    ["first question", "second question"],
    JSON.stringify(survived.entries),
  );
});
