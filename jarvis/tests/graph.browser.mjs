import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

let browser, server, origin;
before(async () => {
  // The panel only talks to the backend's read-only /api/graph/* routes; the
  // rest of the app is the static shell, so a plain file server is enough.
  server = createServer(async (req, res) => {
    try {
      const file = req.url === "/" ? "index.html" : req.url.slice(1);
      const body = await readFile(new URL(`../public/${file}`, import.meta.url));
      res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

const GRAPH_FIXTURE = {
  nodes: [
    // :User nodes carry no type: the account the knowledge belongs to.
    { id: "n0", name: "Mila", common: false },
    { id: "n1", name: "Mila", type: "person", common: false },
    { id: "n2", name: "Rocky", type: "thing", common: true },
    { id: "n3", name: "Berlin", type: "place", common: true },
    { id: "n4", name: "Kokoro-82M", type: "thing", common: true },
  ],
  edges: [
    { source: "n0", target: "n1", type: "KNOWS" },
    { source: "n1", target: "n2", type: "USES" },
    { source: "n1", target: "n3", type: "LIVES_IN" },
    { source: "n2", target: "n4", type: "USES" },
  ],
};

async function openPanel(t, { configured = true } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/api/config", (route) => route.fulfill({ json: {
    user: "Mila",
    wakePhrase: "Rocky",
    silenceMs: 1500,
    whisperLanguage: "en",
    whisperEndpoints: ["http://vm103.test/v1/audio/transcriptions"],
    brainBaseUrl: "http://brain.test/v1",
    brainModel: "deepseek-v4-flash",
    brainConfigured: true,
    ttsEndpoints: ["http://tts.test/v1/audio/speech"],
    ttsConfigured: true,
    ttsModel: "speaches-ai/Kokoro-82M-v1.0-ONNX",
    ttsVoice: "bm_george",
    mcpServers: [
      { id: "websearch", label: "Web search" },
      { id: "graph", label: "Knowledge graph" },
    ],
    graphConfigured: configured,
  } }));
  if (configured) {
    await page.route("**/api/graph/status", (route) => route.fulfill({ json: { nodes: 5, edges: 4, labels: ["User", "Entity"], relTypes: ["KNOWS", "LIVES_IN", "USES"] } }));
    await page.route("**/api/graph/subgraph*", (route) => route.fulfill({ json: GRAPH_FIXTURE }));
    await page.route("**/api/graph/schema", (route) => route.fulfill({ json: { labels: ["User", "Entity"], relTypes: ["LIVES_IN", "USES"], propertyKeys: ["name", "type"] } }));
    await page.route("**/api/graph/activity", (route) => route.fulfill({ json: { entries: [
      { at: new Date().toISOString(), kind: "brain_query", user: "Mila", tool: "read-cypher", cypher: "MATCH (e) RETURN e LIMIT 3", ok: true, ms: 12 },
      { at: new Date().toISOString(), kind: "ingest", user: "Mila", entities: 2, relations: 1 },
    ] } }));
  }
  await page.goto(origin);
  return page;
}

test("the graph panel renders the graph, schema and activity", async (t) => {
  const page = await openPanel(t);
  await page.waitForSelector("#graphCanvas circle");
  assert.match(await page.textContent("#graphStatus"), /5 nodes · 4 links/);
  assert.equal(await page.locator("#graphCanvas circle").count(), 5);
  const labels = await page.locator("#graphCanvas text").allTextContents();
  assert.ok(labels.includes("Mila"), "node labels should be drawn");
  // The signed-in user's account node is drawn distinctly from the person entity.
  assert.ok(labels.includes("Mila (you)"), "the :User node should be labelled as the signed-in user");
  assert.match(await page.textContent("#graphSchema"), /Labels: User, Entity/);
  const activity = await page.locator("#graphActivity li").allTextContents();
  assert.equal(activity.length, 2);
  assert.match(activity[0], /brain read read-cypher/);
  assert.match(activity[1], /stored 2 entities \+ 1 link \(Mila\)/);
});

test("clicking a node re-centres the panel on its neighbourhood", async (t) => {
  const page = await openPanel(t);
  await page.waitForSelector("#graphCanvas circle");
  let centerSeen = null;
  // Registered last, so it wins over the initial subgraph route.
  await page.route("**/api/graph/subgraph*", (route) => {
    centerSeen = new URL(route.request().url()).searchParams.get("center");
    return route.fulfill({ json: GRAPH_FIXTURE });
  });
  await page.locator("#graphCanvas circle").first().click();
  await page.waitForFunction(() => document.getElementById("graphStatus").textContent.includes("neighbourhood"));
  assert.ok(centerSeen, "the centred request should carry the node id");
});

test("the graph panel degrades to a status line when unconfigured", async (t) => {
  const page = await openPanel(t, { configured: false });
  await page.waitForFunction(() => document.getElementById("graphStatus").textContent.includes("Not configured"));
  assert.equal(await page.locator("#graphCanvas circle").count(), 0);
});
