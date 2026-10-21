const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const graphdb = require("./graphdb");

const root = __dirname;
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8094);

const parsedUsers = parseUsers(process.env.USERS || "Mila,Roman,admin");

const config = {
  publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH || "/"),
  // Opt-in white-label theme for branded deployments (the a1-enterprise demo
  // on gpu-2 sets BRAND=a1). Unset/empty serves the app byte-identical to
  // the pve104 default: no theme stylesheet, no logo, same index.html.
  brand: (process.env.BRAND || "").trim().toLowerCase(),
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
  // The allowlist (BRAIN_PROFILES) restricts which profiles a deployment
  // advertises; the a1 demo on gpu-2 sets
  // BRAIN_PROFILES=a1-deepseek,a1-qwen so the private profiles (Claude Code,
  // OVHcloud, OpenRouter) are absent from /api/config entirely — no selector
  // entries, no advertised endpoints. Unset/empty (the pve104 default) builds
  // every profile. Unknown ids are ignored.
  brainProfileAllowlist: splitCsv(process.env.BRAIN_PROFILES || ""),
  brainProfileDefault: process.env.BRAIN_PROFILE_DEFAULT || "a1-deepseek",
  brainSystemPrompt: process.env.BRAIN_SYSTEM_PROMPT || "You are an old-school English butler in the manner of the classic British household: impeccable manners, a dry wit, a light sense of fun, and a fondness for a well-timed dash of black humor. Always remain polite and composed — the wit and dark comedy live in the delivery, never in the facts. You are a concise voice assistant: answer in English, be helpful, and keep spoken answers short.",
  // `??`, not `||`: an explicitly empty TTS_ENDPOINTS must disable self-hosted TTS
  // and leave HAL 9000 on its speechSynthesis fallback.
  ttsEndpoints: splitCsv(process.env.TTS_ENDPOINTS ?? "https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/speech"),
  ttsModel: process.env.TTS_MODEL || "speaches-ai/Kokoro-82M-v1.0-ONNX",
  ttsVoice: process.env.TTS_VOICE || "bm_george",
  ttsApiKey: process.env.TTS_API_KEY || "",
  // Multi-user login: comma-separated user entries. A bare name keeps the
  // legacy convention that the password is the name itself (Mila signs in
  // with "Mila"/"Mila", admin with "admin"/"admin"); "name:password" (split
  // on the first colon) stores an explicit, case-sensitive password for that
  // user — the gpu-2 single-admin deployment uses that form. The default
  // list includes the admin account so the default deployment's ADMIN_USERS
  // default ("admin") is a subset of USERS, as required below.
  users: parsedUsers.users,
  userPasswords: parsedUsers.passwords,
  // The admin session: signs in like any user (ADMIN_USERS must be a subset
  // of USERS) and sees every user's data — the panel shows the whole graph,
  // the brain's graph tools run across all owners, and the admin's session is
  // the only one whose brain gets the graph write/delete tools (store-entity,
  // store-fact, rename-entity, delete-entity). The flag is derived from the
  // session, never from the client.
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
config.aiProfiles = buildAiProfiles();
config.whisperProfiles = buildWhisperProfiles();

// --- Cost panel (OpenRouter credits + OVHcloud billing) ---------------------
// Mirrors the hub's Prometheus exporters (openrouter-exporter,
// ovhcloud-exporter): the backend polls the billing APIs itself and caches
// the results in memory — OpenRouter every 5 minutes, OVHcloud every hour —
// and GET /api/costs serves the cached view. Missing keys leave the section
// disabled and the panel hides it.
const COSTS = {
  openrouter: {
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
    baseUrl: trimSlash(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai"),
    apiKey: process.env.OPENROUTER_API_KEY || "",
    ttlMs: 5 * 60 * 1000,
  },
  ovhcloud: {
    enabled: Boolean(process.env.OVH_APP_KEY && process.env.OVH_APP_SECRET && process.env.OVH_CONSUMER_KEY),
    endpoint: trimSlash(process.env.OVH_ENDPOINT || "https://eu.api.ovh.com/1.0"),
    appKey: process.env.OVH_APP_KEY || "",
    appSecret: process.env.OVH_APP_SECRET || "",
    consumerKey: process.env.OVH_CONSUMER_KEY || "",
    project: process.env.OVH_CLOUD_PROJECT || "",
    numInvoices: Math.min(12, Math.max(1, Number(process.env.OVH_NUM_INVOICES || 6))),
    ttlMs: 60 * 60 * 1000,
  },
};
const costsCache = {
  openrouter: { at: 0, data: null, error: null, inflight: null },
  ovhcloud: { at: 0, data: null, error: null, inflight: null },
};

async function costsHttpGetJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenRouterCosts() {
  const key = { up: 0, error: null, balance: null, total_credits: null, used_lifetime: null, used_total: 0, used_monthly: 0, used_weekly: 0, used_daily: 0, limit: 0, limit_remaining: 0, is_free_tier: false, free_model_daily: { used: 0, limit: 0, remaining: 0 } };
  try {
    const keyData = (await costsHttpGetJson(`${COSTS.openrouter.baseUrl}/api/v1/key`, { authorization: `Bearer ${COSTS.openrouter.apiKey}` })).data || {};
    key.up = 1;
    key.used_total = keyData.usage || 0;
    key.used_monthly = keyData.usage_monthly || 0;
    key.used_weekly = keyData.usage_weekly || 0;
    key.used_daily = keyData.usage_daily || 0;
    key.limit = keyData.limit || 0;
    key.limit_remaining = keyData.limit_remaining || 0;
    key.is_free_tier = Boolean(keyData.is_free_tier);
    if (keyData.free_model_daily_requests) key.free_model_daily = keyData.free_model_daily_requests;
    const creditsData = (await costsHttpGetJson(`${COSTS.openrouter.baseUrl}/api/v1/credits`, { authorization: `Bearer ${COSTS.openrouter.apiKey}` })).data || {};
    key.total_credits = creditsData.total_credits || 0;
    key.used_lifetime = creditsData.total_usage || 0;
    key.balance = key.total_credits - key.used_lifetime;
  } catch (error) {
    key.up = 0;
    key.error = String(error.message || error);
  }
  return key;
}

async function fetchOvhcloudCosts() {
  const data = { up: 0, error: null, invoices: [], total_eur: 0, ai_current_month: null };
  try {
    const endpoint = COSTS.ovhcloud.endpoint;
    const timeDelta = Number(await costsHttpGetJson(`${endpoint}/auth/time`, {})) - Date.now() / 1000;
    const ovhGet = async (path) => {
      const url = `${endpoint}${path}`;
      const timestamp = String(Math.round(Date.now() / 1000 + timeDelta));
      const toSign = `${COSTS.ovhcloud.appSecret}+${COSTS.ovhcloud.consumerKey}+GET+${url}++${timestamp}`;
      const signature = "$1$" + crypto.createHash("sha1").update(toSign, "utf8").digest("hex");
      return costsHttpGetJson(url, {
        "X-Ovh-Application": COSTS.ovhcloud.appKey,
        "X-Ovh-Consumer": COSTS.ovhcloud.consumerKey,
        "X-Ovh-Signature": signature,
        "X-Ovh-Timestamp": timestamp,
      });
    };
    const billIds = await ovhGet("/me/bill");
    if (!Array.isArray(billIds)) throw new Error("/me/bill returned a non-list");
    for (const billId of billIds.slice(-COSTS.ovhcloud.numInvoices)) {
      const invoice = await ovhGet(`/me/bill/${billId}`);
      const date = String(invoice.date || "").slice(0, 10);
      const total = (invoice.priceWithTax || {}).value || 0;
      data.invoices.push({ bill_id: String(billId), date, month: date.slice(0, 7), category: invoice.category || "unknown", total_eur: total });
      data.total_eur += total;
    }
    data.up = 1;
    let project = COSTS.ovhcloud.project;
    if (!project) {
      const projects = await ovhGet("/cloud/project");
      if (Array.isArray(projects) && projects.length) {
        const first = projects[0];
        project = typeof first === "string" ? first : first.name || "";
      }
    }
    if (project) {
      const endpointNames = await ovhGet(`/cloud/project/${project}/ai/endpoint`);
      const nameBySlug = new Map((Array.isArray(endpointNames) ? endpointNames : []).filter((name) => typeof name === "string").map((name) => [name.toLowerCase().replace(/[^a-z0-9]/g, ""), name]));
      const usage = await ovhGet(`/cloud/project/${project}/usage/current`);
      const from = String((usage && usage.period && usage.period.from) || "").slice(0, 7);
      if (from) {
        const monthData = { month: from, input: 0, output: 0, cost_eur: 0, last_update: null };
        const parsed = Date.parse(String(usage.lastUpdate || "").replace(/Z$/, "+00:00"));
        if (!Number.isNaN(parsed)) monthData.last_update = parsed / 1000;
        for (const resourceUsage of usage.resourcesUsage || []) {
          if (resourceUsage.type !== "ai-endpoints") continue;
          for (const resource of resourceUsage.resources || []) {
            for (const component of resource.components || []) {
              const match = String(component.name || "").match(/^(.+)-(input|output)_tokens$/);
              if (!match) continue;
              if (match[2] === "input") monthData.input += Number((component.quantity || {}).value || 0);
              else monthData.output += Number((component.quantity || {}).value || 0);
              monthData.cost_eur += Number(component.totalPrice || 0);
              if (!monthData.model) monthData.model = nameBySlug.get(match[1].toLowerCase().replace(/[^a-z0-9]/g, "")) || match[1];
            }
          }
        }
        data.ai_current_month = monthData;
      }
    }
  } catch (error) {
    data.up = 0;
    data.error = String(error.message || error);
  }
  return data;
}

async function refreshCosts(name, force) {
  const entry = costsCache[name];
  const source = COSTS[name];
  // A good entry is served until its TTL expires — unless the caller forces a
  // fresh fetch (the cost panel's manual "Refresh" button, ?fresh=1) — and a
  // FAILED fetch does not pin the timestamp, so the next poll retries a
  // billing-API outage instead of caching the error for a whole TTL window.
  if (!force && entry.data && Date.now() - entry.at < source.ttlMs) return entry;
  if (!entry.inflight) {
    const fetcher = name === "openrouter" ? fetchOpenRouterCosts : fetchOvhcloudCosts;
    entry.inflight = fetcher().finally(() => { entry.inflight = null; });
  }
  const data = await entry.inflight;
  if (data.up) {
    entry.at = Date.now();
    entry.data = data;
    entry.error = null;
  } else {
    entry.error = data.error;
  }
  return entry;
}

let whisperCursor = 0;
let ttsCursor = 0;
// Per-user prompt history: authenticated username -> the last
// BRAIN_HISTORY_MESSAGES messages, warm for this process only. Each
// user's cache is fully isolated from every other user's.
const conversations = new Map();
// Per-user conversation log (the Prompt/Answer panels' scrollback), in
// SQLite so the history survives restarts and container rebuilds: the browser
// posts every finished turn (brain answers and butler closings alike), and
// GET /api/conversation serves the user's entries windowed to the last
// ?days=N days (default 24, clamped 1..365) — older entries stay stored, just
// out of the window. The db file path is CONVERSATION_DB_PATH (the deployment
// points it at a Docker volume); the default keeps a per-process file in the
// temp dir so a bare `node server.js` and the test backends (separate
// processes) never share state.
const CONVERSATION_DB_PATH = process.env.CONVERSATION_DB_PATH
  || path.join(os.tmpdir(), `jarvis-conversations-${process.pid}.db`);
const CONVERSATION_DEFAULT_DAYS = 24;
const CONVERSATION_MIN_DAYS = 1;
const CONVERSATION_MAX_DAYS = 365;

function openConversationDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      ts TEXT NOT NULL,
      prompt TEXT NOT NULL,
      answer TEXT NOT NULL,
      sources TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user_ts ON conversations (user, ts);
    -- One embedding per stored turn, for semantic search. Separate table so a
    -- model change is a DELETE here, never a migration of the conversation
    -- itself: the turns are the data, the vectors are a derived index.
    CREATE TABLE IF NOT EXISTS conversation_embeddings (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
    -- The per-user websearch source list (the Websearch sources panel): the
    -- built-in baseline (BUILTIN_WEB_SOURCES in mcp/engines.mjs) seeded per
    -- user, plus the user's own feeds. Built-in rows are toggleable, never
    -- deletable (builtin = 1); user rows are toggleable and deletable.
    CREATE TABLE IF NOT EXISTS websearch_sources (
      user TEXT NOT NULL,
      id TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user, id)
    );
  `);
  const hasSources = db.prepare("PRAGMA table_info(conversations)").all().some((column) => column.name === "sources");
  if (!hasSources) db.exec("ALTER TABLE conversations ADD COLUMN sources TEXT");
  return {
    db,
    insert: db.prepare("INSERT INTO conversations (user, ts, prompt, answer, sources) VALUES (@user, @ts, @prompt, @answer, @sources)"),
    selectWindow: db.prepare("SELECT ts, prompt, answer, sources FROM conversations WHERE user = @user AND ts >= @floor ORDER BY ts ASC, id ASC"),
    // The brain's short-term memory after a restart: the newest turns of this
    // user, newest first (the caller reverses them into chronological order).
    // Turns of this user that have no vector yet for the current model — the
    // backfill queue (existing rows, and any row whose embedding call failed).
    selectUnembedded: db.prepare(`SELECT c.id, c.prompt, c.answer FROM conversations c
      LEFT JOIN conversation_embeddings e ON e.conversation_id = c.id AND e.model = @model
      WHERE e.conversation_id IS NULL ORDER BY c.id DESC LIMIT @limit`),
    insertEmbedding: db.prepare(`INSERT INTO conversation_embeddings (conversation_id, model, dims, vec)
      VALUES (@id, @model, @dims, @vec)
      ON CONFLICT (conversation_id) DO UPDATE SET model = @model, dims = @dims, vec = @vec`),
    // Every embedded turn of ONE user, for the cosine scan. Pinned to the
    // signed-in user here, like search() below: the vectors are per-account
    // data, not a shared index.
    selectVectors: db.prepare(`SELECT c.id, c.ts, c.prompt, c.answer, e.vec FROM conversations c
      JOIN conversation_embeddings e ON e.conversation_id = c.id AND e.model = @model
      WHERE c.user = @user AND c.ts >= @floor`),
    countEmbedded: db.prepare(`SELECT COUNT(*) AS n FROM conversation_embeddings WHERE model = @model`),
    selectRecent: db.prepare("SELECT ts, prompt, answer, sources FROM conversations WHERE user = @user ORDER BY ts DESC, id DESC LIMIT @limit"),
    // Free-text search over this user's own stored turns, newest first. The
    // term list is variable, so the WHERE clause is built per call — the
    // terms themselves are always bound parameters, never interpolated, and
    // `user = @user` is prepended here rather than supplied by the caller, so
    // no query can reach another user's conversation.
    search(terms, { user, floor, limit }) {
       const conditions = terms.map((_, index) =>
         `(prompt LIKE @term${index} ESCAPE '\\' OR answer LIKE @term${index} ESCAPE '\\')`).join(" AND ");
       const params = { user, floor, limit };
       terms.forEach((term, index) => { params[`term${index}`] = `%${escapeLike(term)}%`; });
       return db.prepare(`SELECT id, ts, prompt, answer FROM conversations
         WHERE user = @user AND ts >= @floor AND ${conditions}
         ORDER BY ts DESC, id DESC LIMIT @limit`).all(params);
     },
     countWebsearchSources: db.prepare("SELECT COUNT(*) AS n FROM websearch_sources WHERE user = @user"),
     selectWebsearchSources: db.prepare(`SELECT id, source, url, kind, builtin, enabled FROM websearch_sources
       WHERE user = @user ORDER BY CASE kind WHEN 'engine' THEN 0 WHEN 'news' THEN 1 ELSE 2 END, id`),
     websearchSource: db.prepare("SELECT id, source, url, kind, builtin, enabled FROM websearch_sources WHERE user = @user AND id = @id"),
     seedWebsearchSource: db.prepare(`INSERT OR IGNORE INTO websearch_sources (user, id, source, url, kind, builtin, enabled)
       VALUES (@user, @id, @source, @url, @kind, 1, 1)`),
     addWebsearchSource: db.prepare(`INSERT INTO websearch_sources (user, id, source, url, kind, builtin, enabled)
       VALUES (@user, @id, @source, @url, 'feed', 0, 1)`),
     setWebsearchSourceEnabled: db.prepare("UPDATE websearch_sources SET enabled = @enabled WHERE user = @user AND id = @id"),
     deleteWebsearchSource: db.prepare("DELETE FROM websearch_sources WHERE user = @user AND id = @id AND builtin = 0"),
   };
 }

// `%`, `_` and the escape character itself are literals in a user's search
// term, not wildcards: a search for "100%" must not match everything.
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// The source attribution stored with a turn: short site/portal names (never
// raw URLs, never markup). The client sends back what the server put in the
// turn's sources; anything that is not a short string is dropped before it
// can reach the DB or another browser.
function conversationSourcesFromPayload(value) {
  if (!Array.isArray(value)) return null;
  const names = [...new Set(value.map((name) => String(name || "").trim()).filter((name) => name && name.length <= 64))].slice(0, 8);
  return names.length ? JSON.stringify(names) : null;
}

function conversationStoredSources(value) {
  if (!value) return null;
  try {
    const names = JSON.parse(value);
    if (!Array.isArray(names)) return null;
    const clean = names.map((name) => String(name || "")).filter(Boolean);
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

const conversationStore = openConversationDb(CONVERSATION_DB_PATH);

// --- Per-user websearch source list (the Websearch sources panel) ----------
//
// Every user's web_search/web_news calls run against their own list of
// sources, seeded with the built-in baseline from mcp/engines.mjs
// (BUILTIN_WEB_SOURCES: the search engines, the news-search sources and the
// curated interest feeds). Built-in rows can be switched off but never
// deleted; a user may add their own feed URLs (toggleable, deletable). The
// enabled rows are injected into every MCP call as `webSources` — the tool
// schema never exposes it, so the brain (or a prompt injection) cannot read
// or change the user's list. engines.mjs is ESM and this file is CJS on the
// node:20 runtime, so the baseline is loaded lazily through dynamic
// import() and cached in the promise.
let websearchBuiltinPromise = null;
function builtinWebSources() {
  if (!websearchBuiltinPromise) {
    websearchBuiltinPromise = import("./mcp/engines.mjs").then((module) => module.BUILTIN_WEB_SOURCES);
  }
  return websearchBuiltinPromise;
}

// Seed this user's list with the full built-in baseline on first use.
// Idempotent: a user whose rows already exist (even partially toggled) is
// left exactly as-is.
async function ensureWebsearchSourcesSeeded(user) {
  if (conversationStore.countWebsearchSources.get({ user }).n > 0) return;
  const builtin = await builtinWebSources();
  const insert = conversationStore.seedWebsearchSource;
  for (const entry of builtin) {
    insert.run({ user, id: entry.id, source: entry.source, url: entry.url || "", kind: entry.kind });
  }
}

// The signed-in user's enabled sources in the per-call shape the websearch
// MCP understands: built-in ids split by their tool (`engines` for
// web_search, `news` for web_news) plus the user's own feeds. An empty
// result is a real "nothing enabled" list — the tool answers
// "No results found." for it — never undefined.
async function websearchSourcesForUser(user) {
  await ensureWebsearchSourcesSeeded(user);
  const rows = conversationStore.selectWebsearchSources.all({ user });
  const list = { engines: [], news: [], feeds: [] };
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.kind === "engine") list.engines.push(row.id);
    else if (row.kind === "news") list.news.push(row.id);
    else list.feeds.push({ source: row.source, url: row.url });
  }
  return list;
}

// The user's full source list (enabled and disabled) for the panel.
async function websearchSourceRowsForUser(user) {
  await ensureWebsearchSourcesSeeded(user);
  return conversationStore.selectWebsearchSources.all({ user });
}

// --- Websearch source attribution ------------------------------------------
//
// The brain is instructed (see the websearch mcpStates entries below) to end
// an answer with a final "[sources: Name1, Name2]" line naming ONLY the
// sources whose information it actually used. The server parses that line
// after extractAnswer, validates every name against the sources that really
// ran (the pre-search result hosts, the tool results' source names and the
// user's source display names), drops anything the brain hallucinated, and
// strips the line from the answer before it is spoken, displayed, stored or
// graph-ingested. No line, or no valid name, means no websearch tag at all.
const WEB_ATTRIBUTION_INSTRUCTION = [
  "When you answer with information you got from the web_search or web_news tools, finish your",
  "answer with one final line: [sources: Name1, Name2] — a comma-separated list of the source",
  "names (as given in the tool results) whose information you actually used in your answer.",
  "List only the sources that are relevant to what you answered, and omit the line entirely when",
  "you did not use any web information.",
].join(" ");

// Case/whitespace/`www.`-insensitive name match for the attribution line.
function normalizeSourceName(name) {
  let value = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  value = value.replace(/^www\./, "").replace(/\.+$/, "");
  return value;
}

// Split a trailing "[sources: ...]" line off the answer. Returns
// { answer, names }: the answer without the line (whitespace-trimmed) and
// the raw comma-separated names (empty array when there is no line).
function splitAttribution(answer) {
  const match = /\r?\n*\[sources:\s*([^\]\r\n]+)\]\s*$/i.exec(String(answer || ""));
  if (!match) return { answer: String(answer || ""), names: [] };
  const clean = answer.slice(0, match.index).replace(/\s+$/, "");
  const names = match[1].split(",").map((name) => name.trim()).filter(Boolean);
  return { answer: clean, names };
}

// Upfront validation for user-added feeds, mirroring isSafeFetchUrl in
// mcp/engines.mjs (the second line, checked again at fetch time): http/https,
// no embedded credentials, default ports only, no private/internal IP
// literals. The engine module is ESM and node:20's CJS cannot require it, so
// the rules are duplicated here instead of imported.
function unsafeWebsearchSourceUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || "")); } catch { return "not a valid URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "only http/https URLs are allowed";
  if (parsed.username || parsed.password) return "URLs with embedded credentials are not allowed";
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return "only default ports 80/443 are allowed";
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if ((/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) && blockedWebsearchSourceIp(host)) {
    return "that address is on a private/internal network";
  }
  return null;
}

// The private/internal ranges of isBlockedIp in mcp/engines.mjs (IPv4
// literals and IPv6 literals; hostnames are DNS-resolved by the engine's
// fetch guard, not here).
function blockedWebsearchSourceIp(ip) {
  if (typeof ip !== "string" || !ip) return true;
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return blockedWebsearchSourceIp(mapped[1]);
    if (v6 === "::" || v6 === "::1") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local
    if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

// --- Semantic search over the stored conversation -------------------------
//
// Keyword search misses the thing the user actually wants: "where did I park
// my car" never matches a turn that only ever said "Tesla" or "Wagen". So each
// stored turn also gets an embedding, and search_history ranks by cosine
// similarity as well as by words.
//
// The endpoint is OpenAI-compatible (`POST /embeddings`). It defaults to the
// OVHcloud profile the brain already uses, so no new credential is needed;
// point EMBEDDING_* at any other server (a self-hosted llama.cpp or vLLM with
// an embedding model) to move it. Unset and unavailable are both fine: search
// degrades to keyword-only and says so.
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || process.env.BRAIN_OVHCLOUD_BASE_URL || "";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || process.env.BRAIN_OVHCLOUD_API_KEY || "";
// bge-m3: multilingual, so a German turn is found by an English query and the
// other way round — which this app needs, having a language switch. Measured
// on the fleet's endpoint: 1024 dims, ~0.3 s for a small batch.
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "bge-m3";
// Calibrated twice against the live endpoint. Full-sentence queries put
// related turns at 0.60-0.61 and unrelated at 0.37-0.49, which suggested
// 0.55 — but the brain does not send sentences, it sends short phrases, and
// those score lower: the real query "pet appetite problem" scored 0.535
// against the turn "the cat refuses to eat the new food" and was missed,
// while noise stayed at 0.37-0.38. Hence 0.50, measured from the queries the
// tool actually receives rather than from the ones a human would type.
const EMBEDDING_MIN_SCORE = Number(process.env.EMBEDDING_MIN_SCORE || 0.5);
// Above this a hit is a confident match; between the floor and this it is
// shown but flagged, so the brain can weigh a loose association instead of
// treating it as fact.
const EMBEDDING_STRONG_SCORE = 0.58;
const EMBEDDING_TIMEOUT_MS = 20000;
// One embedding covers a whole turn (prompt + answer); longer turns are cut,
// since the opening of a turn carries its topic.
const EMBEDDING_INPUT_CHARS = 2000;
const EMBEDDING_BATCH = 16;
const embeddingConfigured = Boolean(EMBEDDING_BASE_URL);

function embeddingText(prompt, answer) {
  return `${prompt}\n${answer}`.replace(/\s+/g, " ").trim().slice(0, EMBEDDING_INPUT_CHARS);
}

// Vectors are stored L2-normalised, so cosine similarity is a plain dot
// product at query time and the scan stays cheap.
function normalize(vector) {
  const vec = Float32Array.from(vector);
  let sum = 0;
  for (const value of vec) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= length;
  return vec;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

async function embed(inputs, signal) {
  if (!embeddingConfigured) throw new Error("No embedding endpoint configured");
  const headers = { "content-type": "application/json" };
  if (EMBEDDING_API_KEY) headers.authorization = `Bearer ${EMBEDDING_API_KEY}`;
  const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
    signal: signal || AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Embedding HTTP ${response.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const vectors = (data?.data || []).map((item) => item.embedding);
  if (vectors.length !== inputs.length) throw new Error(`Embedding returned ${vectors.length} vectors for ${inputs.length} inputs`);
  return vectors;
}

// Embeds stored turns that have no vector for the current model: the existing
// conversation on first start, plus anything a failed call left behind. One
// run at a time, bounded per call, never blocking a request.
let backfillRunning = false;
let backfillQueued = false;
async function backfillEmbeddings(maxBatches = 20) {
  if (!embeddingConfigured) return { embedded: 0 };
  // Coalesce instead of dropping: several turns stored in quick succession
  // used to hit this guard and get skipped, leaving them unembedded (and so
  // unfindable by meaning) until the next restart. Measured on the live
  // instance: 6 of 8 rapid writes had no vector.
  if (backfillRunning) { backfillQueued = true; return { embedded: 0, queued: true }; }
  backfillRunning = true;
  let embedded = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const rows = conversationStore.selectUnembedded.all({ model: EMBEDDING_MODEL, limit: EMBEDDING_BATCH });
      if (!rows.length) break;
      const vectors = await embed(rows.map((row) => embeddingText(row.prompt, row.answer)));
      const write = conversationStore.db.transaction(() => {
        rows.forEach((row, index) => {
          const vec = normalize(vectors[index]);
          conversationStore.insertEmbedding.run({ id: row.id, model: EMBEDDING_MODEL, dims: vec.length, vec: Buffer.from(vec.buffer) });
        });
      });
      write();
      embedded += rows.length;
    }
    if (embedded) console.log(JSON.stringify({ level: "info", msg: "embedding_backfill", model: EMBEDDING_MODEL, embedded }));
  } catch (error) {
    // Leaves the rows unembedded: the next insert or restart retries them,
    // and search stays keyword-only in the meantime.
    console.log(JSON.stringify({ level: "warn", msg: "embedding_backfill_failed", error: String(error.message || error).slice(0, 200), embedded }));
  } finally {
    backfillRunning = false;
    if (backfillQueued) {
      backfillQueued = false;
      setImmediate(() => { backfillEmbeddings().catch(() => {}); });
    }
  }
  return { embedded };
}

// Safety net for turns whose embedding call failed while the endpoint was
// down: without it they would wait for a restart. Unref'd so it never holds
// the process open.
const EMBEDDING_SWEEP_MS = 5 * 60 * 1000;
if (embeddingConfigured) {
  setInterval(() => { backfillEmbeddings().catch(() => {}); }, EMBEDDING_SWEEP_MS).unref();
}

// Cosine ranking over one user's embedded turns. Brute force on purpose: a
// user's conversation is thousands of rows at most, and 1024 floats each
// scans in milliseconds — a vector index would be machinery without a
// measured problem to solve.
async function semanticMatches(user, query, floor, limit, minScore = EMBEDDING_MIN_SCORE) {
  const rows = conversationStore.selectVectors.all({ user, floor, model: EMBEDDING_MODEL });
  if (!rows.length) return [];
  const [queryVector] = await embed([query]);
  const target = normalize(queryVector);
  return rows
    .map((row) => ({
      id: row.id, ts: row.ts, prompt: row.prompt, answer: row.answer,
      score: dot(target, new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4)),
    }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// The brain carries the last 10 messages (5 turns) in context. On a cold
// process that cache is empty, so rebuild it from the stored conversation;
// anything older than this window is reachable through the search_history
// tool rather than by growing the prompt.
const BRAIN_HISTORY_MESSAGES = 10;

function recentHistoryFromStore(user, turns = BRAIN_HISTORY_MESSAGES / 2) {
  try {
    const rows = conversationStore.selectRecent.all({ user, limit: Math.ceil(turns) });
    return rows.reverse().flatMap((row) => [
      { role: "user", content: row.prompt },
      { role: "assistant", content: row.answer },
    ]);
  } catch (error) {
    // Memory is a convenience; a failed read must not cost the user an answer.
    console.log(JSON.stringify({ level: "warn", msg: "history_seed_failed", error: String(error.message || error).slice(0, 200) }));
    return [];
  }
}

function conversationDaysFromUrl(reqUrl) {
  const raw = new URL(reqUrl, "http://localhost").searchParams.get("days");
  if (raw === null) return CONVERSATION_DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < CONVERSATION_MIN_DAYS || days > CONVERSATION_MAX_DAYS) return null;
  return days;
}

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

// Parse the USERS list (see config.users): a bare name (legacy — the stored
// password is the name itself) or "name:password" (the first colon separates;
// the password is case-sensitive and may contain colons).
function parseUsers(value) {
  const users = [];
  const passwords = {};
  for (const entry of splitCsv(value)) {
    const index = entry.indexOf(":");
    const name = (index === -1 ? entry : entry.slice(0, index)).trim();
    if (!name) continue;
    if (!users.includes(name)) users.push(name);
    passwords[name] = index === -1 ? name : entry.slice(index + 1).trim();
  }
  return { users, passwords };
}

// The hint the login form shows: the legacy "password is your username" text
// is only true while every account still uses that convention.
function loginHint() {
  const legacy = config.users.every((user) => config.userPasswords[user] === user);
  return legacy ? "The password is your username." : "Enter your username and password.";
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

// Vikunja (the task manager) is a service MCP. The live deployment uses one
// vm104-local Vikunja instance for both public Jarvis entries; we keep the
// Host-derived region keys for compatibility, but both can point to the same
// API URL. VIKUNJA_URLS and VIKUNJA_TOKENS are JSON maps keyed by region; the
// tokens are keyed by the signed-in user, so the backend pins one
// @eargollo/vikunja-mcp stdio server per (region, user) to that user's own
// API token — the token IS the scope, the brain acts as the user's own
// Vikunja account (read plus additive writes, no delete).
const VIKUNJA_HOST_REGIONS = {
  "jarvis.gw-1-nbg-1-de-netcup.rwnix.net": "nbg-1",
  "jarvis.gw-1-vie-1-at-netcup.rwnix.net": "vie-1",
};
function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.log(JSON.stringify({ level: "warn", msg: "env_json_invalid", env: name, error: error.message }));
    return {};
  }
}
const vikunjaUrls = parseJsonEnv("VIKUNJA_URLS");
const vikunjaTokens = parseJsonEnv("VIKUNJA_TOKENS");
const vikunjaConfigured = Object.keys(vikunjaUrls).length > 0;
function vikunjaRegionFor(host) {
  const name = String(host || "").split(":")[0].toLowerCase();
  return VIKUNJA_HOST_REGIONS[name] || process.env.VIKUNJA_DEFAULT_REGION || null;
}
if (vikunjaConfigured) mcpServers.push({ id: "vikunja", label: "Vikunja" });

// Mesh-internal service MCPs (the vm104 "privat" deployment). Every entry is
// env-gated: nothing starts unless the deployment sets the matching env, so
// a deployment without these services simply never offers the switches. The
// scope IS the transport — the shared kandev SSH key for the ssh entries,
// the local/loopback MCP endpoint for the kandev entries, the Checkmk API
// token for the checkmk entries — so each server id gets ONE shared child,
// no per-user pinning like Vikunja's. Tool names are namespaced
// `${id}_${tool}` (no id below contains an underscore, so the split is
// unambiguous), and the prefix tells the brain which host a tool acts on.
const MCP_SSH_USER = process.env.MCP_SSH_USER || "ubuntu";
const MCP_SSH_KEY = process.env.MCP_SSH_KEY || "/data/home/.ssh/kandev";
const mcpSshArgs = (host, remoteCommand) =>
  [
    "-T",
    "-i", MCP_SSH_KEY,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    `${MCP_SSH_USER}@${host}`,
    remoteCommand,
  ];
const externalMcpServers = [];
function externalSshMcp(id, label, hostEnv, remoteCommand, note) {
  const host = process.env[hostEnv];
  if (!host) return;
  externalMcpServers.push({ id, label, command: "ssh", args: mcpSshArgs(host, remoteCommand), note });
}
function externalLocalMcp(id, label, args, extraEnv = {}, note) {
  externalMcpServers.push({ id, label, command: process.execPath, args, extraEnv, note });
}
// The ssh remote command starts in the user's home dir, so the mcp CLI needs
// an explicit cd: `mcp run server.py:mcp` resolves server.py against the CWD
// and exits with "File not found: /home/ubuntu/server.py" without it.
const MCP_BASH_COMMAND = "cd /home/ubuntu/mcp-bash && exec /home/ubuntu/mcp-bash/.venv/bin/mcp run server.py:mcp";
externalSshMcp(
  "ssh-nbg", "SSH nbg-1", "MCP_SSH_NBG_HOST", MCP_BASH_COMMAND,
  "A shell on nbg-1, the German WireGuard mesh hub (Ubuntu server: Docker host, ufw, the wg-easy hub and the monitoring stack). Tools: execute_bash (one bash command at a time, stdout+stderr back) and set_cwd. This is a LIVE PRODUCTION host: run only what the user explicitly asks for, never run destructive commands, and after any change say what you changed and how you verified it.",
);
externalSshMcp(
  "ssh-vie1", "SSH vie-1", "MCP_SSH_VIE1_HOST", MCP_BASH_COMMAND,
  "A shell on vie-1, the Austrian WireGuard mesh hub (Ubuntu server: Docker host, ufw, the wg-easy hub and the monitoring stack). Tools: execute_bash (one bash command at a time, stdout+stderr back) and set_cwd. This is a LIVE PRODUCTION host: run only what the user explicitly asks for, never run destructive commands, and after any change say what you changed and how you verified it.",
);
externalSshMcp(
  "sem-nbg", "Semaphore nbg-1", "MCP_SEM_NBG_HOST",
  "docker exec -i semaphore-mcp semaphore-mcp --transport stdio",
  "Semaphore (the Ansible runbook UI) on nbg-1: list and read its projects, playbooks, inventory and runs. Starting or stopping a run changes real systems: do it only when the user explicitly asked for that run, and confirm exactly which run you started or stopped.",
);
externalSshMcp(
  "sem-vie1", "Semaphore vie-1", "MCP_SEM_VIE1_HOST",
  "docker exec -i semaphore-mcp semaphore-mcp --transport stdio",
  "Semaphore (the Ansible runbook UI) on vie-1: list and read its projects, playbooks, inventory and runs. Starting or stopping a run changes real systems: do it only when the user explicitly asked for that run, and confirm exactly which run you started or stopped.",
);
const mcpKandevBridgeCommand = (port) => `node /home/ubuntu/mcp-stdio-bridge.mjs http://127.0.0.1:${port}/mcp`;
externalSshMcp(
  "kandev-nbg", "Kandev nbg-1", "MCP_KANDEV_NBG_HOST", mcpKandevBridgeCommand(38429),
  "The Kandev task manager on nbg-1: list, read, create and update its tasks, workspaces, workflows and agent sessions. Use it when the user asks what tasks or agents exist there or wants one created or updated; confirm what you created or changed.",
);
externalSshMcp(
  "kandev-vie1", "Kandev vie-1", "MCP_KANDEV_VIE1_HOST", mcpKandevBridgeCommand(38429),
  "The Kandev task manager on vie-1: list, read, create and update its tasks, workspaces, workflows and agent sessions. Use it when the user asks what tasks or agents exist there or wants one created or updated; confirm what you created or changed.",
);
if (process.env.MCP_KANDEV_VM104_URL) {
  externalLocalMcp(
    "kandev-vm104", "Kandev vm104",
    [path.join(__dirname, "mcp", "remote-http.mjs"), process.env.MCP_KANDEV_VM104_URL],
    { KANDEV_HTTP_TIMEOUT_MS: String(process.env.MCP_KANDEV_VM104_TIMEOUT_MS || 30000) },
    "The Kandev task manager on vm104 — the machine this assistant runs on: list, read, create and update its tasks, workspaces, workflows and agent sessions. Use it when the user asks what tasks or agents exist here or wants one created or updated; confirm what you created or changed.",
  );
}
if (process.env.CHECKMK_NBG_URL && process.env.CHECKMK_NBG_TOKEN) {
  externalLocalMcp(
    "checkmk-nbg", "Checkmk nbg-1",
    [path.join(__dirname, "mcp", "checkmk.mjs")],
    {
      CHECKMK_BASE_URL: process.env.CHECKMK_NBG_URL,
      CHECKMK_TOKEN: process.env.CHECKMK_NBG_TOKEN,
      CHECKMK_INSECURE: process.env.CHECKMK_NBG_INSECURE || "0",
    },
    "The Checkmk monitoring instance for the nbg-1 side of the mesh: query hosts, services and their states (OK/WARNING/CRITICAL/UNKNOWN). Use cmk_hosts to find a host and cmk_services to see what fails on it.",
  );
}
if (process.env.CHECKMK_VIE1_URL && process.env.CHECKMK_VIE1_TOKEN) {
  externalLocalMcp(
    "checkmk-vie1", "Checkmk vie-1",
    [path.join(__dirname, "mcp", "checkmk.mjs")],
    {
      CHECKMK_BASE_URL: process.env.CHECKMK_VIE1_URL,
      CHECKMK_TOKEN: process.env.CHECKMK_VIE1_TOKEN,
      CHECKMK_INSECURE: process.env.CHECKMK_VIE1_INSECURE || "0",
    },
    "The Checkmk monitoring instance for the vie-1 side of the mesh: query hosts, services and their states (OK/WARNING/CRITICAL/UNKNOWN). Use cmk_hosts to find a host and cmk_services to see what fails on it.",
  );
}
for (const entry of externalMcpServers) mcpServers.push({ id: entry.id, label: entry.label });

function normalizeSelectorId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function readOpencodeConfig() {
  const filePath = process.env.OPENCODE_CONFIG_PATH || "/data/home/.config/opencode/opencode.jsonc";
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.log(JSON.stringify({ level: "warn", msg: "opencode_config_unavailable", path: filePath, error: error.message }));
    }
    return {};
  }
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function opencodeProfile(opencode, providerId, modelRef, fallback = {}) {
  const provider = opencode.provider?.[providerId] || {};
  const models = provider.models || {};
  const model = models[modelRef] || models[fallback.modelRef] || {};
  return {
    baseUrl: trimSlash(process.env[fallback.baseEnv] || provider.options?.baseURL || fallback.baseUrl || ""),
    model: process.env[fallback.modelEnv] || model.id || fallback.model || modelRef,
    apiKey: process.env[fallback.keyEnv] || provider.options?.apiKey || fallback.apiKey || "",
  };
}

function buildAiProfiles() {
  const opencode = readOpencodeConfig();
  const defaults = {
    "a1-deepseek": opencodeProfile(opencode, "a1-dsv4f", "a1-dsv4f", {
      baseEnv: "BRAIN_BASE_URL",
      modelEnv: "BRAIN_MODEL",
      keyEnv: "BRAIN_API_KEY",
      baseUrl: config.brainBaseUrl,
      model: config.brainModel,
      apiKey: config.brainApiKey,
    }),
    "a1-qwen": opencodeProfile(opencode, "qwen", "Qwen3.8-27B-UD-Q8_K_XL.gguf", {
      baseEnv: "BRAIN_A1_QWEN_BASE_URL",
      modelEnv: "BRAIN_A1_QWEN_MODEL",
      keyEnv: "BRAIN_A1_QWEN_API_KEY",
      baseUrl: "https://qwen38-27b-mtp.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1",
      model: "Qwen3.8-27B-UD-Q8_K_XL.gguf",
    }),
    ovhcloud: opencodeProfile(opencode, "ovh", "Qwen3.6-27B", {
      baseEnv: "BRAIN_OVHCLOUD_BASE_URL",
      modelEnv: "BRAIN_OVHCLOUD_MODEL",
      keyEnv: "BRAIN_OVHCLOUD_API_KEY",
      baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
      model: "Qwen3.6-27B",
    }),
    openrouter: opencodeProfile(opencode, "openrouter", "qwen/qwen3.8-27b", {
      baseEnv: "BRAIN_OPENROUTER_BASE_URL",
      modelEnv: "BRAIN_OPENROUTER_MODEL",
      keyEnv: "BRAIN_OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3.8-27b",
    }),
    // Cheapest DeepSeek model on the OpenRouter pricing list (verified
    // 2026-10-17: $0/1M prompt + completion, 1M context). Shares the
    // BRAIN_OPENROUTER_* credentials with the qwen profile; BRAIN_OPENROUTER_
    // DEEPSEEK_MODEL overrides the model when set.
    "openrouter-deepseek": opencodeProfile(opencode, "openrouter", "deepseek-v4-flash", {
      baseEnv: "BRAIN_OPENROUTER_BASE_URL",
      modelEnv: "BRAIN_OPENROUTER_DEEPSEEK_MODEL",
      keyEnv: "BRAIN_OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4-flash",
    }),
    claudecode: {
      baseUrl: trimSlash(process.env.BRAIN_CLAUDECODE_BASE_URL || ""),
      model: process.env.BRAIN_CLAUDECODE_MODEL || "opus",
      apiKey: process.env.BRAIN_CLAUDECODE_API_KEY || "",
    },
  };
  const labels = {
    "a1-deepseek": ["A1 GPU-2 - Deepseek V4 Flash", "a1-deepseek-v4.0-flash", true],
    "a1-qwen": ["A1 GPU-1 - Qwen38 27B", "a1-qwen38-27b", true],
    ovhcloud: ["OVHCloud - Qwen36 27B", "rw_ovhcloud-qwen3.6-27b", true],
    openrouter: ["OpenRouter - Qwen38 27B", "rw_openrouter-qwen3.8-27b", true],
    "openrouter-deepseek": ["OpenRouter - DeepSeek V4 Flash", "rw_openrouter-deepseek-v4-flash", true],
    claudecode: ["Claude Code", "rw-claude-Opus5.5", true],
  };
  const all = Object.entries(defaults).map(([id, profile]) => ({
    id,
    label: labels[id][0],
    profile: labels[id][1],
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
    configured: Boolean(profile.baseUrl && profile.model && (!labels[id][2] || profile.apiKey)),
  }));
  // The allowlist decides which profiles the deployment advertises; the
  // default-profile fallback below only ever sees the visible set.
  const profiles = config.brainProfileAllowlist.length
    ? all.filter((profile) => config.brainProfileAllowlist.includes(profile.id))
    : all;
  if (!profiles.some((profile) => profile.id === config.brainProfileDefault && profile.configured)) {
    config.brainProfileDefault = profiles.find((profile) => profile.configured)?.id || "a1-deepseek";
  }
  return profiles;
}

// `??`, not `||`, on the endpoint chains: an explicitly empty
// WHISPER_*_ENDPOINTS must disable that profile (the gpu-2 deployment sets
// WHISPER_VM103_ENDPOINTS=/WHISPER_OVHCLOUD_ENDPOINTS= to advertise only the
// gpu-1 profile), while an unset variable still falls back to the default —
// the same semantics as ttsEndpoints above.
function buildWhisperProfiles() {
  // Labels carry the resolved model so the selector reads like
  // "A1 - GPU-1 - Systran/faster-whisper-large-v3"; when a WHISPER_*_MODEL
  // env override is set, the label follows it.
  const gpu1Model = process.env.WHISPER_GPU1_MODEL || config.whisperModel;
  const vm103Model = process.env.WHISPER_VM103_MODEL || "deepdml/faster-whisper-large-v3-turbo-ct2";
  const ovhModel = process.env.WHISPER_OVHCLOUD_MODEL || "whisper-large-v3";
  const profiles = [
    {
      id: "gpu-1",
      label: `A1 - GPU-1 - ${gpu1Model}`,
      endpoints: splitCsv(process.env.WHISPER_GPU1_ENDPOINTS ?? process.env.WHISPER_ENDPOINTS ?? "https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/transcriptions"),
      model: gpu1Model,
      apiKey: process.env.WHISPER_GPU1_API_KEY || config.whisperApiKey,
      vadFilter: parseBoolean(process.env.WHISPER_GPU1_VAD_FILTER || String(config.whisperVadFilter)),
      sendVadFilter: true,
    },
    {
      id: "vm103",
      label: `RW - VM103 - ${vm103Model}`,
      endpoints: splitCsv(process.env.WHISPER_VM103_ENDPOINTS ?? "http://192.168.53.111:8003/v1/audio/transcriptions"),
      model: vm103Model,
      apiKey: process.env.WHISPER_VM103_API_KEY || "",
      vadFilter: parseBoolean(process.env.WHISPER_VM103_VAD_FILTER || "true"),
      sendVadFilter: true,
    },
    {
      id: "ovhcloud",
      label: `OVHCloud - ${ovhModel}`,
      endpoints: splitCsv(process.env.WHISPER_OVHCLOUD_ENDPOINTS ?? "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions"),
      model: ovhModel,
      apiKey: process.env.WHISPER_OVHCLOUD_API_KEY || process.env.OVH_AI_ENDPOINTS_ACCESS_TOKEN || process.env.BRAIN_OVHCLOUD_API_KEY || "",
      vadFilter: false,
      sendVadFilter: false,
    },
  ].filter((profile) => profile.endpoints.length && profile.model);
  return profiles;
}

function aiProfileFor(value) {
  const id = normalizeSelectorId(value) || config.brainProfileDefault;
  return config.aiProfiles.find((profile) => profile.id === id && profile.configured)
    || config.aiProfiles.find((profile) => profile.id === config.brainProfileDefault && profile.configured)
    || config.aiProfiles.find((profile) => profile.configured);
}

function whisperProfileFor(value) {
  const id = normalizeSelectorId(value) || "gpu-1";
  return config.whisperProfiles.find((profile) => profile.id === id) || config.whisperProfiles[0] || null;
}

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
  ".png": "image/png",
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
        whisperEndpoints: config.whisperProfiles.reduce((count, profile) => count + profile.endpoints.length, 0),
        brainConfigured: isBrainConfigured(),
        aiProfiles: config.aiProfiles.filter((profile) => profile.configured).length,
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
      // Compare against the password stored for that user (a bare-name USERS
      // entry stores the name itself) constant-time.
      // 403, not 401: the app sits behind the gateway's Basic Auth layer, and
      // any 401 that arrives on a request carrying those credentials makes the
      // browser treat them as rejected and clear its cached Basic
      // credentials — the next request then triggers a second Basic Auth
      // prompt. A bare 403 never does that.
      const user = canonicalUser(username);
      if (!user || !sameSecret(password, config.userPasswords[user])) {
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
    // loginHint tells the login form which convention this deployment uses.
    if (pathname.startsWith("/api/")) {
      const user = sessionUser(req);
      if (!user) return json(res, 403, { error: "forbidden", loginHint: loginHint(), requestId });
      req.user = user;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      return json(res, 200, {
        user: req.user,
        wakePhrase: config.wakePhrase,
        silenceMs: config.silenceMs,
        whisperEndpoints: config.whisperEndpoints.map(redactUrl),
        whisperProfiles: config.whisperProfiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          endpoints: profile.endpoints.map(redactUrl),
          model: profile.model,
        })),
        whisperLanguage: config.whisperLanguage,
        whisperVadFilter: config.whisperVadFilter,
        brainBaseUrl: redactUrl(config.brainBaseUrl),
        brainModel: config.brainModel,
        brainProfileDefault: config.brainProfileDefault,
        aiProfiles: config.aiProfiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          profile: profile.profile,
          baseUrl: redactUrl(profile.baseUrl),
          model: profile.model,
          configured: profile.configured,
        })),
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
        // The History search panel builds one slider per entry from this:
        // min/max/step/default live in the backend, so the UI can never
        // offer a value the backend would reject.
        historySearch: HISTORY_SETTINGS,
        embeddingModel: EMBEDDING_MODEL,
        embeddingConfigured,
      });
    }

    if (req.method === "GET" && pathname === "/api/costs") {
      // The cost panel's live view: OpenRouter credit balance/usage plus the
      // latest OVHcloud invoices and the current month's AI endpoint usage.
      // Both sections are cached server-side (5 min / 1 h TTL); a section is
      // "configured: false" when its credentials are absent, and the panel
      // hides it. On a refresh failure the last good data is served flagged
      // stale, so a billing-API outage degrades gracefully instead of
      // blanking the panel.
      const fresh = new URL(req.url, "http://localhost").searchParams.get("fresh") === "1";
      const sections = {};
      for (const name of ["openrouter", "ovhcloud"]) {
        if (!COSTS[name].enabled) {
          sections[name] = { configured: false };
          continue;
        }
        const entry = await refreshCosts(name, fresh);
        sections[name] = {
          configured: true,
          ...(entry.data || { up: 0, error: entry.error || "not fetched yet" }),
          error: entry.error,
          stale: entry.data ? Date.now() - entry.at >= COSTS[name].ttlMs : null,
          fetched_at: entry.data ? new Date(entry.at).toISOString() : null,
        };
      }
      return json(res, 200, { ...sections, generated_at: new Date().toISOString(), requestId });
    }

    // The Prompt/Answer panels' scrollback: this user's stored conversation,
    // oldest first, windowed to the last ?days=N days (default 24; the store
    // keeps everything, the panels only show the window). Same per-user
    // isolation as the prompt history — a foreign user's conversation is
    // unreachable.
    if (req.method === "GET" && pathname === "/api/conversation") {
      const days = conversationDaysFromUrl(req.url);
      if (days === null) return json(res, 400, { error: "invalid_days", requestId });
      const floor = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const entries = conversationStore.selectWindow.all({ user: req.user, floor }).map((row) => ({ ...row, sources: conversationStoredSources(row.sources) }));
      return json(res, 200, { requestId, entries });
    }

    if (req.method === "POST" && pathname === "/api/conversation") {
      const payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
      const prompt = String(payload.prompt || "").trim().slice(0, 4000);
      const answer = String(payload.answer || "").trim().slice(0, 8000);
      if (!prompt || !answer) return json(res, 400, { error: "prompt_and_answer_required", requestId });
      const entry = { ts: new Date().toISOString(), prompt, answer, sources: conversationSourcesFromPayload(payload.sources) };
      conversationStore.insert.run({ user: req.user, ...entry });
      // Fire-and-forget: the turn is stored either way, and an embedding
      // failure only means this turn is keyword-only until the next backfill.
      backfillEmbeddings().catch(() => {});
      return json(res, 200, { requestId, entry: { ...entry, sources: conversationStoredSources(entry.sources) } });
    }

    // The per-user websearch source list (the Websearch sources panel). This
    // backend is the only writer of the list: the brain neither reads nor
    // changes it (it is injected per MCP call and absent from the tool
    // schema), and the client only ever sees its own user's rows.
    if (req.method === "GET" && pathname === "/api/websearch/sources") {
      const rows = await websearchSourceRowsForUser(req.user);
      return json(res, 200, { requestId, sources: rows });
    }

    if (req.method === "POST" && pathname === "/api/websearch/sources") {
      const payload = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const source = String(payload.source || "").trim().slice(0, 64);
      const rawUrl = String(payload.url || "").trim();
      if (!source || !rawUrl) return json(res, 400, { error: "source_and_url_required", requestId });
      const unsafe = unsafeWebsearchSourceUrl(rawUrl);
      if (unsafe) return json(res, 400, { error: "invalid_url", message: unsafe, requestId });
      const existing = await websearchSourceRowsForUser(req.user);
      if (existing.filter((row) => row.kind === "feed" && !row.builtin).length >= 20) {
        return json(res, 400, { error: "too_many_sources", requestId });
      }
      // Stable per-user id from the display name ("My Feed" -> user:my-feed),
      // with a numeric suffix on collision so two feeds may share a name.
      const baseId = `user:${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "feed"}`;
      const taken = new Set(existing.map((row) => row.id));
      let id = baseId;
      for (let n = 2; taken.has(id); n += 1) id = `${baseId}-${n}`;
      conversationStore.addWebsearchSource.run({ user: req.user, id, source, url: rawUrl });
      return json(res, 201, { requestId, source: conversationStore.websearchSource.get({ user: req.user, id }) });
    }

    if (req.method === "PATCH" && pathname === "/api/websearch/sources") {
      await ensureWebsearchSourcesSeeded(req.user);
      const payload = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const id = String(payload.id || "").trim();
      if (!id) return json(res, 400, { error: "id_required", requestId });
      const row = conversationStore.websearchSource.get({ user: req.user, id });
      if (!row) return json(res, 404, { error: "source_not_found", requestId });
      const enabled = payload.enabled === true ? 1 : 0;
      conversationStore.setWebsearchSourceEnabled.run({ user: req.user, id, enabled });
      return json(res, 200, { requestId, source: { ...row, enabled } });
    }

    if (req.method === "DELETE" && pathname === "/api/websearch/sources") {
      await ensureWebsearchSourcesSeeded(req.user);
      const payload = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
      const id = String(payload.id || "").trim();
      if (!id) return json(res, 400, { error: "id_required", requestId });
      const row = conversationStore.websearchSource.get({ user: req.user, id });
      if (!row) return json(res, 404, { error: "source_not_found", requestId });
      // Built-in baseline rows are toggleable, never deletable — the panel
      // offers Remove on the user's own feeds only.
      if (row.builtin) return json(res, 400, { error: "builtin_source_not_deletable", requestId });
      conversationStore.deleteWebsearchSource.run({ user: req.user, id });
      return json(res, 200, { requestId });
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

    // Fuzzy entity/link search for the full-size graph page. Index-backed and
    // bounded, so it stays cheap however large the graph is; scoped to the
    // session user's world (the admin session searches the whole graph).
    if (req.method === "GET" && pathname === "/api/graph/search") {
      if (!graphStore) return json(res, 503, { error: "graph_not_configured", requestId });
      // The query is clamped, not rejected: a long paste is a usable prefix,
      // and the store escapes it before it reaches Lucene.
      const query = String(url.searchParams.get("q") || "").slice(0, 120);
      if (!query.trim()) return json(res, 200, { requestId, nodes: [], relTypes: [], truncated: false });
      try {
        return json(res, 200, { requestId, ...(await graphStore.search({ user: req.user, query, admin: isAdmin(req.user), limit: Number(url.searchParams.get("limit")) || 25 })) });
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
      const profile = whisperProfileFor(url.searchParams.get("whisperProfile"));
      if (!profile) return json(res, 503, { error: "whisper_not_configured", requestId });
      const result = await transcribeWithFailover(body, req.headers["content-type"] || "audio/webm", language, profile, requestId, controller.signal);
      return json(res, result.error ? 502 : 200, result);
    }

    // Connection test for the endpoint selectors: the UI calls this when the
    // user picks a brain or whisper profile and lights the green/red LED.
    // brain = one minimal chat completion, whisper = the silent WAV through
    // the real transcribeWithFailover path (auth, routing and model load).
    // Unlike the production routes this never falls back to another profile:
    // it tests exactly the id the UI selected, or reports it as not found.
    if (req.method === "POST" && pathname === "/api/endpoint-test") {
      const payload = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
      const kind = payload.kind === "whisper" ? "whisper" : "brain";
      const id = String(payload.id || "").slice(0, 64);
      const started = Date.now();
      if (kind === "whisper") {
        const profile = config.whisperProfiles.find((item) => item.id === id && item.endpoints.length && item.model);
        if (!profile) return json(res, 404, { ok: false, kind, id, error: "whisper_profile_not_found", requestId });
        const result = await transcribeWithFailover(silentWav(), "audio/wav", config.whisperLanguage, profile, requestId, AbortSignal.timeout(70000));
        return json(res, 200, { ok: !result.error, kind, id, ms: Date.now() - started, error: result.error || "", attempts: result.attempts });
      }
      const profile = config.aiProfiles.find((item) => item.id === id && item.configured);
      if (!profile) return json(res, 404, { ok: false, kind, id, error: "brain_profile_not_found", requestId });
      const headers = { "content-type": "application/json" };
      if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
      const response = await fetch(`${profile.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: profile.model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 8,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (!response.ok) {
        return json(res, 200, { ok: false, kind, id, ms: Date.now() - started, error: `HTTP ${response.status}: ${text.slice(0, 200)}` });
      }
      return json(res, 200, { ok: true, kind, id, ms: Date.now() - started });
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const payload = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8") || "{}");
      const prompt = String(payload.prompt || "").trim();
      if (!prompt) return json(res, 400, { error: "missing_prompt", requestId });
      // The prompt history is keyed by the authenticated user, not by a
      // client-chosen id: every tab of Mila shares Mila's cache and no
      // other user can read or write it.
      const profile = aiProfileFor(payload.brainProfile);
      if (!profile) return json(res, 503, { error: "brain_not_configured", requestId });
      const result = await chat(prompt, req.user, normalizeLanguage(payload.language) || "en", profile, requestId, controller.signal, normalizeMcpFlags(payload),
        String(payload.wakePhrase || "").slice(0, 60), req.headers.host, normalizeHistorySettings(payload.historySearch));
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
  // The graph's indexes (full-text search + the owner/name lookups) are
  // created on startup, idempotently. A failure is logged and left alone: the
  // app still serves, search degrades, and the next start retries.
  graphStore?.ensureIndexes()
    .then((result) => console.log(JSON.stringify({ level: "info", msg: "graph_indexes_ready", ...result })))
    .catch((error) => console.log(JSON.stringify({ level: "warn", msg: "graph_indexes_failed", error: error.message })));
  // Embed whatever the conversation store already holds (the turns from
  // before this feature, or from a model change). Bounded, in the background:
  // a slow or down embedding endpoint must not delay serving.
  if (embeddingConfigured) backfillEmbeddings().catch(() => {});
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
  return config.aiProfiles.some((profile) => profile.configured && !String(profile.apiKey).includes("PUT-YOUR"));
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
    let body = data;
    if (config.brand === "a1" && safePath === "/index.html") {
      body = Buffer.from(brandizeA1(data.toString("utf8")));
    }
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
}

// Guarded in-place replacements against exact lines of the current index.html —
// if a future edit moves one of those lines the replacement simply does not
// happen and the page degrades to the default look instead of breaking. The
// file on disk (and every non-BRAND=a1 deployment) is never modified.
// The eyebrow logo sits inline to the LEFT of the "Jarvis web assistant" text.
function brandizeA1(html) {
  const logo = (indent) => `${indent}<img class="brand-logo" src="/logo-a1.png" alt="a1" width="56" height="56">\n`;
  return html
    .replace(
      '    <link rel="stylesheet" href="/style.css">',
      '    <link rel="stylesheet" href="/style.css">\n    <link rel="stylesheet" href="/theme-a1.css">'
    )
    .replace('        <h1>Jarvis</h1>', logo("        ") + "        <h1>Jarvis</h1>")
    .replace(
      '          <p class="eyebrow">Jarvis web assistant</p>',
      '          <p class="eyebrow"><img class="brand-logo eyebrow-logo" src="/logo-a1.png" alt="a1" width="24" height="24"> Jarvis web assistant</p>'
    );
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

// A short silent 16 kHz mono WAV: the cheapest payload that still exercises
// a whisper endpoint end-to-end (auth, routing, model load) without a real
// recording. All three server-side whisper stacks accept it and answer with
// an empty transcript, which transcribeWithFailover reports as noSpeech.
function silentWav(seconds = 0.25) {
  const sampleRate = 16000;
  const data = Buffer.alloc(Math.floor(seconds * sampleRate) * 2); // 16-bit PCM silence
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function transcribeWithFailover(audioBuffer, mimeType, language, profile, requestId, signal) {
  if (!profile?.endpoints?.length) throw new Error("No Whisper endpoints configured");
  const attempts = [];

  for (let i = 0; i < profile.endpoints.length; i += 1) {
    const index = whisperCursor % profile.endpoints.length;
    whisperCursor = (whisperCursor + 1) % profile.endpoints.length;
    const endpoint = profile.endpoints[index];
    const started = Date.now();
    try {
      console.log(JSON.stringify({ level: "info", requestId, msg: "whisper_attempt", profile: profile.id, endpoint: redactUrl(endpoint), bytes: audioBuffer.length, mimeType }));
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      form.append("file", blob, mimeType.startsWith("audio/wav") ? "jarvis-command.wav" : "jarvis-command.webm");
      form.append("model", profile.model);
      form.append("language", language);
      form.append("response_format", "json");
      if (profile.sendVadFilter !== false) form.append("vad_filter", String(profile.vadFilter));
      form.append("temperature", "0");

      const headers = {};
      if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
      const response = await fetch(endpoint, {
        method: "POST", body: form, headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      const data = parseJsonOrText(text);
      const rawTranscript = extractTranscript(data);
      const transcript = isLikelyWhisperHallucination(rawTranscript) ? "" : rawTranscript;
      console.log(JSON.stringify({ level: "info", requestId, msg: transcript ? "whisper_success" : "whisper_no_speech", profile: profile.id, endpoint: redactUrl(endpoint), ms: Date.now() - started, transcriptChars: transcript.length }));
      return {
        requestId,
        text: transcript,
        noSpeech: !transcript,
        profile: profile.id,
        profileLabel: profile.label,
        endpoint: redactUrl(endpoint),
        attempts: attempts.concat({ endpoint: redactUrl(endpoint), ok: true, ms: Date.now() - started }),
      };
    } catch (error) {
      console.log(JSON.stringify({ level: "warn", requestId, msg: "whisper_failure", profile: profile.id, endpoint: redactUrl(endpoint), ms: Date.now() - started, error: error.message }));
      attempts.push({ endpoint: redactUrl(endpoint), ok: false, ms: Date.now() - started, error: error.message });
      signal.throwIfAborted();
    }
  }

  return { requestId, text: "", profile: profile.id, profileLabel: profile.label, error: "all_whisper_endpoints_failed", attempts };
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

  async listTools(timeoutMs = 20000) {
    await this.start();
    return this.request("tools/list", {}, timeoutMs);
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
// database user. On top of the reads, regular sessions get four write/delete
// tools scoped to their own owner; the admin session gets the cross-owner
// variants. The server re-validates the injected user/admin/users arguments
// before any write reaches the write database user.
// MCP_GRAPH_SCRIPT lets tests point the client at a mock server, same
// pattern as MCP_SEARCH_SCRIPT.
const mcpGraph = new McpClient(
  process.execPath,
  [process.env.MCP_GRAPH_SCRIPT || path.join(__dirname, "mcp", "graph.mjs")],
  {
    NEO4J_URI: process.env.NEO4J_URI || "",
    NEO4J_DATABASE: process.env.NEO4J_DATABASE || "neo4j",
    NEO4J_READ_USER: process.env.NEO4J_READ_USER || "",
    NEO4J_READ_PASSWORD: process.env.NEO4J_READ_PASSWORD || "",
    NEO4J_WRITE_USER: process.env.NEO4J_WRITE_USER || "",
    NEO4J_WRITE_PASSWORD: process.env.NEO4J_WRITE_PASSWORD || "",
  },
);

// The external (mesh-internal) service MCP clients, one shared child per
// server id (see the registry above). Tool lists are cached after the first
// successful listing; if the child later dies (ssh drop, container restart),
// McpClient.start() respawns and re-initializes it on the next call, so the
// cached schema stays valid.
const EXTERNAL_TOOL_TIMEOUT_MS = Number(process.env.MCP_EXTERNAL_TOOL_TIMEOUT_MS || 30000);
const externalMcpClients = new Map();
const externalMcpToolCaches = new Map(); // id -> { openai: [...], lookup: Map<namespaced, {client, tool, entry}> }
function externalMcpClientFor(entry) {
  let client = externalMcpClients.get(entry.id);
  if (!client) {
    client = new McpClient(entry.command, entry.args, entry.extraEnv || {});
    externalMcpClients.set(entry.id, client);
  }
  return client;
}
async function externalMcpToolsFor(entry, signal) {
  const cached = externalMcpToolCaches.get(entry.id);
  if (cached) return cached;
  const client = externalMcpClientFor(entry);
  const listed = await withAbort(client.listTools(20000), signal);
  const openai = [];
  const lookup = new Map();
  for (const tool of listed.tools || []) {
    const name = `${entry.id}_${tool.name}`;
    if (!name) continue;
    lookup.set(name, { client, tool: tool.name, entry });
    openai.push({
      type: "function",
      function: {
        name,
        description: `[${entry.label}] ${tool.description || tool.name}`.slice(0, 500),
        parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      },
    });
  }
  const result = { openai, lookup };
  externalMcpToolCaches.set(entry.id, result);
  return result;
}

// Vikunja MCP servers (@eargollo/vikunja-mcp, stdio): one child per
// (region, user), each pinned to that user's own API token for that region's
// instance — there is no per-call user injection to get wrong, the token IS
// the scope. Writes are allowed (the user manages their own tasks), deletes
// are not (VIKUNJA_MCP_ALLOW_DELETE stays off). VIKUNJA_MCP_SCRIPT lets tests
// point the client at a mock server.
const VIKUNJA_TOOL_TIMEOUT_MS = 15000;
const vikunjaClients = new Map();
function vikunjaClientFor(region, user) {
  const url = vikunjaUrls[region];
  const token = (vikunjaTokens[region] || {})[user];
  if (!url || !token) return null;
  const key = `${region}\u0000${user}`;
  let client = vikunjaClients.get(key);
  if (!client) {
    client = new McpClient(process.execPath, [process.env.VIKUNJA_MCP_SCRIPT || "/usr/local/bin/vikunja-mcp"], {
      VIKUNJA_URL: url,
      VIKUNJA_API_TOKEN: token,
      VIKUNJA_MCP_ALLOW_WRITE: "1",
    });
    client.tools = null;
    vikunjaClients.set(key, client);
  }
  return client;
}
async function vikunjaToolsFor(client, signal) {
  if (client.tools) return client.tools;
  const listed = await withAbort(client.listTools(15000), signal);
  client.tools = (listed.tools || [])
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name || ""),
        description: tool.description || "",
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    }))
    .filter((tool) => tool.function.name);
  return client.tools;
}

// The source attribution behind an MCP web tool result: the structured
// sources list the web-search server returns (site/portal names, never raw
// URLs). Missing or malformed shapes degrade to no attribution.
function sourceNamesFromMcp(result) {
  const names = result?.structuredContent?.sources;
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))].slice(0, 8);
}

function mergeSourceNames(...lists) {
  return [...new Set(lists.flat().map((name) => String(name || "").trim()).filter(Boolean))].slice(0, 8);
}

// Runs the web_search tool of the MCP server and resolves with the result
// text plus the source names behind it; the caller treats a failure as
// "answer without search results".
async function webSearch(query, language, requestId, signal, webSources) {
  const started = Date.now();
  try {
    const result = await withAbort(mcpWebSearch.call("web_search", { query, max_results: 5, lang: language === "de" ? "de" : "en", ...(webSources ? { webSources } : {}) }, 20000), signal);
    const text = (result.content || []).map((item) => item.text || "").join("\n").trim();
    if (result.isError || !text) throw new Error(text || "web search returned no results");
    console.log(JSON.stringify({ level: "info", requestId, msg: "websearch_success", ms: Date.now() - started, chars: text.length }));
    return { text, sources: sourceNamesFromMcp(result) };
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

async function chat(prompt, user, language, brainProfile, requestId, signal, mcpFlags, wakePhrase, host, historySettings = normalizeHistorySettings()) {
  if (!brainProfile?.configured || String(brainProfile.apiKey).includes("PUT-YOUR")) {
    throw new Error("Brain endpoint/model is not configured");
  }

  // Short-term memory: the in-process cache when it is warm, otherwise the
  // newest stored turns. Without the fallback a restart made the brain say
  // "this is the first question you've asked me" to a user whose panels were
  // still showing weeks of conversation.
  const history = (conversations.get(user) || recentHistoryFromStore(user, historySettings.memoryTurns))
    .slice(-historySettings.memoryTurns * 2);
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
  let searchSources = [];
  let webSourcesList = null;
  const mcpStates = [];
  if (mcpFlags.websearch) {
    try {
      // The user's own source list for this turn: injected into the pre-search
      // and into every web tool call the brain makes. It is per-account data,
      // resolved here server-side — the client never sends (or sees) it.
      webSourcesList = await websearchSourcesForUser(user);
      const { text: results, sources: sourcesFromSearch } = await webSearch(prompt, language, requestId, signal, webSourcesList);
      searchSources = sourcesFromSearch;
      searchMessage = {
        role: "system",
        content: `Web search results for this prompt (use them if relevant, keep the answer short and spoken):\n${results}`,
      };
      mcpStates.push("Web search (MCP web-search server) is ON: the web was just searched for this prompt and the results are included in this system message; use them when relevant. You can also call the tools web_search (your own query), web_news (latest news for a topic or an interest area: technik, it, finance, geek, nerd) and web_fetch (open a specific URL in a real headless browser and return the rendered page text — use it when the user asks to pull or open a specific page, e.g. a stock quote or a link from the web_search results; it runs the page's JavaScript so it reads dynamic content a plain fetch would miss). For 'latest news' questions — including about the user's interests and their stored topics (the WATCHES facts from the knowledge graph, e.g. a trading news list the user asked to track, or the members of one of the user's named list entities via its PART_OF edges) — call web_news with the concrete topic, one interest at a time. If the user asks whether you can search the web or whether your MCP web-search server is available, answer about this feature itself — it is enabled — not from the search results.");
    } catch (error) {
      if (signal.aborted) throw error;
      console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_skipped", error: error.message }));
      mcpStates.push("Web search (MCP web-search server) is ON, but the search for this prompt returned no results; answer from your own knowledge and do not mention the search.");
    }
    // The attribution contract for web-based answers: a trailing "[sources: …]"
    // line naming only the sources actually used, which this server then
    // validates and strips (see splitAttribution below).
    mcpStates.push(WEB_ATTRIBUTION_INSTRUCTION);
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
          // (which would contradict that) is NOT added here. It is also the
          // only session whose brain gets cross-owner write/delete tools.
          mcpStates.push("The knowledge graph (MCP graph server) is ON and you are the administrator of it: the four read tools show you ALL users' data — get-schema (labels, relation types, property keys), get-entity(name) (every owner's copy of an entity, its data and its links), list-my-knowledge (every user's stored entities, grouped per user) and list-my-facts(about?, relation?) (every user's stored facts — likes, ownership, family, home, work, watched topics, and the questions they asked (ASKED_ABOUT, with the date)). You can also MODIFY any user's graph data: store-entity(owner, name, type) stores an entity under any user's name (type: person, place, organization, event, topic or thing), store-fact(owner, from, to, type, negative?) stores a fact between two endpoints (entities or registered users) under any user's name, rename-entity(owner, name, newName) renames an entity of any user in place — all of its links survive, so ALWAYS use it for renames, never delete+store — and delete-entity(owner, name) removes an entity of any user together with its links. Use them when the admin asks you to store, correct, rename or remove stored knowledge — including another user's stored data — and confirm exactly what changed. When asked what is stored about the graph or about any user, answer from the read tools and attribute each item to its user (e.g. 'Mila: likes Lego; Roman: no stored facts'). Seeing other users' data is allowed in this admin session only — never present another user's data as the admin's own, and do not guess. Admin conversations do NOT update the graph automatically — only your explicit store-entity, store-fact, rename-entity and delete-entity calls change it, so make those calls and confirm exactly what the tool result says instead of claiming you cannot write. Honesty rule: never claim a store/rename/delete succeeded unless the tool result of THIS very turn starts with 'Stored', 'Renamed' or 'Deleted'; if the tool reports that the operation did not happen, say so honestly.");
        } else {
          mcpStates.push(graphText
            ? "The knowledge graph (MCP graph server) is ON: this user's own stored knowledge is included in this system message, and you can call graph tools scoped to this signed-in user: get-schema (labels, relation types, property keys), get-entity(name) (one of this user's own entities, its data and its links), list-my-knowledge (the entities this user has told you about), list-my-facts(about?, relation?) (the facts stored about this user), plus store-entity(name, type), store-fact(from, to, type, negative?), rename-entity(name, newName) and delete-entity(name) for this user's OWN graph data only. Use delete-entity when the user asks you to forget or remove one of their stored entities — first find the exact stored name with list-my-knowledge or get-entity (a close phrasing is fine: a unique close match is resolved automatically), then call the tool with that name; never claim you can delete or change another user's data. Honesty rule: never claim you stored, renamed or deleted anything unless the tool result of THIS very turn starts with 'Stored', 'Renamed' or 'Deleted'; if the tool reports that the operation did not happen (entity not found, no unique match, …), say so honestly — and offer the closest stored names the tool listed — instead of claiming success. Privacy: the graph is this user's private world — every stored entity belongs to the signed-in user, and you can only see or modify data that belongs to the signed-in user, never another user's data; there is no shared or public tier. If asked about another user's preferences, habits or facts, say you have no stored information about them. When describing what the graph does or does not contain, always phrase it from this user's view (e.g. 'I have no record of you liking X' or 'I have no stored information about other users'), never as a global claim about the whole graph (never 'no one likes X' or 'no one is connected to X'). Do not guess. The graph is updated automatically after every answer, so when the user asks you to save, remember or track topics or assign X to my TradingMonitor list, either use the write tool immediately or confirm that it is done; automatic storage writes WATCHES and PART_OF facts as needed. Questions are stored the same way: each question's subject is linked to the user with an ASKED_ABOUT fact that carries the date and time the question was asked, and the answer's entities (films, people, ...) and their links to the subject are stored with it — so 'what did I ask about, and when?' is answered from list-my-facts (relation ASKED_ABOUT), and the stored question subjects are part of this user's knowledge."
            : "The knowledge graph (MCP graph server) is ON but holds nothing for this user yet; you can still inspect the graph with get-schema, get-entity, list-my-knowledge and list-my-facts, and you may use store-entity, store-fact, rename-entity or delete-entity only for this signed-in user's own graph data — for deletes, first find the exact stored name with list-my-knowledge or get-entity (a unique close match is resolved automatically). Never claim you stored, renamed or deleted anything unless the tool result of THIS very turn starts with 'Stored', 'Renamed' or 'Deleted'; if the tool reports that the operation did not happen, say so honestly instead of claiming success. New facts are also stored automatically after every answer — so when the user asks you to save, remember or track topics or assign them to a named list (e.g. 'add X to my trading news list' or 'assign X to my TradingMonitor list'), confirm that it is done instead of claiming you cannot write; the topics are stored (as WATCHES and PART_OF facts, a named list as its own entity) after your answer. Questions are stored the same way: each question's subject is linked to the user with an ASKED_ABOUT fact that carries the date and time of the question, and the answer's entities and their links to the subject are stored with it.");
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
    mcpStates.push("The knowledge graph (MCP graph server) is OFF in the user's browser for this request: no graph context and no graph tools are available for this turn, so answer from the conversation history and your own knowledge. Nothing from this conversation is stored in the graph while the toggle is off — automatic storage of entities and facts runs only with the toggle on — so if the user asks you to remember, save or track something, say you cannot store it while the MCP knowledge graph toggle is off and that they can switch it on to let you store and read their facts.");
  }
  let vikunjaTools = null;
  let vikunjaClient = null;
  let vikunjaToolNames = null;
  if (vikunjaConfigured) {
    if (mcpFlags.vikunja) {
      const region = vikunjaRegionFor(host);
      const client = region ? vikunjaClientFor(region, user) : null;
      if (!client) {
        mcpStates.push("Vikunja (the task manager) is ON in the user's browser but this request has no Vikunja account configured for it (unknown region, or no token for this user on this region's instance); do not claim access to their tasks.");
      } else {
        try {
          vikunjaTools = await vikunjaToolsFor(client, signal);
          vikunjaClient = client;
          vikunjaToolNames = new Set(vikunjaTools.map((tool) => tool.function.name));
          mcpStates.push(`Vikunja (the task manager) is ON: you can see and manage this user's OWN tasks, projects, labels and lists in their Vikunja account on the ${region} instance — you act as the user themself, with their own account and data (this region's tasks only; another region's instance is not reachable from here). The offered tools are the live tool list of the MCP server (for example list_projects, list_tasks, get_task, create_task, add_task_comment, assign_user, add_label_to_task). You can create and update tasks; there is NO delete tool in this integration — if asked to delete or remove a task or project, say deleting is not available here. When you create or change anything, confirm exactly what you did in plain language. When asked whether you can see or manage their tasks, say yes.`);
        } catch (error) {
          if (signal.aborted) throw error;
          console.log(JSON.stringify({ level: "warn", requestId, msg: "vikunja_tools_failed", error: error.message }));
          mcpStates.push("Vikunja (the task manager) is ON, but the task server is currently unreachable; answer from your own knowledge and do not mention tasks you cannot see.");
        }
      }
    } else {
      mcpStates.push("Vikunja (the task manager) is OFF in the user's browser for this request: you cannot see or change their tasks, projects or lists. If the user asks about their tasks or asks you to manage them, say the MCP Vikunja toggle in the UI is off for now and they can switch it on.");
    }
  }
  const externalMcpEntries = [];
  for (const entry of externalMcpServers) {
    if (!mcpFlags[entry.id]) {
      mcpStates.push(`${entry.label} is OFF in the user's browser for this request: do not claim access to it and do not act on it.`);
      continue;
    }
    try {
      const { openai, lookup } = await externalMcpToolsFor(entry, signal);
      if (!openai.length) throw new Error("the MCP server offered no tools");
      externalMcpEntries.push({ ...entry, openai, lookup });
      mcpStates.push(`${entry.label} is ON: ${entry.note} Its tools are namespaced ${entry.id}_<tool> (for example ${openai[0].function.name}).`);
    } catch (error) {
      if (signal.aborted) throw error;
      console.log(JSON.stringify({ level: "warn", requestId, msg: "external_mcp_tools_failed", server: entry.id, error: error.message }));
      mcpStates.push(`${entry.label} is ON, but the service is currently unreachable; answer from your own knowledge and do not claim access to it.`);
    }
  }
  // The whole leading block - persona, MCP state, web-search results and
  // graph context - is ONE system message: strict OpenAI-compatible
  // endpoints (OVH AI Endpoints) reject a second leading system message
  // with HTTP 400 "System message must be at the beginning."
  const leadingSystem = [
    `${config.brainSystemPrompt}\nYour name is ${wakeName} — the user calls you by your wake word, so use "${wakeName}" as your own name in your answers, for example when they ask who you are or address you by name.\nThe user is signed in as ${user}; their signed-in name is their first name, so address them by it in your answers.\n${mcpStates.join("\n")}\nLanguage override: answer in ${answerLanguage}.\nCurrent server time: ${now.toISOString()} (${now.toString()}). If the user asks for the time or date, answer from this timestamp.\nMemory: the messages above are only the last few turns. Every earlier conversation with this user is stored and searchable with the search_history tool. If they refer to anything from before this session — what they asked, what you answered, a link or a decision — call search_history FIRST and answer from the hits with their dates. Never tell this user you have no conversation history or cannot look back: you can, through that tool. Only after a search comes back empty may you say you found nothing about it.\nAnswer directly; do not expose reasoning.`,
    searchMessage ? searchMessage.content : null,
    graphMessage ? graphMessage.content : null,
  ].filter(Boolean).join("\n\n");
  const messages = [
    { role: "system", content: leadingSystem },
    ...history,
    { role: "user", content: prompt },
  ];

  const headers = { "content-type": "application/json" };
  if (brainProfile.apiKey) headers.authorization = `Bearer ${brainProfile.apiKey}`;

  // One overall deadline, comfortably inside the browser's 60 s request
  // timeout: the brain may spend it on at most a few tool round-trips.
  const { data, webResults, webSources, graphUsed, graphWriteSucceeded } = await runBrain({ messages, brainProfile, user, useTools: Boolean(mcpFlags.graph && graphStore), webTools: Boolean(mcpFlags.websearch), webSourcesList, vikunjaTools, vikunjaClient, vikunjaToolNames, externalMcp: externalMcpEntries, admin: isAdmin(user), lang: language === "de" ? "de" : "en", historySettings, requestId, signal, headers,
    deadlineMs: 50000 });
  const answer = extractAnswer(data);
  if (!answer) {
    const finishReason = data?.choices?.[0]?.finish_reason || "";
    console.log(JSON.stringify({ level: "error", requestId, msg: "brain_empty_answer", finishReason, usage: data?.usage || {} }));
    throw new Error(finishReason === "length"
      ? "The brain spent its whole token budget on reasoning and returned no answer; ask again."
      : "Brain returned no answer text");
  }

  // The "[sources: …]" line the brain is instructed to append to web-based
  // answers: validate every name against the sources that actually ran for
  // this turn (the pre-search result hosts, the web tool results' source
  // names, the user's own feeds and the built-in source display names), drop
  // hallucinated names, and strip the line from the answer. The validated
  // names are the turn's websearch attribution — nothing else reaches the
  // tag, the history, the stored turn or the graph.
  const { answer: finalAnswer, names: reportedNames } = splitAttribution(answer);
  const knownSourceNames = new Set();
  for (const name of [...searchSources, ...webSources, ...(webSourcesList?.feeds || []).map((feed) => feed.source)]) {
    const normalized = normalizeSourceName(name);
    if (normalized) knownSourceNames.add(normalized);
  }
  if (webSourcesList) {
    for (const entry of await builtinWebSources()) {
      const normalized = normalizeSourceName(entry.source);
      if (normalized) knownSourceNames.add(normalized);
    }
  }
  const reportedSources = [];
  const seenReported = new Set();
  for (const name of reportedNames) {
    const normalized = normalizeSourceName(name);
    if (!normalized || !knownSourceNames.has(normalized) || seenReported.has(normalized)) continue;
    seenReported.add(normalized);
    reportedSources.push(name);
    if (reportedSources.length >= 8) break;
  }
  const cleanAnswer = finalAnswer || answer;

  const nextHistory = history.concat({ role: "user", content: prompt }, { role: "assistant", content: cleanAnswer })
    .slice(-Math.max(BRAIN_HISTORY_MESSAGES, historySettings.memoryTurns * 2));
  conversations.set(user, nextHistory);
  // Store ordinary turns in the knowledge graph after the answer is handed
  // back: fire-and-forget so the spoken reply is never blocked by or fails on
  // the graph. Stored policy: the automatic storage runs only for turns whose
  // request carries the Knowledge graph MCP toggle on — with it off the turn
  // stores nothing (and the brain above is told so, so it does not promise to
  // remember what it cannot store). If this turn already used an explicit
  // graph write tool, do not run extraction over the prompt/confirmation
  // text: a delete confirmation such as "X was removed" can otherwise
  // reintroduce X as a fresh negative fact immediately after deleting it.
  if (mcpFlags.graph && graphStore && !isAdmin(user) && !graphWriteSucceeded) {
    // The admin is a service account for graph maintenance: ingesting its
    // turns would mint owner=admin copies of every user's entities it touches
    // (renames, corrections), polluting the per-user world. The admin changes
    // the graph only through its explicit write tools.
    // The extractor reads what the turn actually used: the up-front search
    // results plus any web tool results the brain gathered itself.
    ingestTurn({ user, prompt, searchResults: [searchMessage?.content, ...webResults].filter(Boolean).join("\n\n") || null, answer: cleanAnswer, brainProfile, requestId }).catch(() => {});
  }
  // Strict attribution: the tag appears only when the brain named at least
  // one source that actually ran for this turn — a search that ran but was
  // not used in the answer (or an unverifiable "[sources: …]" line) leaves
  // the tag off.
  return { requestId, answer: cleanAnswer, configured: true, model: brainProfile.model, brainProfile: brainProfile.id, brainProfileLabel: brainProfile.label, sources: { websearch: reportedSources.length > 0, graph: Boolean(graphUsed), websearchSources: reportedSources } };
}

// The graph tools offered to the brain when the knowledge graph toggle is on.
// Parameterized reads — there is no Cypher on the surface: mcp/graph.mjs
// builds every query itself, pinned to the signed-in user (injected by this
// backend per call), so a chat turn can never reach another user's data. The
// same owner pin now applies to write/delete tools for regular users: they
// can correct or remove their own stored graph data, but not another user's.
// For the admin session the same read tools run across all owners and the
// write tools accept an owner argument (the backend injects `admin: true` per
// call — never the brain). The MCP server independently enforces the owner
// and admin gates.
// Five rounds: a schema call plus a few follow-ups is the common pattern.
const GRAPH_TOOL_ROUNDS = 5;
const GRAPH_TOOL_TIMEOUT_MS = 15000;
const GRAPH_TOOL_NAMES = new Set(["get-schema", "get-entity", "list-my-knowledge", "list-my-facts"]);
// The write/delete surface — offered to EVERY session with graph tools;
// non-admin calls are owner-scoped to the signed-in user by this backend and
// re-validated in mcp/graph.mjs. Admin calls may target any registered owner.
const GRAPH_WRITE_TOOL_NAMES = new Set(["store-entity", "store-fact", "rename-entity", "delete-entity"]);
// The success prefixes of the MCP write results. The backend verifies a write
// tool ACTUALLY changed something before the brain may claim it to the user:
// a "No entity named …" answer is a non-error result, and unverified the brain
// turns it into "Done, removed." (live incident 2026-10-10: three claimed
// deletions, three entities still in the graph).
const GRAPH_WRITE_SUCCESS_PREFIX = { "delete-entity": 'Deleted "', "store-entity": "Stored ", "store-fact": "Stored ", "rename-entity": 'Renamed "' };
function graphTools(admin) {
  const tools = [
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
          : "Look up one of the signed-in user's own entities (person, place, thing, ...) by name (a close phrasing is fine — on a miss the closest stored names are reported): its data and its links. Returns nothing if the user has no such entity.",
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
          ? "List every user's stored facts (likes, ownership, family, home, work, the questions they asked — ASKED_ABOUT, with the date — ...), optionally filtered to one entity (about) or one relation type (relation, e.g. LIKES)."
          : "List the facts stored about the signed-in user (likes, ownership, family, home, work, the questions they asked — ASKED_ABOUT, with the date and time of the question — ...), optionally filtered to one entity (about) or one relation type (relation, e.g. ASKED_ABOUT).",
        parameters: { type: "object", properties: { about: { type: "string", description: "Optional: only facts about this entity name." }, relation: { type: "string", description: "Optional: only this relation type, e.g. LIKES." } } },
      },
    },
  ];
  // Write/delete surface. Regular sessions get their own scoped variant (no
  // owner parameter is exposed; the backend injects owner=user). The admin
  // session gets the cross-user variant with an explicit registered owner.
  tools.push(
      {
        type: "function",
        function: {
          name: "store-entity",
          description: admin
            ? "Store an entity under a user's name (admin only): owner (a registered user), name, type (person, place, organization, event, topic or thing). An entity named after a registered user becomes that user's account node."
            : "Store an entity in this signed-in user's own graph: name and type (person, place, organization, event, topic or thing). An entity named after a registered user becomes that user's account node.",
          parameters: {
            type: "object",
            properties: {
              ...(admin ? { owner: { type: "string", description: "The registered user the entity is stored for, e.g. 'Mila'." } } : {}),
              name: { type: "string", description: "The entity name, e.g. 'Berlin'." },
              type: { type: "string", description: "One of: person, place, organization, event, topic, thing (default thing)." },
            },
            required: admin ? ["owner", "name"] : ["name"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "store-fact",
          description: admin
            ? "Store a fact (a typed link) under a user's name (admin only): owner (a registered user), from, to, type (e.g. LIKES, LIVES_IN, WATCHES), negative (true for 'doesn't like'). Endpoints named after registered users are their account nodes; other endpoints are (or become) the owner's entities."
            : "Store a fact (a typed link) in this signed-in user's own graph: from, to, type (e.g. LIKES, LIVES_IN, WATCHES), negative (true for 'doesn't like'). Endpoints named after registered users are their account nodes; other endpoints are (or become) this user's entities.",
          parameters: {
            type: "object",
            properties: {
              ...(admin ? { owner: { type: "string", description: "The registered user the fact is stored for, e.g. 'Mila'." } } : {}),
              from: { type: "string", description: "The source name (a user or an entity)." },
              to: { type: "string", description: "The target name (a user or an entity)." },
              type: { type: "string", description: "The relation type, e.g. LIKES (UPPER_SNAKE_CASE)." },
              negative: { type: "boolean", description: "True when the fact is negated ('doesn't like' = LIKES + negative)." },
            },
            required: admin ? ["owner", "from", "to", "type"] : ["from", "to", "type"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "rename-entity",
          description: admin
            ? "Rename an entity of a user in place (admin only): owner (a registered user), name (stored name or a close phrasing — a unique close match is resolved automatically) and newName. All of the entity's links survive the rename — use it for renames instead of delete+store. The new name must be free for that user (case-insensitively) and must not be a registered user's name."
            : "Rename one of this signed-in user's own entities in place: name (stored name or a close phrasing — a unique close match is resolved automatically) and newName. All links survive the rename — use it for renames instead of delete+store. The new name must be free for this user and must not be a registered user's name.",
          parameters: {
            type: "object",
            properties: {
              ...(admin ? { owner: { type: "string", description: "The registered user who owns the entity, e.g. 'Roman'." } } : {}),
              name: { type: "string", description: "The current entity name, e.g. 'TradingMonitor List'." },
              newName: { type: "string", description: "The new entity name, e.g. 'Trading'." },
            },
            required: admin ? ["owner", "name", "newName"] : ["name", "newName"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "delete-entity",
          description: admin
            ? "Delete an entity of a user together with its links (admin only): owner (a registered user) and name (stored name or a close phrasing — a unique close match is resolved automatically). Account nodes of users can never be deleted."
            : "Delete one of this signed-in user's own entities together with its links. Pass the stored name or a close phrasing — a unique close match (e.g. a longer phrasing of the stored name) is resolved automatically. Account nodes of users can never be deleted.",
          parameters: {
            type: "object",
            properties: {
              ...(admin ? { owner: { type: "string", description: "The registered user who owns the entity, e.g. 'Roman'." } } : {}),
              name: { type: "string", description: "The entity name to delete, e.g. 'Berlin'." },
            },
            required: admin ? ["owner", "name"] : ["name"],
          },
        },
      },
  );
  return tools;
}

// The web tools offered to the brain when the web-search toggle is on. Both
// are read-only live lookups (mcp/websearch.mjs runs free keyless engines and
// news sources); `lang` is injected per call by this backend — like the graph
// user — so the brain (or a prompt injection) cannot steer the locale.
const WEB_TOOL_NAMES = new Set(["web_search", "web_news", "web_fetch"]);
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
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Open a specific URL in a real headless browser (as a human user's browser would) and return the rendered page as text. Use it when the user asks to pull or open a specific page — e.g. a stock quote or a link from the web_search results — or when a search snippet is too thin to answer. It runs the page's JavaScript, so it reads dynamic content a plain fetch would miss. Pass the exact URL.",
        parameters: { type: "object", properties: { url: { type: "string", description: "The http(s) URL to open." }, max_chars: { type: "number", description: "Optional maximum characters of page text to return (default 12000, max 30000)." } }, required: ["url"] },
      },
    },
  ];
}

// The conversation-history tool. Always offered — it reads nothing but the
// signed-in user's OWN stored turns, which they can already see in the
// Prompt/Answer panels, so there is no toggle to get wrong. It exists
// because the brain's in-context memory is only the last few turns: without
// it, anything older ("what did I ask you about X last week?") is invisible
// and the brain truthfully but uselessly says it has no record.
const HISTORY_TOOL_NAMES = new Set(["search_history"]);
const HISTORY_SEARCH_MAX_DAYS = 365;
const HISTORY_SEARCH_DEFAULT_DAYS = 90;
const HISTORY_SEARCH_MAX_RESULTS = 20;
const HISTORY_SEARCH_DEFAULT_RESULTS = 6;
// Long turns are truncated per field so a handful of hits cannot blow the
// brain's context budget.
const HISTORY_SNIPPET_CHARS = 600;

function historyTools() {
  return [
    {
      type: "function",
      function: {
        name: "search_history",
        description: "Search this user's own earlier conversations with you (their stored prompts and your answers). It is a SEMANTIC search: it finds turns that mean the same thing even when they use different words or another language, so 'where did I park my car' finds a turn that only said 'Tesla' or 'Wagen'. It also matches literal words. Use it whenever the user refers to something from a past conversation — 'what did I ask you about X', 'what did you tell me last week', 'the link you gave me', 'did we talk about Y' — or when you need what was agreed earlier. Your in-context memory only covers the last few turns of this session; everything older is reachable ONLY through this tool, so search before saying you have no record of something.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, as the user would say it, e.g. 'where I parked the car' or 'Vikunja token'. Meaning is matched as well as words, so a short natural phrase works better than keywords." },
            days: { type: "number", description: `How far back to look, in days (default ${HISTORY_SEARCH_DEFAULT_DAYS}, max ${HISTORY_SEARCH_MAX_DAYS}).` },
            max_results: { type: "number", description: `Maximum number of matching turns (default ${HISTORY_SEARCH_DEFAULT_RESULTS}, max ${HISTORY_SEARCH_MAX_RESULTS}).` },
          },
          required: ["query"],
        },
      },
    },
  ];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// Every knob of the history search in one place: the limits are the contract
// the UI panel renders sliders from (/api/config) and the ceiling the backend
// clamps each request to, so a hand-made request can never widen them.
const HISTORY_SETTINGS = {
  days: { min: 1, max: HISTORY_SEARCH_MAX_DAYS, step: 1, default: HISTORY_SEARCH_DEFAULT_DAYS },
  maxResults: { min: 1, max: HISTORY_SEARCH_MAX_RESULTS, step: 1, default: HISTORY_SEARCH_DEFAULT_RESULTS },
  snippetChars: { min: 100, max: 2000, step: 50, default: HISTORY_SNIPPET_CHARS },
  minScore: { min: 0.3, max: 0.9, step: 0.01, default: EMBEDDING_MIN_SCORE },
  strongScore: { min: 0.4, max: 0.95, step: 0.01, default: EMBEDDING_STRONG_SCORE },
  memoryTurns: { min: 1, max: 20, step: 1, default: BRAIN_HISTORY_MESSAGES / 2 },
};

// The browser's panel sends these with every /api/chat request; anything
// missing or out of range falls back to the configured default.
function normalizeHistorySettings(raw) {
  const given = raw && typeof raw === "object" ? raw : {};
  const clamped = {};
  for (const [key, spec] of Object.entries(HISTORY_SETTINGS)) {
    clamped[key] = spec.step < 1
      ? clampFloat(given[key], spec.min, spec.max, spec.default)
      : clampNumber(given[key], spec.min, spec.max, spec.default);
  }
  return clamped;
}

function snippet(text, chars = HISTORY_SNIPPET_CHARS) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > chars ? `${clean.slice(0, chars)}…` : clean;
}

// Hybrid search over the signed-in user's own rows only — both halves pin
// `user` inside the store, so a prompt injection riding on the brain cannot
// widen either one to another account.
//
// Keyword matching is exact and high precision; semantic matching finds the
// turn that means the same thing in other words (or another language). They
// find different turns, so the result is their union: a turn the words hit is
// worth showing even when its vector scores low, and vice versa.
async function searchHistory(user, args, settings = normalizeHistorySettings()) {
  const query = String(args.query || "").trim();
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return "No query given. Call search_history again with the words to look for.";
  // The user's panel value is the CEILING, not a suggestion: the brain may
  // narrow the window or ask for fewer turns, but its own `days` /
  // `max_results` can never widen past what the slider allows. (Measured
  // live: the brain sends max_results of its own, so treating the panel
  // value as a mere default let a "max results 1" setting return eight
  // turns.)
  const days = clampNumber(args.days, 1, settings.days, settings.days);
  const limit = clampNumber(args.max_results, 1, settings.maxResults, settings.maxResults);
  const floor = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const keywordRows = conversationStore.search(terms, { user, floor, limit });
  let semanticRows = [];
  let semanticNote = "";
  if (embeddingConfigured) {
    try {
      semanticRows = await semanticMatches(user, query, floor, limit, settings.minScore);
    } catch (error) {
      // Degrade, never fail the turn: the keyword half still answers.
      semanticNote = " (meaning-based matching was unavailable for this search, so only word matches are listed)";
      console.log(JSON.stringify({ level: "warn", msg: "history_semantic_failed", error: String(error.message || error).slice(0, 200) }));
    }
  } else {
    semanticNote = " (meaning-based matching is not configured, so only word matches are listed)";
  }

  // Union, keyword first so an exact hit is never pushed out by a vector one,
  // and capped at `limit` overall — "max results 6" must mean six turns, not
  // six per half. Semantic hits arrive best-score-first, so the ones that fill
  // the remaining slots are the strongest.
  const byId = new Map();
  for (const row of keywordRows) byId.set(row.id, { ...row, how: "words" });
  for (const row of semanticRows) {
    const existing = byId.get(row.id);
    if (existing) existing.how = `words + meaning, similarity ${row.score.toFixed(2)}`;
    else if (byId.size < limit) byId.set(row.id, { ...row, how: `meaning, similarity ${row.score.toFixed(2)}${row.score < settings.strongScore ? " — loosely related, treat with care" : ""}` });
  }
  const rows = [...byId.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!rows.length) return `Nothing in this user's last ${days} days of conversation matches "${query}", by words or by meaning${semanticNote}.`;
  // Oldest first reads like a conversation; the dates are what the user will
  // recognise, so they lead each hit.
  return [`${rows.length} earlier turn(s) matching "${query}", oldest first${semanticNote}:`]
    .concat(rows.map((row) => `[${row.ts}] (matched by ${row.how})\nUser: ${snippet(row.prompt, settings.snippetChars)}\nYou: ${snippet(row.answer, settings.snippetChars)}`))
    .join("\n\n");
}

// One short, loggable description of a tool call for the activity feed —
// never raw Cypher (there is none on the surface anymore).
function graphToolDetail(name, args) {
  const parts = [];
  if (args.owner) parts.push(`owner=${args.owner}`);
  if (args.name) parts.push(`name=${args.name}`);
  if (args.newName) parts.push(`newName=${args.newName}`);
  if (args.from) parts.push(`from=${args.from}`);
  if (args.to) parts.push(`to=${args.to}`);
  // As sent (relation types arrive UPPER_SNAKE_CASE, entity types lowercase);
  // the audit line mirrors the call, not a re-derivation.
  if (args.type) parts.push(`type=${String(args.type).slice(0, 24)}`);
  if (args.negative === true) parts.push("negative");
  if (args.about) parts.push(`about=${args.about}`);
  if (args.relation) parts.push(`relation=${String(args.relation).toUpperCase()}`);
  return parts.length ? `${name}: ${parts.join(", ")}` : name;
}

async function runBrain({ messages, brainProfile, user, useTools, webTools: webToolsOn = false, webSourcesList = null, vikunjaTools = null, vikunjaClient = null, vikunjaToolNames = null, externalMcp = [], admin = false, lang = "de", historySettings = normalizeHistorySettings(), requestId, signal, headers, deadlineMs }) {
  const local = [...messages];
  const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
  // Web tool results collected for post-turn ingestion (the extractor reads
  // the search context the turn actually used), separate from the answer.
  const webResults = [];
  // The source names behind every web tool result of this turn — the
  // attribution the UI shows with the answer.
  const webSources = [];
  let graphWriteSucceeded = false;
  let graphUsed = false;
  // search_history is always in the tool set: it is the user's own stored
  // conversation and has no browser toggle, so the brain can always reach
  // back past its in-context window.
  const hasTools = true;
  const externalLookup = new Map();
  for (const entry of externalMcp) for (const [name, target] of entry.lookup) externalLookup.set(name, target);
  for (let round = 0; ; round += 1) {
    const body = {
      model: brainProfile.model,
      messages: local,
      temperature: 0.2,
      // The brain is a reasoning model: max_tokens covers its thinking tokens
      // too, so an undersized budget is spent on reasoning and the reply comes
      // back with empty content (finish_reason "length"). 4096 leaves ~26 s of
      // budget at the measured ~150 tok/s while staying inside the timeout.
      max_tokens: 4096,
    };
    if (hasTools) body.tools = [...(useTools ? graphTools(admin) : []), ...(webToolsOn ? webTools() : []), ...(vikunjaTools || []), ...externalMcp.flatMap((entry) => entry.openai), ...historyTools()];
    let data;
    try {
      const response = await fetch(`${brainProfile.baseUrl}/chat/completions`, {
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
    let toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    // Some brain endpoints (DeepSeek behind an OpenAI-compatible proxy) answer
    // with the model's NATIVE tool-call XML inside `content` instead of the
    // OpenAI `tool_calls` field — e.g.
    //   <|tool_calls|><|invoke| name="list-my-facts"><|parameter|
    //   name="relation" string="true">PART_OF<|/parameter|><|/invoke|>
    //   <|/tool_calls|>
    // Unparsed, that XML would be spoken and rendered as the answer. The
    // anchors (invoke/parameter tags with name="...") are matched leniently:
    // the wrapper tokens vary between model builds.
    let fromXml = false;
    if (!toolCalls.length && hasTools) {
      toolCalls = graphdb.parseToolCallsFromContent(message?.content);
      fromXml = toolCalls.length > 0;
    }
    if (!hasTools || !toolCalls.length) return { data, webResults, webSources, graphUsed, graphWriteSucceeded };
    if (round >= GRAPH_TOOL_ROUNDS) {
      // Tool budget spent: force a final answer without tools.
      // Tool budget spent: force a final answer without tools. The nudge
      // rides as a `user` turn, not a `system` one: a system message after
      // the conversation is rejected outright by strict endpoints — OVH AI
      // Endpoints answer HTTP 400 "System message must be at the beginning."
      // (seen live 2026-10-17), while vLLM/llama.cpp tolerate it. Every
      // system message in this app therefore stays in the leading block, and the leading block itself is one single system message.
      local.push({ ...message, role: "assistant" }, { role: "user", content: "Tool budget reached. Answer now from what you have gathered." });
      const fallback = await fetch(`${brainProfile.baseUrl}/chat/completions`, {
        method: "POST", signal: totalSignal, headers,
        body: JSON.stringify({ model: brainProfile.model, messages: local, temperature: 0.2, max_tokens: 4096 }),
      });
      const fallbackText = await fallback.text();
      if (!fallback.ok) throw new Error(`Brain HTTP ${fallback.status}: ${fallbackText.slice(0, 500)}`);
      return { data: JSON.parse(fallbackText), webResults, webSources, graphUsed, graphWriteSucceeded };
    }
    // For XML-parsed calls the raw message carries no tool_calls field, so
    // carry the parsed ones on the assistant turn: the tool results below
    // reference their ids, and the next round's history stays protocol-valid.
    local.push(fromXml
      ? { role: "assistant", content: message.content, tool_calls: toolCalls }
      : { ...message, role: "assistant" });
    for (const call of toolCalls) {
      const name = String(call.function?.name || "");
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* malformed args -> error result below */ }
      const started = Date.now();
      if (useTools && (GRAPH_TOOL_NAMES.has(name) || GRAPH_WRITE_TOOL_NAMES.has(name))) {
        // The session user, the admin flag and the registered user list are
        // injected HERE, not in the brain's tool schema: the brain (or a
        // prompt injection riding on it) can only ever target the signed-in
        // user's own data — cross-owner admin queries and cross-owner writes
        // are reachable only for the admin session (the spread order
        // means a brain-supplied user/admin/users can never win).
        try {
          const result = await withAbort(mcpGraph.call(name, { ...args, user, admin, users: config.users }, GRAPH_TOOL_TIMEOUT_MS), totalSignal);
          const isWrite = GRAPH_WRITE_TOOL_NAMES.has(name);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          if (!isWrite && !result.isError) graphUsed = true;
          // Write tools are verified on their success prefix: a "No entity
          // named …" / "No unique match …" answer is a NON-error result, and
          // without this check the brain would claim the delete anyway.
          let toolContent = resultText || "No result.";
          const prefix = GRAPH_WRITE_SUCCESS_PREFIX[name];
          const writeOk = isWrite && !result.isError && typeof prefix === "string" && toolContent.startsWith(prefix);
          if (writeOk) graphWriteSucceeded = true;
          if (isWrite && !writeOk) {
            // The backend — not the (possibly prompt-injected) model — tells
            // the brain the truth: nothing was written.
            toolContent += ` The operation did NOT succeed — the tool reported the message above. Do not claim it did; tell the user honestly what happened.`;
          }
          recordGraphActivity({ kind: isWrite ? "brain_write" : "brain_query", user, tool: name, detail: graphToolDetail(name, args).slice(0, 200), ok: isWrite ? writeOk : !result.isError, error: (isWrite ? !writeOk : result.isError) ? toolContent.slice(0, 200) : undefined, ms: Date.now() - started });
          local.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          recordGraphActivity({ kind: GRAPH_WRITE_TOOL_NAMES.has(name) ? "brain_write" : "brain_query", user, tool: name, detail: graphToolDetail(name, args).slice(0, 200), ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started });
          local.push({ role: "tool", tool_call_id: call.id, content: `Graph lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else if (HISTORY_TOOL_NAMES.has(name)) {
        // Local SQLite read, scoped to the signed-in user inside the store —
        // the brain's arguments carry no user and cannot add one.
        try {
          const resultText = await withAbort(searchHistory(user, args, historySettings), totalSignal);
          console.log(JSON.stringify({ level: "info", requestId, msg: "history_tool", tool: name, query: String(args.query || "").slice(0, 200), ms: Date.now() - started, chars: resultText.length }));
          local.push({ role: "tool", tool_call_id: call.id, content: resultText });
        } catch (error) {
          console.log(JSON.stringify({ level: "warn", requestId, msg: "history_tool", tool: name, ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started }));
          local.push({ role: "tool", tool_call_id: call.id, content: `History lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else if (webToolsOn && WEB_TOOL_NAMES.has(name)) {
        // The answer language is injected HERE (like the graph user): the
        // brain's web tool schema has no lang parameter. The signed-in
        // user's enabled source list goes in the same way (web_search /
        // web_news only — web_fetch takes an explicit URL and is
        // unaffected by which sources are switched on). The brain never sees
        // either: they are absent from the tool schema.
        const webSourcesArg = webSourcesList && name !== "web_fetch" ? { webSources: webSourcesList } : {};
        try {
          const result = await withAbort(mcpWebSearch.call(name, { ...args, lang, ...webSourcesArg }, WEB_TOOL_TIMEOUT_MS), totalSignal);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          const detail = (name === "web_news" ? args.topic : name === "web_fetch" ? args.url : args.query) || "";
          console.log(JSON.stringify({ level: "info", requestId, msg: "websearch_tool", tool: name, detail: String(detail).slice(0, 300), ok: !result.isError, ms: Date.now() - started, chars: resultText.length }));
          if (!result.isError) {
            webResults.push(`${name} (${detail}):\n${resultText}`);
            for (const sourceName of sourceNamesFromMcp(result)) {
              if (!webSources.includes(sourceName)) webSources.push(sourceName);
            }
          }
          local.push({ role: "tool", tool_call_id: call.id, content: resultText || "No result." });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          console.log(JSON.stringify({ level: "warn", requestId, msg: "websearch_tool", tool: name, ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started }));
          local.push({ role: "tool", tool_call_id: call.id, content: `Web lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else if (vikunjaClient && vikunjaToolNames?.has(name)) {
        // The (region, user) pinning happens at spawn time (the child was
        // started with this user's own token for this region's instance), so
        // the call itself needs no user injection — and no other user's
        // account is reachable from this child.
        try {
          const result = await withAbort(vikunjaClient.call(name, args, VIKUNJA_TOOL_TIMEOUT_MS), totalSignal);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          console.log(JSON.stringify({ level: "info", requestId, msg: "vikunja_tool", tool: name, ok: !result.isError, ms: Date.now() - started, chars: resultText.length }));
          local.push({ role: "tool", tool_call_id: call.id, content: resultText || "No result." });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          console.log(JSON.stringify({ level: "warn", requestId, msg: "vikunja_tool", tool: name, ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started }));
          local.push({ role: "tool", tool_call_id: call.id, content: `Vikunja lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else if (externalLookup.has(name)) {
        // Mesh-internal service tools (namespaced <id>_<tool>): one shared
        // child per service, so the call itself carries no user context —
        // the transport (ssh key / API token / loopback endpoint) IS the scope.
        const { client, tool, entry } = externalLookup.get(name);
        try {
          const result = await withAbort(client.call(tool, args, EXTERNAL_TOOL_TIMEOUT_MS), totalSignal);
          const resultText = (result.content || []).map((item) => item.text || "").join("\n").trim();
          console.log(JSON.stringify({ level: "info", requestId, msg: "external_mcp_tool", server: entry.id, tool: name, ok: !result.isError, ms: Date.now() - started, chars: resultText.length }));
          local.push({ role: "tool", tool_call_id: call.id, content: resultText || "No result." });
        } catch (error) {
          if (totalSignal.aborted) throw error;
          console.log(JSON.stringify({ level: "warn", requestId, msg: "external_mcp_tool", server: entry.id, tool: name, ok: false, error: String(error.message || error).slice(0, 200), ms: Date.now() - started }));
          local.push({ role: "tool", tool_call_id: call.id, content: `${entry.label} lookup failed: ${error.message}. Answer from what you know.` });
        }
      } else {
        // A write-tool name from a non-admin brain (or a typo) is still an
        // attempted write: audit it as one, even though nothing ran.
        if (useTools) recordGraphActivity({ kind: GRAPH_WRITE_TOOL_NAMES.has(name) ? "brain_write" : "brain_query", user, tool: name, ok: false, error: "unknown tool", ms: 0 });
        // The write/delete tools are offered to every session (owner-scoped
        // for regular users), so they belong in the hint for everyone.
        const available = [
          ...(useTools ? ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts", "store-entity", "store-fact", "rename-entity", "delete-entity"] : []),
          ...(webToolsOn ? ["web_search", "web_news", "web_fetch"] : []),
          ...(vikunjaToolNames ? [...vikunjaToolNames] : []),
          ...externalLookup.keys(),
        ];
        local.push({ role: "tool", tool_call_id: call.id, content: `Unknown tool. Use: ${available.join(", ")}.` });
      }
    }
  }
}

// --- Knowledge graph ingestion (the automatic write path) -------------------
// The other write path is the admin session's MCP write tools (store-entity,
// store-fact, rename-entity, delete-entity) — an explicit, audited admin
// action, never the ingestion.

const EXTRACT_SYSTEM_PROMPT = `You extract knowledge-graph entities from a voice-assistant conversation turn.
Return ONLY a JSON object, no prose, with this exact shape:
{"entities":[{"name":"...","type":"person|place|organization|event|topic|thing","props":{"key":"value"}}],"relations":[{"from":"EntityName","to":"EntityName","type":"RELATION_TYPE","negative":false}],"question_subjects":["EntityName"]}
Rules:
- Extract from the prompt, the web search results and the answer together.
- "name" is a short canonical name (e.g. "Mila", "Berlin", "Kokoro-82M"), at most a few words.
- type must be exactly one of: person, place, organization, event, topic, thing.
- The graph is the signed-in user's private world: every extracted entity is stored under their name, so no shared/public flag exists and nothing you extract is visible to any other user.
- Always include the signed-in user (the name on the "user:" line) as a person entity with their exact name.
- First-person statements in the prompt are facts to store, never skip them: "I like X" -> LIKES, "I'm interested in X" -> INTERESTED_IN, "I own X" or "I have X" -> OWNS, "I live in X" -> LIVES_IN, "I work at X" -> WORKS_AT, "my friend/mother/family is Y" -> FRIEND_OF/FAMILY_OF, always with "from" set to the user's entity name.
 - If the user's PROMPT is a question or request about specific things (a person, film, place, topic, ...), put their canonical names in "question_subjects" (each one MUST also appear in "entities" with the right type). The assistant links each subject to the signed-in user automatically, with the date and time of the question — so "tell me more about Jean Reno" stores Jean Reno as an entity connected to the user. For statements, save/track commands and questions about no entity (the time, the weather, "can you do X") return "question_subjects": []. At most 3 subjects.
 - When the turn answers a question, the ANSWER's concrete entities are stored too: the things the answer names (films, albums, works, people, places, ...) go into "entities", and each answer entity that relates to a question subject gets a relation to it — a film the subject acted in or directed -> ACTED_IN from the subject to the film (a genuine relation none of the known types expresses, so the new type is created automatically). A few high-confidence links are enough; do not pad with guesses.
 - Example: user "Roman", prompt "Tell me more about Jean Reno.", the answer runs through his films ->
   {"entities":[{"name":"Roman","type":"person"},{"name":"Jean Reno","type":"person"},{"name":"Léon: The Professional","type":"thing"},{"name":"La Femme Nikita","type":"thing"}],"relations":[{"from":"Jean Reno","to":"Léon: The Professional","type":"ACTED_IN","negative":false},{"from":"Jean Reno","to":"La Femme Nikita","type":"ACTED_IN","negative":false}],"question_subjects":["Jean Reno"]}
 - Never emit a relation of type ASKED_ABOUT yourself: it is stored automatically for the question subjects.
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
async function ingestTurn({ user, prompt, searchResults, answer, brainProfile, requestId }) {
  const started = Date.now();
  const headers = { "content-type": "application/json" };
  if (brainProfile.apiKey) headers.authorization = `Bearer ${brainProfile.apiKey}`;
  try {
    const response = await fetch(`${brainProfile.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      // 45 s, like the brain's own deadline: a full 4096-token budget can be
      // ~27 s of pure reasoning at the measured ~150 tok/s, so the old 30 s
      // abort would race the extraction.
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model: brainProfile.model,
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
    const { upserted, relations: linked, skippedUsers, skippedUnconnected, orphansRemoved } = await graphStore.upsertTurn({ user, ...extraction });
    // Report what was actually written, not what the extractor emitted: the
    // store skips an entity named after a registered user (it is that user's
    // account node, never an :Entity) and one no fact connects, and its
    // end-of-ingest check removes any orphan it still finds — so "extracted"
    // can exceed "stored" for three distinct reasons, each counted on its own.
    recordGraphActivity({ kind: "ingest", user, entities: upserted, relations: linked, skippedUsers, skippedUnconnected, orphansRemoved: orphansRemoved.length });
    console.log(JSON.stringify({ level: "info", requestId, msg: "graph_ingest_success", ms: Date.now() - started, extracted: extraction.entities.length, stored: upserted, extractedRelations: extraction.relations.length, linked, subjects: extraction.subjects.length, skippedUsers, skippedUnconnected, orphansRemoved }));
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
