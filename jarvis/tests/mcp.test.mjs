import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanHtml, decodeDuckDuckGoHref, decodeBingUrl, normalizeUrlForDedupe, mergeResults, formatSearchResults,
} from "../mcp/engines.mjs";

test("cleanHtml strips tags and named plus numeric entities", () => {
  assert.equal(cleanHtml("<b>Rocky</b> &amp; the <i>Rolling Stones</i>"), "Rocky & the Rolling Stones");
  assert.equal(cleanHtml("A&#0183;B &#x27;quoted&#x27; &quot;x&quot;"), "A·B 'quoted' \"x\"");
  assert.equal(cleanHtml("  multi   space\nlines "), "multi space lines");
});

test("DuckDuckGo redirect links unwrap to the real target, ads come back empty", () => {
  const organic = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fhuggingface.co%2Fhexgrad%2FKokoro-82M&amp;rut=abc";
  assert.equal(decodeDuckDuckGoHref(organic), "https://huggingface.co/hexgrad/Kokoro-82M");
  // Ads are double-wrapped: the uddg target itself is duckduckgo.com/y.js.
  const ad = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dexample.com%26ad_provider%3Dbingv7aa";
  assert.equal(decodeDuckDuckGoHref(ad), "");
  assert.equal(decodeDuckDuckGoHref("https://example.com/plain"), "https://example.com/plain");
  assert.equal(decodeDuckDuckGoHref(""), "");
  assert.equal(decodeDuckDuckGoHref("not a url"), "");
});

test("Bing redirect links unwrap the base64url target, dead ends come back empty", () => {
  const target = "https://example.com/page?x=1&y=2";
  const encoded = Buffer.from(target, "utf8").toString("base64url");
  assert.equal(decodeBingUrl(`https://www.bing.com/ck/a?!&p=x&amp;u=a1${encoded}`), target);
  assert.equal(decodeBingUrl("https://www.bing.com/some/dead-end"), "");
  assert.equal(decodeBingUrl("https://example.com/plain"), "https://example.com/plain");
  assert.equal(decodeBingUrl(""), "");
  assert.equal(decodeBingUrl("not a url"), "");
});

test("dedupe normalisation ignores scheme, www and trailing slash", () => {
  assert.equal(normalizeUrlForDedupe("https://www.example.com/a/b/"), "example.com/a/b");
  assert.equal(normalizeUrlForDedupe("http://example.com/a/b"), "example.com/a/b");
  assert.equal(normalizeUrlForDedupe("not a url"), "not a url");
});

test("mergeResults round-robins engines, dedupes and caps", () => {
  const sets = [
    {
      engine: "duckduckgo",
      results: [
        { title: "d1", url: "https://example.com/a", snippet: "" },
        { title: "d2", url: "https://example.com/b", snippet: "" },
        { title: "d3", url: "https://example.com/c", snippet: "" },
      ],
    },
    {
      engine: "bing",
      // Same page as d1 in a different form: must be deduped away.
      results: [
        { title: "b1", url: "https://www.example.com/a/", snippet: "" },
        { title: "b2", url: "https://example.com/d", snippet: "" },
      ],
    },
    { engine: "wikipedia", results: [{ title: "w1", url: "https://en.wikipedia.org/wiki/X", snippet: "" }] },
  ];
  const merged = mergeResults(sets, 4);
  assert.deepEqual(merged.map((result) => `${result.engine}:${result.url}`), [
    "duckduckgo:https://example.com/a",
    "wikipedia:https://en.wikipedia.org/wiki/X",
    "duckduckgo:https://example.com/b",
    "bing:https://example.com/d",
  ]);
  const all = mergeResults(sets, 10);
  assert.equal(all.length, 5);
  assert.equal(all.filter((result) => result.engine === "duckduckgo").length, 3);
  assert.deepEqual(mergeResults([{ engine: "x", results: [{ title: "no url" }] }], 5), []);
  assert.deepEqual(mergeResults([], 5), []);
});

test("formatSearchResults tags engines and puts the instant answer first", () => {
  const text = formatSearchResults(
    [{ engine: "bing", title: "T", url: "https://example.com", snippet: "S" }],
    "The instant answer.",
  );
  assert.equal(text, "Instant answer (DuckDuckGo):\nThe instant answer.\n\n1. [bing] T\nhttps://example.com\nS");
  assert.equal(formatSearchResults([{ engine: "duckduckgo", title: "Only", url: "https://x.test", snippet: "" }], null),
    "1. [duckduckgo] Only\nhttps://x.test\n");
  assert.equal(formatSearchResults([], null), "");
});

function startMcpServer() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../mcp/websearch.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = message.id !== undefined ? pending.get(message.id) : null;
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "MCP error"));
      else entry.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return {
    request,
    notify,
    close: () => new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    }),
  };
}

test("MCP web-search server speaks the MCP protocol over stdio", async (t) => {
  const server = startMcpServer();
  t.after(() => server.close());

  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "jarvis-test", version: "0.1.0" },
  });
  assert.equal(init.serverInfo.name, "jarvis-websearch");
  assert.deepEqual(init.capabilities.tools, { listChanged: false });
  server.notify("notifications/initialized");

  const tools = await server.request("tools/list");
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["web_search"]);
  assert.deepEqual(tools.tools[0].inputSchema.required, ["query"]);

  const empty = await server.request("tools/call", { name: "web_search", arguments: { query: "   " } });
  assert.equal(empty.isError, true);
  await assert.rejects(server.request("tools/call", { name: "no_such_tool", arguments: {} }), /Unknown tool/);
  await assert.rejects(server.request("resources/list", {}), /Method not found/);
});
