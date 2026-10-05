import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERIES, TOOLS, formatEntity, formatEntityAll, formatKnowledge, formatKnowledgeAll, formatFacts, formatFactsAll } from "../mcp/graph.mjs";

// The MCP graph server is the brain's only window into the database. These
// pins keep every query bounded by the signed-in user (owner = them): a
// foreign or unknown entity name must come back exactly like a nonexistent
// one, and no query may return another user's entity.

test("get-entity is owner-scoped: a foreign entity name is indistinguishable from a nonexistent one", () => {
  // The entity match is pinned to owner = $user — the parameter the backend
  // injects; the brain never sees or sets it.
  assert.ok(QUERIES.getEntity.includes("MATCH (e:Entity {name: $name, owner: $user})"), QUERIES.getEntity);
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

test("the MCP tool surface is read-only: no write or delete tool exists", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    ["get-entity", "get-schema", "list-my-facts", "list-my-knowledge"],
  );
  for (const name of names) {
    assert.doesNotMatch(name, /write|delete|remove|create|update|cypher/i, `read-only surface: ${name}`);
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
});

// The admin variants are the only cross-user reads in this file. They run
// ONLY when the backend injects admin: true (an app-level session property,
// never brain input), and they must report each row's owner.
test("admin queries read across all owners (no user or owner pinning) and report the owner", () => {
  assert.ok(QUERIES.getEntityAll.includes("MATCH (e:Entity {name: $name})"), QUERIES.getEntityAll);
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
});
