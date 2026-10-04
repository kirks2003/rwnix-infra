#!/usr/bin/env node
// Minimal Model Context Protocol server (stdio transport, newline-delimited
// JSON-RPC 2.0) exposing one web_search tool to the Jarvis backend.
// The backend spawns this process on demand (see mcpWebSearch in server.js).
//
// Search runs every free keyless engine in parallel and merges the results
// (round-robin, deduplicated by URL; see mergeResults in engines.mjs):
//   - DuckDuckGo HTML (result links unwrapped from the redirect form)
//   - Bing HTML (result links unwrapped from the bing.com/ck/a redirect)
//   - Wikipedia search API (structured, no bot wall)
//   - DuckDuckGo Instant Answer API (abstract/definition/answer/related
//     topics — the "AI answer" layer, separate from the result list)
// Each engine degrades to zero results on a bot wall (403/429/captcha/202
// challenge from datacenter IPs) without failing the whole search. Measured
// engine availability from server IPs: see DEPLOYMENT.md, "MCP web search".

import readline from "node:readline";
import {
  cleanHtml, decodeDuckDuckGoHref, decodeBingUrl, mergeResults, formatSearchResults,
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
        serverInfo: { name: "jarvis-websearch", version: "1.1.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      return respond(id, { tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== "web_search") {
        return respond(id, null, { code: -32602, message: `Unknown tool: ${params?.name}` });
      }
      const query = String(params.arguments?.query || "").trim();
      if (!query) {
        return respond(id, { content: [{ type: "text", text: "Empty query" }], isError: true });
      }
      const maxResults = Math.min(10, Math.max(1, Number(params.arguments?.max_results) || 5));
      try {
        const { merged, instant } = await searchWeb(query, maxResults);
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

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const BOT_UA = "Jarvis/1.0 (self-hosted voice assistant)";

async function fetchText(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.text();
}

// Queries every engine in parallel; a walled or down engine degrades to zero
// results. The instant-answer API runs alongside and is independent: the
// merged list stands on its own when it is empty.
async function searchWeb(query, maxResults) {
  const engines = [
    { engine: "duckduckgo", run: () => searchDuckDuckGo(query, maxResults) },
    { engine: "bing", run: () => searchBing(query, maxResults) },
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

async function searchDuckDuckGo(query, maxResults) {
  // One retry: the endpoint is occasionally flaky (ECONNRESET / 202 anomaly
  // challenge from datacenter IPs).
  let lastError;
  let html;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": BROWSER_UA },
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

async function searchBing(query, maxResults) {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": BROWSER_UA },
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
