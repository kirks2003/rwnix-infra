import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanHtml, decodeDuckDuckGoHref, decodeBingUrl, normalizeUrlForDedupe, mergeResults, formatSearchResults,
  INTEREST_FEEDS, normalizeTopic, parseFeedItems, formatNewsItems, browserHeaders,
} from "../mcp/engines.mjs";

test("cleanHtml strips tags and named plus numeric entities", () => {
  assert.equal(cleanHtml("<b>Rocky</b> &amp; the <i>Rolling Stones</i>"), "Rocky & the Rolling Stones");
  assert.equal(cleanHtml("A&#0183;B &#x27;quoted&#x27; &quot;x&quot;"), "A·B 'quoted' \"x\"");
  assert.equal(cleanHtml("It&apos;s &apos;quoted&apos;"), "It's 'quoted'");
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

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Sample feed</title>
  <item>
    <title><![CDATA[First &amp; <b>bold</b> story]]></title>
    <link>https://news.example.com/first</link>
    <description>Snippet one</description>
    <pubDate>Tue, 05 Oct 2026 12:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Second story</title>
    <link>https://news.example.com/second</link>
    <guid isPermaLink="false">news.example.com/second</guid>
    <description>Snippet two</description>
    <pubDate>Tue, 05 Oct 2026 09:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Linkless story</title>
    <description>no link, must be skipped</description>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <id>https://feeds.example.com/</id>
  <link rel="self" href="https://feeds.example.com/self.xml"/>
  <entry>
    <title>Atom entry</title>
    <link rel="alternate" type="text/html" href="https://feeds.example.com/entry-1"/>
    <id>entry-1</id>
    <updated>2026-10-05T08:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
  <entry>
    <title>Second entry</title>
    <link rel="alternate" href="https://feeds.example.com/entry-2"/>
    <published>2026-10-04T08:00:00Z</published>
  </entry>
</feed>`;

test("parseFeedItems reads RSS 2.0 and Atom items, strips markup, skips linkless items", () => {
  const rss = parseFeedItems(RSS_SAMPLE, "Sample");
  assert.deepEqual(rss, [
    { title: "First & bold story", url: "https://news.example.com/first", snippet: "Snippet one", source: "Sample", date: Date.parse("Tue, 05 Oct 2026 12:00:00 +0000") },
    { title: "Second story", url: "https://news.example.com/second", snippet: "Snippet two", source: "Sample", date: Date.parse("Tue, 05 Oct 2026 09:00:00 +0000") },
  ]);
  const atom = parseFeedItems(ATOM_SAMPLE, "Atom");
  assert.deepEqual(atom, [
    { title: "Atom entry", url: "https://feeds.example.com/entry-1", snippet: "Atom summary", source: "Atom", date: Date.parse("2026-10-05T08:00:00Z") },
    { title: "Second entry", url: "https://feeds.example.com/entry-2", snippet: "", source: "Atom", date: Date.parse("2026-10-04T08:00:00Z") },
  ]);
  assert.deepEqual(parseFeedItems("<html>no feed</html>", "X"), []);
  assert.deepEqual(parseFeedItems("", "X"), []);
});

test("normalizeTopic maps the interest-area spellings and leaves free topics alone", () => {
  assert.equal(normalizeTopic("technik"), "technik");
  assert.equal(normalizeTopic("Technologie"), "technik");
  assert.equal(normalizeTopic("TECHNIK"), "technik");
  assert.equal(normalizeTopic("it"), "it");
  assert.equal(normalizeTopic("Informatik"), "it");
  assert.equal(normalizeTopic("finance"), "finance");
  assert.equal(normalizeTopic("Finanzen"), "finance");
  assert.equal(normalizeTopic("geek"), "geek");
  assert.equal(normalizeTopic("nerd"), "nerd");
  assert.equal(normalizeTopic("Home Assistant"), null);
  assert.equal(normalizeTopic("  "), null);
  assert.equal(normalizeTopic(null), null);
});

test("browserHeaders look like a normal Chrome request and steer the language", () => {
  const de = browserHeaders("de", true);
  assert.match(de["user-agent"], /^Mozilla\/5\.0 .*Chrome\/\d+\.\d+\.\d+\.\d+ Safari/);
  assert.equal(de["accept-language"], "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7");
  assert.match(de["sec-ch-ua"], /^"Chromium";v="/);
  assert.equal(de["sec-ch-ua-mobile"], "?0");
  assert.equal(de["sec-fetch-dest"], "document");
  assert.equal(de["sec-fetch-mode"], "navigate");
  assert.equal(de["sec-fetch-user"], "?1");
  assert.equal(de["upgrade-insecure-requests"], "1");
  assert.equal(de["priority"], "u=0,i");
  assert.match(de.accept, /^text\/html/);
  assert.equal(de["accept-encoding"], "gzip, deflate, br");

  const en = browserHeaders("en", false);
  assert.equal(en["accept-language"], "en-US,en;q=0.9");
  assert.equal(en["sec-fetch-dest"], "empty");
  assert.equal(en["sec-fetch-mode"], "cors");
  assert.equal(en["sec-fetch-user"], undefined);
  assert.equal(en["upgrade-insecure-requests"], undefined);
  assert.equal(en["priority"], "u=1,i");
  assert.equal(en.accept, "*/*");
});

test("the interest feed map covers the five areas with reachable http(s) feeds", () => {
  for (const area of ["technik", "it", "finance", "geek", "nerd"]) {
    const feeds = INTEREST_FEEDS[area];
    assert.ok(Array.isArray(feeds) && feeds.length >= 2, `${area} has curated feeds`);
    for (const feed of feeds) {
      assert.ok(/^https:\/\//.test(feed.url), `${area} feed URL is https`);
      assert.ok(feed.source, `${area} feed has a source name`);
      assert.ok(feed.lang === "de" || feed.lang === "en", `${area} feed has a language`);
    }
  }
});

test("formatNewsItems sorts newest first and tags source, date and URL", () => {
  const items = [
    { title: "Old", url: "https://a.test/1", snippet: "", source: "Feed A", date: Date.parse("2026-10-01T00:00:00Z") },
    { title: "New", url: "https://a.test/2", snippet: "S", source: "Feed B", date: Date.parse("2026-10-05T00:00:00Z") },
    { title: "Undated", url: "https://a.test/3", snippet: "", source: "Feed C", date: 0 },
  ];
  const text = formatNewsItems(items);
  assert.equal(text, "1. New — Feed B (2026-10-05)\nhttps://a.test/2\nS\n\n2. Old — Feed A (2026-10-01)\nhttps://a.test/1\n\n\n3. Undated — Feed C\nhttps://a.test/3\n");
  assert.equal(formatNewsItems([]), "");
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
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["web_search", "web_news"]);
  assert.deepEqual(tools.tools[0].inputSchema.required, ["query"]);
  assert.deepEqual(tools.tools[1].inputSchema.required, ["topic"]);

  const empty = await server.request("tools/call", { name: "web_search", arguments: { query: "   " } });
  assert.equal(empty.isError, true);
  const emptyNews = await server.request("tools/call", { name: "web_news", arguments: { topic: "  " } });
  assert.equal(emptyNews.isError, true);
  await assert.rejects(server.request("tools/call", { name: "no_such_tool", arguments: {} }), /Unknown tool/);
  await assert.rejects(server.request("resources/list", {}), /Method not found/);
});
