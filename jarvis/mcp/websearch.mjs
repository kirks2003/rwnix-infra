#!/usr/bin/env node
// Minimal Model Context Protocol server (stdio transport, newline-delimited
// JSON-RPC 2.0) exposing one web_search tool to the Jarvis backend.
// The backend spawns this process on demand (see mcpWebSearch in server.js).

import readline from "node:readline";

const TOOL = {
  name: "web_search",
  description: "Search the web for a query and return the top results as title, URL and snippet.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "number", description: "Maximum number of results to return (default 5, max 10)." },
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
        serverInfo: { name: "jarvis-websearch", version: "1.0.0" },
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
        const results = await searchWeb(query, maxResults);
        if (!results.length) return respond(id, { content: [{ type: "text", text: "No results found." }] });
        const text = results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
        return respond(id, { content: [{ type: "text", text }] });
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

async function fetchText(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response.text();
}

// DuckDuckGo HTML endpoint first (no API key), Wikipedia API as fallback.
async function searchWeb(query, maxResults) {
  try {
    const results = await searchDuckDuckGo(query, maxResults);
    if (results.length) return results;
  } catch {
    // Fall through to Wikipedia.
  }
  return searchWikipedia(query, maxResults);
}

async function searchDuckDuckGo(query, maxResults) {
  // One retry: the endpoint is occasionally flaky (ECONNRESET from datacenter IPs).
  let lastError;
  let html;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Jarvis/1.0)" },
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
  return results;
}

// Result links are redirect URLs like //duckduckgo.com/l/?uddg=<encoded>;
// unwrap them to the real target.
function decodeDuckDuckGoHref(href) {
  if (!href) return "";
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return "";
  }
}

async function searchWikipedia(query, maxResults) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json`;
  const data = JSON.parse(await fetchText(url, { headers: { "user-agent": "Jarvis/1.0 (self-hosted voice assistant)" } }));
  return (data.query?.search || []).map((item) => ({
    title: item.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, "_"))}`,
    snippet: cleanHtml(item.snippet || ""),
  }));
}

function cleanHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
