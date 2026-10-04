const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
      });
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
  constructor(command, args) {
    this.command = command;
    this.args = args;
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
      const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
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
      mcpStates.push("Web search (MCP web-search server) is ON: the web was just searched for this prompt and the results are in a separate message; use them when relevant. If the user asks whether you can search the web or whether your MCP web-search server is available, answer about this feature itself — it is enabled — not from the search results.");
    } catch (error) {
      if (signal.aborted) throw error;
      console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_skipped", error: error.message }));
      mcpStates.push("Web search (MCP web-search server) is ON, but the search for this prompt returned no results; answer from your own knowledge and do not mention the search.");
    }
  } else {
    mcpStates.push("Web search (MCP web-search server) is OFF in the user's browser for this request, so no web results are available. For questions that need live or current data (the weather now, news, prices, sports scores, today's events), say you cannot check it while web search is off and that the user can enable it with the MCP web search toggle in the UI to let you look it up. If the user asks about web search or MCP, say it is switched off and can be enabled with the MCP search toggle in the UI.");
  }
  const messages = [
    {
      role: "system",
      content: `${config.brainSystemPrompt}\nYour name is ${wakeName} — the user calls you by your wake word, so use "${wakeName}" as your own name in your answers, for example when they ask who you are or address you by name.\nThe user is signed in as ${user}; their signed-in name is their first name, so address them by it in your answers.\n${mcpStates.join("\n")}\nLanguage override: answer in ${answerLanguage}.\nCurrent server time: ${now.toISOString()} (${now.toString()}). If the user asks for the time or date, answer from this timestamp. Answer directly; do not expose reasoning.`,
    },
    ...(searchMessage ? [searchMessage] : []),
    ...history,
    { role: "user", content: prompt },
  ];

  const headers = { "content-type": "application/json" };
  if (config.brainApiKey) headers.authorization = `Bearer ${config.brainApiKey}`;

  const response = await fetch(`${config.brainBaseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    headers,
    body: JSON.stringify({
      model: config.brainModel,
      messages,
      temperature: 0.2,
      // The brain is a reasoning model: max_tokens covers its thinking tokens
      // too, so an undersized budget is spent on reasoning and the reply comes
      // back with empty content (finish_reason "length"). 4096 leaves ~26 s of
      // budget at the measured ~150 tok/s while staying inside the 45 s timeout.
      max_tokens: 4096,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Brain HTTP ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
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
  return { requestId, answer, configured: true, model: config.brainModel };
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
