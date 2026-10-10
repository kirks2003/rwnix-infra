import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERIES, TOOLS, ADMIN_WRITE_TOOLS, factQuery, validateWriteTool, formatEntity, formatEntityAll, formatKnowledge, formatKnowledgeAll, formatFacts, formatFactsAll } from "../mcp/graph.mjs";

// The MCP graph server is the brain's only window into the database. These
// pins keep every query bounded by the signed-in user (owner = them): a
// foreign or unknown entity name must come back exactly like a nonexistent
// one, and no query may return another user's entity.

test("get-entity is owner-scoped: a foreign entity name is indistinguishable from a nonexistent one", () => {
  // The entity match is pinned to owner = $user — the parameter the backend
  // injects; the brain never sees or sets it. The name is matched
  // case-insensitively (entity identity is name+owner, type is a property).
  assert.ok(QUERIES.getEntity.includes("MATCH (e:Entity {owner: $user})"), QUERIES.getEntity);
  assert.ok(QUERIES.getEntity.includes("WHERE toLower(e.name) = toLower($name)"), QUERIES.getEntity);
  assert.doesNotMatch(QUERIES.getEntity, /MATCH \(e:Entity \{name: \$name\}\)/, "no unscoped entity match");
  // Links are only to :User account markers or the user's own entities —
  // never to another user's entity.
  assert.ok(QUERIES.getEntity.includes("other:User OR coalesce(other.owner, '') = $user"), QUERIES.getEntity);
  // The KNOWS bookkeeping is gone; the negative flag is still returned.
  assert.doesNotMatch(QUERIES.getEntity, /KNOWS/);
  assert.ok(QUERIES.getEntity.includes("coalesce(r.negative, false)"), QUERIES.getEntity);
  // Direction comes from startNode: Neo4j has no direction() function, so
  // any query calling one would be a hard syntax error at runtime.
  assert.ok(
    QUERIES.getEntity.includes("CASE WHEN e = startNode(r) THEN 'OUTGOING' ELSE 'INCOMING' END AS dir"),
    QUERIES.getEntity,
  );
});

test("no query uses the nonexistent direction() Cypher function", () => {
  for (const [name, cypher] of Object.entries(QUERIES)) {
    assert.doesNotMatch(cypher, /direction\(/, `${name} must not call direction()`);
  }
});

test("the MCP tool surface: four read tools plus four owner-scoped write/delete tools, never free-form Cypher", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    ["delete-entity", "get-entity", "get-schema", "list-my-facts", "list-my-knowledge", "rename-entity", "store-entity", "store-fact"],
  );
  for (const name of names) {
    assert.doesNotMatch(name, /cypher/i, `no free-form query on the surface: ${name}`);
  }
  assert.deepEqual([...ADMIN_WRITE_TOOLS].sort(), ["delete-entity", "rename-entity", "store-entity", "store-fact"]);
  // The write tools' schema carries the owner the handler validates against
  // the injected user list — and exposes no admin/users parameter, so the
  // brain can never claim admin (only the backend's injection can).
  for (const name of ["store-entity", "store-fact", "rename-entity", "delete-entity"]) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool.inputSchema.required.includes("owner"), `${name} requires an owner`);
    assert.ok(!("admin" in tool.inputSchema.properties), `${name} exposes no admin parameter`);
    assert.ok(!("users" in tool.inputSchema.properties), `${name} exposes no users parameter`);
  }
});

test("list-my-knowledge returns only the user's own entities", () => {
  assert.ok(QUERIES.listMyKnowledge.includes("MATCH (e:Entity {owner: $user})"), QUERIES.listMyKnowledge);
  assert.doesNotMatch(QUERIES.listMyKnowledge, /common/);
});

test("list-my-facts stays pinned to the user's :User node", () => {
  assert.ok(QUERIES.listMyFacts.includes("MATCH (u:User {name: $user})-[r]->(e:Entity)"), QUERIES.listMyFacts);
  assert.ok(QUERIES.listMyFacts.includes("type(r) <> 'KNOWS'"), QUERIES.listMyFacts);
});

test("formatEntity renders the entity, its props and its links", () => {
  const text = formatEntity(
    { name: "Lego", type: "thing", props: { name: "Lego", type: "thing", owner: "Mila", mention_count: 2, note: "toy bricks" } },
    [
      { other: "Mila", rel: "LIKES", dir: "INCOMING", negative: false },
      { other: "Kokoro-82M", rel: "USES", dir: "OUTGOING", negative: true },
    ],
  );
  assert.match(text, /^Lego \(thing\)\./);
  assert.match(text, /Properties: note=toy bricks\./);
  assert.match(text, /Mila likes -> Lego/);
  assert.match(text, /Lego uses -> Kokoro-82M \(negative\)/);
  // The owner bookkeeping never leaks into the rendered properties.
  assert.doesNotMatch(text, /owner/);
});

test("formatEntity renders no-links cleanly", () => {
  assert.equal(formatEntity({ name: "Berlin", type: "place", props: { name: "Berlin", type: "place", owner: "Mila" } }, []), "Berlin (place). Links: none.");
});

test("formatKnowledge lists the user's entities (or the empty state)", () => {
  assert.equal(formatKnowledge([]), "This user has no stored knowledge yet.");
  assert.equal(
    formatKnowledge([{ name: "Amelie", type: "person" }, { name: "Berlin" }]),
    "This user knows: Amelie (person), Berlin (thing).",
  );
});

test("formatFacts renders facts and the empty state with filters", () => {
  assert.equal(formatFacts([], "Lego", "LIKES"), 'No stored facts about this user mentioning "Lego" of type LIKES yet.');
  assert.equal(formatFacts([{ type: "LIKES", name: "Lego", negative: true }]), "Facts about this user: likes (negative) -> Lego.");
  // An ASKED_ABOUT fact renders the question's date — the edge's last_seen,
  // booked by the ingestion upsert when the user asked. Other facts carry no
  // date, and a missing timestamp never renders a broken "(on undefined)".
  assert.equal(
    formatFacts([{ type: "ASKED_ABOUT", name: "Jean Reno", negative: false, lastSeen: "2026-10-10T07:15:00.000Z" }]),
    "Facts about this user: asked about -> Jean Reno (on 2026-10-10).",
  );
  assert.equal(
    formatFacts([{ type: "ASKED_ABOUT", name: "Jean Reno", negative: false }]),
    "Facts about this user: asked about -> Jean Reno.",
  );
});

// The admin variants are the only cross-user reads in this file. They run
// ONLY when the backend injects admin: true (an app-level session property,
// never brain input), and they must report each row's owner.
test("admin queries read across all owners (no user or owner pinning) and report the owner", () => {
  assert.ok(QUERIES.getEntityAll.includes("MATCH (e:Entity)"), QUERIES.getEntityAll);
  assert.ok(QUERIES.getEntityAll.includes("WHERE toLower(e.name) = toLower($name)"), QUERIES.getEntityAll);
  assert.doesNotMatch(QUERIES.getEntityAll, /owner: \$user/, "no owner pinning in the admin lookup");
  assert.ok(QUERIES.getEntityAll.includes("e.owner AS owner"), "the admin lookup returns each copy's owner");
  assert.ok(
    QUERIES.getEntityAll.includes("CASE WHEN e = startNode(r) THEN 'OUTGOING' ELSE 'INCOMING' END AS dir"),
    QUERIES.getEntityAll,
  );
  assert.ok(QUERIES.listAllKnowledge.includes("MATCH (e:Entity) RETURN e.name AS name, e.type AS type, e.owner AS owner"), QUERIES.listAllKnowledge);
  assert.doesNotMatch(QUERIES.listAllKnowledge, /owner: \$user/, "no owner pinning in the admin knowledge list");
  assert.ok(QUERIES.listAllFacts.includes("MATCH (u:User)-[r]->(e:Entity)"), QUERIES.listAllFacts);
  assert.doesNotMatch(QUERIES.listAllFacts, /\{name: \$user\}/, "no user pinning in the admin facts");
  assert.ok(QUERIES.listAllFacts.includes("type(r) <> 'KNOWS'"), "the admin facts still hide bookkeeping edges");
});

test("formatEntityAll renders one line per owner copy with its own links", () => {
  const rows = [
    { name: "Lego", type: "thing", owner: "Mila", props: { name: "Lego", type: "thing", owner: "Mila", mention_count: 3, note: "bricks" }, other: "Mila", rel: "LIKES", dir: "INCOMING", negative: false },
    { name: "Lego", type: "thing", owner: "Roman", props: { name: "Lego", type: "thing", owner: "Roman" }, other: null, rel: null, dir: null, negative: false },
  ];
  const text = formatEntityAll(rows);
  assert.match(text, /Lego \(thing\) has 2 owner copies:/);
  assert.match(text, /owner Mila: Lego \(thing\), properties note=bricks, links Mila likes -> Lego/);
  assert.match(text, /owner Roman: Lego \(thing\), links none/);
  // Bookkeeping (incl. mention_count) never renders as a property.
  assert.doesNotMatch(text, /mention_count/);
});

test("formatEntityAll renders the no-entity state", () => {
  assert.equal(formatEntityAll([]), "No entity found in the graph.");
});

test("formatKnowledgeAll and formatFactsAll group per user (and render empty states)", () => {
  assert.equal(formatKnowledgeAll([]), "No stored entities in the graph yet.");
  assert.equal(
    formatKnowledgeAll([{ name: "Lego", type: "thing", owner: "Mila" }, { name: "Lego", type: "thing", owner: "Roman" }, { name: "Rocky", type: "thing", owner: "Mila" }]),
    "Stored entities per user: Mila: Lego (thing), Rocky (thing); Roman: Lego (thing).",
  );
  assert.equal(formatFactsAll([]), "No stored facts in the graph yet.");
  assert.equal(
    formatFactsAll([{ type: "LIKES", user: "Mila", name: "Lego", negative: false }, { type: "OWNS", user: "Mila", name: "Car", negative: false }]),
    "Stored facts per user: Mila: likes -> Lego; owns -> Car.",
  );
  // The admin view renders the ASKED_ABOUT date too, per owner.
  assert.equal(
    formatFactsAll([{ type: "ASKED_ABOUT", user: "Mila", name: "Jean Reno", negative: false, lastSeen: "2026-10-10T07:15:00.000Z" }]),
    "Stored facts per user: Mila: asked about -> Jean Reno (on 2026-10-10).",
  );
});

// The admin write queries: run ONLY for the backend-injected admin flag and
// ONLY over the write database user. They must land in exactly the shape the
// panel and the brain reads expect (the ingestion's upsert semantics), and
// the delete can never match a :User account node.
test("write queries: entities are owner-keyed like the ingestion (name case-insensitive), delete never matches :User", () => {
  // store-entity: the same upsert key as the ingestion — (name, owner), the
  // name case-insensitively, the type NOT part of the identity (the old
  // type-keyed MERGE is the "two BTCUSD" bug) — with the same bookkeeping.
  assert.match(QUERIES.ensureEntity, /OPTIONAL MATCH \(e:Entity \{owner: \$owner\}\)/);
  assert.match(QUERIES.ensureEntity, /WHERE toLower\(e\.name\) = toLower\(\$name\)/);
  assert.match(QUERIES.ensureEntity, /CREATE \(e:Entity \{name: \$name, type: \$type, owner: \$owner, first_seen: \$now\}\)/);
  assert.doesNotMatch(QUERIES.ensureEntity, /MERGE \(e:Entity/, "no type-keyed entity MERGE");
  assert.match(QUERIES.ensureEntity, /e\.mention_count = coalesce\(e\.mention_count, 0\) \+ 1/);
  // store-fact: referenced users are their :User account nodes (MERGEd if
  // missing, like the ingestion), entity endpoints are the owner's copies.
  assert.equal(QUERIES.ensureUser, "MERGE (u:User {name: $name})");
  assert.match(QUERIES.touchEntity, /MATCH \(e:Entity \{owner: \$owner\}\) WHERE toLower\(e\.name\) = toLower\(\$name\) SET e\.last_seen = \$now/);
  // delete-entity: :Entity only (a :User account node can never match),
  // owner-pinned — the admin's cross-user reach is the $owner parameter,
  // never a missing pin.
  assert.equal(QUERIES.deleteEntity, "MATCH (e:Entity {owner: $owner}) WHERE toLower(e.name) = toLower($name) DETACH DELETE e");
  assert.doesNotMatch(QUERIES.deleteEntity, /User/);
  // findEntity is the same match: "not found" is identical for a foreign and
  // a nonexistent entity.
  assert.match(QUERIES.findEntity, /MATCH \(e:Entity \{owner: \$owner\}\) WHERE toLower\(e\.name\) = toLower\(\$name\)/);
  // rename-entity: a name-property change on the owner-pinned node — the
  // elementId and every link survive (a delete+recreate would detach them),
  // and it can never match a :User account node or another owner's copy.
  assert.match(QUERIES.renameEntity, /MATCH \(e:Entity \{owner: \$owner\}\) WHERE toLower\(e\.name\) = toLower\(\$name\)/);
  assert.match(QUERIES.renameEntity, /SET e\.name = \$newName/);
  assert.doesNotMatch(QUERIES.renameEntity, /DELETE/);
  assert.doesNotMatch(QUERIES.renameEntity, /User/);
});

test("factQuery: one query per endpoint-kind pair, typed and owner-pinned, no injection", () => {
  // User -> entity, entity -> user, entity -> entity: the pattern pair comes
  // from the validated endpoint kinds, the type is interpolated only after
  // the isRelationType check.
  assert.equal(
    factQuery("LIKES", true, false),
    "UNWIND $rows AS row MATCH (a:User {name: row.from}) MATCH (b:Entity {owner: $owner}) WHERE toLower(b.name) = toLower(row.to) MERGE (a)-[r:LIKES]->(b) SET r.last_seen = $now, r.negative = $negative",
  );
  assert.equal(
    factQuery("FRIEND_OF", false, true),
    "UNWIND $rows AS row MATCH (a:Entity {owner: $owner}) WHERE toLower(a.name) = toLower(row.from) MATCH (b:User {name: row.to}) MERGE (a)-[r:FRIEND_OF]->(b) SET r.last_seen = $now, r.negative = $negative",
  );
  assert.equal(
    factQuery("RELATED_TO", false, false),
    "UNWIND $rows AS row MATCH (a:Entity {owner: $owner}) WHERE toLower(a.name) = toLower(row.from) MATCH (b:Entity {owner: $owner}) WHERE toLower(b.name) = toLower(row.to) MERGE (a)-[r:RELATED_TO]->(b) SET r.last_seen = $now, r.negative = $negative",
  );
  assert.equal(
    factQuery("LIKES", true, true),
    "UNWIND $rows AS row MATCH (a:User {name: row.from}) MATCH (b:User {name: row.to}) MERGE (a)-[r:LIKES]->(b) SET r.last_seen = $now, r.negative = $negative",
  );
  // Anything that is not a valid Neo4j relation identifier is refused — the
  // type never reaches the query string unvalidated.
  assert.throws(() => factQuery("BAD TYPE", true, true), /invalid relation type/);
  assert.throws(() => factQuery("LIKES) DETACH DELETE", true, true), /invalid relation type/);
  // A well-formed introduced type (like the ingestion's) passes through.
  assert.match(factQuery("INTERESTED_IN", false, false), /\[r:INTERESTED_IN\]/);
});

test("validateWriteTool: regular users can write only their own owner scope, admin can target any registered owner", () => {
  const users = ["Mila", "Roman", "admin"];
  const base = { user: "admin", users };
  // Non-admin callers may omit owner: it defaults to the injected user.
  const selfDelete = validateWriteTool("delete-entity", { user: "Mila", users, name: "Berlin" }, users);
  assert.equal(selfDelete.ok, true, JSON.stringify(selfDelete));
  assert.deepEqual(selfDelete.params, { owner: "Mila", name: "Berlin" });
  // But an explicit different owner is refused before any database access:
  // a regular user cannot remove or rewrite another user's graph entity.
  for (const tool of ["store-entity", "store-fact", "rename-entity", "delete-entity"]) {
    const result = validateWriteTool(tool, { user: "Roman", users, owner: "Mila", name: "Berlin", newName: "Berlintown", from: "Roman", to: "Pizza", type: "LIKES" }, users);
    assert.equal(result.ok, false, `${tool} cross-owner as regular user`);
    assert.match(result.error, /Roman's own graph data/);
  }
  // The owner must be a registered user (case-insensitive, canonicalised to
  // the configured spelling) — a brain or a prompt injection cannot mint
  // data under a made-up owner.
  const admin = { ...base, admin: true };
  assert.equal(validateWriteTool("store-entity", { ...admin, owner: "Stranger", name: "Berlin" }, users).ok, false, "unregistered owner");
  const entity = validateWriteTool("store-entity", { ...admin, owner: "mila", name: "  Berlin  ", type: "PLACE" }, users);
  assert.equal(entity.ok, true, JSON.stringify(entity));
  assert.deepEqual(entity.params, { owner: "Mila", name: "Berlin", type: "place" });
  // Unknown entity types fall back to "thing" (never a rejected turn).
  assert.equal(validateWriteTool("store-entity", { ...admin, owner: "Mila", name: "Berlin", type: "gibberish" }, users).params.type, "thing");
  // Facts: user-named endpoints canonicalise to their :User account nodes, a
  // self-fact is refused, a malformed relation type degrades to RELATED_TO
  // (like the ingestion) so the fact is never lost, the negative flag is
  // boolean.
  const fact = validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "mila", to: "Pizza", type: "likes" }, users);
  assert.equal(fact.ok, true, JSON.stringify(fact));
  assert.deepEqual(fact.params, { owner: "Mila", from: "Mila", to: "Pizza", fromIsUser: true, toIsUser: false, type: "LIKES", negative: false });
  assert.equal(validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "Mila", to: "mila", type: "LIKES" }, users).ok, false, "self-fact");
  assert.equal(validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "Pizza", to: "pizza", type: "LIKES" }, users).ok, false, "case-variant self-fact (would MERGE a self-loop)");
  assert.equal(validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "Mila", to: "Pizza", type: "I really do not know" }, users).params.type, "RELATED_TO");
  assert.equal(validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "Mila", to: "Pizza", type: "LIKES", negative: true }, users).params.negative, true);
  // Rename takes owner + name + newName: the name is case-insensitively
  // identical to the current one (no rename), and a registered user's name
  // is their account node, never an entity.
  const rename = validateWriteTool("rename-entity", { ...admin, owner: "mila", name: "  Berlin  ", newName: "Berlintown" }, users);
  assert.equal(rename.ok, true, JSON.stringify(rename));
  assert.deepEqual(rename.params, { owner: "Mila", name: "Berlin", newName: "Berlintown" });
  assert.equal(validateWriteTool("rename-entity", { ...admin, owner: "Mila", name: "Berlin", newName: "BERLIN" }, users).ok, false, "case-variant same name is no rename");
  assert.equal(validateWriteTool("rename-entity", { ...admin, owner: "Mila", name: "Berlin", newName: "Roman" }, users).ok, false, "user's name is their account node");
  // Deletion takes owner + name only (the :Entity match pins both; :User can
  // never match).
  const del = validateWriteTool("delete-entity", { ...admin, owner: "roman", name: "Lego" }, users);
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.deepEqual(del.params, { owner: "Roman", name: "Lego" });
  // Missing required arguments are refused, too.
  assert.equal(validateWriteTool("store-entity", { ...admin, owner: "Mila" }, users).ok, false, "missing name");
  assert.equal(validateWriteTool("store-fact", { ...admin, owner: "Mila", from: "Mila" }, users).ok, false, "missing to");
  assert.equal(validateWriteTool("rename-entity", { ...admin, owner: "Mila", name: "Berlin" }, users).ok, false, "missing newName");
});
