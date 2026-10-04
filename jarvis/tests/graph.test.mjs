import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import graphdb from "../graphdb.js";

// --- parseExtraction ---------------------------------------------------------

test("parseExtraction handles plain, fenced and prose-wrapped JSON", () => {
  const plain = graphdb.parseExtraction('{"entities":[{"name":"Mila","type":"person","common":false}],"relations":[{"from":"Mila","to":"Berlin","type":"LIVES_IN"}]}');
  assert.deepEqual(plain, {
    entities: [{ name: "Mila", type: "person", common: false, props: {} }],
    relations: [{ from: "Mila", to: "Berlin", type: "LIVES_IN" }],
  });
  const fenced = graphdb.parseExtraction('Here you go:\n```json\n{"entities":[{"name":"Berlin","type":"place"}],"relations":[]}\n```\nDone.');
  assert.equal(fenced.entities.length, 1);
  assert.equal(fenced.entities[0].name, "Berlin");
});

test("parseExtraction sanitises names, types, props and clamps counts", () => {
  const many = {
    entities: Array.from({ length: 30 }, (_, index) => ({ name: `  E${index}  `, type: index % 2 ? "place" : "bogus-type", props: { okkey: `v${index}`, "Bad Key": "x", name: "injected" } })),
    relations: Array.from({ length: 40 }, (_, index) => ({ from: "A", to: `B${index}`, type: "WEIRD-TYPE" })),
  };
  const parsed = graphdb.parseExtraction(JSON.stringify(many));
  assert.equal(parsed.entities.length, graphdb.MAX_ENTITIES);
  assert.equal(parsed.entities[0].name, "E0");
  assert.equal(parsed.entities[0].type, "thing");
  assert.equal(parsed.entities[1].type, "place");
  assert.deepEqual(parsed.entities[0].props, { okkey: "v0" });
  assert.equal(parsed.relations.length, graphdb.MAX_RELATIONS);
  assert.ok(parsed.relations.every((relation) => relation.type === "RELATED_TO"));
});

test("parseExtraction drops duplicates, self-relations and garbage", () => {
  assert.deepEqual(graphdb.parseExtraction("no json here"), { entities: [], relations: [] });
  assert.deepEqual(graphdb.parseExtraction("{{{"), { entities: [], relations: [] });
  const parsed = graphdb.parseExtraction(JSON.stringify({
    entities: [
      { name: "  Mila  ", type: "PERSON" },
      { name: "Mila", type: "person" },
      { name: "", type: "person" },
      { name: "Mila", type: "place" },
    ],
    relations: [
      { from: "Mila", to: "Mila", type: "X" },
      { from: "Mila", to: "Roman", type: "FRIEND_OF" },
      { from: "Mila", to: "Roman", type: "FRIEND_OF" },
    ],
  }));
  assert.deepEqual(parsed.entities.map((entity) => `${entity.name}:${entity.type}`), ["Mila:person", "Mila:place"]);
  assert.deepEqual(parsed.relations, [{ from: "Mila", to: "Roman", type: "FRIEND_OF" }]);
});

test("formatGraphContext renders user and shared lines, empty stays empty", () => {
  const text = graphdb.formatGraphContext({
    userEntities: [{ name: "Berlin", type: "place" }],
    commonEntities: [{ name: "Kokoro-82M", type: "thing" }],
  });
  assert.match(text, /Known to this user so far: Berlin \(place\)/);
  assert.match(text, /Shared knowledge: Kokoro-82M \(thing\)/);
  assert.equal(graphdb.formatGraphContext({ userEntities: [], commonEntities: [] }), "");
});

// --- memory store -------------------------------------------------------------

test("memory store: status, context, upsert, shared flag and neighbourhood", async () => {
  const store = graphdb.createMemoryStore();
  const status = await store.status();
  assert.ok(status.nodes >= 5);
  assert.ok(status.edges >= 4);
  const context = await store.readContext("Mila");
  assert.ok(context.userEntities.some((entity) => entity.name === "Rocky"));
  assert.ok(context.commonEntities.some((entity) => entity.name === "Berlin"));
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Amelie", type: "person", common: false, props: { city: "Leipzig" } }],
    relations: [{ from: "Amelie", to: "Mila", type: "FRIEND_OF" }],
  });
  let sub = await store.subgraph({ limit: 60 });
  assert.ok(sub.nodes.some((node) => node.name === "Amelie"));
  assert.ok(sub.edges.some((edge) => edge.type === "FRIEND_OF"));
  const amelieId = sub.nodes.find((node) => node.name === "Amelie").id;
  const centered = await store.subgraph({ center: amelieId });
  assert.ok(centered.nodes.some((node) => node.name === "Mila"));
  // Amelie->Mila FRIEND_OF plus Mila->Amelie KNOWS from the upsert.
  assert.equal(centered.edges.length, 2);
  // Roman learns about Amelie too -> the entity becomes shared knowledge.
  await store.upsertTurn({ user: "Roman", entities: [{ name: "Amelie", type: "person", common: false, props: {} }], relations: [] });
  sub = await store.subgraph({ limit: 60 });
  assert.equal(sub.nodes.find((node) => node.name === "Amelie").common, true);
});

test("memory store: the signed-in user is one node (no duplicate person, no self-KNOWS)", async () => {
  const store = graphdb.createMemoryStore();
  await store.upsertTurn({
    user: "Mila",
    // The extraction always lists the user themselves as a person entity.
    entities: [
      { name: "Mila", type: "person", common: false, props: {} },
      { name: "Lego", type: "thing", common: true, props: {} },
    ],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  const sub = await store.subgraph({ limit: 60 });
  assert.equal(sub.nodes.filter((node) => node.name === "Mila").length, 1, "exactly one Mila node");
  assert.ok(sub.nodes.some((node) => node.name === "Lego" && node.type === "thing"));
  const milaId = sub.nodes.find((node) => node.name === "Mila").id;
  const legoId = sub.nodes.find((node) => node.name === "Lego").id;
  // The LIKES edge goes straight from the single (user) Mila to Lego.
  assert.ok(sub.edges.some((edge) => edge.source === milaId && edge.target === legoId && edge.type === "LIKES"));
  assert.ok(sub.edges.some((edge) => edge.source === milaId && edge.target === legoId && edge.type === "KNOWS"));
  assert.ok(!sub.edges.some((edge) => edge.source === edge.target), "no self-edge");
});

// --- neo4j store (mock driver) --------------------------------------------------

test("neo4j store: subgraph LIMIT is an integer parameter (the JS driver sends plain numbers as floats and Neo4j rejects them)", async () => {
  const { createRequire } = await import("node:module");
  const neo4j = createRequire(import.meta.url)("neo4j-driver");
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher, params) {
          calls.push({ cypher, params });
          return { records: [] };
        },
        async close() {},
      };
    },
  });
  const store = graphdb.createGraphStore({
    uri: "bolt://mock:7687",
    database: "neo4j",
    readUser: "r",
    readPassword: "r",
    writeUser: "w",
    writePassword: "w",
    driverFactory: fakeFactory,
  });
  await store.subgraph({ limit: 20 });
  const limitCall = calls.find((call) => call.cypher.includes("LIMIT $limit"));
  assert.ok(limitCall, "expected the LIMIT $limit query");
  assert.equal(limitCall.params.limit.toNumber(), 20);
  assert.ok(neo4j.isInt(limitCall.params.limit), "limit must be a neo4j.int, not a float");
});

test("neo4j store: upsertTurn Cypher uses only valid relationship patterns", async () => {
  // Neo4j rejects reversed patterns written as -[:KNOWS<-] (parse error at
  // the "<"); the shared-knowledge step used to do exactly that, which made
  // every ingestion fail after the entity MERGE and silently dropped all
  // relations. The mock driver accepts anything, so pin the pattern shape.
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher, params) { calls.push(cypher); return { records: [] }; },
        async close() {},
      };
    },
  });
  const store = graphdb.createGraphStore({
    uri: "bolt://mock:7687",
    database: "neo4j",
    readUser: "r",
    readPassword: "r",
    writeUser: "w",
    writePassword: "w",
    driverFactory: fakeFactory,
  });
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", common: true, props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  assert.ok(calls.length >= 3, "entity MERGE, shared-knowledge and relation MERGE must all run");
  assert.ok(calls.every((cypher) => !/-\[:[A-Z_]+<-\]/.test(cypher)), JSON.stringify(calls));
  assert.ok(calls.some((cypher) => cypher.includes("(:User)-[:KNOWS]->(e:Entity)")), JSON.stringify(calls));
});

test("neo4j store: the user's own person is not MERGEd as an :Entity and user relations target the :User node", async () => {
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher, params) { calls.push({ cypher, params }); return { records: [] }; },
        async close() {},
      };
    },
  });
  const store = graphdb.createGraphStore({
    uri: "bolt://mock:7687",
    database: "neo4j",
    readUser: "r",
    readPassword: "r",
    writeUser: "w",
    writePassword: "w",
    driverFactory: fakeFactory,
  });
  await store.upsertTurn({
    user: "Mila",
    entities: [
      { name: "Mila", type: "person", common: false, props: {} },
      { name: "Lego", type: "thing", common: true, props: {} },
    ],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  const entityMerge = calls.find((call) => call.cypher.includes("MERGE (e:Entity"));
  assert.ok(entityMerge, "expected the entity MERGE");
  // The user's own person must not be part of the entity rows (that would
  // create the duplicate "Mila" node the panel used to show).
  assert.ok(!JSON.stringify(entityMerge.params.rows).includes("Mila"), JSON.stringify(entityMerge.params.rows));
  // The LIKES relation named after the user must target their :User node.
  const likes = calls.find((call) => call.cypher.includes("r:LIKES"));
  assert.ok(likes, "expected the LIKES MERGE");
  assert.ok(likes.cypher.includes("MATCH (a:User {name: $user})"), likes.cypher);
  assert.ok(likes.cypher.includes("MATCH (b:Entity {name: row.to})"), likes.cypher);
});

// --- backend integration -------------------------------------------------------

let upstream;
const backends = [];
const origins = [];
let toolRequests = [];
let finalRequests = [];
let receivedChat;
const MOCK_MCP = fileURLToPath(new URL("./mock-graph-mcp.mjs", import.meta.url));
const EXTRACT_JSON = JSON.stringify({
  entities: [{ name: "Amelie", type: "person", common: false, props: {} }],
  relations: [{ from: "Amelie", to: "Mila", type: "FRIEND_OF" }],
});

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedChat = body;
    const textOf = (message) => (typeof message?.content === "string" ? message.content : "");
    const systemText = (body.messages || []).map(textOf).join("\n");
    res.setHeader("content-type", "application/json");
    if (systemText.includes("extract knowledge-graph entities")) {
      return res.end(JSON.stringify({ choices: [{ message: { content: EXTRACT_JSON } }] }));
    }
    const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === "user");
    const wantsDelete = String(lastUser?.content || "").includes("Delete everything");
    const cypher = wantsDelete ? "MATCH (e:Entity) DETACH DELETE e" : "MATCH (e:Entity) RETURN e.name AS name LIMIT 5";
    const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
    if (body.tools && !hasToolResult) {
      toolRequests.push(body);
      return res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read-cypher", arguments: JSON.stringify({ query: cypher }) } }],
          },
        }],
      }));
    }
    finalRequests.push(body);
    res.end(JSON.stringify({ choices: [{ message: { content: "I checked the graph." } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  // Unconfigured: no NEO4J_* variables at all.
  const unconfigured = await startBackend({ BRAIN_BASE_URL: base, WHISPER_ENDPOINTS: "" });
  backends.push(unconfigured);
  origins.push(unconfigured.origin);
  // Configured with the in-memory store and the mock MCP server.
  const configured = await startBackend({
    BRAIN_BASE_URL: base,
    WHISPER_ENDPOINTS: "",
    NEO4J_URI: "bolt://mock:7687",
    NEO4J_READ_USER: "jarvis_read",
    NEO4J_READ_PASSWORD: "read-secret",
    NEO4J_WRITE_USER: "jarvis_write",
    NEO4J_WRITE_PASSWORD: "write-secret",
    GRAPH_MEMORY: "1",
    MCP_GRAPH_COMMAND: process.execPath,
    MCP_GRAPH_ARGS: JSON.stringify([MOCK_MCP]),
  });
  backends.push(configured);
  origins.push(configured.origin);
});

after(async () => {
  for (const backend of backends) {
    backend.process.kill();
    await once(backend.process, "exit");
  }
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

// Boots server.js on a free port; `logs` accumulates stdout+stderr so the
// mock MCP's stderr lines are visible to the assertions.
function startBackend(extraEnv) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(process.execPath, ["server.js"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, PORT: "0", BRAIN_API_KEY: "", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => { output += chunk; };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => reject(new Error(`backend did not start: ${output}`)), 8000);
    child.stdout.on("data", () => {
      const match = output.match(/listening on 0.0.0.0:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ process: child, origin: `http://127.0.0.1:${match[1]}`, get logs() { return output; } });
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function login(origin, user = "Mila") {
  const response = await fetch(`${origin}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: user }),
  });
  assert.equal(response.status, 200, `login as ${user} should succeed`);
  const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith("jarvis_session="));
  return session.split(";")[0];
}

async function auth(origin, pathname, cookie) {
  return fetch(`${origin}${pathname}`, { headers: { cookie } });
}

async function waitFor(fn, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for graph activity");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("graph endpoints report not configured when the NEO4J_* variables are empty", async () => {
  const origin = origins[0];
  const cookie = await login(origin);
  const status = await auth(origin, "/api/graph/status", cookie);
  assert.equal(status.status, 503);
  assert.equal((await status.json()).error, "graph_not_configured");
  const config = await (await auth(origin, "/api/config", cookie)).json();
  assert.equal(config.graphConfigured, false);
  assert.ok(config.mcpServers.some((server) => server.id === "graph" && server.label === "Knowledge graph"));
});

test("a chat with the graph toggle on degrades gracefully when unconfigured", async () => {
  const origin = origins[0];
  const cookie = await login(origin);
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "What do you remember about me?", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.answer);
  assert.match(receivedChat.messages[0].content, /knowledge graph \(MCP graph server\) is ON in the user's browser but not configured/);
  // No tools are offered without a configured store, and nothing was ingested.
  assert.equal(receivedChat.tools, undefined);
});

test("configured graph: status, schema, context, tool loop and ingestion", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const cookie = await login(origin);

  const status = await (await auth(origin, "/api/graph/status", cookie)).json();
  assert.ok(status.nodes >= 5);
  assert.ok(status.edges >= 4);
  assert.ok(status.labels.includes("Entity"));

  const schema = await (await auth(origin, "/api/graph/schema", cookie)).json();
  assert.ok(schema.relTypes.includes("USES"));

  toolRequests = [];
  finalRequests = [];
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "Do you know my friend Amelie?", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answer, "I checked the graph.");

  // The brain got the tools and the user's stored context.
  assert.equal(toolRequests.length, 1);
  const names = toolRequests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ["get-schema", "read-cypher"]);
  const systemText = toolRequests[0].messages.map((message) => String(message.content || "")).join("\n");
  assert.match(systemText, /Knowledge graph context/);
  assert.match(systemText, /Known to this user so far:.*Rocky/);
  // The tool result came back through the MCP server and was fed to the brain.
  assert.ok(finalRequests.length >= 1);
  const toolMessage = finalRequests[0].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the brain should receive the tool result");
  assert.match(toolMessage.content, /mock data/);
  // The mock MCP saw the read call; no write tool exists on the surface.
  assert.match(backend.logs, /MOCK_GRAPH_CALL read-cypher/);
  assert.doesNotMatch(backend.logs, /MOCK_GRAPH_CALL write-cypher/);
  // The activity ring recorded the brain read.
  const activity = await (await auth(origin, "/api/graph/activity", cookie)).json();
  assert.ok(activity.entries.some((entry) => entry.kind === "brain_query" && entry.ok));

  // Ingestion runs fire-and-forget after the answer: poll until the memory
  // store shows the extracted entity and the activity shows the ingest.
  await waitFor(async () => {
    const entries = (await (await auth(origin, "/api/graph/activity", cookie)).json()).entries;
    return entries.some((entry) => entry.kind === "ingest" && entry.user === "Mila");
  });
  const subgraph = await (await auth(origin, "/api/graph/subgraph?limit=60", cookie)).json();
  const amelie = subgraph.nodes.find((node) => node.name === "Amelie");
  assert.ok(amelie, "the extracted entity should be in the graph");
  assert.equal(amelie.type, "person");
  assert.ok(subgraph.edges.some((edge) => edge.type === "FRIEND_OF"));
});

test("a write Cypher through the read-only tool surface is rejected and reported", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const cookie = await login(origin);
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "Delete everything", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.answer, "the brain should still answer from the error tool result");
  // The delete Cypher reached the MCP (and would reach the DB), but the
  // read-only layer rejected it; the brain got the failure as a tool result.
  assert.match(backend.logs, /MOCK_GRAPH_CALL read-cypher/);
  assert.match(backend.logs, /DETACH DELETE/);
  const lastFinal = finalRequests[finalRequests.length - 1];
  const toolMessage = [...lastFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /read-only/);
});
