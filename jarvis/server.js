const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const graphdb = require("./graphdb");

const root = __dirname;
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8094);

const config = {
  publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH || "/"),
  wakePhrase: process.env.WAKE_PHRASE || "Hey Rocky",
  silenceMs: Number(process.env.SILENCE_MS || 1500),
  whisperEndpoints: splitCsv(process.env.WHISPER_ENDPOINTS || "https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/transcriptions"),
  whisperModel: process.env.WHISPER_MODEL || "Systran/faster-whisper-large-v3",
  whisperLanguage: process.env.WHISPER_LANGUAGE || "en",
  whisperVadFilter: parseBoolean(process.env.WHISPER_VAD_FILTER || "true"),
  whisperApiKey: process.env.WHISPER_API_KEY || "",
  brainBaseUrl: trimSlash(process.env.BRAIN_BASE_URL || "https://ds4-flash.gpu-2-de-fra-1-exo.csdc-nm.at/v1"),
  brainModel: process.env.BRAIN_MODEL || "deepseek-v4-flash",
  brainApiKey: process.env.BRAIN_API_KEY || "",
  brainSystemPrompt: process.env.BRAIN_SYSTEM_PROMPT || "You are Jarvis, a concise voice assistant. Answer in English, be helpful, and keep spoken answers short.",
  // `??`, not `||`: an explicitly empty TTS_ENDPOINTS must disable self-hosted TTS
  // and leave HAL 9000 on its speechSynthesis fallback.
  ttsEndpoints: splitCsv(process.env.TTS_ENDPOINTS ?? "https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/speech"),
  ttsModel: process.env.TTS_MODEL || "speaches-ai/Kokoro-82M-v1.0-ONNX",
  ttsVoice: process.env.TTS_VOICE || "bm_george",
  ttsApiKey: process.env.TTS_API_KEY || "",
  // Multi-user login: comma-separated user names. Each user's password is
  // their own name (Mila signs in with "Mila"/"Mila").
  users: splitCsv(process.env.USERS || "Mila,Roman"),
  // The admin session: signs in like any user (ADMIN_USERS must be a subset
  // of USERS) and sees every user's data — the panel shows the whole graph
  // and the brain's graph tools run across all owners. The flag is derived
  // from the session, never from the client.
  admins: splitCsv(process.env.ADMIN_USERS || "admin"),
  // Neo4j knowledge graph. The read user is used for the brain context, the
  // /api/graph/* panel endpoints and (via the MCP server) the brain's own
  // read-only queries; the write user is used ONLY by the backend's turn
  // ingestion. Everything stays off when these are empty.
  graph: {
    uri: trimSlash(process.env.NEO4J_URI || ""),
    database: process.env.NEO4J_DATABASE || "neo4j",
    readUser: process.env.NEO4J_READ_USER || "",
    readPassword: process.env.NEO4J_READ_PASSWORD || "",
    writeUser: process.env.NEO4J_WRITE_USER || "",
    writePassword: process.env.NEO4J_WRITE_PASSWORD || "",
  },
};

let whisperCursor = 0;
let ttsCursor = 0;
// Per-user prompt history: authenticated username -> last 10 messages. Each
// user's cache is fully isolated from every other user's.
const conversations = new Map();

// --- Login sessions ---------------------------------------------------------
// In-memory sessions: token -> { user, createdAt }. The token travels as an
// HttpOnly cookie; every /api route except /api/login, /api/logout and
// /api/health requires a valid one.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map(); // client address -> { failures, blockedUntil }

function canonicalUser(name) {
  const wanted = String(name || "").trim().toLowerCase();
  for (const user of config.users) if (user.toLowerCase() === wanted) return user;
  return null;
}

// The admin session is a session property, never client input: it is derived
// from the signed-in user and drives the global panel view, the cross-owner
// brain tools and the full activity feed.
function isAdmin(user) {
  return Boolean(user) && config.admins.includes(user);
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sessionToken(req) {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)jarvis_session=([a-f0-9]{64})(?=(?:;|\s|$))/);
  return match ? match[1] : null;
}

function sessionUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    if (session) sessions.delete(token);
    return null;
  }
  return session.user;
}

function issueSession(user, req, res) {
  if (sessions.size > 1000) {
    for (const [token, session] of sessions) {
      if (Date.now() - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
    }
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user, createdAt: Date.now() });
  // Secure when the request arrived over a TLS front (the app needs HTTPS for
  // microphone access anyway); plain LAN http stays usable.
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ? "; Secure" : "";
  res.setHeader("set-cookie", `jarvis_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function endSession(req, res) {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
  res.setHeader("set-cookie", "jarvis_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function loginBlocked(address) {
  const entry = loginAttempts.get(address);
  if (!entry) return false;
  if (entry.blockedUntil > Date.now()) return true;
  // A past blockedUntil is an expired lockout (0 means "never blocked");
  // drop it, but keep the failure counter while it is still accumulating.
  if (entry.blockedUntil > 0) loginAttempts.delete(address);
  return false;
}

function recordLoginFailure(address) {
  const entry = loginAttempts.get(address) || { failures: 0, blockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= 5) {
    entry.failures = 0;
    entry.blockedUntil = Date.now() + LOGIN_LOCK_MS;
    console.log(JSON.stringify({ level: "warn", msg: "login_locked_out", address, lockMs: LOGIN_LOCK_MS }));
  }
  loginAttempts.set(address, entry);
}

// Per-profile Kokoro voice. Character profiles use the en_GB set of
// Kokoro-82M-v1.0; the named male/female voices use the en_US set (am_*/af_*).
// All of them are served by the deployed gpu-1 model. Unknown profiles fall
// back to the configured TTS_VOICE.
const profileVoices = {
  hal9000: "bm_george",
  commander: "bm_daniel",
  android: "bm_lewis",
  wizard: "bm_fable",
  newscaster: "am_michael",
  heart: "af_heart",
  bella: "af_bella",
  nicole: "af_nicole",
  sarah: "af_sarah",
  adam: "am_adam",
  eric: "am_eric",
  liam: "am_liam",
};

// MCP servers the backend can run on demand. Each entry gets its own switch
// in the UI; /api/chat carries the enabled set as `mcp: { id: true }` (a bare
// `websearch` boolean from older clients is still accepted).
const mcpServers = [
  { id: "websearch", label: "Web search" },
  { id: "graph", label: "Knowledge graph" },
];

function normalizeMcpFlags(payload) {
  const flags = {};
  for (const server of mcpServers) flags[server.id] = false;
  if (payload && typeof payload.mcp === "object" && payload.mcp !== null) {
    for (const server of mcpServers) flags[server.id] = Boolean(payload.mcp[server.id]);
  } else if (payload && typeof payload.websearch === "boolean") {
    flags.websearch = payload.websearch;
  }
  return flags;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("Browser disconnected"));
  });
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = stripBasePath(url.pathname);

    if (req.method === "GET" && pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        requestId,
        uptimeSec: Math.round(process.uptime()),
        whisperEndpoints: config.whisperEndpoints.length,
        brainConfigured: isBrainConfigured(),
        ttsEndpoints: config.ttsEndpoints.length,
      });
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const payload = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "");
      const address = clientAddress(req);
      if (loginBlocked(address)) {
        return json(res, 429, { error: "too_many_attempts", requestId });
      }
      // The password is the username itself; compare it constant-time.
      // 403, not 401: the app sits behind the gateway's Basic Auth layer, and
      // any 401 that arrives on a request carrying those credentials makes the
      // browser treat them as rejected and clear its cached Basic
      // credentials — the next request then triggers a second Basic Auth
      // prompt. A bare 403 never does that.
      const user = canonicalUser(username);
      if (!user || !sameSecret(password, user)) {
        recordLoginFailure(address);
        return json(res, 403, { error: "forbidden", requestId });
      }
      loginAttempts.delete(address);
      issueSession(user, req, res);
      console.log(JSON.stringify({ level: "info", requestId, msg: "login_ok", user }));
      return json(res, 200, { user, requestId });
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      const user = sessionUser(req);
      endSession(req, res);
      return json(res, 200, { user: user || null, requestId });
    }

    // Every other /api route requires a session; the UI treats the 403 on
    // /api/config as "show the login form". 403 (not 401) for the same reason
    // as the login failure above: a 401 would make the browser drop its cached
    // gateway Basic Auth credentials and re-prompt on the next request.
    if (pathname.startsWith("/api/")) {
      const user = sessionUser(req);
      if (!user) return json(res, 403, { error: "forbidden", requestId });
      req.user = user;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      return json(res, 200, {
        user: req.user,
        wakePhrase: config.wakePhrase,
        silenceMs: config.silenceMs,
        whisperEndpoints: config.whisperEndpoints.map(redactUrl),
        whisperLanguage: config.whisperLanguage,
        whisperVadFilter: config.whisperVadFilter,
        brainBaseUrl: redactUrl(config.brainBaseUrl),
        brainModel: config.brainModel,
        brainConfigured: isBrainConfigured(),
        ttsEndpoints: config.ttsEndpoints.map(redactUrl),
        ttsConfigured: config.ttsEndpoints.length > 0,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        mcpServers: mcpServers.map(({ id, label }) => ({ id, label })),
        graphConfigured: isGraphConfigured(),
        // Lets the panel offer the Remove button on any entity in the admin's
        // global view (a regular user may only remove their own — which is
        // exactly the owner of every entity in their view anyway).
        admin: isAdmin(req.user),
      });
    }

    // Per-user isolation: every graph endpoint is scoped to the signed-in
    // user's world (their node, the entities they own, and the fact edges
    // between them — ownership bounds the world, there is no shared tier).
    // The store builds the queries; a foreign `center` elementId simply
    // comes back empty. The ONE exception is the admin session (`admin` is
    // derived from the signed-in user, never from the query): its view is the
    // whole graph — every user's nodes, entities and facts.
    if (req.method === "GET" && pathname === "/api/graph/status") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      try {
        return json(res, 200, { requestId, ...(await graphStore.status({ user: req.user, admin: isAdmin(req.user) })) });
      } catch (error) {
        return json(res, 502, { error: "graph_unavailable", message: error.message, requestId });
      }
    }

    if (req.method === "GET" && pathname === "/api/graph/subgraph") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      const center = String(url.searchParams.get("center") || "").slice(0, 128) || null;
      try {
        return json(res, 200, { requestId, ...(await graphStore.subgraph({ user: req.user, limit: Number(url.searchParams.get("limit")) || 60, center, admin: isAdmin(req.user) })) });
      } catch (error) {
        return json(res, 502, { error: "graph_unavailable", message: error.message, requestId });
      }
    }

    // The one explicit delete path: the signed-in user removes one of their
    // OWN entities (the store pins the query to owner = session user, so a
    // foreign id 404s exactly like a nonexistent one). The admin session may
    // delete any entity. The brain's MCP server has no write or delete tool
    // at all — this endpoint is only reachable as a deliberate UI action.
    if (req.method === "DELETE" && pathname === "/api/graph/entity") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      const id = String(url.searchParams.get("id") || "").slice(0, 128);
      if (!id) return json(res, 400, { error: "missing_id", requestId });
      try {
        const result = await graphStore.removeEntity({ user: req.user, id, admin: isAdmin(req.user) });
        if (!result.deleted) return json(res, 404, { error: "entity_not_found", requestId });
        recordGraphActivity({ kind: "delete", user: req.user, name: result.name });
        return json(res, 200, { requestId, ...result });
      } catch (error) {
        return json(res, 502, { error: "graph_unavailable", message: error.message, requestId });
      }
    }

    if (req.method === "GET" && pathname === "/api/graph/schema") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      try {
        return json(res, 200, { requestId, ...(await graphStore.schema()) });
      } catch (error) {
        return json(res, 502, { error: "graph_unavailable", message: error.message, requestId });
      }
    }

    // Only this user's own activity — another user's stored turns or brain
    // queries are their personal data, not something to display here. The
    // admin session sees the whole feed (every user's reads and ingests).
    if (req.method === "GET" && pathname === "/api/graph/activity") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      const entries = isAdmin(req.user) ? graphActivity : graphActivity.filter((entry) => entry.user === req.user);
      return json(res, 200, { requestId, entries: entries.slice(-30).reverse() });
    }

    if (req.method === "POST" && pathname === "/api/transcribe") {
      const body = await readBody(req, 25 * 1024 * 1024);
      if (!body.length) return json(res, 400, { error: "empty_audio", requestId });
      // The UI language switch sends the spoken language per request; the
      // configured WHISPER_LANGUAGE stays the default for other clients.
      const language = normalizeLanguage(url.searchParams.get("language")) || config.whisperLanguage;
      const result = await transcribeWithFailover(body, req.headers["content-type"] || "audio/webm", language, requestId, controller.signal);
      return json(res, result.error ? 502 : 200, result);
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const payload = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
      const prompt = String(payload.prompt || "").trim();
      if (!prompt) return json(res, 400, { error: "missing_prompt", requestId });
      // The prompt history is keyed by the authenticated user, not by a
      // client-chosen id: every tab of Mila shares Mila's cache and no
      // other user can read or write it.
      const result = await chat(prompt, req.user, normalizeLanguage(payload.language) || "en", requestId, controller.signal, normalizeMcpFlags(payload),
        String(payload.wakePhrase || "").slice(0, 60));
      return json(res, 200, result);
    }

    if (req.method === "POST" && pathname === "/api/speak") {
      const payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
      const text = String(payload.text || "").trim().slice(0, 2000);
      const speed = clampSpeed(payload.speed);
      const profile = String(payload.profile || "default").slice(0, 32);
      if (!text) return json(res, 400, { error: "missing_text", requestId });
      if (!config.ttsEndpoints.length) return json(res, 503, { error: "tts_not_configured", requestId });
      // The self-hosted TTS engine (Kokoro) is English-only; German answers
      // are spoken by the browser voice, so reject instead of mispronouncing.
      if (normalizeLanguage(payload.language) !== "" && normalizeLanguage(payload.language) !== "en") {
        return json(res, 503, { error: "tts_language_unsupported", language: normalizeLanguage(payload.language), requestId });
      }
      return synthesizeWithFailover(text, speed, profileVoices[profile] || config.ttsVoice, profile, requestId, res, controller.signal);
    }

    if (req.method === "GET") {
      return serveStatic(pathname, res);
    }

    json(res, 405, { error: "method_not_allowed", requestId });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", requestId, msg: error.message, stack: error.stack }));
    if (!res.destroyed) json(res, 500, { error: "server_error", message: error.message, requestId });
  } finally {
    console.log(JSON.stringify({ level: "info", requestId, method: req.method, url: req.url, ms: Date.now() - started }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Jarvis listening on 0.0.0.0:${server.address().port}`);
});

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeBasePath(value) {
  const pathValue = `/${String(value || "/").replace(/^\/+|\/+$/g, "")}`;
  return pathValue === "/" ? "/" : pathValue;
}

function stripBasePath(pathname) {
  if (config.publicBasePath === "/") return pathname;
  if (pathname === config.publicBasePath) return "/";
  if (pathname.startsWith(`${config.publicBasePath}/`)) return pathname.slice(config.publicBasePath.length);
  return pathname;
}

function isBrainConfigured() {
  return Boolean(config.brainBaseUrl && config.brainModel && !config.brainApiKey.includes("PUT-YOUR"));
}

function isGraphConfigured() {
  const graph = config.graph;
  return Boolean(graph.uri && graph.readUser && graph.readPassword && graph.writeUser && graph.writePassword);
}

// Knowledge graph store (null when unconfigured). GRAPH_MEMORY=1 swaps in the
// in-memory store with a small starter graph for tests and demos.
const graphStore = (() => {
  // The registered user list is part of the isolation rule: any entity or
  // relation endpoint named after a user resolves to that user's :User node,
  // never to an :Entity (see graphdb.upsertTurn).
  if (process.env.GRAPH_MEMORY === "1") return graphdb.createMemoryStore(config.users);
  if (!isGraphConfigured()) return null;
  try {
    return graphdb.createGraphStore({
      uri: config.graph.uri,
      database: config.graph.database,
      readUser: config.graph.readUser,
      readPassword: config.graph.readPassword,
      writeUser: config.graph.writeUser,
      writePassword: config.graph.writePassword,
      users: config.users,
    });
  } catch (error) {
    console.log(JSON.stringify({ level: "warn", msg: "graph_store_unavailable", error: error.message }));
    return null;
  }
})();

// Bounded ring of graph events (brain reads + ingested turns) for the panel's
// activity list.
const GRAPH_ACTIVITY_CAP = 50;
const graphActivity = [];

function recordGraphActivity(entry) {
  graphActivity.push({ at: new Date().toISOString(), ...entry });
  if (graphActivity.length > GRAPH_ACTIVITY_CAP) graphActivity.shift();
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return value ? "[configured]" : "";
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "forbidden" });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(res, 404, { error: "not_found" });
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("aborted", () => reject(new Error("Request upload aborted")));
    req.on("error", reject);
  });
}

async function transcribeWithFailover(audioBuffer, mimeType, language, requestId, signal) {
  if (!config.whisperEndpoints.length) throw new Error("No Whisper endpoints configured");
  const attempts = [];

  for (let i = 0; i < config.whisperEndpoints.length; i += 1) {
    const index = whisperCursor % config.whisperEndpoints.length;
    whisperCursor = (whisperCursor + 1) % config.whisperEndpoints.length;
    const endpoint = config.whisperEndpoints[index];
    const started = Date.now();
    try {
      console.log(JSON.stringify({ level: "info", requestId, msg: "whisper_attempt", endpoint: redactUrl(endpoint), bytes: audioBuffer.length, mimeType }));
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      form.append("file", blob, mimeType.startsWith("audio/wav") ? "jarvis-command.wav" : "jarvis-command.webm");
      form.append("model", config.whisperModel);
      form.append("language", language);
      form.append("response_format", "json");
      form.append("vad_filter", String(config.whisperVadFilter));
      form.append("temperature", "0");

      const headers = {};
      if (config.whisperApiKey) headers.authorization = `Bearer ${config.whisperApiKey}`;
      const response = await fetch(endpoint, {
        method: "POST", body: form, headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      const data = parseJsonOrText(text);
      const rawTranscript = extractTranscript(data);
      const transcript = isLikelyWhisperHallucination(rawTranscript) ? "" : rawTranscript;
      console.log(JSON.stringify({ level: "info", requestId, msg: transcript ? "whisper_success" : "whisper_no_speech", endpoint: redactUrl(endpoint), ms: Date.now() - started, transcriptChars: transcript.length }));
      return {
        requestId,
        text: transcript,
        noSpeech: !transcript,
        endpoint: redactUrl(endpoint),
        attempts: attempts.concat({ endpoint: redactUrl(endpoint), ok: true, ms: Date.now() - started }),
      };
    } catch (error) {
      console.log(JSON.stringify({ level: "warn", requestId, msg: "whisper_failure", endpoint: redactUrl(endpoint), ms: Date.now() - started, error: error.message }));
      attempts.push({ endpoint: redactUrl(endpoint), ok: false, ms: Date.now() - started, error: error.message });
      signal.throwIfAborted();
    }
  }

  return { requestId, text: "", error: "all_whisper_endpoints_failed", attempts };
}

function clampSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1;
}

// Only accept a two-letter ISO code; anything else falls back to the default.
function normalizeLanguage(value) {
  const language = String(value || "").trim().toLowerCase();
  return /^[a-z]{2}$/.test(language) ? language : "";
}

// Proxies an OpenAI-compatible /v1/audio/speech endpoint (Kokoro-FastAPI,
// openedai-speech, Piper wrappers) so the browser never holds the TTS key.
async function synthesizeWithFailover(text, speed, voice, profile, requestId, res, signal) {
  const attempts = [];

  for (let i = 0; i < config.ttsEndpoints.length; i += 1) {
    const index = ttsCursor % config.ttsEndpoints.length;
    ttsCursor = (ttsCursor + 1) % config.ttsEndpoints.length;
    const endpoint = config.ttsEndpoints[index];
    const started = Date.now();
    try {
      const headers = { "content-type": "application/json" };
      if (config.ttsApiKey) headers.authorization = `Bearer ${config.ttsApiKey}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.ttsModel,
          voice,
          input: text,
          response_format: "wav",
          speed,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length) throw new Error("empty audio response");
      console.log(JSON.stringify({ level: "info", requestId, msg: "tts_success", endpoint: redactUrl(endpoint), profile, speed, ms: Date.now() - started, bytes: audio.length }));
      res.writeHead(200, {
        "content-type": response.headers.get("content-type") || "audio/wav",
        "content-length": audio.length,
        "cache-control": "no-store",
        "x-request-id": requestId,
      });
      return res.end(audio);
    } catch (error) {
      console.log(JSON.stringify({ level: "warn", requestId, msg: "tts_failure", endpoint: redactUrl(endpoint), ms: Date.now() - started, error: error.message }));
      attempts.push({ endpoint: redactUrl(endpoint), ok: false, ms: Date.now() - started, error: error.message });
      signal.throwIfAborted();
    }
  }

  return json(res, 502, { error: "all_tts_endpoints_failed", requestId, attempts });
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractTranscript(data) {
  if (typeof data === "string") return data.trim();
  if (data && typeof data.text === "string") return data.text.trim();
  if (data && Array.isArray(data.segments)) return data.segments.map((segment) => segment.text || "").join(" ").trim();
  return "";
}

function isLikelyWhisperHallucination(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  const hallucinations = [
    "untertitelung des zdf",
    "untertitel der amara.org-community",
    "subtitles by the amara.org community",
    "thanks for watching",
  ];
  if (hallucinations.some((phrase) => normalized.includes(phrase))) return true;
  // large-v3 emits these for near-silence even with the VAD filter on. Treating
  // them as speech would send a phantom prompt to the brain.
  return ["thank you.", "thank you", "you", "bye.", "okay.", "."].includes(normalized);
}

// Minimal MCP client (JSON-RPC 2.0 over stdio, one child process reused
// across requests). The web-search tool is only used when the browser's
// MCP web-search toggle sends websearch: true with the /api/chat request.
class McpClient {
  constructor(command, args, extraEnv = {}) {
    this.command = command;
    this.args = args;
    this.extraEnv = extraEnv;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.startPromise = null;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const { spawn } = require("node:child_process");
      const fail = (error) => {
        this.startPromise = null;
        this.child = null;
        reject(error);
      };
      const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.extraEnv } });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.onData(chunk));
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log(JSON.stringify({ level: "warn", msg: "mcp_stderr", text }));
      });
      child.on("error", (error) => fail(error));
      child.on("exit", () => {
        this.child = null;
        this.startPromise = null;
        for (const entry of this.pending.values()) entry.reject(new Error("MCP server exited"));
        this.pending.clear();
      });
      this.child = child;
      this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "jarvis-backend", version: "1.0.0" },
      }).then((result) => {
        this.notify("notifications/initialized");
        resolve(result);
      }, fail);
    });
    return this.startPromise;
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = message.id !== undefined ? this.pending.get(message.id) : null;
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "MCP error"));
      else entry.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error("MCP server is not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  }

  async call(name, args, timeoutMs = 20000) {
    await this.start();
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }
}

// MCP_SEARCH_SCRIPT lets tests point the client at a mock server; production
// uses the real DuckDuckGo/Wikipedia search server.
const mcpWebSearch = new McpClient(process.execPath, [process.env.MCP_SEARCH_SCRIPT || path.join(__dirname, "mcp", "websearch.mjs")]);

// The knowledge-graph MCP server (our own, mcp/graph.mjs, stdio). It exposes
// four parameterized read tools and NO free-form Cypher: Neo4j Community has
// no RBAC, so a raw read tool would let the brain (or a prompt injection)
// reach every node — including other users' personal data. Instead each
// query is built inside the server, pinned to the signed-in user that this
// backend injects into the arguments of every call, over the read-only
// database user. MCP_GRAPH_SCRIPT lets tests point the client at a mock
// server, same pattern as MCP_SEARCH_SCRIPT.
const mcpGraph = new McpClient(
  process.execPath,
  [process.env.MCP_GRAPH_SCRIPT || path.join(__dirname, "mcp", "graph.mjs")],
  {
    NEO4J_URI: process.env.NEO4J_URI || "",
    NEO4J_DATABASE: process.env.NEO4J_DATABASE || "neo4j",
    NEO4J_READ_USER: process.env.NEO4J_READ_USER || "",
    NEO4J_READ_PASSWORD: process.env.NEO4J_READ_PASSWORD || "",
  },
);

// Runs the web_search tool of the MCP server and resolves with the result
// text; the caller treats a failure as "answer without search results".
async function webSearch(query, requestId, signal) {
  const started = Date.now();
  try {
    const result = await withAbort(mcpWebSearch.call("web_search", { query, max_results: 5 }, 20000), signal);
    const text = (result.content || []).map((item) => item.text || "").join("\n").trim();
    if (result.isError || !text) throw new Error(text || "web search returned no results");
    console.log(JSON.stringify({ level: "info", requestId, msg: "websearch_success", ms: Date.now() - started, chars: text.length }));
    return text;
  } catch (error) {
    if (signal.aborted) throw error;
    console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_failure", ms: Date.now() - started, error: error.message }));
    throw error;
  }
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", cancel); resolve(value); },
      (error) => { signal.removeEventListener("abort", cancel); reject(error); },
    );
  });
}

async function chat(prompt, user, language, requestId, signal, mcpFlags, wakePhrase) {
  if (!isBrainConfigured()) {
    throw new Error("Brain endpoint/model is not configured");
  }

  const history = conversations.get(user) || [];
  const now = new Date();
  // The override wins over a hardcoded answer language in BRAIN_SYSTEM_PROMPT,
  // which is how the UI language switch reaches the brain.
  const answerLanguage = language === "de" ? "German (Deutsch)" : "English";
  // The wake word is how the user calls the assistant, so the brain answers as
  // the wake word's name (the phrase without the leading "Hey/Hi/Hallo"
  // filler) — "Hey Rocky" -> Rocky, "Kaya" -> Kaya — instead of a fixed name.
  const wakeName = wakeNameFromPhrase(wakePhrase);
  // Fresh per request: search results are context for this prompt only and are
  // never stored in the per-session conversation history. One state line per
  // MCP server tells the brain which of the browser's MCP switches are on, so
  // it does not deny an enabled feature or claim results for a disabled one.
  let searchMessage = null;
  const mcpStates = [];
  if (mcpFlags.websearch) {
    try {
      const results = await webSearch(prompt, requestId, signal);
      searchMessage = {
        role: "system",
        content: `Web search results for this prompt (use them if relevant, keep the answer short and spoken):\n${results}`,
      };
      mcpStates.push("Web search (MCP web-search server) is ON: the web was just searched for this prompt and the results are in a separate message; use them when relevant. You can also call the tools web_search (your own query) and web_news (latest news for a topic or an interest area: technik, it, finance, geek, nerd). For 'latest news' questions — including about the user's interests and their stored topics (the WATCHES facts from the knowledge graph, e.g. a trading news list the user asked to track, or the members of one of the user's named list entities via its PART_OF edges) — call web_news with the concrete topic, one interest at a time. If the user asks whether you can search the web or whether your MCP web-search server is available, answer about this feature itself — it is enabled — not from the search results.");
    } catch (error) {
      if (signal.aborted) throw error;
      console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_skipped", error: error.message }));
      mcpStates.push("Web search (MCP web-search server) is ON, but the search for this prompt returned no results; answer from your own knowledge and do not mention the search.");
    }
  } else {
    mcpStates.push("Web search (MCP web-search server) is OFF in the user's browser for this request, so no web results are available. For questions that need live or current data (the weather now, news, prices, sports scores, today's events), say you cannot check it while web search is off and that the user can enable it with the MCP web search toggle in the UI to let you look it up. If the user asks about web search or MCP, say it is switched off and can be enabled with the MCP search toggle in the UI.");
  }
  let graphMessage = null;
  if (mcpFlags.graph) {
    if (graphStore) {
      try {
        const context = await withAbort(graphStore.readContext(user), signal);
        const graphText = graphdb.formatGraphContext(context);
        if (graphText) graphMessage = { role: "system", content: graphText };
        if (isAdmin(user)) {
          // The admin session is the one place allowed to see every user's
          // data: the tools run across all owners, so the privacy line above
          // (which would contradict that) is NOT added here.
          mcpStates.push("The knowledge graph (MCP graph server) is ON and you are the administrator of it: the four read-only tools show you ALL users' data — get-schema (labels, relation types, property keys), get-entity(name) (every owner's copy of an entity, its data and its links), list-my-knowledge (every user's stored entities, grouped per user) and list-my-facts(about?, relation?) (every user's stored facts — likes, ownership, family, home, work, watched topics). When asked what is stored about the graph or about any user, answer from these tools and attribute each item to its user (e.g. 'Mila: likes Lego; Roman: no stored facts'). Seeing other users' data is allowed in this admin session only — never present another user's data as the admin's own, and do not guess. The graph is updated automatically after every answer from the conversation, so save/remember/track requests are stored (as WATCHES and PART_OF facts, a named list as its own entity — for the signed-in user) after your answer — confirm that instead of claiming you cannot write.");
        } else {
          mcpStates.push(graphText
            ? "The knowledge graph (MCP graph server) is ON: this user's own stored knowledge is in a separate message, and you can call four read-only tools about the graph: get-schema (labels, relation types, property keys), get-entity(name) (one of this user's own entities, its data and its links), list-my-knowledge (the entities this user has told you about) and list-my-facts(about?, relation?) (the facts stored about this user — likes, ownership, family, home, work, watched topics). If the user asks what you remember or know about them, answer from the graph context, these tools and the conversation history. Privacy: the graph is this user's private world — every stored entity belongs to the signed-in user, and you can only see data that belongs to the signed-in user, never another user's data; there is no shared or public tier. If asked about another user's preferences, habits or facts, say you have no stored information about them. When describing what the graph does or does not contain, always phrase it from this user's view (e.g. 'I have no record of you liking X' or 'I have no stored information about other users'), never as a global claim about the whole graph (never 'no one likes X' or 'no one is connected to X'). Do not guess. Your graph tools are read-only, but the graph is updated automatically after every answer from the conversation — so when the user asks you to save, remember or track topics or assign them to a named list (e.g. 'add X to my trading news list' or 'assign X to my TradingMonitor list'), confirm that it is done instead of claiming you cannot write; the topics are stored (as WATCHES and PART_OF facts, a named list as its own entity) and visible in the graph context and the list-my-facts tool from the next turn on."
            : "The knowledge graph (MCP graph server) is ON but holds nothing for this user yet; you can still inspect the graph with the get-schema, get-entity, list-my-knowledge and list-my-facts tools. New facts are stored automatically after every answer — so when the user asks you to save, remember or track topics or assign them to a named list (e.g. 'add X to my trading news list' or 'assign X to my TradingMonitor list'), confirm that it is done instead of claiming you cannot write; the topics are stored (as WATCHES and PART_OF facts, a named list as its own entity) after your answer.");
        }
      } catch (error) {
        if (signal.aborted) throw error;
        console.log(JSON.stringify({ level: "warn", requestId, msg: "graph_context_failed", error: error.message }));
        mcpStates.push("The knowledge graph (MCP graph server) is ON, but the graph is currently unreachable; answer from your own knowledge and do not mention the graph.");
      }
    } else {
      mcpStates.push("The knowledge graph (MCP graph server) is ON in the user's browser but not configured on this server; do not claim graph access or stored memories.");
    }
  } else {
    mcpStates.push("The knowledge graph (MCP graph server) is OFF in the user's browser for this request: no graph context and no graph tools are available for this turn, so answer from the conversation history and your own knowledge. Facts from this conversation are still stored in the graph after the answer; the user can enable the MCP knowledge graph toggle to let you read them in future conversations.");
  }
  const messages = [
    {
      role: "system",
      content: `${config.brainSystemPrompt}\nYour name is ${wakeName} — the user calls you by your wake word, so use "${wakeName}" as your own name in your answers, for example when they ask who you are or address you by name.\nThe user is signed in as ${user}; their signed-in name is their first name, so address them by it in your answers.\n${mcpStates.join("\n")}\nLanguage override: answer in ${answerLanguage}.\nCurrent server time: ${now.toISOString()} (${now.toString()}). If the user asks for the time or date, answer from this timestamp. Answer directly; do not expose reasoning.`,
    },
    ...(searchMessage ? [searchMessage] : []),
    ...(graphMessage ? [graphMessage] : []),
    ...history,
    { role: "user", content: prompt },
  ];

  const headers = { "content-type": "application/json" };
  if (config.brainApiKey) headers.authorization = `Bearer ${config.brainApiKey}`;

  // One overall deadline, comfortably inside the browser's 60 s request
  // timeout: the brain may spend it on at most a few tool round-trips.
  const { data, webResults } = await runBrain({ messages, user, useTools: Boolean(mcpFlags.graph && graphStore), webTools: Boolean(mcpFlags.websearch), admin: isAdmin(user), lang: language === "de" ? "de" : "en", requestId, signal, headers,
    deadlineMs: 50000 });
  const answer = extractAnswer(data);
  if (!answer) {
    const finishReason = data?.choices?.[0]?.finish_reason || "";
    console.log(JSON.stringify({ level: "error", requestId, msg: "brain_empty_answer", finishReason, usage: data?.usage || {} }));
    throw new Error(finishReason === "length"
      ? "The brain spent its whole token budget on reasoning and returned no answer; ask again."
      : "Brain returned no answer text");
  }

  const nextHistory = history.concat({ role: "user", content: prompt }, { role: "assistant", content: answer }).slice(-10);
  conversations.set(user, nextHistory);
  // Store the turn in the knowledge graph after the answer is handed back:
  // fire-and-forget so the spoken reply is never blocked by or fails on the
  // graph. This is the app's only write path into the graph.
  if (graphStore) {
    // The extractor reads what the turn actually used: the up-front search
    // results plus any web tool results the brain gathered itself.
    ingestTurn({ user, prompt, searchResults: [searchMessage?.content, ...webResults].filter(Boolean).join("\n\n") || null, answer, requestId }).catch(() => {});
  }
  return { requestId, answer, configured: true, model: config.brainModel };
}

// The graph tools offered to the brain when the knowledge graph toggle is on.
// Parameterized reads only — there is no Cypher on the surface: mcp/graph.mjs
// builds every query itself, pinned to the signed-in user (injected by this
// backend per call), so a chat turn can neither write to the graph nor reach
// another user's data. For the admin session the same four tool names run
// across all owners (the backend injects `admin: true` per call — never the
// brain), and the descriptions say so.
// Five rounds: a schema call plus a few follow-ups is the common pattern.
const GRAPH_TOOL_ROUNDS = 5;
const GRAPH_TOOL_TIMEOUT_MS = 15000;
const GRAPH_TOOL_NAMES = new Set(["get-schema", "get-entity", "list-my-knowledge", "list-my-facts"]);
function graphTools(admin) {
  return [
    {
      type: "function",
      function: {
        name: "get-schema",
        description: "Inspect the knowledge graph schema: node labels, relationship types and property keys.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get-entity",
        description: admin
          ? "Look up an entity by name: every user's copy of it (one per owner), its data and its links. Returns nothing if no user has such an entity."
          : "Look up one of the signed-in user's own entities (person, place, thing, ...) by name: its data and its links. Returns nothing if the user has no such entity.",
        parameters: { type: "object", properties: { name: { type: "string", description: "The entity name, e.g. 'Berlin'." } }, required: ["name"] },
      },
    },
    {
      type: "function",
      function: {
        name: "list-my-knowledge",
        description: admin
          ? "List every user's stored entities (all knowledge in the graph, grouped per user)."
          : "List the entities the signed-in user has told you about (their stored knowledge).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "list-my-facts",
        description: admin
          ? "List every user's stored facts (likes, ownership, family, home, work, ...), optionally filtered to one entity (about) or one relation type (relation, e.g. LIKES)."
          : "List the facts stored about the signed-in user (likes, ownership, family, home, work, ...), optionally filtered to one entity (about) or one relation type (relation, e.g. LIKES).",
        parameters: { type: "object", properties: { about: { type: "string", description: "Optional: only facts about this entity name." }, relation: { type: "string", description: "Optional: only this relation type, e.g. LIKES." } } },
      },
    },
  ];
}

// The web tools offered to the brain when the web-search toggle is on. Both
// are read-only live lookups (mcp/websearch.mjs runs free keyless engines and
// news sources); `lang` is injected per call by this backend — like the graph
// user — so the brain (or a prompt injection) cannot steer the locale.
const WEB_TOOL_NAMES = new Set(["web_search", "web_news"]);
const WEB_TOOL_TIMEOUT_MS = 20000;
function webTools() {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web (Bing, Wikipedia, DuckDuckGo) with your own query. Use for concrete questions or current information the injected search results do not cover.",
        parameters: { type: "object", properties: { query: { type: "string", description: "The search query, in a few words." }, max_results: { type: "number", description: "Optional maximum number of results (default 5, max 10)." } }, required: ["query"] },
      },
    },
    {
      type: "function",
      function: {
        name: "web_news",
        description: "Fetch the latest news (past 7 days) from free news sources (Google News, Bing News, heise, Golem, Ars Technica, The Verge, TechCrunch, CNBC, MarketWatch, Financial Times, Hacker News, Lobsters, r/programming). Use whenever the user asks for news or the latest developments: with a concrete topic (e.g. one of their interests from the knowledge graph or the conversation) or an interest area — technik, it, finance, geek, nerd.",
        parameters: { type: "object", properties: { topic: { type: "string", description: "A concrete topic (e.g. 'Home Assistant') or an interest area: technik, it, finance, geek, nerd." }, max_results: { type: "number", description: "Optional maximum number of news items (default 8, max 15)." } }, required: ["topic"] },
      },
    },
  ];
}

// One short, loggable description of a tool call for the activity feed —
// never raw Cypher (there is none on the surface anymore).
function graphToolDetail(name, args) {
  const parts = [];
  if (args.name) parts.push(`name=${args.name}`);
  if (args.about) parts.push(`about=${args.about}`);
  if (args.relation) parts.push(`relation=${String(args.relation).toUpperCase()}`);
  return parts.length ? `${name}: ${parts.join(", ")}` : name;
}

async function runBrain({ messages, user, useTools, webTools: webToolsOn = false, admin = false, lang = "de", requestId, signal, headers, deadlineMs }) {
  const local = [...messages];
  const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
  // Web tool results collected for post-turn ingestion (the extractor reads
  // the search context the turn actually used), separate from the answer.
  const webResults = [];
  const hasTools = Boolean(useTools || webToolsOn);
  for (let round = 0; ; round += 1) {
    const body = {
      model: config.brainModel,
      messages: local,
      temperature: 0.2,
      // The brain is a reasoning model: max_tokens covers its thinking tokens
      // too, so an undersized budget is spent on reasoning and the reply comes
      // back with empty content (finish_reason "length"). 4096 leaves ~26 s of
      // budget at the measured ~150 tok/s while staying inside the timeout.
      max_tokens: 4096,
    };
    if (hasTools) body.tools = [...(useTools ? graphTools(admin) : []), ...(webToolsOn ? webTools() : [])];
    let data;
    try {
      const response = await fetch(`${config.brainBaseUrl}/chat/completions`, {
        method: "POST", signal: totalSignal, headers, body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Brain HTTP ${response.status}: ${text.slice(0, 500)}`);
      data = JSON.parse(text);
    } catch (error) {
      if (totalSignal.aborted && !signal.aborted) throw new Error(`Brain timed out after ${deadlineMs} ms`);
      throw error;
    }
    const message = data?.choices?.[0]?.message;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!hasTools || !toolCalls.length) return { data, webResults };
    if (round >= GRAPH_TOOL_ROUNDS) {
      // Tool budget spent: force a final answer without tools.
      local.push({ ...message, role: "assistant" }, { role: "system", content: "Tool budget reached. Answer now from what you have gathered." });
      const fallback = await fetch(`${config.brainBaseUrl}/chat/completions`, {
        method: "POST", signal: totalSignal, headers,
        body: JSON.stringify({ model: config.brainModel, messages: local, temperature: 0.2, max_tokens: 4096 }),
      });
      const fallbackText = await fallback.text();
      if (!fallback.ok) throw new Error(`Brain HTTP ${fallback.status}: ${fallbackText.slice(0, 500)}`);
      return { data: JSON.parse(fallbackText), webResults };
    }
    local.push({ ...message, role: "assistant" });
    for (const call of toolCalls) {
      const name = String(call.function?.name || "");
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* malformed args -> error result below */ }
      const started = Date.now();
      if (useTools && GRAPH_TOOL_NAMES.has(name)) {
        // The session user (and the admin flag) are injected HERE, not in
        // the brain's tool schema: the brain (or a prompt injection riding on
        // it) can only ever target the signed-in user's own data — and the
        // cross-owner admin queries are reachable only for the admin session.
        try {
          const result = await withAbort(mcpGraph.call(name, { ...args, user, admin }, GRAPH_TOOL_TIMEOUT_MS), totalSignal);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          recordGraphActivity({ kind: "brain_query", user, tool: name, detail: graphToolDetail(name, args).slice(0, 200), ok: !result.isError, error: result.isError ? resultText.slice(0, 200) : undefined, ms: Date.now() - started });
          local.push({ role: "tool", tool_call_id: call.id, content: resultText || "No result." });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          recordGraphActivity({ kind: "brain_query", user, tool: name, detail: graphToolDetail(name, args).slice(0, 200), ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started });
          local.push({ role: "tool", tool_call_id: call.id, content: `Graph lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else if (webToolsOn && WEB_TOOL_NAMES.has(name)) {
        // The answer language is injected HERE (like the graph user): the
        // brain's web tool schema has no lang parameter.
        try {
          const result = await withAbort(mcpWebSearch.call(name, { ...args, lang }, WEB_TOOL_TIMEOUT_MS), totalSignal);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          console.log(JSON.stringify({ level: "info", requestId, msg: "websearch_tool", tool: name, detail: (name === "web_news" ? args.topic : args.query) || "", ok: !result.isError, ms: Date.now() - started, chars: resultText.length }));
          if (!result.isError) webResults.push(`${name} (${name === "web_news" ? args.topic : args.query}):\n${resultText}`);
          local.push({ role: "tool", tool_call_id: call.id, content: resultText || "No result." });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_tool", tool: name, ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started }));
          local.push({ role: "tool", tool_call_id: call.id, content: `Web lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else {
        if (useTools) recordGraphActivity({ kind: "brain_query", user, tool: name, ok: false, error: "unknown tool", ms: 0 });
        const available = [
          ...(useTools ? ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts"] : []),
          ...(webToolsOn ? ["web_search", "web_news"] : []),
        ];
        local.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool. Use: ${available.join(", ")}.` });
      }
    }
  }
}

// --- Knowledge graph ingestion (the only write path) -------------------------

const EXTRACT_SYSTEM_PROMPT = `You extract knowledge-graph entities from a voice-assistant conversation turn.
Return ONLY a JSON object, no prose, with this exact shape:
{"entities":[{"name":"...","type":"person|place|organization|event|topic|thing","props":{"key":"value"}}],"relations":[{"from":"EntityName","to":"EntityName","type":"RELATION_TYPE","negative":false}]}
Rules:
- Extract from the prompt, the web search results and the answer together.
- "name" is a short canonical name (e.g. "Mila", "Berlin", "Kokoro-82M"), at most a few words.
- type must be exactly one of: person, place, organization, event, topic, thing.
- The graph is the signed-in user's private world: every extracted entity is stored under their name, so no shared/public flag exists and nothing you extract is visible to any other user.
- Always include the signed-in user (the name on the "user:" line) as a person entity with their exact name.
- First-person statements in the prompt are facts to store, never skip them: "I like X" -> LIKES, "I'm interested in X" -> INTERESTED_IN, "I own X" or "I have X" -> OWNS, "I live in X" -> LIVES_IN, "I work at X" -> WORKS_AT, "my friend/mother/family is Y" -> FRIEND_OF/FAMILY_OF, always with "from" set to the user's entity name.
- Instructions to save, remember, track or add topics are facts to store just like statements: "add X, Y to my (trading news) list", "remember these keywords/topics: X, Y", "track/watch X for me" -> a WATCHES relation from the user to each listed topic (topics of type topic or thing, persons stay person, companies organization), with "from" set to the user's entity name. Store them even though the prompt is an instruction rather than a statement (including when the answer only confirms it, e.g. "noted, I will remember these").
- Example: user "Roman", prompt "Add Trump, Gold, Nvidia to my trading news list." ->
  {"entities":[{"name":"Roman","type":"person"},{"name":"Trump","type":"person"},{"name":"Gold","type":"topic"},{"name":"Nvidia","type":"organization"}],"relations":[{"from":"Roman","to":"Trump","type":"WATCHES","negative":false},{"from":"Roman","to":"Gold","type":"WATCHES","negative":false},{"from":"Roman","to":"Nvidia","type":"WATCHES","negative":false}]}
- Named lists the user maintains ("my TradingMonitor List", "my news list", "my reading list") are stored as thing entities with the exact name the user gave the list: "assign/add/move X (and Y) to my L" -> the list entity L (type thing), a PART_OF relation from each listed topic to L, and a WATCHES relation from the user to each listed topic (the upsert is idempotent — a repeated mention just reconfirms it). The list entity must appear in "entities" even when it was only mentioned in this turn.
- Example: user "Roman", prompt "Assign Trump to my TradingMonitor List." ->
  {"entities":[{"name":"Roman","type":"person"},{"name":"Trump","type":"person"},{"name":"TradingMonitor List","type":"thing"}],"relations":[{"from":"Roman","to":"Trump","type":"WATCHES","negative":false},{"from":"Trump","to":"TradingMonitor List","type":"PART_OF","negative":false}]}
- Negation is the "negative" flag, never a new relation type: "I don't like X" / "I no longer own X" -> the same type with "negative": true (e.g. LIKES + negative). A negative statement overwrites an earlier positive one about the same pair; do not emit both.
- Example: user "Mila", prompt "I like Lego." ->
  {"entities":[{"name":"Mila","type":"person"},{"name":"Lego","type":"thing"}],"relations":[{"from":"Mila","to":"Lego","type":"LIKES","negative":false}]}
- Example: user "Mila", prompt "I don't like Lego anymore." ->
  {"entities":[{"name":"Mila","type":"person"},{"name":"Lego","type":"thing"}],"relations":[{"from":"Mila","to":"Lego","type":"LIKES","negative":true}]}
- Example: user "Roman", prompt "I'm interested in Home Assistant." ->
  {"entities":[{"name":"Roman","type":"person"},{"name":"Home Assistant","type":"thing"}],"relations":[{"from":"Roman","to":"Home Assistant","type":"INTERESTED_IN","negative":false}]}
- relations use UPPERCASE_SNAKE_CASE types. Prefer the existing types: WORKS_AT, LIVES_IN, STUDIES_AT, BORN_IN, FRIEND_OF, FAMILY_OF, PART_OF, LOCATED_IN, RELATED_TO, MENTIONED_IN, LIKES, WENT_TO, OWNS, USES, INTERESTED_IN, WATCHES. If a fact is a genuine relation none of these expresses (interest, plans, goals, ...), introduce a precise new type of at most 3 words (e.g. "I'm interested in X" -> INTERESTED_IN): the graph creates it automatically. Never introduce a type that only paraphrases an existing one (liking, preference and taste stay LIKES; "interested in" is NOT liking) — and never for negation, which is the "negative" flag. "from" and "to" must be entity names from your entities list.
- At most 12 entities and 15 relations. Prefer a few high-confidence facts over many guesses; return {"entities":[],"relations":[]} only for turns that carry no facts at all (e.g. "thanks").`;

// Runs after a finished turn: one cheap structured LLM call over the prompt,
// the search results (if any) and the answer, then an idempotent MERGE upsert
// with the write-only DB user. Never blocks or fails the user's reply.
async function ingestTurn({ user, prompt, searchResults, answer, requestId }) {
  const started = Date.now();
  const headers = { "content-type": "application/json" };
  if (config.brainApiKey) headers.authorization = `Bearer ${config.brainApiKey}`;
  try {
    const response = await fetch(`${config.brainBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      // 45 s, like the brain's own deadline: a full 4096-token budget can be
      // ~27 s of pure reasoning at the measured ~150 tok/s, so the old 30 s
      // abort would race the extraction.
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: config.brainModel,
        temperature: 0,
        // The brain is a reasoning model: max_tokens covers its thinking
        // tokens too. 1200 left no budget for the JSON reply — live turns
        // came back with content: null (finish_reason "length") and the
        // extraction silently stored nothing (every turn graph_ingest_empty
        // from 2026-10-05 21:35Z on). Same fix as the chat path.
        max_tokens: 4096,
        messages: [
          { role: "system", content: EXTRACT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `user: ${user}\nprompt: ${String(prompt).slice(0, 2000)}\nweb_search_results:\n${String(searchResults || "(none)").slice(0, 6000)}\nanswer: ${String(answer).slice(0, 2000)}`,
          },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Brain HTTP ${response.status}: ${text.slice(0, 300)}`);
    const extraction = graphdb.parseExtraction(extractAnswer(JSON.parse(text)) || text);
    if (!extraction.entities.length && !extraction.relations.length) {
      console.log(JSON.stringify({ level: "info", requestId, msg: "graph_ingest_empty", ms: Date.now() - started, raw: text.slice(0, 300) }));
      return;
    }
    const { upserted, relations: linked } = await graphStore.upsertTurn({ user, ...extraction });
    // Report what was actually written, not what the extractor emitted: an
    // entity named after a registered user is stored as that user's account
    // node, never as an :Entity, so "extracted" can exceed "stored".
    const skippedUsers = extraction.entities.length - upserted;
    recordGraphActivity({ kind: "ingest", user, entities: upserted, relations: linked, skippedUsers });
    console.log(JSON.stringify({ level: "info", requestId, msg: "graph_ingest_success", ms: Date.now() - started, extracted: extraction.entities.length, stored: upserted, extractedRelations: extraction.relations.length, linked, skippedUsers }));
  } catch (error) {
    console.log(JSON.stringify({ level: "warn", requestId, msg: "graph_ingest_failure", ms: Date.now() - started, error: error.message }));
  }
}

// The wake word's name: the last word of the phrase after dropping a leading
// "Hey/Hi/Hallo" filler, capitalized ("Hey Rocky" -> "Rocky", "Kaya" ->
// "Kaya"). The app name is the fallback for browsers that send no phrase.
function wakeNameFromPhrase(phrase) {
  const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && /^(hey|hi|hallo|yo|o)$/i.test(words[0])) words.shift();
  const name = words[words.length - 1] || "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Jarvis";
}

function extractAnswer(data) {
  const message = data?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}
