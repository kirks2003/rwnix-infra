import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import graphdb from "../graphdb.js";

// --- parseExtraction ---------------------------------------------------------

test("parseExtraction handles plain, fenced and prose-wrapped JSON", () => {
  const plain = graphdb.parseExtraction('{"entities":[{"name":"Mila","type":"person"}],"relations":[{"from":"Mila","to":"Berlin","type":"LIVES_IN"}]}');
  assert.deepEqual(plain, {
    entities: [{ name: "Mila", type: "person", props: {} }],
    relations: [{ from: "Mila", to: "Berlin", type: "LIVES_IN", negative: false }],
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

test("formatGraphContext renders the user's own entities only (no shared tier)", () => {
  const text = graphdb.formatGraphContext({
    userEntities: [{ name: "Berlin", type: "place" }],
  });
  assert.match(text, /Known to this user so far: Berlin \(place\)/);
  assert.doesNotMatch(text, /Shared knowledge/);
  assert.equal(graphdb.formatGraphContext({ userEntities: [] }), "");
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
  // Isolated mentions are drawn but flagged; linked entities are not.
  assert.equal(sub.nodes.find((node) => node.name === "Berlin").isolated, true, "Berlin is an isolated mention");
  assert.equal(sub.nodes.find((node) => node.name === "Rocky").isolated, false, "Rocky has a fact edge");
  assert.equal(sub.nodes.find((node) => node.name === "Mila").isolated, false, "the :User node is never isolated");
  const amelieId = sub.nodes.find((node) => node.name === "Amelie").id;
  const centered = await store.subgraph({ user: "Mila", center: amelieId });
  assert.ok(centered.nodes.some((node) => node.name === "Mila"));
  // Only the real fact (Amelie->Mila FRIEND_OF) is drawn; the bookkeeping
  // Mila->Amelie KNOWS edge from the upsert stays out of the panel data.
  assert.equal(centered.edges.length, 1);
  assert.equal(centered.edges[0].type, "FRIEND_OF");
  // Centring on an isolated mention (no fact edge) still returns the node
  // itself — not an empty view.
  const berlinId = sub.nodes.find((node) => node.name === "Berlin").id;
  const centeredBerlin = await store.subgraph({ user: "Mila", center: berlinId });
  assert.ok(centeredBerlin.nodes.some((node) => node.name === "Berlin"), "the isolated centre comes back");
  assert.equal(centeredBerlin.edges.length, 0, "an isolated centre has no edges");
  // Roman mentions Amelie too: he gets his OWN copy (owner Roman) — Mila's
  // node is a different node and stays untouched (owner-keyed isolation).
  await store.upsertTurn({ user: "Roman", entities: [{ name: "Amelie", type: "person", props: {} }], relations: [] });
  sub = await store.subgraph({ user: "Mila" });
  assert.equal(sub.nodes.find((node) => node.name === "Amelie").owner, "Mila", "Mila's Amelie node is still hers");
  // And Roman's view does not contain Mila's fact edge at all. His isolated
  // starter mention (Coffee) is drawn but flagged.
  const romanSub = await store.subgraph({ user: "Roman" });
  assert.ok(!romanSub.edges.some((edge) => edge.type === "FRIEND_OF"));
  assert.ok(!romanSub.nodes.some((node) => node.name === "Mila"), "no other user node");
  assert.equal(romanSub.nodes.find((node) => node.name === "Coffee").isolated, true, "Roman's isolated mention is drawn and flagged");
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
  // Status counts are scoped the same way: Mila owns more entities (Rocky,
  // Berlin, Kokoro, Lego, Amelie, Car) than Roman (Coffee, Pizza, Amelie), so
  // her node count is higher — isolated mentions (Berlin, Coffee) count too,
  // since they are drawn (dimmed) now.
  await store.upsertTurn({
    user: "Mila",
    entities: [{ name: "Car", type: "thing", props: {} }],
    relations: [{ from: "Mila", to: "Car", type: "OWNS" }],
  });
  const romanStatus = await store.status({ user: "Roman" });
  const milaStatus = await store.status({ user: "Mila" });
  assert.notEqual(romanStatus.nodes, milaStatus.nodes, `node counts differ per user: ${JSON.stringify({ romanStatus, milaStatus })}`);
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
  // Roman adds a private fact on top of the starter world.
  await store.upsertTurn({
    user: "Roman",
    entities: [{ name: "Pizza", type: "thing", props: {} }],
    relations: [{ from: "Roman", to: "Pizza", type: "LIKES" }],
  });
  // The admin's panel view is the WHOLE graph: every account node, every
  // owner-keyed entity (isolated ones flagged) and every fact edge.
  const adminStatus = await store.status({ user: "admin", admin: true });
  assert.equal(adminStatus.nodes, 7, JSON.stringify(adminStatus));
  assert.equal(adminStatus.edges, 2, JSON.stringify(adminStatus));
  const adminSub = await store.subgraph({ user: "admin", admin: true });
  const names = adminSub.nodes.map((node) => node.name);
  assert.ok(names.includes("Mila") && names.includes("Roman"), `every user's account node: ${JSON.stringify(names)}`);
  assert.ok(names.includes("Rocky") && names.includes("Coffee") && names.includes("Pizza"), "every user's entities are drawn");
  // Same-named entities of different owners would both appear; here the
  // owner field is what keeps copies tellable apart.
  assert.equal(adminSub.nodes.find((node) => node.name === "Pizza").owner, "Roman");
  assert.equal(adminSub.nodes.find((node) => node.name === "Rocky").owner, "Mila");
  // Isolated mentions keep their flag in the admin view, too.
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
  // Entities are written owner-keyed (name+type+owner = the turn user) and no
  // KNOWS bookkeeping edge is written any more — ownership IS provenance.
  const entityMerge = calls.find((cypher) => cypher.includes("MERGE (e:Entity"));
  assert.ok(entityMerge, "the entity MERGE must run");
  assert.ok(entityMerge.includes("MERGE (e:Entity {name: row.name, type: row.type, owner: $user})"), entityMerge);
  assert.ok(!calls.some((cypher) => cypher.includes("KNOWS")), JSON.stringify(calls));
  // The relation MERGE stores the negation flag; SET (not ON CREATE) is what
  // lets a later "I don't like X" flip an existing edge.
  const relationMerge = calls.find((cypher) => cypher.includes("r:LIKES"));
  assert.ok(relationMerge, "expected the LIKES MERGE");
  assert.ok(relationMerge.includes("SET r.last_seen = row.now, r.negative = row.negative"), relationMerge);
  // The old "known by two or more users" shared-flag step is gone: it derived
  // common-ness from other users' mentions (a privacy leak under isolation).
  assert.ok(!calls.some((cypher) => cypher.includes("count(*) AS knownBy")), JSON.stringify(calls));
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
  const entityMerge = calls.find((call) => call.cypher.includes("MERGE (e:Entity"));
  assert.ok(entityMerge, "the non-user entities still get merged");
  assert.ok(!entityMerge.params.rows.some((row) => row.name === "Mila"), JSON.stringify(entityMerge.params.rows));
  assert.ok(entityMerge.params.rows.some((row) => row.name === "Lego"));
  // The referenced user's :User node is ensured to exist ...
  const userMerge = calls.find((call) => call.cypher.includes("MERGE (u:User {name: name})"));
  assert.ok(userMerge, "referenced users' :User nodes must be merged");
  assert.ok(userMerge.params.names.includes("Mila") && userMerge.params.names.includes("Roman"));
  // ... and the fact edge targets that :User node, not an :Entity — and the
  // entity endpoint is owner-scoped to the turn user.
  const relationMerge = calls.find((call) => call.cypher.includes("r:LIKES"));
  assert.ok(relationMerge.cypher.includes("MATCH (a:User {name: row.from})"), relationMerge.cypher);
  assert.ok(relationMerge.cypher.includes("MATCH (b:Entity {name: row.to, owner: $user})"), relationMerge.cypher);
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
  const entityMerge = calls.find((call) => call.cypher.includes("MERGE (e:Entity"));
  assert.ok(entityMerge, "expected the entity MERGE");
  // The user's own person must not be part of the entity rows (that would
  // create the duplicate "Mila" node the panel used to show).
  assert.ok(!JSON.stringify(entityMerge.params.rows).includes("Mila"), JSON.stringify(entityMerge.params.rows));
  // The LIKES relation named after the user must target their :User node, and
  // the entity endpoint is owner-scoped to the turn user.
  const likes = calls.find((call) => call.cypher.includes("r:LIKES"));
  assert.ok(likes, "expected the LIKES MERGE");
  assert.ok(likes.cypher.includes("MATCH (a:User {name: row.from})"), likes.cypher);
  assert.ok(likes.cypher.includes("MATCH (b:Entity {name: row.to, owner: $user})"), likes.cypher);
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
  entities: [{ name: "Amelie", type: "person", props: {} }],
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
    // "Loop the tools" makes the mock brain request tools on every round, so
    // the server-side round budget is exercised; like a real brain, it stops
    // looping once told the budget is reached.
    const loopTools = String(lastUser?.content || "").includes("Loop the tools") && !systemText.includes("Tool budget reached");
    const hasToolResult = (body.messages || []).some((message) => message.role === "tool");
    if (body.tools && (!hasToolResult || loopTools)) {
      toolRequests.push(body);
      // The "Delete everything" turn tries the OLD raw-Cypher tool, which is
      // no longer on the surface: the server must reject it as unknown and
      // never forward it to the MCP server.
      const tool = wantsDelete
        ? { name: "read-cypher", arguments: JSON.stringify({ query: "MATCH (e:Entity) DETACH DELETE e" }) }
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
// The brain got the parameterized read tools (no Cypher on the surface) and
  // the user's stored context.
  assert.equal(toolRequests.length, 1);
  const names = toolRequests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(names, ["get-schema", "get-entity", "list-my-knowledge", "list-my-facts"]);
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
  // entity, whoever owns them.
  const status = await (await auth(origin, "/api/graph/status", adminCookie)).json();
  assert.ok(status.nodes >= 6, `admin sees the whole graph: ${JSON.stringify(status)}`);
  const subgraph = await (await auth(origin, "/api/graph/subgraph?limit=60", adminCookie)).json();
  const names = subgraph.nodes.map((node) => node.name);
  assert.ok(names.includes("Mila") && names.includes("Roman"), `every user's nodes: ${JSON.stringify(names)}`);
  assert.ok(names.includes("Rocky") && names.includes("Coffee"), `every user's entities: ${JSON.stringify(names)}`);
  // Roman's isolated starter mention is drawn but flagged in the admin view.
  assert.equal(subgraph.nodes.find((node) => node.name === "Coffee").isolated, true, JSON.stringify(subgraph.nodes));
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
