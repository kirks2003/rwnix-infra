#!/usr/bin/env node
// Minimal Model Context Protocol server (stdio transport, newline-delimited
// JSON-RPC 2.0) exposing three tools to the Jarvis backend:
//   - web_search: general web search (see below)
//   - web_news: latest news for a topic or an interest area (technik, it,
//     finance, geek, nerd) from free keyless news sources
//   - web_fetch: open a URL in a real headless Chromium browser (a human
//     browser's TLS/HTTP2 fingerprint plus JavaScript execution — what
//     bypasses bot recognition that a header set alone cannot) and hand the
//     rendered page text to the brain. This is what lets "pull the price
//     from google finance" work: the quote loads in a post-load XHR, so only
//     a browser that runs the page's JS sees it.
// The backend spawns this process on demand (see mcpWebSearch in server.js).
//
// web_search runs every free keyless engine in parallel and merges the
// results (round-robin, deduplicated by URL; see mergeResults in engines.mjs):
//   - DuckDuckGo HTML (result links unwrapped from the redirect form)
//   - Bing HTML (result links unwrapped from the bing.com/ck/a redirect)
//   - Wikipedia search API (structured, no bot wall)
//   - DuckDuckGo Instant Answer API (abstract/definition/answer/related
//     topics — the "AI answer" layer, separate from the result list)
// Each engine degrades to zero results on a bot wall (403/429/captcha/202
// challenge from datacenter IPs) without failing the whole search.
//
// web_news queries, also in parallel (each source degrades to zero items):
//   - Bing News RSS (https://www.bing.com/news/search?q=…&format=rss) — the
//     primary news search; its apiclick.aspx links are HTTP redirects to the
//     real article and are resolved server-side
//   - the curated interest feeds in engines.mjs (INTEREST_FEEDS) for the
//     interest areas: heise/Golem (technik), Ars Technica/The Verge/
//     TechCrunch (it), CNBC/MarketWatch/FT (finance), Hacker News/Lobsters
//     (geek), r/programming + HN + Lobsters (nerd)
//   - Google News RSS (free-form topics only) as a breadth backup: its links
//     are JS-only wrappers (the 200 page is an app shell, no server-side
//     redirect), so it only fills slots the primary sources left empty
// Measured availability from the production server IP (2026-10-05, twice):
// DuckDuckGo is *intermittent* from datacenter IPs (connection-level refusal
// on the first probe, HTTP 200 again hours later — a rate limit, not a ban);
// GDELT times out; Bing News RSS, Google News RSS, Bing HTML, Wikipedia and
// all interest feeds work consistently. Search requests therefore carry a
// full Chrome header set with a language-aware Accept-Language
// (browserHeaders in engines.mjs) so they look like a normal user request —
// a bare user-agent is the classic bot tell, and Accept-Language is what
// gets German queries to return German results. See DEPLOYMENT.md, "Live web
// search + news for the brain".

import readline from "node:readline";
import dns from "node:dns/promises";
import {
  cleanHtml, decodeDuckDuckGoHref, decodeBingUrl, mergeResults, formatSearchResults,
  normalizeUrlForDedupe, browserHeaders, INTEREST_FEEDS, normalizeTopic, parseFeedItems, formatNewsItems,
  isSafeFetchUrl, isBlockedIp, htmlToText,
} from "./engines.mjs";

const TOOL = {
  name: "web_search",
  description: "Search the web for a query. Runs the free keyless engines (DuckDuckGo, Bing, Wikipedia) in parallel plus the DuckDuckGo instant-answer API and returns the merged top results as title, URL and snippet, tagged with their source engine.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "number", description: "Maximum number of merged results to return (default 5, max 10)." },
    },
    required: ["query"],
  },
};

// `lang` is injected by the backend (the answer language) — it is not part of
// the brain-facing tool schema, so a prompt injection cannot steer the locale.
const NEWS_TOOL = {
  name: "web_news",
  description: "Fetch the latest news (past 7 days) from free news sources: Google News RSS, Bing News RSS and curated RSS feeds (heise, Golem, Ars Technica, The Verge, TechCrunch, CNBC, MarketWatch, Financial Times, Hacker News, Lobsters, r/programming). 'topic' is either a free topic (e.g. 'Home Assistant') or an interest area: technik, it, finance, geek, nerd.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "A free topic (e.g. 'Home Assistant') or an interest area: technik, it, finance, geek, nerd." },
      max_results: { type: "number", description: "Maximum number of news items to return (default 8, max 15)." },
    },
    required: ["topic"],
  },
};

// Opens the page in a real browser, so the tool description can promise what
// it does: rendered content, not the raw HTML shell a plain fetch gets.
const FETCH_TOOL = {
  name: "web_fetch",
  description: "Open a URL in a real headless browser (as a human user's browser would) and return the rendered page as text. Use it when the user asks to pull or open a specific page — e.g. a stock quote from a search result — or when a search snippet is too thin to answer. Pass the exact URL from the search results.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to open." },
      max_chars: { type: "number", description: "Maximum characters of page text to return (default 12000, max 30000)." },
    },
    required: ["url"],
  },
};

const readLine = readline.createInterface({ input: process.stdin, terminal: false });
readLine.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleMessage(message).catch((error) => {
    if (message.id !== undefined) respond(message.id, null, { code: -32603, message: error.message });
  });
});

async function handleMessage(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jarvis-websearch", version: "1.4.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      return respond(id, { tools: [TOOL, NEWS_TOOL, FETCH_TOOL] });
    case "tools/call": {
      if (params?.name === "web_news") {
        return handleNews(id, params.arguments || {});
      }
      if (params?.name === "web_fetch") {
        return handleFetch(id, params.arguments || {});
      }
      if (params?.name !== "web_search") {
        return respond(id, null, { code: -32602, message: `Unknown tool: ${params?.name}` });
      }
      const query = String(params.arguments?.query || "").trim();
      if (!query) {
        return respond(id, { content: [{ type: "text", text: "Empty query" }], isError: true });
      }
      const maxResults = Math.min(10, Math.max(1, Number(params.arguments?.max_results) || 5));
      const lang = params.arguments?.lang === "en" ? "en" : "de";
      try {
        const { merged, instant } = await searchWeb(query, maxResults, lang);
        if (!merged.length && !instant) return respond(id, { content: [{ type: "text", text: "No results found." }] });
        return respond(id, { content: [{ type: "text", text: formatSearchResults(merged, instant) }] });
      } catch (error) {
        return respond(id, { content: [{ type: "text", text: `Search failed: ${error.message}` }], isError: true });
      }
    }
    default:
      if (id !== undefined) respond(id, null, { code: -32601, message: `Method not found: ${method}` });
  }
}

function respond(id, result, error) {
  const message = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Descriptive UA for feed/API endpoints (RSS readers identify themselves; the
// HTML search engines get the full browser header set via browserHeaders).
const BOT_UA = "Jarvis/1.0 (self-hosted voice assistant)";

async function fetchText(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.text();
}

async function handleNews(id, arguments_) {
  const topic = String(arguments_.topic || "").trim();
  if (!topic) {
    return respond(id, { content: [{ type: "text", text: "Empty topic" }], isError: true });
  }
  const maxResults = Math.min(15, Math.max(1, Number(arguments_.max_results) || 8));
  const lang = arguments_.lang === "en" ? "en" : "de";
  try {
    const items = await searchNews(topic, maxResults, lang);
    if (!items.length) return respond(id, { content: [{ type: "text", text: "No news found." }] });
    return respond(id, { content: [{ type: "text", text: formatNewsItems(items) }] });
  } catch (error) {
    return respond(id, { content: [{ type: "text", text: `News search failed: ${error.message}` }], isError: true });
  }
}

// Google News RSS search URL. `when:7d` keeps the news recent; German news
// for the German answer language, US-default otherwise.
function googleNewsUrl(query, lang) {
  const params = new URLSearchParams({ q: `${query} when:7d` });
  if (lang === "de") {
    params.set("hl", "de");
    params.set("gl", "DE");
    params.set("ceid", "DE:de");
  }
  return `https://news.google.com/rss/search?${params.toString()}`;
}

const AREA_QUERY = {
  technik: { de: "Technik", en: "technology" },
  it: { de: "IT und Technologie", en: "IT technology" },
  finance: { de: "Finanzen", en: "finance" },
  geek: { de: "Geek", en: "geek" },
  nerd: { de: "Nerd", en: "nerd" },
};

function bingNewsUrl(query) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
}

// One news fetch batch, all in parallel; a walled or down source degrades to
// zero items. Interest areas mix their curated feeds with a Bing News RSS
// search (so an area that lost all its feeds still yields news); a free topic
// searches Bing News RSS, with Google News RSS as a breadth backup.
//
// URL quality decides the primary/backup split: Bing News links are HTTP
// redirects to the real article (resolved below); Google News links are
// JS-only wrappers (its 200 page is an app shell, no server-side redirect),
// so Google News only fills slots the primary sources left empty.
async function searchNews(topic, maxResults, lang) {
  const area = normalizeTopic(topic);
  const primary = [];
  const backup = [];
  if (area) {
    for (const feed of INTEREST_FEEDS[area]) {
      primary.push({ source: feed.source, url: feed.url, browser: false });
    }
    primary.push({ source: "Bing News", url: bingNewsUrl(AREA_QUERY[area][lang]), browser: true });
  } else {
    primary.push({ source: "Bing News", url: bingNewsUrl(topic), browser: true });
    backup.push({ source: "Google News", url: googleNewsUrl(topic, lang), browser: true });
  }
  const fetchSource = (item) => fetchText(item.url, {
    headers: item.browser ? browserHeaders(lang, false) : { "user-agent": BOT_UA },
  });
  const [primarySettled, backupSettled] = await Promise.all([
    Promise.allSettled(primary.map(fetchSource)),
    Promise.allSettled(backup.map(fetchSource)),
  ]);
  const collect = (sources, settled) => {
    const items = [];
    sources.forEach((item, index) => {
      if (settled[index].status !== "fulfilled") return;
      items.push(...parseFeedItems(settled[index].value, item.source));
    });
    return items;
  };
  // Dedupe key: host + path for real article URLs (the same article via two
  // sources merges), but the FULL url for redirect wrappers — every
  // apiclick.aspx / rss/articles link shares host+path, so host+path would
  // collapse a whole source into one item.
  const seen = new Set();
  const dedupe = (items) => items.filter((item) => {
    const isWrapper = item.url.includes("bing.com/news/apiclick.aspx") || item.url.includes("news.google.com/rss/articles/");
    const key = isWrapper ? item.url.toLowerCase() : normalizeUrlForDedupe(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Resolve the Bing redirects before deduping: the same article via two
  // wrappers then merges on its real URL.
  const primaryItems = dedupe(await resolveBingNewsUrls(collect(primary, primarySettled), lang));
  const backupItems = dedupe(await resolveBingNewsUrls(collect(backup, backupSettled), lang));
  const merged = primaryItems.length >= maxResults
    ? primaryItems
    : [...primaryItems, ...backupItems];
  return merged.slice(0, maxResults);
}

// Bing News RSS links are bing.com/news/apiclick.aspx?… redirects; follow
// them in parallel so the brain (and the Answer panel) get the real article
// URL. A failed resolution keeps the wrapper URL.
async function resolveBingNewsUrls(items, lang) {
  return Promise.all(items.map(async (item) => {
    if (!item.url.includes("bing.com/news/apiclick.aspx")) return item;
    const resolved = await resolveRedirectUrl(item.url, lang);
    return resolved ? { ...item, url: resolved } : item;
  }));
}

async function resolveRedirectUrl(url, lang) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow", headers: browserHeaders(lang, true) });
    const final = response.url;
    if (response.body) await response.body.cancel().catch(() => {});
    if (final === url || final.includes("bing.com")) return "";
    return final;
  } catch {
    return "";
  }
}

// --- web_fetch: open a URL in a real browser ----------------------------------
//
// One persistent Chromium per MCP process (this server is one long-lived
// child of the backend), launched lazily on the first fetch and closed when
// the process dies. A fresh context per fetch keeps cookies isolated between
// pages; the locale follows the answer language so the browser (and every
// request it makes) speaks the user's language. `--no-sandbox` because the
// container runs as root, `--disable-dev-shm-usage` because the container's
// /dev/shm is 64 MB.
let browserPromise = null;
let browserUnavailable = false;
function ensureBrowser() {
  if (browserUnavailable) throw new Error("browser unavailable");
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    })).catch((error) => {
      // A missing browser (not installed, crashed, no system libraries) must
      // not kill the tool: the plain-fetch fallback below still answers, just
      // without JavaScript.
      browserUnavailable = true;
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    browserPromise?.then((browser) => browser.close()).catch(() => {});
    process.exit(signal === "SIGINT" ? 130 : 0);
  });
}
process.on("exit", () => {
  // Synchronous best-effort: the event loop is gone, this only helps when
  // the browser is already closed or closing fast.
  browserPromise?.then((browser) => browser.close({ timeout: 500 })).catch(() => {});
});

async function handleFetch(id, arguments_) {
  const url = String(arguments_.url || "").trim();
  const maxChars = Math.min(30000, Math.max(2000, Number(arguments_.max_chars) || 12000));
  const lang = arguments_.lang === "en" ? "en" : "de";
  const started = Date.now();
  if (!url) return respond(id, { content: [{ type: "text", text: "Empty URL" }], isError: true });
  const unsafe = isSafeFetchUrl(url);
  if (unsafe) {
    console.log(JSON.stringify({ level: "warn", msg: "webfetch_blocked", url: url.slice(0, 200), reason: unsafe }));
    return respond(id, { content: [{ type: "text", text: `Cannot open ${url}: ${unsafe}` }], isError: true });
  }
  // A hostname can point at any IP (DNS rebinding included), so the guard is
  // re-checked against the resolved addresses right before the fetch.
  const hostname = new URL(url).hostname;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(":")) {
    let addresses;
    try {
      addresses = (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
    } catch {
      return respond(id, { content: [{ type: "text", text: `Cannot open ${url}: the hostname does not resolve` }], isError: true });
    }
    if (!addresses.length || addresses.some(isBlockedIp)) {
      return respond(id, { content: [{ type: "text", text: `Cannot open ${url}: it resolves to a private/internal address` }], isError: true });
    }
  }
  try {
    const result = await fetchWithBrowser(url, maxChars, lang);
    console.log(JSON.stringify({ level: "info", msg: "webfetch_success", url: url.slice(0, 200), ms: Date.now() - started, chars: result.text.length, browser: true }));
    return respond(id, { content: [{ type: "text", text: result.text }] });
  } catch (browserError) {
    // The page may simply be slow or walled for the browser; a plain
    // browser-header fetch is a degraded but real fallback (no JavaScript).
    try {
      const html = await fetchText(url, { headers: browserHeaders(lang, true) });
      const text = `${htmlToText(html, maxChars)}\n\n[fetched without JavaScript — dynamic page content may be missing]`;
      console.log(JSON.stringify({ level: "info", msg: "webfetch_fallback", url: url.slice(0, 200), ms: Date.now() - started, error: browserError.message.slice(0, 120) }));
      return respond(id, { content: [{ type: "text", text }] });
    } catch (fallbackError) {
      console.log(JSON.stringify({ level: "warn", msg: "webfetch_failure", url: url.slice(0, 200), ms: Date.now() - started, error: fallbackError.message.slice(0, 120) }));
      return respond(id, { content: [{ type: "text", text: `Fetch failed: ${fallbackError.message}` }], isError: true });
    }
  }
}

// Open the page in the shared browser and wait for the post-load XHRs that
// render dynamic content (a stock quote loads exactly this way): domcontent-
// loaded first (hard 10 s cap — the backend's tool timeout is 20 s), then the
// load event, then a bounded network-idle settle. The rendered innerText is
// what the brain reads: visible text only, in reading order.
async function fetchWithBrowser(url, maxChars, lang) {
  const browser = await ensureBrowser();
  const context = await browser.newContext({
    locale: lang === "en" ? "en-US" : "de-DE",
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForLoadState("load", { timeout: 4000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    const { title, text, finalUrl } = await page.evaluate(() => ({
      title: document.title || "",
      text: document.body ? document.body.innerText : "",
      finalUrl: location.href,
    }));
    const body = htmlToText(text, maxChars);
    return { finalUrl, text: `Page: ${finalUrl}\nTitle: ${title}\n\n${body || "[the page rendered no readable text]"}` };
  } finally {
    await context.close().catch(() => {});
  }
}

// Queries every engine in parallel; a walled or down engine degrades to zero
// results. The instant-answer API runs alongside and is independent: the
// merged list stands on its own when it is empty.
async function searchWeb(query, maxResults, lang) {
  const engines = [
    { engine: "duckduckgo", run: () => searchDuckDuckGo(query, maxResults, lang) },
    { engine: "bing", run: () => searchBing(query, maxResults, lang) },
    { engine: "wikipedia", run: () => searchWikipedia(query, maxResults) },
  ];
  const instantPromise = searchDuckDuckGoInstant(query).catch(() => null);
  const settled = await Promise.allSettled(engines.map((entry) => entry.run()));
  const sets = engines.map((entry, index) => ({
    engine: entry.engine,
    results: settled[index].status === "fulfilled" ? settled[index].value : [],
  }));
  const merged = mergeResults(sets, maxResults);
  const instant = await instantPromise;
  return { merged, instant };
}

async function searchDuckDuckGo(query, maxResults, lang) {
  // One retry: the endpoint is occasionally flaky (connection-level refusal /
  // ECONNRESET / 202 anomaly challenge from datacenter IPs — a rate limit
  // that clears again, not a ban).
  let lastError;
  let html;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: browserHeaders(lang, true),
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (html === undefined) throw lastError;
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => cleanHtml(match[1]));
  const results = [];
  for (const match of html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = decodeDuckDuckGoHref(match[1]);
    if (!url) continue;
    results.push({ title: cleanHtml(match[2]), url, snippet: snippets[results.length] || "" });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error("DuckDuckGo returned no parseable results (bot wall?)");
  return results;
}

async function searchBing(query, maxResults, lang) {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: browserHeaders(lang, true),
  });
  const results = [];
  for (const item of html.split('<li class="b_algo"').slice(1)) {
    const titleMatch = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const url = decodeBingUrl(titleMatch[1]);
    if (!url) continue;
    const snippetMatch = item.match(/<div class="b_caption">\s*<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title: cleanHtml(titleMatch[2]), url, snippet: snippetMatch ? cleanHtml(snippetMatch[1]) : "" });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error("Bing returned no parseable results (bot wall?)");
  return results;
}

async function searchWikipedia(query, maxResults) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json`;
  const data = JSON.parse(await fetchText(url, { headers: { "user-agent": BOT_UA } }));
  const results = (data.query?.search || []).map((item) => ({
    title: item.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, "_"))}`,
    snippet: cleanHtml(item.snippet || ""),
  }));
  if (!results.length) throw new Error("Wikipedia returned no results");
  return results;
}

// The keyless instant-answer API: a short abstract, definition or direct
// answer plus up to two related topics — the closest free thing to an
// "AI answer" without an LLM or a key.
async function searchDuckDuckGoInstant(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
  const data = JSON.parse(await fetchText(url, { headers: { "user-agent": BOT_UA } }));
  const parts = [];
  if (data.Answer) parts.push(data.Answer);
  if (data.AbstractText) parts.push(data.AbstractURL ? `${data.AbstractText} (${data.AbstractURL})` : data.AbstractText);
  else if (data.Definition) parts.push(data.Definition);
  for (const topic of (data.RelatedTopics || []).slice(0, 2)) {
    if (topic && topic.Text && topic.FirstURL) parts.push(`${topic.Text} (${topic.FirstURL})`);
  }
  const text = parts.join(" ").trim();
  if (!text) throw new Error("DuckDuckGo instant answer returned no data");
  return text;
}
