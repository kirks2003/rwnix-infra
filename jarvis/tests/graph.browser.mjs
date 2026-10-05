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

// The shape of the API's per-user scoped subgraph: the signed-in user's
// type-less node, the entities they own, and the fact edges between them
// (ownership bounds the world; :User account markers may appear as edge
// endpoints). Never another user's node or edge, and never the bookkeeping
// KNOWS edges. An owned entity no fact edge touches (Vienna) is drawn too,
// flagged `isolated` so the view renders it dimmed.
const GRAPH_FIXTURE = {
  nodes: [
    // :User nodes carry no type: the account the knowledge belongs to.
    { id: "n0", name: "Mila", owner: null },
    { id: "n1", name: "Rocky", type: "thing", owner: "Mila" },
    { id: "n2", name: "Berlin", type: "place", owner: "Mila" },
    { id: "n3", name: "Amelie", type: "person", owner: "Mila" },
    { id: "n4", name: "Lego", type: "thing", owner: "Mila" },
    { id: "n6", name: "Vienna", type: "place", owner: "Mila", isolated: true },
  ],
  // Only real facts, one of them negative. n3 and n2 carry two edges at once
  // (LIVES_IN + WORKS_AT): parallel-edge label stacking.
  edges: [
    { source: "n0", target: "n1", type: "LIKES" },
    { source: "n3", target: "n2", type: "LIVES_IN" },
    { source: "n3", target: "n0", type: "FRIEND_OF" },
    { source: "n1", target: "n4", type: "USES", negative: true },
    { source: "n3", target: "n2", type: "WORKS_AT" },
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
    await page.route("**/api/graph/status", (route) => route.fulfill({ json: { nodes: 6, edges: 5, labels: ["User", "Entity"], relTypes: ["FRIEND_OF", "LIKES", "LIVES_IN", "USES", "WORKS_AT"] } }));
    await page.route("**/api/graph/subgraph*", (route) => route.fulfill({ json: GRAPH_FIXTURE }));
    await page.route("**/api/graph/schema", (route) => route.fulfill({ json: { labels: ["User", "Entity"], relTypes: ["LIVES_IN", "USES"], propertyKeys: ["name", "type"] } }));
    // The feed is scoped to the session user, so entries no longer carry a
    // visible user suffix; brain entries log the parameterized tool and its
    // argument summary (detail), not raw Cypher.
    await page.route("**/api/graph/activity", (route) => route.fulfill({ json: { entries: [
      { at: new Date().toISOString(), kind: "brain_query", user: "Mila", tool: "list-my-facts", detail: "facts for Mila (mock)", ok: true, ms: 12 },
      { at: new Date().toISOString(), kind: "ingest", user: "Mila", entities: 2, relations: 1 },
      // 0 stored / 2 skipped: the extractor only named registered users.
      { at: new Date().toISOString(), kind: "ingest", user: "Mila", entities: 0, relations: 0, skippedUsers: 2 },
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
  assert.match(await page.textContent("#graphStatus"), /6 nodes · 5 links/);
  assert.equal(await page.locator("#graphCanvas circle").count(), 6);
  const labels = await page.locator("#graphCanvas text").allTextContents();
  assert.ok(labels.includes("Rocky"), "entity labels should be drawn");
  assert.ok(labels.includes("Vienna"), "the isolated mention is drawn, not hidden");
  // Isolated mentions (owned, no fact edge) render dimmed; linked nodes do
  // not. Node order in the fixture: Mila, Rocky, Berlin, Amelie, Lego, Vienna.
  const opacities = await page.$$eval("#graphCanvas circle", (circles) => circles.map((circle) => circle.style.fillOpacity));
  assert.deepEqual(opacities, ["0.65", "0.65", "0.65", "0.65", "0.65", "0.35"], `isolated node dimmed: ${JSON.stringify(opacities)}`);
  // Per-user isolation: the user appears exactly once, as the type-less
  // account node — there is no second person entity for the signed-in user.
  assert.ok(labels.includes("Mila (you)"), "the :User node should be labelled as the signed-in user");
  assert.equal(labels.filter((label) => label.startsWith("Mila")).length, 1, `one Mila node: ${JSON.stringify(labels)}`);
  const edgeLabels = await page.locator("#graphCanvas text.edge-label").allTextContents();
  assert.equal(edgeLabels.length, GRAPH_FIXTURE.edges.length, `edge labels: ${JSON.stringify(edgeLabels)}`);
  assert.ok(edgeLabels.includes("likes"), "relation types are shown in plain words");
  assert.ok(edgeLabels.includes("lives in"), "underscored relation types render as words");
  // The negative flag renders as the negative form.
  assert.ok(edgeLabels.includes("doesn't use"), `negation: ${JSON.stringify(edgeLabels)}`);
  // The bookkeeping KNOWS edge never reaches the panel.
  assert.ok(!edgeLabels.includes("knows"), "KNOWS is not rendered");
  assert.match(await page.textContent("#graphSchema"), /Labels: User, Entity/);
  const activity = await page.locator("#graphActivity li").allTextContents();
  assert.equal(activity.length, 3);
  assert.match(activity[0], /brain read list-my-facts/);
  // The feed is scoped to the session user, so no per-entry user suffix.
  assert.match(activity[1], /stored 2 entities \+ 1 link$/);
  // Nothing stored (the mentions were user accounts) must not read as
  // "stored 0 entities" — the feed says what actually happened.
  assert.match(activity[2], /2 user-account mentions — nothing stored as an entity$/);
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

test("the Remove button deletes the centred entity and refreshes the panel", async (t) => {
  const page = await openPanel(t);
  // A live copy of the fixture the mocked DELETE endpoint mutates, so the
  // panel reload after the removal shows the node actually gone.
  let fixture = structuredClone(GRAPH_FIXTURE);
  let centerSeen = null;
  const deleted = [];
  await page.route("**/api/graph/subgraph*", (route) => {
    centerSeen = new URL(route.request().url()).searchParams.get("center");
    return route.fulfill({ json: fixture });
  });
  // The mock returns the FULL fixture for every subgraph request, so the
  // rendered DOM is identical for any centre (and the status string too) —
  // the only render signal is renderGraph's svg.replaceChildren(). Count
  // exactly those mutations (the SVG element itself persists). Installed
  // after the first 2D render, before any centring click.
  await page.evaluate(() => {
    const svg = document.getElementById("graphCanvas");
    new MutationObserver(() => { window.__graphRenders = (window.__graphRenders || 0) + 1; }).observe(svg, { childList: true });
  });
  // Wait until the panel has requested the given centre AND re-rendered after
  // the click: the route records the centre at interception time (before the
  // page processes the response), so a fresh DOM render after that is what
  // guarantees the status and the Remove button are current.
  const waitCenter = async (id) => {
    const started = Date.now();
    const baseline = await page.evaluate(() => window.__graphRenders || 0);
    for (;;) {
      const renders = await page.evaluate(() => window.__graphRenders || 0);
      const statusText = await page.locator("#graphStatus").textContent();
      const settled = id === null
        ? !statusText.includes("neighbourhood") && renders > baseline
        : centerSeen === id && statusText.includes("neighbourhood") && renders > baseline;
      if (settled) return;
      if (Date.now() - started > 5000) throw new Error(`timed out waiting for centre ${id}, saw ${centerSeen} / ${statusText} / renders ${renders}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await page.route("**/api/graph/entity*", (route) => {
    if (route.request().method() !== "DELETE") return route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
    const id = new URL(route.request().url()).searchParams.get("id");
    const node = fixture.nodes.find((candidate) => candidate.id === id);
    if (!node || !node.type) return route.fulfill({ status: 404, json: { error: "entity_not_found" } });
    fixture = {
      nodes: fixture.nodes.filter((candidate) => candidate.id !== id),
      edges: fixture.edges.filter((edge) => edge.source !== id && edge.target !== id),
    };
    deleted.push(node.name);
    return route.fulfill({ json: { requestId: "r", deleted: 1, name: node.name } });
  });
  await page.click("#graphView2dButton"); // the 3D view is the default
  await page.waitForSelector("#graphCanvas circle");
  const button = page.locator("#graphRemoveButton");
  assert.equal(await button.isVisible(), false, "no centred node, no Remove button");
  // Fixture order: Mila, Rocky, Berlin, Amelie, Lego, Vienna.
  const circles = page.locator("#graphCanvas circle");
  assert.equal(await circles.count(), 6);
  // A :User account node is never deletable.
  await circles.first().click();
  await waitCenter("n0");
  assert.equal(await button.isVisible(), false, "no Remove button for the :User node");
  // Centre on the isolated mention: the button names it.
  await circles.nth(5).click();
  await waitCenter("n6"); // the fixture's ids skip n5; Vienna is n6
  assert.equal(await button.isVisible(), true, "the Remove button appears for a centred entity");
  assert.match(await button.textContent(), /Remove Vienna/);
  await page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  assert.deepEqual(deleted, ["Vienna"], "the DELETE request removes exactly the centred entity");
  // The panel reloads on the full world: Vienna is gone, the button hides.
  await waitCenter(null);
  assert.equal(await circles.count(), 5, "the removed node is no longer drawn");
  const labels = await page.locator("#graphCanvas text").allTextContents();
  assert.ok(!labels.includes("Vienna"), `Vienna removed: ${JSON.stringify(labels)}`);
  assert.equal(await button.isVisible(), false);
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
  const labels = await page.locator(".graph-3d-labels span:not(.edge)").allTextContents();
  assert.ok(labels.includes("Mila (you)"), `labels: ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("Rocky"), "entity labels are drawn");
  assert.ok(labels.includes("Vienna"), "the isolated mention is drawn in 3D too");
  assert.equal(await page.locator(".graph-3d-labels span.isolated").count(), 1, "the isolated mention's label carries the dimming class");
  const edgeLabels = await page.locator(".graph-3d-labels span.edge").allTextContents();
  assert.equal(edgeLabels.length, GRAPH_FIXTURE.edges.length, `edge labels: ${JSON.stringify(edgeLabels)}`);
  assert.ok(edgeLabels.includes("likes"), "relation types are shown in plain words");
  assert.ok(edgeLabels.includes("lives in"), "underscored relation types render as words");
  // The negative flag renders as the negative form.
  assert.ok(edgeLabels.includes("doesn't use"), `negation: ${JSON.stringify(edgeLabels)}`);
  // The bookkeeping KNOWS edge never reaches the panel.
  assert.ok(!edgeLabels.includes("knows"), "KNOWS is not rendered");
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
    nodes: [...GRAPH_FIXTURE.nodes, { id: "n5", name: "Paris", type: "place", owner: "Mila" }],
    edges: [...GRAPH_FIXTURE.edges, { source: "n3", target: "n5", type: "LOCATED_IN" }],
  } }));
  await page.click("#graphRefreshButton");
  await page.waitForSelector('.graph-3d-labels span:has-text("Paris")');
  assert.equal(await page.locator(".graph-3d-labels span:not(.edge)").count(), GRAPH_FIXTURE.nodes.length + 1);
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
  assert.equal(await page.locator("#graphCanvas circle").count(), 6, "the 2D view renders instead");
});
