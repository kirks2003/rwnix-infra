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

// The panel talks to the backend's read-only /api/graph/* routes; the rest
// of the app is the static shell, so a plain file server is enough.
async function routeGraphApi(page, { configured = true } = {}) {
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
}

async function openPanel(t, { configured = true } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await routeGraphApi(page, { configured });
  await page.goto(origin);
  return page;
}

test("the graph panel renders the graph, schema and activity", async (t) => {
  const page = await openPanel(t);
  await page.click("#graphView2dButton"); // the 3D view is the default
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
  await page.click("#graphView2dButton"); // the 3D view is the default
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
  // Without a graph the 3D view is not offered either.
  assert.equal(await page.locator("#graph3dStage canvas").count(), 0);
  assert.equal(await page.locator("#graphView3dButton").isDisabled(), true);
});

test("the 3D view is the default: an animated live graph with labels", async (t) => {
  const page = await openPanel(t);
  await page.waitForSelector("#graph3dStage canvas");
  assert.equal(await page.locator("#graph3dStage").isHidden(), false, "the 3D stage is visible by default");
  assert.equal(await page.locator("#graphCanvas").isHidden(), true, "the 2D SVG is hidden while 3D is active");
  assert.equal(await page.evaluate(() => Boolean(document.querySelector("#graph3dStage canvas").getContext("webgl2"))), true);
  // The layout is still settling, so the scene must be animating.
  const canvas = page.locator("#graph3dStage canvas");
  await page.waitForTimeout(2500);
  const shot1 = await canvas.screenshot();
  await page.waitForTimeout(1000);
  const shot2 = await canvas.screenshot();
  assert.notDeepEqual(shot1, shot2, "the 3D view should keep animating");
  const labels = await page.locator(".graph-3d-labels span").allTextContents();
  assert.ok(labels.includes("Mila (you)"), `labels: ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("Rocky"), "entity labels are drawn");
  // The wrap must reserve the canvas height in 3D mode (the hidden 2D SVG
  // contributes no flow height), or the stage paints over the panels below.
  const boxes = await page.evaluate(() => {
    const wrap = document.querySelector(".graph-canvas-wrap");
    const stage = document.getElementById("graph3dStage");
    const section = document.querySelector(".graph-panel");
    const next = document.querySelector(".panels-toggle-row");
    return {
      wrap: wrap.getBoundingClientRect().toJSON(),
      stage: stage.getBoundingClientRect().toJSON(),
      sectionBottom: section.getBoundingClientRect().bottom,
      nextTop: next.getBoundingClientRect().top,
    };
  });
  assert.ok(boxes.wrap.height >= 319, `wrap reserves the 320px canvas height (got ${boxes.wrap.height})`);
  assert.ok(boxes.stage.bottom <= boxes.wrap.bottom + 1, "the 3D stage stays inside its wrap");
  assert.ok(boxes.nextTop >= boxes.sectionBottom, "the panels toggle row starts below the graph panel");
});

test("the 3D view: clicking a node label re-centres the panel", async (t) => {
  const page = await openPanel(t);
  await page.waitForSelector('.graph-3d-labels span:has-text("Berlin")');
  let centerSeen = null;
  // Registered last, so it wins over the initial subgraph route.
  await page.route("**/api/graph/subgraph*", (route) => {
    centerSeen = new URL(route.request().url()).searchParams.get("center");
    return route.fulfill({ json: GRAPH_FIXTURE });
  });
  await page.locator(".graph-3d-labels span", { hasText: "Berlin" }).click();
  await page.waitForFunction(() => document.getElementById("graphStatus").textContent.includes("neighbourhood"));
  assert.ok(centerSeen, "the centred request should carry the node id");
});

test("the 3D view: new data appears live on the next refresh", async (t) => {
  const page = await openPanel(t);
  await page.waitForSelector('.graph-3d-labels span:has-text("Rocky")');
  assert.equal(await page.locator('.graph-3d-labels span:has-text("Paris")').count(), 0);
  // Registered last, so it wins: the graph gained a node and a link.
  await page.route("**/api/graph/subgraph*", (route) => route.fulfill({ json: {
    nodes: [...GRAPH_FIXTURE.nodes, { id: "n5", name: "Paris", type: "place", common: true }],
    edges: [...GRAPH_FIXTURE.edges, { source: "n3", target: "n5", type: "LOCATED_IN" }],
  } }));
  await page.click("#graphRefreshButton");
  await page.waitForSelector('.graph-3d-labels span:has-text("Paris")');
  assert.equal(await page.locator(".graph-3d-labels span").count(), GRAPH_FIXTURE.nodes.length + 1);
});

test("the 3D view falls back to 2D when WebGL is unavailable", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).startsWith("webgl")) return null;
      return original.call(this, type, ...args);
    };
  });
  await routeGraphApi(page);
  await page.goto(origin);
  await page.waitForSelector("#graphCanvas circle");
  assert.equal(await page.locator("#graph3dStage").isHidden(), true, "the 3D stage stays hidden without WebGL");
  assert.equal(await page.locator("#graph3dStage canvas").count(), 0, "no 3D canvas is created");
  assert.equal(await page.locator("#graphView3dButton").isDisabled(), true, "the 3D toggle is disabled");
  assert.equal(await page.locator("#graphCanvas circle").count(), 5, "the 2D view renders instead");
});
