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
  assert.deepEqual(body.tools.map((tool) => tool.function.name), ["web_search", "web_news", "web_fetch"]);
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
