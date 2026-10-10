import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import graphdb from "../graphdb.js";

// --- parseExtraction ---------------------------------------------------------

// The graph tool surface only. `search_history` is offered on every chat
// (it reads the user's own stored conversation and has no toggle), so these
// assertions filter it out rather than restating it in each expected list.
const NON_GRAPH_TOOLS = new Set(["search_history"]);
const graphToolNames = (tools) => (tools || [])
  .map((tool) => tool.function.name)
  .filter((name) => !NON_GRAPH_TOOLS.has(name));

test("parseExtraction handles plain, fenced and prose-wrapped JSON", () => {
  const plain = graphdb.parseExtraction('{"entities":[{"name":"Mila","type":"person"}],"relations":[{"from":"Mila","to":"Berlin","type":"LIVES_IN"}]}');
  assert.deepEqual(plain, {
    entities: [{ name: "Mila", type: "person", props: {} }],
    relations: [{ from: "Mila", to: "Berlin", type: "LIVES_IN", negative: false }],
    subjects: [],
  });
  const fenced = graphdb.parseExtraction('Here you go:\n```json\n{"entities":[{"name":"Berlin","type":"place"}],"relations":[]}\n```\nDone.');
  assert.equal(fenced.entities.length, 1);
  assert.equal(fenced.entities[0].name, "Berlin");
});

test("parseExtraction sanitises names, types, props and clamps counts", () => {
  const many = {
    entities: Array.from({ length: 30 }, (_, index) => ({ name: `  E${index}  `, type: index % 2 ? "place" : "bogus-type", props: { okkey: `v${index}`, "Bad Key": "x", name: "injected" } })),
    relations: Array.from({ length: 40 }, (_, index) => ({ from: "A", to: `B${index}`, type: "I REALLY DO NOT KNOW" })),
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

test("parseExtraction introduces well-formed new relation types, rejects prose and the reserved KNOWS", () => {
  const parsed = graphdb.parseExtraction(JSON.stringify({
    entities: [{ name: "Roman", type: "person" }, { name: "Home Assistant", type: "thing" }],
    relations: [
      { from: "Roman", to: "Home Assistant", type: "interested_in" },
      { from: "Roman", to: "Home Assistant", type: "PLANNING TO VISIT" },
      { from: "Roman", to: "Berlin", type: "I AM NOT SURE ABOUT THIS ONE" },
      { from: "Mila", to: "Berlin", type: "KNOWS" },
    ],
  }));
  assert.deepEqual(parsed.relations, [
    { from: "Roman", to: "Home Assistant", type: "INTERESTED_IN", negative: false },
    { from: "Roman", to: "Home Assistant", type: "PLANNING_TO_VISIT", negative: false },
    { from: "Roman", to: "Berlin", type: "RELATED_TO", negative: false },
    { from: "Mila", to: "Berlin", type: "RELATED_TO", negative: false },
  ]);
});

test("parseToolCallsFromContent recovers the native XML tool calls as OpenAI-shaped calls", () => {
  // The DeepSeek-native shape the brain endpoint leaks into `content`:
  const xml = '<|tool_calls|><|invoke| name="list-my-facts"><|parameter| name="relation" string="true">PART_OF<|/parameter|><|/invoke|><|/tool_calls|>';
  const calls = graphdb.parseToolCallsFromContent(xml);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].function.name, "list-my-facts");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { relation: "PART_OF" });
  assert.ok(calls[0].id, "the synthesized call carries an id for the tool result");
  // Multiple calls in one message, typed values, and missing wrapper tokens.
  const multi = '<invoke name="store-fact" >'
    + '<parameter name="owner" string="true">Mila</parameter>'
    + '<parameter name="negative">true</parameter>'
    + '<parameter name="count">3</parameter>'
    + "</invoke>"
    + '<invoke name="delete-entity"><parameter name="name">Berlin</parameter><parameter name="owner">Mila</parameter></invoke>';
  const multiCalls = graphdb.parseToolCallsFromContent(multi);
  assert.equal(multiCalls.length, 2, JSON.stringify(multiCalls));
  assert.deepEqual(JSON.parse(multiCalls[0].function.arguments), { owner: "Mila", negative: true, count: 3 });
  assert.deepEqual(JSON.parse(multiCalls[1].function.arguments), { name: "Berlin", owner: "Mila" });
});

test("parseToolCallsFromContent leaves ordinary answers untouched", () => {
  assert.deepEqual(graphdb.parseToolCallsFromContent("The graph shows 14 nodes."), []);
  assert.deepEqual(graphdb.parseToolCallsFromContent(null), []);
  // Prose that merely mentions the format is not reinterpreted: without the
  // tool_calls wrapper, BOTH an invoke and a parameter tag are required.
  assert.deepEqual(graphdb.parseToolCallsFromContent('The model replies with <invoke name="foo"> blocks.'), []);
});

test("parseExtraction drops duplicates, self-relations and garbage", () => {
  assert.deepEqual(graphdb.parseExtraction("no json here"), { entities: [], relations: [], subjects: [] });
  assert.deepEqual(graphdb.parseExtraction("{{{"), { entities: [], relations: [], subjects: [] });
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
  // One entity per turn per NAME (case-insensitive — the store's key is
  // name+owner without the type): "  Mila  "/PERSON and "Mila" are the same
  // entity, and the same name with a different type ("Mila" place) is the
  // SAME entity re-described, not a second one — the first occurrence wins.
  assert.deepEqual(parsed.entities.map((entity) => `${entity.name}:${entity.type}`), ["Mila:person"]);
  assert.deepEqual(parsed.relations, [{ from: "Mila", to: "Roman", type: "FRIEND_OF", negative: false }]);
});

test("parseExtraction carries the negation flag (only boolean true counts)", () => {
  const parsed = graphdb.parseExtraction(JSON.stringify({
    entities: [],
    relations: [
      { from: "Mila", to: "Lego", type: "LIKES", negative: true },
      { from: "Mila", to: "Lego", type: "USES", negative: "yes" },
      { from: "Mila", to: "Berlin", type: "LIVES_IN" },
    ],
  }));
  assert.deepEqual(parsed.relations, [
    { from: "Mila", to: "Lego", type: "LIKES", negative: true },
    { from: "Mila", to: "Lego", type: "USES", negative: false },
    { from: "Mila", to: "Berlin", type: "LIVES_IN", negative: false },
  ]);
});

test("parseExtraction parses question subjects: canonicalised, deduped, capped, auto-added", () => {
  const parsed = graphdb.parseExtraction(JSON.stringify({
    entities: [
      { name: "Roman", type: "person" },
      { name: "Jean Reno", type: "person" },
      { name: "Léon: The Professional", type: "thing" },
    ],
    relations: [
      { from: "Jean Reno", to: "Léon: The Professional", type: "ACTED_IN" },
      { from: "Roman", to: "Jean Reno", type: "ASKED_ABOUT" },
    ],
    question_subjects: ["jean reno", "Jean Reno", null, "Bruce Willis", "Bruce Willis", "Mel Gibson", "Dwayne Johnson"],
  }));
  // A subject is canonicalised to the entity's spelling, deduped
  // case-insensitively and capped at three — the fourth distinct name is
  // dropped with its would-be entity.
  assert.deepEqual(parsed.subjects, ["Jean Reno", "Bruce Willis", "Mel Gibson"]);
  // A subject missing from the entities list is added (type "thing"), so the
  // subject node is never lost to the "only entities a fact connects are
  // stored" rule.
  assert.deepEqual(parsed.entities.find((entity) => entity.name === "Bruce Willis"), { name: "Bruce Willis", type: "thing", props: {} });
  assert.deepEqual(parsed.entities.find((entity) => entity.name === "Mel Gibson"), { name: "Mel Gibson", type: "thing", props: {} });
  assert.ok(!parsed.entities.some((entity) => entity.name === "Dwayne Johnson"), "past the cap: no entity, no subject");
  // ASKED_ABOUT is reserved: an LLM-emitted copy degrades to RELATED_TO like
  // any prose type — the backend books the real edge itself.
  assert.deepEqual(parsed.relations, [
    { from: "Jean Reno", to: "Léon: The Professional", type: "ACTED_IN", negative: false },
    { from: "Roman", to: "Jean Reno", type: "RELATED_TO", negative: false },
  ]);
});

test("formatGraphContext renders the user's own entities only (no shared tier)", () => {
  const text = graphdb.formatGraphContext({
    userEntities: [{ name: "Berlin", type: "place" }],
  });
  assert.match(text, /Known to this user so far: Berlin \(place\)/);
  assert.doesNotMatch(text, /Shared knowledge/);
  assert.equal(graphdb.formatGraphContext({ userEntities: [] }), "");
});

// --- search -------------------------------------------------------------------

test("buildLuceneQuery escapes the user's text and requires the owner", () => {
  // Every token must match, and within a token exact beats prefix beats typo.
  const query = graphdb.buildLuceneQuery("Nvidia", { owner: "Roman" });
  assert.match(query, /\+owner:roman/, query);
  assert.match(query, /name:nvidia\^4/, query);
  assert.match(query, /name:nvidia\*\^2/, query);
  assert.match(query, /name:nvidia~\^1/, query);
  // Multi-token: both are required, so the search narrows as you type.
  const two = graphdb.buildLuceneQuery("home assistant", { owner: "Roman" });
  assert.equal((two.match(/\+\(/g) || []).length, 2, two);
  // Lucene's own operators in the input are escaped to plain text: a stray
  // quote or bracket would otherwise be a parse error (a 502 on every
  // keystroke) or silently change what the query means.
  const nasty = graphdb.buildLuceneQuery('a") OR owner:Mila OR (name:"b', { owner: "Roman" });
  assert.ok(!/[^\\]"/.test(nasty), `quotes are escaped: ${nasty}`);
  assert.match(nasty, /\+owner:roman/, "the owner term still pins the search");
  assert.ok(!/[^\\:]owner:mila/.test(nasty), `no injected owner term: ${nasty}`);
  // Short tokens get no prefix/fuzzy clause: at two characters a typo budget
  // matches most of the graph.
  const short = graphdb.buildLuceneQuery("ab", { owner: "Roman" });
  assert.ok(!short.includes("~"), short);
  // The admin session searches every owner, so no owner term is added.
  assert.ok(!graphdb.buildLuceneQuery("gold", { owner: null }).includes("owner:"), "admin: no owner pin");
  // Nothing to search for is not a query at all (the caller skips the index).
  assert.equal(graphdb.buildLuceneQuery("   ", { owner: "Roman" }), null);
});

test("matchRelationTypes finds link types by word, prefix and typo, never KNOWS", () => {
  const types = ["LIKES", "INTERESTED_IN", "LIVES_IN", "WORKS_AT", "KNOWS"];
  // The exact match ranks first. A near miss may follow it — "likes" really is
  // one edit from "lives", and a typo tolerance cannot know which was meant —
  // so what matters is the order, not that the list holds one entry.
  assert.equal(graphdb.matchRelationTypes("likes", types)[0], "LIKES");
  // A word of a compound type, and the whole thing spelled out.
  assert.deepEqual(graphdb.matchRelationTypes("interested", types), ["INTERESTED_IN"]);
  assert.deepEqual(graphdb.matchRelationTypes("interested in", types), ["INTERESTED_IN"]);
  // A typo within the budget still finds it.
  assert.deepEqual(graphdb.matchRelationTypes("intrested", types), ["INTERESTED_IN"]);
  assert.deepEqual(graphdb.matchRelationTypes("lkes", types), ["LIKES"]);
  assert.equal(graphdb.matchRelationTypes("lives", types)[0], "LIVES_IN");
  // "in" matches both compound types; the closest match is listed first.
  assert.deepEqual(graphdb.matchRelationTypes("in", types).sort(), ["INTERESTED_IN", "LIVES_IN"]);
  // KNOWS is internal bookkeeping and is never offered as a link to filter on.
  assert.deepEqual(graphdb.matchRelationTypes("knows", types), []);
  assert.deepEqual(graphdb.matchRelationTypes("", types), []);
});

test("memory store: search is fuzzy, case-insensitive and scoped to the owner", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman"]);
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Nvidia", type: "organization", props: {} }, { name: "Home Assistant", type: "thing", props: {} }],
    relations: [
      { from: "Roman", to: "Nvidia", type: "INTERESTED_IN" },
      { from: "Roman", to: "Home Assistant", type: "USES" },
    ],
  });
  const names = async (query, options = {}) =>
    (await store.search({ user: "Roman", query, ...options })).nodes.map((node) => node.name);
  assert.deepEqual(await names("nvidia"), ["Nvidia"], "case-insensitive");
  assert.deepEqual(await names("NVIDIA"), ["Nvidia"], "upper case too");
  assert.deepEqual(await names("nvidea"), ["Nvidia"], "a typo still finds it");
  assert.deepEqual(await names("nvi"), ["Nvidia"], "a prefix finds it");
  assert.deepEqual(await names("assistant"), ["Home Assistant"], "a later word of the name");
  assert.deepEqual(await names("home assist"), ["Home Assistant"], "every token must match");
  assert.deepEqual(await names("zzzz"), [], "no false positives");
  // Scoping: Mila's search never reaches Roman's entities, and the admin's does.
  assert.deepEqual((await store.search({ user: "Mila", query: "nvidia" })).nodes, [], "owner-scoped");
  const asAdmin = await store.search({ user: "admin", query: "nvidia", admin: true });
  assert.deepEqual(asAdmin.nodes.map((node) => node.owner), ["Roman"], "the admin searches every owner");
  // Link types come back alongside the entities, from the query's own words.
  const linkHit = await store.search({ user: "Roman", query: "interested" });
  assert.deepEqual(linkHit.relTypes, ["INTERESTED_IN"], JSON.stringify(linkHit));
  // The result list is bounded and says so.
  const bounded = await store.search({ user: "Roman", query: "o", limit: 1 });
  assert.ok(bounded.nodes.length <= 1, JSON.stringify(bounded));
});

// --- memory store -------------------------------------------------------------

test("memory store: status, context, upsert, per-user scope and neighbourhood", async () => {
  const store = graphdb.createMemoryStore();
  // Mila's drawn world: her node, the entities she owns (Rocky and Kokoro via
  // Rocky -USES->, and the isolated mention Berlin — drawn, but flagged
  // `isolated` for the UI to dim) and the fact edges. Roman's private data is
  // not in the counts.
  const status = await store.status({ user: "Mila" });
  assert.equal(status.nodes, 4, JSON.stringify(status));
  assert.equal(status.edges, 1, JSON.stringify(status));
  const context = await store.readContext("Mila");
  assert.ok(context.userEntities.some((entity) => entity.name === "Rocky"));
  // Berlin is Mila's own entity now (owner-keyed) — the brain context has no
  // shared tier any more.
  assert.ok(context.userEntities.some((entity) => entity.name === "Berlin"));
  assert.equal(context.commonEntities, undefined, "no shared tier in the brain context");
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Amelie", type: "person", props: { city: "Leipzig" } }],
    relations: [{ from: "Amelie", to: "Mila", type: "FRIEND_OF" }],
  });
  let sub = await store.subgraph({ user: "Mila" });
  assert.ok(sub.nodes.some((node) => node.name === "Amelie"));
  assert.ok(sub.edges.some((edge) => edge.type === "FRIEND_OF"));
  assert.equal(sub.nodes.find((node) => node.name === "Amelie").isolated, false, "Amelie has a fact edge");
  assert.equal(sub.nodes.find((node) => node.name === "Mila").isolated, false, "the :User node is never isolated");
  // Berlin was a bare mention the demo world started with — a legacy node
  // with no path of fact edges to Mila's :User node. The stored policy
  // removes it on this first ingest: an entity with no relation to the user
  // does not belong in the world.
  assert.ok(!sub.nodes.some((node) => node.name === "Berlin"), "the pre-existing isolated mention is swept by the policy");
  const amelieId = sub.nodes.find((node) => node.name === "Amelie").id;
  const centered = await store.subgraph({ user: "Mila", center: amelieId });
  assert.ok(centered.nodes.some((node) => node.name === "Mila"));
  // Only the real fact (Amelie->Mila FRIEND_OF) is drawn; the bookkeeping
  // Mila->Amelie KNOWS edge from the upsert stays out of the panel data.
  assert.equal(centered.edges.length, 1);
  assert.equal(centered.edges[0].type, "FRIEND_OF");
  // Roman mentions Amelie too: he gets his OWN copy (owner Roman) — Mila's
  // node is a different node and stays untouched (owner-keyed isolation).
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Amelie", type: "person", props: {} }],
    relations: [{ from: "Roman", to: "Amelie", type: "FRIEND_OF" }],
  });
  sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.nodes.find((node) => node.name === "Amelie").owner, "Mila", "Mila's Amelie node is still hers");
  // And Roman's view does not contain Mila's fact edge at all.
  const romanSub = await store.subgraph({ user: "Roman" });
  assert.ok(romanSub.nodes.some((node) => node.name === "Amelie" && node.owner === "Roman"), "Roman has his own copy");
  assert.ok(!romanSub.nodes.some((node) => node.name === "Mila"), "no other user node");
  // His starter's isolated Coffee was swept the same way on his first ingest.
  assert.ok(!romanSub.nodes.some((node) => node.name === "Coffee"), "his pre-existing isolated mention was swept on his first ingest");
});

test("memory store: an entity no fact connects is never stored", async () => {
  const store = graphdb.createMemoryStore(["Mila"]);
  // A bare mention ("we talked about Vienna") carries no fact: storing it
  // would put a node in the panel that no edge touches.
  const bare = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Vienna", type: "place", props: {} }],
    relations: [],
  });
  assert.equal(bare.upserted, 0, "nothing is stored for a mention without a fact");
  assert.equal(bare.skippedUnconnected, 1, "and it is counted as skipped, not as stored");
  let sub = await store.subgraph({ user: "Mila" });
  assert.ok(!sub.nodes.some((node) => node.name === "Vienna"), "no unconnected node appears");
  // The same entity WITH a fact is stored, and the fact is drawn.
  const connected = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Vienna", type: "place", props: {} }],
    relations: [{ from: "Mila", to: "Vienna", type: "LIVES_IN" }],
  });
  assert.equal(connected.upserted, 1, "a connected entity is stored");
  assert.equal(connected.skippedUnconnected, 0);
  assert.deepEqual(connected.orphansRemoved, [], "and the check finds nothing to undo");
  sub = await store.subgraph({ user: "Mila" });
  const vienna = sub.nodes.find((node) => node.name === "Vienna");
  assert.ok(vienna, "the connected entity is in the world");
  assert.equal(vienna.isolated, false, "and it is not isolated");
});

test("memory store: the policy sweeps every entity without a path of fact edges to the user", async () => {
  const store = graphdb.createMemoryStore(["Mila"]);
  // The starter world holds a pre-existing orphan: Berlin, a bare mention
  // with no path of fact edges to Mila's :User node. A turn that never
  // mentions it still removes it — the stored policy is global (no entity
  // may float without a relation to the user), not scoped to the turn's own
  // names, and the removal is reported.
  const result = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Vienna", type: "place", props: {} }],
    relations: [{ from: "Mila", to: "Vienna", type: "LIVES_IN" }],
  });
  assert.ok(result.orphansRemoved.includes("Berlin"), `the pre-existing orphan is swept: ${JSON.stringify(result)}`);
  let sub = await store.subgraph({ user: "Mila" });
  assert.ok(!sub.nodes.some((node) => node.name === "Berlin"), "the orphan is gone");
  assert.equal(sub.nodes.find((node) => node.name === "Vienna").isolated, false, "the connected entity survives");
  // A fact between two entities neither of which touches the user is a
  // disconnected cluster: removed on the very turn it is created. (The
  // starter's own Rocky/Kokoro-82M pair is such a cluster, so it goes too.)
  const cluster = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Rocky", type: "thing", props: {} }, { name: "Kokoro", type: "thing", props: {} }],
    relations: [{ from: "Rocky", to: "Kokoro", type: "USES" }],
  });
  assert.ok(cluster.orphansRemoved.includes("Kokoro"), `the new cluster is swept: ${JSON.stringify(cluster)}`);
  assert.ok(cluster.orphansRemoved.includes("Rocky"), "the starter's disconnected pair goes with it");
  sub = await store.subgraph({ user: "Mila" });
  assert.ok(!sub.nodes.some((node) => node.name === "Kokoro"), "the disconnected cluster is gone");
  // A chain that reaches the user survives: Mila OWNS a tool, the tool
  // USES a model — two hops away, still a relation to the user.
  const chain = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Jarvis", type: "thing", props: {} }, { name: "Whisper", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Jarvis", type: "OWNS" }, { from: "Jarvis", to: "Whisper", type: "USES" }],
  });
  assert.deepEqual(chain.orphansRemoved, [], JSON.stringify(chain));
  sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.nodes.find((node) => node.name === "Whisper").isolated, false, "a two-hop entity stays connected");
  assert.equal(sub.nodes.find((node) => node.name === "Jarvis").isolated, false, "and so is the one-hop one");
});

test("memory store: a fact onto an entity stored in an earlier turn still links (and keeps both)", async () => {
  const store = graphdb.createMemoryStore(["Mila"]);
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Rocky", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Rocky", type: "OWNS" }],
  });
  // The later turn names Rocky only as a relation endpoint, without
  // re-extracting it as an entity: it must still resolve to the stored copy,
  // or the new entity would be created with an edge into thin air and then
  // swept as an orphan.
  const result = await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Kokoro", type: "thing", props: {} }],
    relations: [{ from: "Rocky", to: "Kokoro", type: "USES" }],
  });
  assert.equal(result.upserted, 1, "the new entity is stored");
  assert.equal(result.relations, 1, "and the fact onto the earlier entity is linked");
  const sub = await store.subgraph({ user: "Mila" });
  assert.ok(sub.nodes.some((node) => node.name === "Kokoro"), "Kokoro survived the ingest check");
  assert.ok(sub.edges.some((edge) => edge.type === "USES"), "the USES fact is drawn");
  // Both ends of the new fact are connected (the demo world's own pre-existing
  // mentions are another matter — the check only covers this turn's names).
  assert.equal(sub.nodes.find((node) => node.name === "Kokoro").isolated, false, "the stored entity is connected");
  assert.equal(sub.nodes.find((node) => node.name === "Rocky").isolated, false, "and so is the earlier one it links to");
});

test("memory store: the signed-in user is one node (no duplicate person, no self-KNOWS)", async () => {
  const store = graphdb.createMemoryStore();
  await store.upsertTurn({
    user: "Mila",
    // The extraction always lists the user themselves as a person entity.
    entities: [
      { name: "Mila", type: "person", props: {} },
      { name: "Lego", type: "thing", props: {} },
    ],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  const sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.nodes.filter((node) => node.name === "Mila").length, 1, "exactly one Mila node");
  assert.ok(sub.nodes.some((node) => node.name === "Lego" && node.type === "thing"));
  const milaId = sub.nodes.find((node) => node.name === "Mila").id;
  const legoId = sub.nodes.find((node) => node.name === "Lego").id;
  // The LIKES edge goes straight from the single (user) Mila to Lego.
  assert.ok(sub.edges.some((edge) => edge.source === milaId && edge.target === legoId && edge.type === "LIKES"));
  assert.ok(!sub.edges.some((edge) => edge.source === edge.target), "no self-edge");
  // The bookkeeping KNOWS edge is internal (brain context / shared flag) and
  // never part of the panel's subgraph.
  assert.ok(!sub.edges.some((edge) => edge.type === "KNOWS"), "KNOWS stays out of the panel data");
  const schema = await store.schema();
  assert.ok(schema.relTypes.includes("LIKES"));
  assert.ok(!schema.relTypes.includes("KNOWS"), "the schema line must not advertise KNOWS");
});

test("memory store: a mention of a registered user stores nothing and counts it as skipped", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman", "admin"]);
  const before = (await store.subgraph({ user: "Roman" })).nodes.length;
  // The extractor named a person who has their own account: that person is
  // their :User node, never an :Entity — and the counts must say so, or the
  // activity feed lies about "stored N entities".
  const result = await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Mila", type: "person", props: {} }],
    relations: [],
  });
  assert.equal(result.upserted, 0, JSON.stringify(result));
  assert.equal(result.relations, 0, JSON.stringify(result));
  assert.equal(result.skippedUsers, 1, "the user mention is counted as a user skip, not an unconnected one");
  assert.equal(result.skippedUnconnected, 0, JSON.stringify(result));
  const after = await store.subgraph({ user: "Roman" });
  assert.ok(!after.nodes.some((node) => node.name === "Mila"), "no Mila node appears in Roman's world");
  assert.ok(!after.nodes.some((node) => node.name === "Mila"), "no Mila node appears in Roman's world");
});

test("memory store: introduced relation types are stored, malformed ones are dropped", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman"]);
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Home Assistant", type: "thing", props: {} }],
    relations: [
      { from: "Mila", to: "Home Assistant", type: "INTERESTED_IN" },
      { from: "Mila", to: "Home Assistant", type: "I AM NOT SURE ABOUT THIS ONE" },
    ],
  });
  const sub = await store.subgraph({ user: "Mila" });
  const types = sub.edges.map((edge) => edge.type);
  // Only the introduced type: the starter fact (Rocky USES Kokoro) went with
  // its disconnected cluster — the policy sweep removes both on this first
  // ingest — and the malformed type was dropped before the write.
  assert.deepEqual(types, ["INTERESTED_IN"], `edges: ${JSON.stringify(types)}`);
  assert.ok(!types.includes("RELATED_TO"), `no fallback type: ${JSON.stringify(types)}`);
  // The schema picks the new type up from the store itself.
  const schema = await store.schema();
  assert.ok(schema.relTypes.includes("INTERESTED_IN"), JSON.stringify(schema.relTypes));
});

test("memory store: one entity per owner per name — a re-extracted type or casing never creates a second copy", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman"]);
  // The reported bug: the same name extracted as "topic" in one turn and as
  // "thing" (or with different casing) in a later turn was TWO nodes.
  // Each mention carries its own fact: an entity no fact connects is not
  // stored at all, so identity is exercised through connected mentions.
  await store.upsertTurn({ user: "Roman", entities: [{ name: "BTCUSD", type: "topic", props: {} }], relations: [{ from: "Roman", to: "BTCUSD", type: "OWNS" }] });
  await store.upsertTurn({ user: "Roman", entities: [{ name: "btcusd", type: "thing", props: {} }], relations: [{ from: "Roman", to: "btcusd", type: "LIKES" }] });
  const sub = await store.subgraph({ user: "Roman" });
  const btc = sub.nodes.filter((node) => node.name.toLowerCase() === "btcusd" && node.owner === "Roman");
  assert.equal(btc.length, 1, `one node per owner per name: ${JSON.stringify(btc)}`);
  // The first stored copy wins (spelling + type); the re-mention only bumps
  // the bookkeeping.
  assert.equal(btc[0].name, "BTCUSD");
  assert.equal(btc[0].type, "topic");
  // Facts to the case/type variant resolve to the SAME node — no dangling
  // edges, no second node.
  await store.upsertTurn({ user: "Roman", relations: [{ from: "Roman", to: "btcusd", type: "WATCHES" }] });
  const sub2 = await store.subgraph({ user: "Roman" });
  const edges = sub2.edges.filter((edge) => {
    const node = sub2.nodes.find((candidate) => candidate.id === edge.target);
    return node && node.name.toLowerCase() === "btcusd";
  });
  assert.deepEqual(edges.map((edge) => edge.type), ["OWNS", "LIKES", "WATCHES"], JSON.stringify(edges));
  assert.equal(sub2.nodes.filter((node) => node.name.toLowerCase() === "btcusd").length, 1);
  // Ownership is still the isolation boundary: the same name under another
  // owner is that other user's own copy.
  await store.upsertTurn({ user: "Mila", entities: [{ name: "btcusd", type: "topic", props: {} }], relations: [{ from: "Mila", to: "btcusd", type: "WATCHES" }] });
  const milaSub = await store.subgraph({ user: "Mila" });
  assert.ok(milaSub.nodes.some((node) => node.name.toLowerCase() === "btcusd" && node.owner === "Mila"), "Mila gets her own copy");
  assert.equal((await store.subgraph({ user: "Roman" })).nodes.filter((node) => node.name.toLowerCase() === "btcusd").length, 1);
});

test("memory store: negation is a flag on the same edge and flips on re-statement", async () => {
  const store = graphdb.createMemoryStore();
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  let sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.edges.filter((edge) => edge.type === "LIKES")[0].negative, false);
  // "I don't like Lego anymore": the same edge flips, no second edge appears.
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES", negative: true }],
  });
  sub = await store.subgraph({ user: "Mila" });
  const likes = sub.edges.filter((edge) => edge.type === "LIKES");
  assert.equal(likes.length, 1, "one LIKES edge, not a new one");
  assert.equal(likes[0].negative, true, "the flag flipped to negative");
  // And a positive re-statement flips it back.
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.edges.filter((edge) => edge.type === "LIKES")[0].negative, false);
});

test("memory store: per-user isolation — each user sees only their own world", async () => {
  // The registered user list is what makes "Mila" a user, not an entity.
  const store = graphdb.createMemoryStore(["Mila", "Roman"]);
  // Each user keeps a private fact; both share the starter world (Rocky, ...).
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Pizza", type: "thing", props: {} }],
    relations: [{ from: "Roman", to: "Pizza", type: "LIKES" }],
  });
  const roman = await store.subgraph({ user: "Roman" });
  const romanNames = roman.nodes.map((node) => node.name);
  assert.ok(romanNames.includes("Roman") && romanNames.includes("Pizza"));
  assert.ok(!romanNames.includes("Mila"), `no other user node: ${JSON.stringify(romanNames)}`);
  assert.ok(!romanNames.includes("Lego"), `no other user's entity: ${JSON.stringify(romanNames)}`);
  assert.ok(roman.edges.some((edge) => edge.type === "LIKES"), "Roman's own fact is visible");
  // Mila's world is symmetric: her fact and entity, nothing of Roman's.
  const mila = await store.subgraph({ user: "Mila" });
  assert.ok(mila.nodes.some((node) => node.name === "Lego"));
  assert.ok(!mila.nodes.some((node) => node.name === "Pizza"));
  assert.ok(!mila.nodes.some((node) => node.name === "Roman"));
  // A fact Roman states ABOUT Mila lands on her :User node — an account
  // marker (name only, no personal data), never a "Mila" person entity.
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Mila", type: "person", props: {} }],
    relations: [{ from: "Mila", to: "Pizza", type: "LIKES" }],
  });
  const romanAfter = await store.subgraph({ user: "Roman" });
  // His own fact plus the one he stated about Mila, whose node appears as a
  // type-less account marker — never as a person entity or with her data.
  assert.equal(romanAfter.edges.filter((edge) => edge.type === "LIKES").length, 2, JSON.stringify(romanAfter.edges));
  const milaMarker = romanAfter.nodes.find((node) => node.name === "Mila");
  assert.ok(milaMarker, "Mila appears as an account marker");
  assert.equal(milaMarker.type, undefined, "the marker is type-less, not a person entity");
  // And the other direction holds: Mila never sees Roman's entity "Pizza"
  // because of his statement about her (owner-keyed isolation).
  const milaAfter = await store.subgraph({ user: "Mila" });
  assert.ok(!milaAfter.nodes.some((node) => node.name === "Pizza"), `no other user's entity leaks: ${JSON.stringify(milaAfter.nodes.map((node) => node.name))}`);
  // Status counts are scoped the same way. The policy already swept the
  // starter world's isolated mentions (Rocky/Berlin/Kokoro on Mila's first
  // ingest, Coffee on Roman's), so each world holds its own facts' endpoints
  // only — never the other user's.
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Car", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Car", type: "OWNS" }],
  });
  const romanStatus = await store.status({ user: "Roman" });
  const milaStatus = await store.status({ user: "Mila" });
  // Roman: his node, Pizza and Mila's account marker (his fact about her).
  // Mila: her node, Lego, Car.
  assert.equal(romanStatus.nodes, 3, JSON.stringify(romanStatus));
  assert.equal(romanStatus.edges, 2, JSON.stringify(romanStatus));
  assert.equal(milaStatus.nodes, 3, JSON.stringify(milaStatus));
  assert.equal(milaStatus.edges, 2, JSON.stringify(milaStatus));
  // A centre the user cannot see (another user's node) comes back empty.
  const milaNodeId = mila.nodes.find((node) => node.name === "Mila").id;
  const foreign = await store.subgraph({ user: "Roman", center: milaNodeId });
  assert.equal(foreign.nodes.length, 0, "foreign centre must not be drawable");
  // But the user can centre on their own node and on known entities.
  const romanNodeId = roman.nodes.find((node) => node.name === "Roman").id;
  const own = await store.subgraph({ user: "Roman", center: romanNodeId });
  assert.ok(own.nodes.some((node) => node.name === "Pizza"));
  const pizzaId = roman.nodes.find((node) => node.name === "Pizza").id;
  const centeredPizza = await store.subgraph({ user: "Roman", center: pizzaId });
  assert.equal(centeredPizza.nodes.length, 3, "Pizza plus Roman's node and Mila's account marker");
});

test("memory store: the admin sees the whole graph (every user's nodes, owners and facts)", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman", "admin"]);
  // Roman adds a private fact on top of the starter world. His first ingest
  // sweeps his own isolated starter mention (Coffee); Mila never ingests, so
  // her starter world (Rocky/Berlin/Kokoro) survives until one of her turns.
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Pizza", type: "thing", props: {} }],
    relations: [{ from: "Roman", to: "Pizza", type: "LIKES" }],
  });
  // The admin's panel view is the WHOLE graph: every account node, every
  // owner-keyed entity (isolated ones flagged) and every fact edge.
  const adminStatus = await store.status({ user: "admin", admin: true });
  assert.equal(adminStatus.nodes, 6, JSON.stringify(adminStatus));
  assert.equal(adminStatus.edges, 2, JSON.stringify(adminStatus));
  const adminSub = await store.subgraph({ user: "admin", admin: true });
  const names = adminSub.nodes.map((node) => node.name);
  assert.ok(names.includes("Mila") && names.includes("Roman"), `every user's account node: ${JSON.stringify(names)}`);
  assert.ok(names.includes("Rocky") && names.includes("Pizza"), "every user's surviving entities are drawn");
  assert.ok(!names.includes("Coffee"), "Roman's isolated mention was swept on his first ingest");
  // Same-named entities of different owners would both appear; here the
  // owner field is what keeps copies tellable apart.
  assert.equal(adminSub.nodes.find((node) => node.name === "Pizza").owner, "Roman");
  assert.equal(adminSub.nodes.find((node) => node.name === "Rocky").owner, "Mila");
  // A pre-existing isolated mention keeps its flag in the admin view, too.
  assert.equal(adminSub.nodes.find((node) => node.name === "Berlin").isolated, true);
  assert.equal(adminSub.nodes.find((node) => node.name === "Pizza").isolated, false, "Pizza has a fact edge");
  // A regular user is unaffected: no admin flag -> no cross-user data.
  const milaSub = await store.subgraph({ user: "Mila", admin: false });
  assert.ok(!milaSub.nodes.some((node) => node.name === "Pizza"), "Mila never sees Roman's entity");
  // The admin may centre on ANY node, whoever owns it.
  const rockyId = adminSub.nodes.find((node) => node.name === "Rocky").id;
  const centered = await store.subgraph({ user: "admin", admin: true, center: rockyId });
  assert.ok(centered.nodes.some((node) => node.name === "Kokoro-82M"), "admin centre reaches any neighbour");
});

test("memory store: removeEntity deletes only the caller's own entity, with its edges", async () => {
  const store = graphdb.createMemoryStore(["Mila", "Roman"]);
  const milaSub = await store.subgraph({ user: "Mila" });
  const rocky = milaSub.nodes.find((node) => node.name === "Rocky");
  const milaNode = milaSub.nodes.find((node) => node.name === "Mila");
  const romanSub = await store.subgraph({ user: "Roman" });
  const coffee = romanSub.nodes.find((node) => node.name === "Coffee");
  // A foreign entity id is indistinguishable from a nonexistent one: no
  // cross-user write, no enumeration.
  assert.deepEqual(await store.removeEntity({ user: "Mila", id: coffee.id }), { deleted: 0, name: null, orphansRemoved: [] });
  assert.ok((await store.subgraph({ user: "Roman" })).nodes.some((node) => node.id === coffee.id), "Roman's Coffee survived Mila's attempt");
  // A :User account node is never deletable, not even by its own user.
  assert.deepEqual(await store.removeEntity({ user: "Mila", id: milaNode.id }), { deleted: 0, name: null, orphansRemoved: [] });
  // The caller's own entity is gone, together with its edges (Rocky -USES->
  // Kokoro) — and the policy sweeps everything the removal left without a
  // path of fact edges to Mila's node: the freed Kokoro-82M and the
  // starter's isolated Berlin, which had none to begin with.
  assert.deepEqual(await store.removeEntity({ user: "Mila", id: rocky.id }),
    { deleted: 1, name: "Rocky", orphansRemoved: ["Berlin", "Kokoro-82M"] });
  const after = await store.subgraph({ user: "Mila" });
  assert.ok(!after.nodes.some((node) => node.id === rocky.id), "Rocky is gone from Mila's view");
  assert.equal(after.edges.length, 0, "the USES edge is deleted with its node");
  assert.ok(!after.nodes.some((node) => node.name === "Kokoro-82M"), "the freed neighbour is swept by the policy");
  // The admin may delete any entity, whoever owns it.
  assert.deepEqual(await store.removeEntity({ user: "admin", id: coffee.id, admin: true }), { deleted: 1, name: "Coffee", orphansRemoved: [] });
  const adminAfter = await store.subgraph({ user: "admin", admin: true });
  assert.ok(!adminAfter.nodes.some((node) => node.id === coffee.id), "Coffee is gone from the global view");
  // Deleting again is a clean no-op.
  assert.deepEqual(await store.removeEntity({ user: "Mila", id: rocky.id }), { deleted: 0, name: null, orphansRemoved: [] });
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
          // The scoped subgraph starts from the user's :User node; without a
          // row it would stop before the LIMIT query.
          const records = cypher.includes("MATCH (u:User {name: $user}) RETURN elementId(u)")
            ? [{ toObject: () => ({ id: "u1", name: "Mila" }) }]
            : [];
          return { records };
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
  await store.subgraph({ user: "Mila", limit: 20 });
  const limitCall = calls.find((call) => call.cypher.includes("LIMIT $limit"));
  assert.ok(limitCall, "expected the LIMIT $limit query");
  assert.equal(limitCall.params.limit.toNumber(), 20);
  assert.ok(neo4j.isInt(limitCall.params.limit), "limit must be a neo4j.int, not a float");
});

test("neo4j store: removeEntity pins the owner-scoped DETACH DELETE (admin: no owner pin)", async () => {
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher, params) {
          calls.push({ cypher, params });
          // Only the delete itself (the elementId match) returns a row; the
          // policy sweep that follows finds nothing to remove.
          if (cypher.includes("elementId(e)")) {
            return { records: [{ toObject: () => ({ name: "Lego", owner: "Mila", deleted: 1 }) }] };
          }
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
  const userResult = await store.removeEntity({ user: "Mila", id: "4:abc" });
  assert.deepEqual(userResult, { deleted: 1, name: "Lego", orphansRemoved: [] });
  const userCall = calls[0];
  // The delete matches :Entity ONLY (a :User id can never match) and is
  // pinned to owner = the session user, so a foreign id matches nothing.
  assert.ok(userCall.cypher.includes("MATCH (e:Entity) WHERE elementId(e) = $id AND e.owner = $user"), userCall.cypher);
  assert.ok(userCall.cypher.includes("DETACH DELETE e"), "the node's edges go with the node");
  assert.equal(userCall.params.user, "Mila");
  assert.equal(userCall.params.id, "4:abc");
  // The policy sweep runs after the delete, pinned to the deleted entity's
  // owner (the same owner for a non-admin delete).
  const userSweep = calls[1];
  assert.ok(userSweep.cypher.includes("NOT EXISTS"), "the connectivity check runs after the delete");
  assert.equal(userSweep.params.user, "Mila", "the sweep is pinned to the deleted entity's owner");
  // The admin variant drops the owner pin — the backend sets admin: true for
  // admin sessions only, never from client input.
  await store.removeEntity({ user: "admin", id: "4:abc", admin: true });
  const adminCall = calls[2];
  assert.ok(adminCall.cypher.includes("MATCH (e:Entity) WHERE elementId(e) = $id"), adminCall.cypher);
  assert.doesNotMatch(adminCall.cypher, /e\.owner = \$user/, "no owner PINNING in the admin delete");
  assert.deepEqual(adminCall.params, { id: "4:abc" });
  assert.equal(calls[3].params.user, "Mila", "the admin delete still sweeps the entity's own owner");
  // A no-match result comes back as deleted: 0 (the endpoint maps that to 404).
  const empty = graphdb.createGraphStore({
    uri: "bolt://mock:7687",
    database: "neo4j",
    readUser: "r",
    readPassword: "r",
    writeUser: "w",
    writePassword: "w",
    driverFactory: () => ({ session: () => ({ run: async () => ({ records: [] }), close: async () => {} }) }),
  });
  assert.deepEqual(await empty.removeEntity({ user: "Mila", id: "4:xyz" }), { deleted: 0, name: null, orphansRemoved: [] });
});

test("neo4j store: an introduced relation type is merged under its own name (owner-scoped endpoints)", async () => {
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
    user: "Roman",
    entities: [{ name: "Home Assistant", type: "thing", props: {} }],
    relations: [{ from: "Roman", to: "Home Assistant", type: "INTERESTED_IN" }],
  });
  // Neo4j creates the type on first use: the MERGE carries the new name
  // verbatim, and the entity endpoint stays owner-scoped to the turn user.
  const merge = calls.find((call) => call.cypher.includes("INTERESTED_IN"));
  assert.ok(merge, "expected the MERGE for the introduced type");
  assert.ok(merge.cypher.includes("MERGE (a)-[r:INTERESTED_IN]->(b)"), merge.cypher);
  assert.ok(merge.cypher.includes("MATCH (a:User {name: row.from})"), merge.cypher);
  assert.ok(merge.cypher.includes("MATCH (b:Entity {owner: $user}) WHERE toLower(b.name) = toLower(row.to)"), merge.cypher);
  // A malformed type never reaches the database.
  calls.length = 0;
  await store.upsertTurn({
    user: "Roman",
    entities: [],
    relations: [{ from: "Roman", to: "Home Assistant", type: "I AM NOT SURE ABOUT THIS ONE" }],
  });
  assert.ok(!calls.some((call) => call.cypher.includes("I AM NOT SURE")), "malformed types are dropped before any query");
});

test("neo4j store: question subjects get a deterministic ASKED_ABOUT edge from the user's :User node", async () => {
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
    users: ["Mila", "Roman"],
  });
  await store.upsertTurn({
    user: "Roman",
    entities: [
      { name: "Jean Reno", type: "person", props: {} },
      { name: "Léon: The Professional", type: "thing", props: {} },
    ],
    relations: [{ from: "Jean Reno", to: "Léon: The Professional", type: "ACTED_IN" }],
    subjects: ["Jean Reno"],
  });
  // The backend (never the extraction) books one ASKED_ABOUT edge per
  // subject, from the user's :User node to the subject's :Entity copy.
  const merge = calls.find((call) => call.cypher.includes("ASKED_ABOUT"));
  assert.ok(merge, "expected the MERGE for the ASKED_ABOUT edge");
  assert.ok(merge.cypher.includes("MERGE (a)-[r:ASKED_ABOUT]->(b)"), merge.cypher);
  assert.ok(merge.cypher.includes("MATCH (a:User {name: row.from})"), `the source is the user's account node: ${merge.cypher}`);
  assert.ok(merge.cypher.includes("MATCH (b:Entity {owner: $user}) WHERE toLower(b.name) = toLower(row.to)"), `the target is the user's own copy: ${merge.cypher}`);
  const askedRow = merge.params.rows.find((row) => row.type === undefined && row.from === "Roman" && row.to === "Jean Reno");
  assert.ok(askedRow, `the edge rows carry the deterministic endpoints: ${JSON.stringify(merge.params.rows)}`);
  assert.ok(askedRow.negative === false, "a question was asked, full stop");
  // The turn's timestamp lands on the edge (r.last_seen) — the question's
  // date and time, surfaced by the panel and the brain.
  assert.ok(merge.cypher.includes("SET r.last_seen = row.now"), merge.cypher);
  assert.match(askedRow.now, /^\d{4}-\d{2}-\d{2}T/);
  // A subject the user does not own and never stored is not resolvable: no
  // dangling edge is written.
  calls.length = 0;
  await store.upsertTurn({ user: "Roman", entities: [], relations: [], subjects: ["Nobody Ever Stored"] });
  assert.ok(!calls.some((call) => call.cypher.includes("ASKED_ABOUT")), "an unresolvable subject writes no edge");
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
    users: ["Mila", "Roman"],
  });
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Lego", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  assert.ok(calls.length >= 3, "user MERGE, entity MERGE and relation MERGE must all run");
  assert.ok(calls.every((cypher) => !/-\[:[A-Z_]+<-\]/.test(cypher)), JSON.stringify(calls));
  // Entities are upserted keyed by (name, owner) — the name case-insensitively,
  // the type NOT part of the identity (a type-keyed MERGE is exactly the
  // "two BTCUSD" bug) — and no KNOWS bookkeeping edge is written any more
  // (ownership IS provenance).
  const entityUpsert = calls.find((cypher) => cypher.includes("CREATE (e:Entity"));
  assert.ok(entityUpsert, "the entity upsert must run");
  assert.ok(entityUpsert.includes("OPTIONAL MATCH (e:Entity {owner: $user})"), entityUpsert);
  assert.ok(entityUpsert.includes("WHERE toLower(e.name) = toLower(row.name)"), entityUpsert);
  assert.doesNotMatch(entityUpsert, /MERGE \(e:Entity/, "no type-keyed entity MERGE");
  // No KNOWS bookkeeping edge is written any more (ownership IS provenance).
  // The orphan check below does name KNOWS, but only to exclude it from what
  // counts as a connection — so the rule is about writing one, not mentioning it.
  assert.ok(!calls.some((cypher) => /(MERGE|CREATE) \([a-z]*\)-\[[a-z]*:KNOWS/.test(cypher)), JSON.stringify(calls));
  // The end-of-ingest policy check: every entity of this owner without a
  // bounded path of fact edges to the owner's own :User node is deleted, so
  // a disconnected cluster can never survive an ingest.
  const orphanCheck = calls.find((cypher) => cypher.includes("DETACH DELETE e") && cypher.includes("NOT EXISTS"));
  assert.ok(orphanCheck, `expected the orphan check: ${JSON.stringify(calls)}`);
  assert.ok(orphanCheck.includes("MATCH (e:Entity {owner: $user})"), "the check is pinned to the turn's owner");
  assert.ok(orphanCheck.includes("MATCH (u:User {name: $user})"), "the check connects to the owner's own :User node");
  assert.ok(orphanCheck.includes("*1..6"), "the connectivity path is bounded");
  assert.ok(orphanCheck.includes("type(edge) <> 'KNOWS'"), "KNOWS does not count as a connection");
  // The relation MERGE stores the negation flag; SET (not ON CREATE) is what
  // lets a later "I don't like X" flip an existing edge.
  const relationMerge = calls.find((cypher) => cypher.includes("r:LIKES"));
  assert.ok(relationMerge, "expected the LIKES MERGE");
  assert.ok(relationMerge.includes("SET r.last_seen = row.now, r.negative = row.negative"), relationMerge);
  // The old "known by two or more users" shared-flag step is gone: it derived
  // common-ness from other users' mentions (a privacy leak under isolation).
  assert.ok(!calls.some((cypher) => cypher.includes("count(*) AS knownBy")), JSON.stringify(calls));
});

test("neo4j store: search goes through the full-text index, owner-pinned and bounded", async () => {
  // The point of the feature: at millions of nodes the query must be answered
  // by the index, never by a label scan, and the per-user boundary must hold
  // even if the Lucene string were wrong.
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
    uri: "bolt://mock:7687", database: "neo4j", readUser: "r", readPassword: "r",
    writeUser: "w", writePassword: "w", driverFactory: fakeFactory, users: ["Mila", "Roman"],
  });
  await store.search({ user: "Roman", query: "nvidea", limit: 25 });
  const search = calls.find((call) => call.cypher.includes("db.index.fulltext.queryNodes"));
  assert.ok(search, `the search must use the full-text index: ${JSON.stringify(calls.map((call) => call.cypher))}`);
  assert.ok(!calls.some((call) => /MATCH \(e:Entity/.test(call.cypher)), "no label scan in the search path");
  assert.match(search.cypher, /WHERE node\.owner = \$user/, "the owner is re-checked after the index");
  assert.equal(search.params.user, "Roman");
  assert.match(search.params.lucene, /\+owner:roman/, search.params.lucene);
  // One row beyond the cap, so "there is more" needs no second query.
  assert.equal(Number(search.params.limit), 26, JSON.stringify(search.params));
  // The admin session searches every owner: no owner term, no owner filter.
  calls.length = 0;
  await store.search({ user: "admin", query: "nvidea", admin: true });
  const adminSearch = calls.find((call) => call.cypher.includes("db.index.fulltext.queryNodes"));
  // The owner is still returned (the admin needs to see whose entity it is),
  // but nothing filters on it.
  assert.doesNotMatch(adminSearch.cypher, /WHERE node\.owner/, adminSearch.cypher);
  assert.match(adminSearch.cypher, /node\.owner AS owner/, adminSearch.cypher);
  assert.ok(!adminSearch.params.lucene.includes("owner:"), adminSearch.params.lucene);
  // Link types come from the token store, not from scanning relationships.
  assert.ok(calls.some((call) => call.cypher.includes("db.relationshipTypes()")), JSON.stringify(calls.map((call) => call.cypher)));
  assert.ok(!calls.some((call) => /MATCH \(\)-\[r\]->\(\)/.test(call.cypher)), "no relationship scan for the link types");
  // An empty query never reaches the index at all.
  calls.length = 0;
  const empty = await store.search({ user: "Roman", query: "   " });
  assert.deepEqual(empty.nodes, []);
  assert.ok(!calls.some((call) => call.cypher.includes("queryNodes")), "a blank query is not a search");
});

test("neo4j store: ensureIndexes creates the search and lookup indexes idempotently", async () => {
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher) { calls.push(cypher); return { records: [] }; },
        async close() {},
      };
    },
  });
  const store = graphdb.createGraphStore({
    uri: "bolt://mock:7687", database: "neo4j", readUser: "r", readPassword: "r",
    writeUser: "w", writePassword: "w", driverFactory: fakeFactory, users: [],
  });
  await store.ensureIndexes();
  const joined = calls.join("\n");
  assert.match(joined, /CREATE FULLTEXT INDEX entity_search IF NOT EXISTS FOR \(e:Entity\) ON EACH \[e\.name, e\.owner\]/, joined);
  assert.match(joined, /CREATE INDEX entity_owner IF NOT EXISTS FOR \(e:Entity\) ON \(e\.owner\)/, joined);
  assert.match(joined, /CREATE INDEX user_name IF NOT EXISTS FOR \(u:User\) ON \(u\.name\)/, joined);
  // Idempotent: a redeploy must not fail on an existing database.
  assert.ok(calls.every((cypher) => cypher.includes("IF NOT EXISTS")), joined);
});

test("neo4j store: endpoints named after other users target their :User node, never an :Entity", async () => {
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
    users: ["Mila", "Roman"],
  });
  // Roman reports what Mila likes: "Mila" must stay a :User, never an :Entity
  // (a person entity with a user's name is a proxy for that user's personal
  // data and would show up in the other users' panels).
  await store.upsertTurn({
    user: "Roman",
    entities: [
      { name: "Mila", type: "person", props: {} },
      { name: "Lego", type: "thing", props: {} },
    ],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  // The person entity "Mila" is user Mila: it must not be created as an :Entity.
  const entityUpsert = calls.find((call) => call.cypher.includes("CREATE (e:Entity"));
  assert.ok(entityUpsert, "the non-user entities still get upserted");
  assert.ok(!entityUpsert.params.rows.some((row) => row.name === "Mila"), JSON.stringify(entityUpsert.params.rows));
  assert.ok(entityUpsert.params.rows.some((row) => row.name === "Lego"));
  // The referenced user's :User node is ensured to exist ...
  const userMerge = calls.find((call) => call.cypher.includes("MERGE (u:User {name: name})"));
  assert.ok(userMerge, "referenced users' :User nodes must be merged");
  assert.ok(userMerge.params.names.includes("Mila") && userMerge.params.names.includes("Roman"));
  // ... and the fact edge targets that :User node, not an :Entity — and the
  // entity endpoint is owner-scoped to the turn user.
  const relationMerge = calls.find((call) => call.cypher.includes("r:LIKES"));
  assert.ok(relationMerge.cypher.includes("MATCH (a:User {name: row.from})"), relationMerge.cypher);
  assert.ok(relationMerge.cypher.includes("MATCH (b:Entity {owner: $user}) WHERE toLower(b.name) = toLower(row.to)"), relationMerge.cypher);
});

test("neo4j store: the panel subgraph is scoped to the user, hides KNOWS and returns the negation flag", async () => {
  const calls = [];
  const fakeFactory = () => ({
    session() {
      return {
        async run(cypher, params) {
          calls.push({ cypher, params });
          const records = cypher.includes("MATCH (u:User {name: $user}) RETURN elementId(u)")
            ? [{ toObject: () => ({ id: "u1", name: "Mila" }) }]
            : cypher.includes("MATCH (e:Entity {owner: $user})")
              ? [{ toObject: () => ({ id: "n1", name: "Lego", type: "thing", owner: "Mila" }) }]
              : [];
          return { records };
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
  await store.subgraph({ user: "Mila", limit: 20 });
  await store.subgraph({ user: "Mila", center: "someId" });
  // Every query that takes the user is pinned to the session user (the edge
  // query is scoped through the $ids it was given instead).
  assert.ok(calls.every((call) => !("user" in call.params) || call.params.user === "Mila"), JSON.stringify(calls.map((call) => call.params)));
  assert.ok(calls.filter((call) => "user" in call.params).length >= 2, "user-scoped queries must run");
  const edgeQuery = calls.find((call) => call.cypher.includes("elementId(a) IN $ids"));
  assert.ok(edgeQuery, "expected the newest-mode edge query");
  assert.ok(edgeQuery.cypher.includes("type(r) <> 'KNOWS'"), `KNOWS must be filtered: ${edgeQuery.cypher}`);
  assert.ok(edgeQuery.cypher.includes("coalesce(r.negative, false)"), `negation must be returned: ${edgeQuery.cypher}`);
  // The edge's turn timestamp is returned too (r.last_seen): for an
  // ASKED_ABOUT edge it is the date the user asked, drawn by the panel.
  assert.ok(edgeQuery.cypher.includes("r.last_seen AS lastSeen"), `the edge timestamp must be returned: ${edgeQuery.cypher}`);
  // Every :Entity endpoint must be in the user's owned set; :User endpoints
  // are account markers; pure user-to-user edges are limited to their parties.
  assert.ok(edgeQuery.cypher.includes("(a:User OR elementId(a) IN $ids)"), `entity endpoints must be owner-scoped: ${edgeQuery.cypher}`);
  assert.ok(edgeQuery.cypher.includes("NOT (a:User AND b:User)"), `user-to-user edges limited to their parties: ${edgeQuery.cypher}`);
  const centerQuery = calls.find((call) => call.cypher.includes("elementId(a) = $center"));
  assert.ok(centerQuery, "expected the centred subgraph query");
  assert.ok(centerQuery.cypher.includes("type(r) <> 'KNOWS'"), `KNOWS must be filtered: ${centerQuery.cypher}`);
  // A centre with no fact edges must still come back: with a null r,
  // type(r) is null, so the filter needs an explicit r IS NULL disjunct or
  // the centre view is empty.
  assert.ok(centerQuery.cypher.includes("r IS NULL OR"), `null-safe centre filter: ${centerQuery.cypher}`);
  // The centre must be the user's own node or an entity they own ...
  assert.ok(centerQuery.cypher.includes("(a:Entity AND a.owner = $user)"), centerQuery.cypher);
  // ... and neighbours are the user's own entities or :User account markers
  // (never another user's entity).
  assert.ok(centerQuery.cypher.includes("(b:User OR (b:Entity AND b.owner = $user))"), centerQuery.cypher);
  // The newest-mode view returns the user node plus owned entities; the mock
  // returns one owned entity (Lego) and no fact edge, so it is drawn but
  // flagged `isolated` (the UI dims it).
  const world = await store.subgraph({ user: "Mila", limit: 20 });
  const lego = world.nodes.find((node) => node.name === "Lego");
  assert.ok(lego, "the owned entity is drawn");
  assert.equal(lego.isolated, true, "no fact edge touches it -> isolated");
});

test("neo4j store: the admin subgraph queries are global (no user or owner pinning)", async () => {
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
  await store.subgraph({ user: "admin", admin: true });
  // Every account node and every owner-keyed entity — no query in the admin
  // branch is pinned to a user (the flag is set by the backend, never the
  // client), so nothing can be scoped down to one user's world.
  const userQuery = calls.find((call) => call.cypher.includes("MATCH (u:User)"));
  assert.ok(userQuery, "the admin fetches every :User node");
  assert.doesNotMatch(userQuery.cypher, /\{name: \$user\}/, "no name pinning in the admin user query");
  const entityQuery = calls.find((call) => call.cypher.includes("MATCH (e:Entity) ORDER BY"));
  assert.ok(entityQuery, "the admin fetches every :Entity node");
  assert.doesNotMatch(entityQuery.cypher, /owner: \$user/, "no owner pinning in the admin entity query");
  assert.ok(calls.every((call) => !call.params || !("user" in call.params)), "no $user parameter in any admin query");
  // The edge query is scoped to the fetched world (at least one endpoint in
  // it) and includes user-to-user edges, which the per-user query excludes.
  const edgeQuery = calls.find((call) => call.cypher.includes("elementId(a) IN $ids OR elementId(b) IN $ids"));
  assert.ok(edgeQuery, "expected the global edge query");
  assert.ok(edgeQuery.cypher.includes("type(r) <> 'KNOWS'"), `KNOWS must be filtered: ${edgeQuery.cypher}`);
  assert.doesNotMatch(edgeQuery.cypher, /NOT \(a:User AND b:User\)/, "no user-to-user restriction for the admin");
  // The admin may centre on any node, and an isolated centre still comes
  // back (null-safe filter).
  calls.length = 0;
  await store.subgraph({ user: "admin", admin: true, center: "someId" });
  const adminCenterQuery = calls.find((call) => call.cypher.includes("elementId(a) = $center"));
  assert.ok(adminCenterQuery, "expected the admin centred query");
  assert.ok(adminCenterQuery.cypher.includes("r IS NULL OR"), `null-safe centre filter: ${adminCenterQuery.cypher}`);
  assert.ok(adminCenterQuery.cypher.includes("type(r) <> 'KNOWS'"), `KNOWS must be filtered: ${adminCenterQuery.cypher}`);
  assert.doesNotMatch(adminCenterQuery.cypher, /owner = \$user/, "the admin centre is not owner-restricted");
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
    users: ["Mila", "Roman"],
  });
  await store.upsertTurn({
    user: "Mila",
    entities: [
      { name: "Mila", type: "person", props: {} },
      { name: "Lego", type: "thing", props: {} },
    ],
    relations: [{ from: "Mila", to: "Lego", type: "LIKES" }],
  });
  const entityUpsert = calls.find((call) => call.cypher.includes("CREATE (e:Entity"));
  assert.ok(entityUpsert, "expected the entity upsert");
  // The user's own person must not be part of the entity rows (that would
  // create the duplicate "Mila" node the panel used to show).
  assert.ok(!JSON.stringify(entityUpsert.params.rows).includes("Mila"), JSON.stringify(entityUpsert.params.rows));
  // The LIKES relation named after the user must target their :User node, and
  // the entity endpoint is owner-scoped to the turn user.
  const likes = calls.find((call) => call.cypher.includes("r:LIKES"));
  assert.ok(likes, "expected the LIKES MERGE");
  assert.ok(likes.cypher.includes("MATCH (a:User {name: row.from})"), likes.cypher);
  assert.ok(likes.cypher.includes("MATCH (b:Entity {owner: $user}) WHERE toLower(b.name) = toLower(row.to)"), likes.cypher);
});

// --- backend integration -------------------------------------------------------

let upstream;
const backends = [];
const origins = [];
let toolRequests = [];
let finalRequests = [];
let receivedChat;
let extractionRequests = 0;
const MOCK_MCP = fileURLToPath(new URL("./mock-graph-mcp.mjs", import.meta.url));
const EXTRACT_JSON = JSON.stringify({
  entities: [{ name: "Amelie", type: "person", props: {} }],
  relations: [{ from: "Amelie", to: "Mila", type: "FRIEND_OF" }],
});
// A turn whose only extracted entity is a registered user: the store writes
// nothing (the person is their account node) and must report it as skipped.
const USER_MENTION_JSON = JSON.stringify({
  entities: [{ name: "Mila", type: "person", props: {} }],
  relations: [],
});
// A fact whose relation type does not exist yet: the store must create it
// under its own name, not force it into an existing type.
const INTEREST_JSON = JSON.stringify({
  entities: [{ name: "Home Assistant", type: "thing", props: {} }],
  relations: [{ from: "Roman", to: "Home Assistant", type: "INTERESTED_IN" }],
});
// A question turn: the question subject (Jean Reno), the answer's films as
// entities linked to the subject, and the subject the backend links to the
// user with a deterministic ASKED_ABOUT edge.
const QUESTION_TEST_JSON = JSON.stringify({
  entities: [
    { name: "Jean Reno", type: "person", props: {} },
    { name: "Léon: The Professional", type: "thing", props: {} },
    { name: "La Femme Nikita", type: "thing", props: {} },
  ],
  relations: [
    { from: "Jean Reno", to: "Léon: The Professional", type: "ACTED_IN" },
    { from: "Jean Reno", to: "La Femme Nikita", type: "ACTED_IN" },
  ],
  question_subjects: ["Jean Reno"],
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
       extractionRequests += 1;
       const userMention = systemText.includes("user-account-mention");
       const interest = systemText.includes("interest-test");
       const question = systemText.includes("question-test");
       const extraction = userMention ? USER_MENTION_JSON : interest ? INTEREST_JSON : question ? QUESTION_TEST_JSON : EXTRACT_JSON;
       return res.end(JSON.stringify({ choices: [{ message: { content: extraction } }] }));
     }
    const lastUser = [...(body.messages || [])].reverse().find((message) => message.role === "user");
    const wantsDelete = String(lastUser?.content || "").includes("Delete everything");
    // The "Store the entity/fact" and "Delete the entity via the graph"
    // turns make the mock brain request the admin write/delete tools — used
    // by BOTH the admin (routed to the MCP server) and a regular user
    // (rejected as unknown before it reaches the MCP server) in the tests.
    const wantsStoreEntity = String(lastUser?.content || "").includes("Store the entity");
    const wantsStoreFact = String(lastUser?.content || "").includes("Store the fact");
    const wantsOtherOwner = String(lastUser?.content || "").includes("other user");
    const wantsDeleteViaTool = String(lastUser?.content || "").includes("Delete the entity via the graph");
    const wantsRename = String(lastUser?.content || "").includes("Rename the entity");
    // "Call the tool in xml" mimics the brain endpoint that answers with the
    // model's NATIVE tool-call XML in the message content instead of the
    // OpenAI tool_calls field — the backend must parse and execute it, never
    // hand the markup to the user as the answer.
    const wantsXmlToolCall = String(lastUser?.content || "").includes("Call the tool in xml");
    // "Loop the tools" makes the mock brain request tools on every round, so
    // the server-side round budget is exercised; like a real brain, it stops
    // looping once told the budget is reached.
    const loopTools = String(lastUser?.content || "").includes("Loop the tools") && !systemText.includes("Tool budget reached");
    const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
    if (wantsXmlToolCall && body.tools && !hasToolResult) {
      toolRequests.push(body);
      return res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: '<|tool_calls|><|invoke| name="list-my-facts"><|parameter| name="about" string="true">Pizza<|/parameter|><|/invoke|><|/tool_calls|>',
          },
        }],
      }));
    }
    if (body.tools && (!hasToolResult || loopTools)) {
      toolRequests.push(body);
      // The "Delete everything" turn tries the OLD raw-Cypher tool, which is
      // no longer on the surface: the server must reject it as unknown and
      // never forward it to the MCP server.
      const tool = wantsDelete
        ? { name: "read-cypher", arguments: JSON.stringify({ query: "MATCH (e:Entity) DETACH DELETE e" }) }
        : wantsStoreEntity
          ? { name: "store-entity", arguments: JSON.stringify({ owner: "Mila", name: "Test Entity", type: "thing" }) }
          : wantsStoreFact
             ? { name: "store-fact", arguments: JSON.stringify({ owner: wantsOtherOwner ? "Roman" : "Mila", from: "Mila", to: "Pizza", type: "LIKES", negative: false }) }
             : wantsRename
               ? { name: "rename-entity", arguments: JSON.stringify({ owner: "Mila", name: "Berlin", newName: "Berlintown" }) }
               : wantsDeleteViaTool
              ? { name: "delete-entity", arguments: JSON.stringify({ owner: "Mila", name: "Berlin" }) }
              : loopTools
                ? { name: "list-my-knowledge", arguments: "{}" }
                : { name: "list-my-facts", arguments: "{}" };
      return res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: tool }],
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
  // Configured with the in-memory store and the mock MCP server. The user
  // list includes the admin account (password = name, like every user).
  const configured = await startBackend({
    BRAIN_BASE_URL: base,
    WHISPER_ENDPOINTS: "",
    USERS: "Mila,Roman,admin",
    NEO4J_URI: "bolt://mock:7687",
    NEO4J_READ_USER: "jarvis_read",
    NEO4J_READ_PASSWORD: "read-secret",
    NEO4J_WRITE_USER: "jarvis_write",
    NEO4J_WRITE_PASSWORD: "write-secret",
    GRAPH_MEMORY: "1",
    MCP_GRAPH_SCRIPT: MOCK_MCP,
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
      env: { ...process.env, PORT: "0", OPENCODE_CONFIG_PATH: "/tmp/jarvis-test-no-opencode.jsonc", BRAIN_API_KEY: "test-brain", ...extraEnv },
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
  const del = await fetch(`${origin}/api/graph/entity?id=mem-1`, { method: "DELETE", headers: { cookie } });
  assert.equal(del.status, 503, "the delete path is unconfigured too");
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
  // No GRAPH tools are offered without a configured store, and nothing was
  // ingested. (search_history is still there: it needs no graph.)
  assert.deepEqual(graphToolNames(receivedChat.tools), []);
});

test("configured graph: status, schema, context, tool loop and ingestion", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const cookie = await login(origin);

  // The status is scoped to the signed-in user's drawn world: Mila's node,
  // the entities she owns (Rocky and Kokoro via Rocky -USES->, plus the
  // isolated mention Berlin — drawn, flagged for the UI to dim) and the fact
  // edges. Nothing of another user's counts in.
  const status = await (await auth(origin, "/api/graph/status", cookie)).json();
  assert.equal(status.nodes, 4, JSON.stringify(status));
  assert.equal(status.edges, 1, JSON.stringify(status));
  assert.ok(status.labels.includes("Entity"));
  const earlySub = await (await auth(origin, "/api/graph/subgraph?limit=60", cookie)).json();
  assert.equal(earlySub.nodes.find((node) => node.name === "Berlin").isolated, true, "isolated mention is drawn and flagged");

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
  // The brain got the parameterized read tools plus self-scoped write tools
  // (no Cypher on the surface) and the user's stored context.
  assert.equal(toolRequests.length, 1);
  const names = graphToolNames(toolRequests[0].tools);
  assert.deepEqual(names, ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts", "store-entity", "store-fact", "rename-entity", "delete-entity"]);
  const systemText = toolRequests[0].messages.map((message) => String(message.content || "")).join("\n");
  assert.match(systemText, /Knowledge graph context/);
  assert.match(systemText, /Known to this user so far:.*Rocky/);
  // The privacy rule: the brain's view is this user's private view; other
  // users' data is never accessible (so it cannot answer "what does Mila
  // like?" for Roman), and it must phrase graph claims from that user's view,
  // never as a global "no one does X" statement.
  assert.match(systemText, /list-my-facts\(about\?, relation\?\)/);
  assert.match(systemText, /never another user's data/);
  assert.match(systemText, /never as a global claim/);

  // The tool result came back through the MCP server and was fed to the brain.
  assert.ok(finalRequests.length >= 1);
  const toolMessage = finalRequests[0].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the brain should receive the tool result");
  assert.match(toolMessage.content, /mock data/);
  // The mock MCP saw the scoped read call — with the user the backend
  // injected — and there is no raw-Cypher tool left to call.
  assert.match(backend.logs, /MOCK_GRAPH_CALL list-my-facts/);
  assert.match(backend.logs, /"user":"Mila"/);
  assert.doesNotMatch(backend.logs, /MOCK_GRAPH_CALL read-cypher/);
  // The activity ring recorded the brain read.
  const activity = await (await auth(origin, "/api/graph/activity", cookie)).json();
  assert.ok(activity.entries.some((entry) => entry.kind === "brain_query" && entry.ok));
  // Per-user isolation: the feed is scoped to the session user, so Roman's
  // view does not contain Mila's brain query.
  const romanCookie = await login(origin, "Roman");
  const romanActivity = await (await auth(origin, "/api/graph/activity", romanCookie)).json();
  assert.equal(romanActivity.entries.length, 0, JSON.stringify(romanActivity.entries));

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
  assert.equal(amelie.owner, "Mila", "entities are owner-keyed to the signed-in user");
  assert.ok(subgraph.edges.some((edge) => edge.type === "FRIEND_OF"));
});

test("a chat with the graph toggle off stores nothing: no extraction, no entities, no ingest entry", async () => {
  const origin = origins[1];
  const cookie = await login(origin, "Roman");
  const subBefore = await (await auth(origin, "/api/graph/subgraph?limit=60", cookie)).json();
  const brainExtractionsBefore = extractionRequests;
  // No mcp map at all: every MCP switch is off, like a default browser.
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "I like Pizza very much." }),
  });
  assert.equal(response.status, 200);
  // The brain was told the toggle is off and that nothing is stored while it
  // is, so it cannot promise to remember what it cannot store.
  const systemText = (receivedChat.messages || []).map((message) => String(message.content || "")).join("\n");
  assert.match(systemText, /knowledge graph \(MCP graph server\) is OFF in the user's browser/);
  assert.match(systemText, /Nothing from this conversation is stored in the graph while the toggle is off/);
  // Ingestion is fire-and-forget: give it time to have run, then assert it did
  // not — no extraction call, no ingest activity entry, no new node or edge.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(extractionRequests, brainExtractionsBefore, "no extraction call while the toggle is off");
  const activity = await (await auth(origin, "/api/graph/activity", cookie)).json();
  assert.ok(!activity.entries.some((entry) => entry.kind === "ingest" && entry.user === "Roman"), JSON.stringify(activity.entries));
  const subAfter = await (await auth(origin, "/api/graph/subgraph?limit=60", cookie)).json();
  assert.equal(subAfter.nodes.length, subBefore.nodes.length, JSON.stringify({ subBefore, subAfter }));
  assert.equal(subAfter.edges.length, subBefore.edges.length, JSON.stringify({ subBefore, subAfter }));
});

test("a question turn stores the subject, the answer entities, the ASKED_ABOUT link and the ask date", async () => {
  const origin = origins[1];
  // Mila: her world already holds Amelie (the earlier ingest), and this
  // stays her second ingest, so Roman's "first ingest sweeps Coffee" test
  // below keeps its precondition.
  const cookie = await login(origin, "Mila");
  toolRequests = [];
  finalRequests = [];
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "question-test: tell me more about Jean Reno", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  // The brain was told questions are stored with the date, and the
  // list-my-facts tool description carries ASKED_ABOUT.
  const brainSystem = (toolRequests[0]?.messages || []).map((message) => String(message.content || "")).join("\n");
  assert.match(brainSystem, /ASKED_ABOUT fact that carries the date and time/);
  // Ingestion is fire-and-forget: poll until the memory store recorded it.
  // (Mila's earlier ingest stored 1 relation; the question turn stores 3.)
  const ingest = await waitFor(async () => {
    const entries = (await (await auth(origin, "/api/graph/activity", cookie)).json()).entries;
    return entries.find((entry) => entry.kind === "ingest" && entry.user === "Mila" && entry.relations >= 3);
  });
  // The extraction prompt asks for the question subjects and the answer's
  // entities, and forbids the LLM from emitting ASKED_ABOUT itself (the
  // backend books the edge).
  const extractionSystem = (receivedChat.messages || []).map((message) => String(message.content || "")).join("\n");
  assert.match(extractionSystem, /question_subjects/);
  assert.match(extractionSystem, /Never emit a relation of type ASKED_ABOUT/);
  // Three entities (the subject + the two films), three relations (two
  // ACTED_IN + the deterministic ASKED_ABOUT).
  assert.equal(ingest.entities, 3, JSON.stringify(ingest));
  assert.equal(ingest.relations, 3, JSON.stringify(ingest));
  const sub = await (await auth(origin, "/api/graph/subgraph?limit=60", cookie)).json();
  // The question subject is stored as an entity of the asking user …
  const reno = sub.nodes.find((node) => node.name === "Jean Reno");
  assert.ok(reno, "the question subject is stored as an entity");
  assert.equal(reno.type, "person");
  assert.equal(reno.owner, "Mila", "owner-keyed to the asking user");
  // … the answer's films are stored too, linked to the subject …
  assert.ok(sub.nodes.some((node) => node.name === "Léon: The Professional" && node.owner === "Mila"), "the answer's films are stored");
  assert.ok(sub.nodes.some((node) => node.name === "La Femme Nikita" && node.owner === "Mila"));
  assert.equal(sub.edges.filter((edge) => edge.type === "ACTED_IN").length, 2, JSON.stringify(sub.edges));
  // … and the user is linked to the subject with ASKED_ABOUT, carrying the
  // date and time the question was asked.
  const asked = sub.edges.find((edge) => edge.type === "ASKED_ABOUT");
  assert.ok(asked, "the user is linked to the question subject");
  const milaNode = sub.nodes.find((node) => node.name === "Mila");
  assert.equal(asked.source, milaNode.id, "ASKED_ABOUT runs from the user's own node");
  assert.equal(asked.target, reno.id, "… to the subject entity");
  assert.match(asked.lastSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `the question carries its timestamp: ${JSON.stringify(asked)}`);
});

test("mentioning a registered user stores no entity and the feed says so", async () => {
  const origin = origins[1];
  const romanCookie = await login(origin, "Roman");
  const before = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: romanCookie },
    body: JSON.stringify({ prompt: "user-account-mention: who is Mila?", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  // Ingestion is fire-and-forget: poll until the memory store recorded it.
  const ingest = await waitFor(async () => {
    const entries = (await (await auth(origin, "/api/graph/activity", romanCookie)).json()).entries;
    return entries.find((entry) => entry.kind === "ingest" && entry.user === "Roman");
  });
  // The extractor emitted one entity, but it was a user account: nothing was
  // stored, and the feed reports that honestly instead of "stored 1 entity".
  assert.equal(ingest.entities, 0, JSON.stringify(ingest));
  assert.equal(ingest.relations, 0, JSON.stringify(ingest));
  assert.equal(ingest.skippedUsers, 1, JSON.stringify(ingest));
  // The user mention itself stored nothing: no new node, and no Mila marker
  // either (with no fact edge there is no neighbour pulling her in). But the
  // stored policy is global: this was Roman's first ingest on this server, so
  // it swept his starter world's isolated mention (Coffee has no path of fact
  // edges to his node), and the feed reports that removal.
  const after = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
  assert.ok(!after.nodes.some((node) => node.name === "Mila"), JSON.stringify(after.nodes));
  // The activity feed counts what the sweep removed (the store reports the
  // names, the feed the number).
  assert.equal(ingest.orphansRemoved, 1, `the pre-existing isolated mention is swept: ${JSON.stringify(ingest)}`);
  assert.ok(!after.nodes.some((node) => node.name === "Coffee"), "the orphan is gone");
  assert.equal(after.nodes.length, before.nodes.length - 1, JSON.stringify({ before, after }));
});

test("/api/graph/search is fuzzy, session-scoped and needs a session", async () => {
  const origin = origins[1];
  const romanCookie = await login(origin, "Roman");
  const search = async (query, cookie = romanCookie) =>
    (await auth(origin, `/api/graph/search?q=${encodeURIComponent(query)}`, cookie)).json();
  // Give Roman something to find.
  await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: romanCookie },
    body: JSON.stringify({ prompt: "interest-test: I'm interested in Home Assistant.", mcp: { graph: true, websearch: false } }),
  });
  const found = await waitFor(async () => {
    const result = await search("home assistant");
    return result.nodes?.length ? result : null;
  });
  assert.equal(found.nodes[0].name, "Home Assistant", JSON.stringify(found));
  // Typos and casing are forgiven.
  assert.equal((await search("HOME ASSISTANT")).nodes[0]?.name, "Home Assistant");
  assert.equal((await search("assistent")).nodes[0]?.name, "Home Assistant");
  // Link types are matched too, from the query's own words.
  assert.ok((await search("interested")).relTypes.includes("INTERESTED_IN"), "link types are searchable");
  // The boundary: another user's search never reaches Roman's entities.
  const milaCookie = await login(origin, "Mila");
  assert.deepEqual((await search("home assistant", milaCookie)).nodes, [], "owner-scoped");
  // The admin searches across owners and sees who owns each hit.
  const adminCookie = await login(origin, "admin");
  const asAdmin = await search("home assistant", adminCookie);
  assert.equal(asAdmin.nodes[0]?.owner, "Roman", JSON.stringify(asAdmin));
  // A blank query is an empty result, not an error.
  assert.deepEqual((await search("   ")).nodes, []);
  // And no session, no search.
  const anonymous = await fetch(`${origin}/api/graph/search?q=home`);
  assert.equal(anonymous.status, 403);
});

test("an introduced relation type is created on the fly and shows up in the schema", async () => {
  const origin = origins[1];
  const romanCookie = await login(origin, "Roman");
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: romanCookie },
    body: JSON.stringify({ prompt: "interest-test: I'm interested in Home Assistant.", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  // Ingestion is fire-and-forget: poll until the edge with the new type is
  // visible in the panel's scoped subgraph.
  const edge = await waitFor(async () => {
    const sub = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
    return sub.edges.find((candidate) => candidate.type === "INTERESTED_IN");
  });
  assert.equal(edge.negative, false, JSON.stringify(edge));
  // The entity the fact points at landed in the user's world.
  const sub = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
  assert.ok(sub.nodes.some((node) => node.name === "Home Assistant" && node.owner === "Roman"), JSON.stringify(sub.nodes));
  // The schema picks the new type up from the store itself — no static list.
  const schema = await (await auth(origin, "/api/graph/schema", romanCookie)).json();
  assert.ok(schema.relTypes.includes("INTERESTED_IN"), JSON.stringify(schema.relTypes));
});

test("the graph tool budget leaves room for schema plus follow-up queries (five rounds)", async () => {
  const origin = origins[1];
  const cookie = await login(origin);
  finalRequests = [];
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "Loop the tools", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answer, "I checked the graph.", "the budget forces a final answer");
  // The mock brain requested a tool on every round; the server must execute
  // exactly five tool rounds and then force the final answer. Three rounds
  // was not enough for the live "what does Mila like?" case (schema + user
  // lookup + relation query).
  const lastRequest = finalRequests[finalRequests.length - 1];
  const toolResults = lastRequest.messages.filter((message) => message.role === "tool");
  assert.equal(toolResults.length, 5, `tool results delivered to the brain: ${toolResults.length}`);
  assert.match(
    lastRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /Tool budget reached/,
  );
});

test("raw Cypher is not on the tool surface: the old read-cypher call is rejected as unknown", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const cookie = await login(origin);
  finalRequests = [];
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "Delete everything", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.answer, "the brain should still answer from the error tool result");
  // The raw-Cypher tool is gone from the surface: the server rejects the
  // call as unknown and the Cypher never reaches the MCP server (there is
  // nothing there that accepts it), so no write — or foreign read — is
  // possible through the brain.
  assert.doesNotMatch(backend.logs, /MOCK_GRAPH_CALL read-cypher/);
  assert.doesNotMatch(backend.logs, /DETACH DELETE/);
  const lastFinal = finalRequests[finalRequests.length - 1];
  const toolMessage = [...lastFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /Unknown tool/);
  const activity = await (await auth(origin, "/api/graph/activity", cookie)).json();
  assert.ok(
    activity.entries.some((entry) => entry.kind === "brain_query" && entry.tool === "read-cypher" && !entry.ok),
    JSON.stringify(activity.entries),
  );
});

test("admin session: global panel, cross-owner brain tools, full activity feed", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const adminCookie = await login(origin, "admin");
  // The admin's panel is the WHOLE graph: every user's account node and
  // entity, whoever owns them. (The starter world's isolated mentions were
  // already swept by the stored policy on the users' first ingests earlier in
  // this file, so the world holds the users' own facts only.)
  const status = await (await auth(origin, "/api/graph/status", adminCookie)).json();
  assert.ok(status.nodes >= 4, `admin sees the whole graph: ${JSON.stringify(status)}`);
  const subgraph = await (await auth(origin, "/api/graph/subgraph?limit=60", adminCookie)).json();
  const names = subgraph.nodes.map((node) => node.name);
  assert.ok(names.includes("Mila") && names.includes("Roman"), `every user's nodes: ${JSON.stringify(names)}`);
  // Entities of both owners are drawn: Mila's ingested Amelie, and what
  // Roman's earlier turns stored.
  assert.ok(names.includes("Amelie") && names.includes("Home Assistant"), `every user's entities: ${JSON.stringify(names)}`);
  // The stored policy already swept the disconnected starter mentions.
  assert.ok(!names.includes("Rocky") && !names.includes("Coffee"), `no disconnected starter entities remain: ${JSON.stringify(names)}`);
  // A non-admin user is unaffected by the admin's presence in USERS.
  const milaCookie = await login(origin, "Mila");
  const milaStatus = await (await auth(origin, "/api/graph/status", milaCookie)).json();
  assert.ok(milaStatus.nodes < status.nodes, "Mila's view is still scoped to her world");
  // The admin's brain tools run across all owners: the backend injects the
  // admin flag, and the prompt tells the brain this is the admin session.
  toolRequests = [];
  finalRequests = [];
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ prompt: "Tell me about all graph db entries of all users", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  assert.equal(toolRequests.length, 1);
  const adminSystem = toolRequests[0].messages.map((message) => String(message.content || "")).join("\n");
  assert.match(adminSystem, /administrator/);
  assert.match(adminSystem, /ALL users' data/);
  assert.doesNotMatch(adminSystem, /never another user's data/, "the per-user privacy line does not apply to the admin");
  // The tool call carried the injected admin flag (the mock MCP logs the args
  // to stderr; the backend JSON-stringifies that line, so quotes are escaped).
  assert.match(backend.logs, /\\"user\\":\\"admin\\",\\"admin\\":true/);
  // The admin's activity feed is global: it includes Mila's earlier brain read.
  const activity = await (await auth(origin, "/api/graph/activity", adminCookie)).json();
  assert.ok(activity.entries.some((entry) => entry.kind === "brain_query" && entry.user === "Mila"), JSON.stringify(activity.entries));
  // ...while Mila's own feed does not include the admin's brain read.
  const milaActivity = await (await auth(origin, "/api/graph/activity", milaCookie)).json();
  assert.ok(!milaActivity.entries.some((entry) => entry.user === "admin"), JSON.stringify(milaActivity.entries));
});

test("graph write tools: regular users are self-scoped, admin can target any registered owner", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const adminCookie = await login(origin, "admin");
  const milaCookie = await login(origin, "Mila");

  // The admin brain gets the three write/delete tools on top of the four
  // reads...
  toolRequests = [];
  finalRequests = [];
  const logStart = backend.logs.length;
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ prompt: "Store the fact", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  assert.equal(toolRequests.length, 1);
  assert.deepEqual(
    graphToolNames(toolRequests[0].tools),
    ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts", "store-entity", "store-fact", "rename-entity", "delete-entity"],
  );
  // ...and the write call reached the MCP server with the backend-injected
  // session user, admin flag and registered user list (the mock logs the
  // arguments to stderr; the backend JSON-stringifies the line, so the
  // quotes are escaped).
  const logDelta = backend.logs.slice(logStart);
  assert.match(logDelta, /MOCK_GRAPH_CALL store-fact/);
  assert.match(logDelta, /\\"user\\":\\"admin\\",\\"admin\\":true,\\"users\\":\[\\"Mila\\",\\"Roman\\",\\"admin\\"\]/);
  // The (mock) write result came back through the tool loop to the brain.
  const lastFinal = finalRequests[finalRequests.length - 1];
  const toolMessage = [...lastFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /Stored LIKES from Mila to Pizza under Mila/);
  // And it was audited in the admin's global activity feed as a write.
  const activity = await (await auth(origin, "/api/graph/activity", adminCookie)).json();
  assert.ok(
    activity.entries.some((entry) => entry.kind === "brain_write" && entry.user === "admin" && entry.tool === "store-fact" && entry.ok),
    JSON.stringify(activity.entries),
  );

  // A regular user's brain is offered the same write tools, but without an
  // owner parameter: the backend/MCP layer forces owner to the signed-in user.
  toolRequests = [];
  finalRequests = [];
  extractionRequests = 0;
  const milaLogStart = backend.logs.length;
  const milaResponse = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: milaCookie },
    body: JSON.stringify({ prompt: "Store the fact", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(milaResponse.status, 200);
  assert.deepEqual(
    graphToolNames(toolRequests[0].tools),
    ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts", "store-entity", "store-fact", "rename-entity", "delete-entity"],
  );
  const milaSchema = toolRequests[0].tools.find((tool) => tool.function.name === "store-fact").function.parameters;
  assert.ok(!milaSchema.properties.owner, "regular users are not offered an owner selector");
  assert.match(backend.logs.slice(milaLogStart), /MOCK_GRAPH_CALL store-fact/);
  assert.match(backend.logs.slice(milaLogStart), /\\"user\\":\\"Mila\\",\\"admin\\":false,\\"users\\":\[\\"Mila\\",\\"Roman\\",\\"admin\\"\]/);
  assert.match(backend.logs.slice(milaLogStart), /\\"owner\\":\\"Mila\\"/);
  const milaFinal = finalRequests[finalRequests.length - 1];
  const milaToolMessage = [...milaFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(milaToolMessage?.content), /Stored LIKES from Mila to Pizza under Mila/);
  // The self-scoped write is audited in the user's own feed as a write.
  const milaActivity = await (await auth(origin, "/api/graph/activity", milaCookie)).json();
  assert.ok(
    milaActivity.entries.some((entry) => entry.kind === "brain_write" && entry.user === "Mila" && entry.tool === "store-fact" && entry.ok),
    JSON.stringify(milaActivity.entries),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(extractionRequests, 0, "a successful explicit graph write must not be re-ingested from its confirmation text");

  // A forged owner for another user still reaches only the guarded MCP
  // server, which returns an error and writes nothing.
  toolRequests = [];
  finalRequests = [];
  const crossOwnerLogStart = backend.logs.length;
  const crossOwnerResponse = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: milaCookie },
    body: JSON.stringify({ prompt: "Store the fact for other user", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(crossOwnerResponse.status, 200);
  assert.match(backend.logs.slice(crossOwnerLogStart), /MOCK_GRAPH_CALL store-fact/);
  assert.match(backend.logs.slice(crossOwnerLogStart), /\\"owner\\":\\"Roman\\"/);
  const crossOwnerFinal = finalRequests[finalRequests.length - 1];
  const crossOwnerToolMessage = [...crossOwnerFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(crossOwnerToolMessage?.content), /can only modify Mila's own graph data/);
  const crossOwnerActivity = await (await auth(origin, "/api/graph/activity", milaCookie)).json();
  assert.ok(
    crossOwnerActivity.entries.some((entry) => entry.kind === "brain_write" && entry.user === "Mila" && entry.tool === "store-fact" && entry.ok === false),
    JSON.stringify(crossOwnerActivity.entries),
  );
});

test("admin rename-entity: on the write surface, routed with the injected args, audited as a write", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const adminCookie = await login(origin, "admin");

  toolRequests = [];
  finalRequests = [];
  const logStart = backend.logs.length;
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ prompt: "Rename the entity", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    graphToolNames(toolRequests[0].tools),
    ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts", "store-entity", "store-fact", "rename-entity", "delete-entity"],
  );
  // The rename call reached the MCP server with the backend-injected session
  // user, admin flag and registered user list.
  const logDelta = backend.logs.slice(logStart);
  assert.match(logDelta, /MOCK_GRAPH_CALL rename-entity/);
  assert.match(logDelta, /\\"name\\":\\"Berlin\\",\\"newName\\":\\"Berlintown\\"/);
  assert.match(logDelta, /\\"user\\":\\"admin\\",\\"admin\\":true,\\"users\\":\[\\"Mila\\",\\"Roman\\",\\"admin\\"\]/);
  // The (mock) rename result came back through the tool loop to the brain.
  const lastFinal = finalRequests[finalRequests.length - 1];
  const toolMessage = [...lastFinal.messages].reverse().find((message) => message.role === "tool");
  assert.match(String(toolMessage?.content), /Renamed Berlin to Berlintown/);
  // Audited in the admin's global activity feed as a write.
  const activity = await (await auth(origin, "/api/graph/activity", adminCookie)).json();
  assert.ok(
    activity.entries.some((entry) => entry.kind === "brain_write" && entry.user === "admin" && entry.tool === "rename-entity" && entry.ok),
    JSON.stringify(activity.entries),
  );
});

test("a brain answering with native tool-call XML in the content still executes the tool, never shows the XML", async () => {
  const origin = origins[1];
  const backend = backends[1];
  const adminCookie = await login(origin, "admin");

  toolRequests = [];
  finalRequests = [];
  const logStart = backend.logs.length;
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ prompt: "Call the tool in xml", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  // The XML was parsed and executed: the tool result reached the brain and
  // the final answer is prose, not the tool-call markup.
  assert.doesNotMatch(result.answer, /tool_calls|invoke|parameter/i, `XML leaked into the answer: ${result.answer}`);
  assert.match(result.answer, /I checked the graph/);
  const logDelta = backend.logs.slice(logStart);
  assert.match(logDelta, /MOCK_GRAPH_CALL list-my-facts/);
  assert.match(logDelta, /\\"about\\":\\"Pizza\\"/);
  assert.match(logDelta, /\\"user\\":\\"admin\\",\\"admin\\":true/);
  // The parsed call rides on the assistant turn, so the tool result's id
  // has its counterpart (protocol-valid history for the next round).
  const lastFinal = finalRequests[finalRequests.length - 1];
  const toolMessage = [...lastFinal.messages].reverse().find((message) => message.role === "tool");
  const assistantTurn = [...lastFinal.messages].reverse().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
  assert.ok(assistantTurn, "the parsed tool calls ride on the assistant turn");
  assert.equal(assistantTurn.tool_calls[0].function.name, "list-my-facts");
  assert.equal(assistantTurn.tool_calls[0].id, toolMessage.tool_call_id, "tool result references the parsed call id");
});

test("admin turns are not auto-ingested: the service account mints no owner=admin entities", async () => {
  const origin = origins[1];
  const adminCookie = await login(origin, "admin");

  const subBefore = await (await auth(origin, "/api/graph/subgraph?limit=60", adminCookie)).json();
  assert.ok(!subBefore.nodes.some((node) => node.owner === "admin"), JSON.stringify(subBefore.nodes));
  // Any admin chat turn would normally be extracted and stored (the mock
  // extractor returns Amelie FRIEND_OF Mila for a plain turn).
  const response = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ prompt: "Tell me about all graph db entries of all users", mcp: { graph: true, websearch: false } }),
  });
  assert.equal(response.status, 200);
  // Ingestion is fire-and-forget — give the (skipped) path time to have run,
  // then assert nothing landed under the admin's name.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const subAfter = await (await auth(origin, "/api/graph/subgraph?limit=60", adminCookie)).json();
  assert.ok(!subAfter.nodes.some((node) => node.owner === "admin"), `admin turn minted owner=admin entities: ${JSON.stringify(subAfter.nodes)}`);
  const activity = await (await auth(origin, "/api/graph/activity", adminCookie)).json();
  assert.ok(!activity.entries.some((entry) => entry.kind === "ingest" && entry.user === "admin"), JSON.stringify(activity.entries));
});

test("the panel's explicit delete removes only the caller's own entity", async () => {
  const origin = origins[1];
  const deleteEntity = (id, cookie) =>
    fetch(`${origin}/api/graph/entity?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { cookie } });

  const romanCookie = await login(origin, "Roman");
  const romanSub = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
  // Any entity this owner still has: the demo world's unconnected mentions no
  // longer survive the ingest check, so the targets are picked from the world
  // as it is (an :Entity carries a type; the account node does not).
  const coffee = romanSub.nodes.find((node) => node.type);
  const romanNode = romanSub.nodes.find((node) => node.name === "Roman");
  assert.ok(coffee, `Roman owns an entity to delete: ${JSON.stringify(romanSub.nodes)}`);

  // Missing id: 400.
  let res = await fetch(`${origin}/api/graph/entity`, { method: "DELETE", headers: { cookie: romanCookie } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "missing_id");

  // The caller's own entity: 200, and gone from their view.
  res = await deleteEntity(coffee.id, romanCookie);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.deleted, 1);
  assert.equal(body.name, coffee.name);
  const romanAfter = await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json();
  assert.ok(!romanAfter.nodes.some((node) => node.id === coffee.id), "Coffee is gone from Roman's view");

  // A foreign entity: 404 for the caller, still there for its owner.
  const milaCookie = await login(origin, "Mila");
  const milaSub = await (await auth(origin, "/api/graph/subgraph?limit=60", milaCookie)).json();
  const berlin = milaSub.nodes.find((node) => node.type);
  assert.ok(berlin, `Mila owns an entity: ${JSON.stringify(milaSub.nodes)}`);
  res = await deleteEntity(berlin.id, romanCookie);
  assert.equal(res.status, 404, "Roman cannot delete Mila's entity");
  assert.equal((await res.json()).error, "entity_not_found");
  const milaAfter = await (await auth(origin, "/api/graph/subgraph?limit=60", milaCookie)).json();
  assert.ok(milaAfter.nodes.some((node) => node.id === berlin.id), "Mila's entity survived Roman's attempt");

  // A :User account node is not deletable, not even by its own user.
  res = await deleteEntity(romanNode.id, romanCookie);
  assert.equal(res.status, 404);
  assert.ok((await (await auth(origin, "/api/graph/subgraph?limit=60", romanCookie)).json()).nodes.some((node) => node.id === romanNode.id));

  // The admin may delete any entity, whoever owns it.
  const adminCookie = await login(origin, "admin");
  res = await deleteEntity(berlin.id, adminCookie);
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.name, berlin.name);
  const adminAfter = await (await auth(origin, "/api/graph/subgraph?limit=60", adminCookie)).json();
  assert.ok(!adminAfter.nodes.some((node) => node.id === berlin.id), "the entity is gone from the admin's global view");
  const milaFinal = await (await auth(origin, "/api/graph/subgraph?limit=60", milaCookie)).json();
  assert.ok(!milaFinal.nodes.some((node) => node.id === berlin.id), "…and from Mila's view");

  // The deletion is audited in the activity feed (the admin's global feed
  // records who removed what; the user's own feed includes their own removal).
  const adminActivity = await (await auth(origin, "/api/graph/activity", adminCookie)).json();
  assert.ok(adminActivity.entries.some((entry) => entry.kind === "delete" && entry.user === "admin" && entry.name === berlin.name), JSON.stringify(adminActivity.entries));
  const romanActivity = await (await auth(origin, "/api/graph/activity", romanCookie)).json();
  assert.ok(romanActivity.entries.some((entry) => entry.kind === "delete" && entry.user === "Roman" && entry.name === coffee.name), JSON.stringify(romanActivity.entries));

  // /api/config exposes the admin flag the panel needs for its button.
  const adminConfig = await (await auth(origin, "/api/config", adminCookie)).json();
  assert.equal(adminConfig.admin, true);
  const romanConfig = await (await auth(origin, "/api/config", romanCookie)).json();
  assert.equal(romanConfig.admin, false);
});
