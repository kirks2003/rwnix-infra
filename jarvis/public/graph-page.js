// The full-size knowledge graph page (/graph.html), opened in its own tab
// from the app's graph panel. Same data and same two renderers as the panel,
// but filling the viewport and starting at 150% entity/link-text size. Its
// slider values are stored under their own key, so this view keeps its larger
// default without touching the panel's sizes.
import { createGraph3D } from "./graph3d.js";
import { renderGraph2d } from "./graph2d.js";

const el = {};
for (const id of ["graphStatus", "graphCanvas", "graph3dStage", "graphView2dButton", "graphView3dButton",
  "graphNodeSize", "graphNodeSizeValue", "graphTextSize", "graphTextSizeValue", "graphRefreshButton", "graphHint",
  "graphSearch", "graphSearchStatus", "graphSearchClear", "graphSearchResults", "graphUser"]) {
  el[id] = document.getElementById(id);
}

const sizesStorageKey = "jarvis.graphSizes.full";
const DEFAULT_SCALE_PERCENT = 150;

let config = null;
let graphCenter = null;
let graphView = "3d";
let graph3d = null;
let graph3dFailed = false;
let lastSubgraph = null;
const graphScales = { node: 1.5, text: 1.5 };

function applyGraphScales() {
  document.documentElement.style.setProperty("--graph-node-scale", String(graphScales.node));
  document.documentElement.style.setProperty("--graph-text-scale", String(graphScales.text));
  el.graphNodeSizeValue.textContent = `${Math.round(graphScales.node * 100)}%`;
  el.graphTextSizeValue.textContent = `${Math.round(graphScales.text * 100)}%`;
  if (graph3d) graph3d.setNodeScale(graphScales.node);
  if (lastSubgraph && !el.graphCanvas.hasAttribute("hidden")) render2d(lastSubgraph);
}

function onGraphScaleInput() {
  graphScales.node = Number(el.graphNodeSize.value) / 100;
  graphScales.text = Number(el.graphTextSize.value) / 100;
  try {
    localStorage.setItem(sizesStorageKey, JSON.stringify({ node: el.graphNodeSize.value, text: el.graphTextSize.value }));
  } catch {
    // Storage unavailable (private mode): the sliders still work for the
    // session.
  }
  applyGraphScales();
}

el.graphNodeSize.addEventListener("input", onGraphScaleInput);
el.graphTextSize.addEventListener("input", onGraphScaleInput);

// The 2D drawing lives in the SVG's own 640x360 user-unit box; the viewBox
// stretches it to the window, so "full size" needs no pixel maths here.
function render2d(subgraph) {
  renderGraph2d(el.graphCanvas, subgraph, {
    nodeScale: graphScales.node,
    userName: config?.user ?? null,
    onNodeClick: (nodeId) => loadGraph(nodeId),
    width: 640,
    height: 360,
    highlight: matchedIds.size || matchedRelTypes.size ? { nodeIds: matchedIds, relTypes: matchedRelTypes } : null,
  });
}

function setGraphView(view) {
  graphView = view;
  const use3d = view === "3d" && !graph3dFailed && Boolean(config?.graphConfigured);
  // toggleAttribute, not the .hidden property: on SVG elements the property
  // does not reflect the attribute, so the [hidden] CSS would never lift.
  el.graph3dStage.toggleAttribute("hidden", !use3d);
  el.graphCanvas.toggleAttribute("hidden", use3d);
  el.graphView3dButton.classList.toggle("active", use3d);
  el.graphView2dButton.classList.toggle("active", !use3d);
  el.graphView3dButton.disabled = !config?.graphConfigured || graph3dFailed;
  el.graphView2dButton.disabled = !config?.graphConfigured;
  if (use3d && !graph3d) {
    graph3d = createGraph3D(el.graph3dStage, {
      userName: config?.user || null,
      nodeScale: graphScales.node,
      onNodeClick: (nodeId) => loadGraph(nodeId),
      onFallback: () => {
        graph3dFailed = true;
        if (graph3d) { graph3d.dispose(); graph3d = null; }
        el.graphView3dButton.disabled = true;
        el.graphView3dButton.title = "WebGL is not available in this browser";
        setGraphView("2d");
      },
    });
  }
  if (lastSubgraph) {
    if (use3d && graph3d) graph3d.update(lastSubgraph);
    else if (!use3d) render2d(lastSubgraph);
  }
}

async function loadGraph(center) {
  if (center !== undefined) graphCenter = center;
  if (!config?.graphConfigured) return;
  try {
    const [status, subgraph] = await Promise.all([
      fetch("/api/graph/status", { cache: "no-store" }).then((response) => response.json()),
      fetch(`/api/graph/subgraph?limit=60${graphCenter ? `&center=${encodeURIComponent(graphCenter)}` : ""}`, { cache: "no-store" }).then((response) => response.json()),
    ]);
    if (status.error) {
      el.graphStatus.textContent = status.error === "graph_unavailable" ? `Unreachable: ${status.message || "database down"}` : "Not available";
      return;
    }
    el.graphStatus.textContent = `${status.nodes} nodes · ${status.edges} links${graphCenter ? " · neighbourhood" : ""}`;
    lastSubgraph = subgraph;
    if (graphView === "3d" && graph3d) graph3d.update(subgraph);
    else render2d(subgraph);
  } catch (error) {
    el.graphStatus.textContent = `Unreachable: ${error.message}`;
  }
}

el.graphRefreshButton.addEventListener("click", () => loadGraph(null));
el.graphView3dButton.addEventListener("click", () => setGraphView("3d"));
el.graphView2dButton.addEventListener("click", () => setGraphView("2d"));

// --- Search ------------------------------------------------------------------
// The search runs on the server against a full-text index, so it covers the
// WHOLE graph, not just the nodes this page has loaded. Picking a hit re-centres
// the view on that entity's neighbourhood (the same bounded subgraph fetch a
// node click does), which is what keeps the page usable on a huge graph: the
// result list is paged, the drawing never is.
let searchTimer = null;
let searchSequence = 0;
let matchedIds = new Set();
let matchedRelTypes = new Set();
// The node a lone search hit already pulled into view, so a re-render of the
// same query does not fetch it again.
let focusLoadedFor = null;

// Dim whatever the current query does not match, in both views, so the search
// reads as a filter on the picture and not just a list beside it.
function applyMatchHighlight() {
  const active = matchedIds.size > 0 || matchedRelTypes.size > 0;
  if (graph3d) {
    graph3d.setHighlight(active ? { nodeIds: matchedIds, relTypes: matchedRelTypes } : null);
    // Narrowed to exactly one entity: the camera follows it from here, live —
    // the layout keeps moving the node, so this is a per-frame follow, not a
    // one-off recentre. setFocus ignores an id that is not drawn.
    graph3d.setFocus(singleMatchId());
  }
  if (lastSubgraph && !el.graphCanvas.hasAttribute("hidden")) render2d(lastSubgraph);
}

// The one entity the query is down to, or null while it still matches several
// (a link-type filter is a set of edges, never a single node to follow).
function singleMatchId() {
  return matchedIds.size === 1 && matchedRelTypes.size === 0 ? [...matchedIds][0] : null;
}

const inDrawnWindow = (id) => (lastSubgraph?.nodes || []).some((node) => node.id === id);

function renderSearchResults(result, query) {
  const nodes = result.nodes || [];
  const relTypes = result.relTypes || [];
  el.graphSearchClear.toggleAttribute("hidden", !query);
  if (!query) {
    el.graphSearchResults.replaceChildren();
    el.graphSearchResults.toggleAttribute("hidden", true);
    el.graphSearchStatus.textContent = "";
    return;
  }
  const counts = [
    `${nodes.length}${result.truncated ? "+" : ""} entit${nodes.length === 1 ? "y" : "ies"}`,
    relTypes.length ? `${relTypes.length} link type${relTypes.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  el.graphSearchStatus.textContent = nodes.length || relTypes.length ? counts : "no match";
  const items = [];
  for (const type of relTypes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "graph-search-hit link-type";
    item.textContent = `link: ${type.toLowerCase().replace(/_/g, " ")}`;
    // A link type is not a place to centre on: it filters the drawn edges.
    item.addEventListener("click", () => {
      matchedRelTypes = new Set([type]);
      matchedIds = new Set();
      applyMatchHighlight();
      el.graphSearchResults.toggleAttribute("hidden", true);
    });
    items.push(item);
  }
  for (const node of nodes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "graph-search-hit";
    const owner = config?.admin && node.owner ? ` · ${node.owner}` : "";
    item.textContent = `${node.name}${node.type ? ` · ${node.type}` : ""}${owner}`;
    item.addEventListener("click", () => {
      el.graphSearch.value = node.name;
      el.graphSearchResults.toggleAttribute("hidden", true);
      // Centre the drawing on the hit, and keep it highlighted there.
      matchedIds = new Set([node.id]);
      matchedRelTypes = new Set();
      focusLoadedFor = node.id;
      loadGraph(node.id).then(applyMatchHighlight);
    });
    items.push(item);
  }
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "graph-search-empty";
    empty.textContent = `Nothing matches “${query}”.`;
    items.push(empty);
  }
  el.graphSearchResults.replaceChildren(...items);
  el.graphSearchResults.toggleAttribute("hidden", false);
}

async function runSearch(query) {
  const sequence = ++searchSequence;
  if (!query.trim()) {
    matchedIds = new Set();
    matchedRelTypes = new Set();
    renderSearchResults({ nodes: [], relTypes: [] }, "");
    applyMatchHighlight();
    // A search focus may have swapped the drawn window to one entity's
    // neighbourhood (a lone hit fetched, or a result clicked); clearing the
    // query restores the initial objects, not just the highlight and the
    // camera. loadGraph(null) also resets graphCenter, so the 15 s poll stops
    // re-fetching the neighbourhood.
    if (focusLoadedFor) {
      focusLoadedFor = null;
      loadGraph(null);
    }
    return;
  }
  el.graphSearchStatus.textContent = "searching…";
  let result;
  try {
    result = await (await fetch(`/api/graph/search?q=${encodeURIComponent(query)}&limit=25`, { cache: "no-store" })).json();
  } catch (error) {
    el.graphSearchStatus.textContent = `search failed: ${error.message}`;
    return;
  }
  // A slower earlier request must not overwrite a newer one's results.
  if (sequence !== searchSequence) return;
  if (result.error) {
    el.graphSearchStatus.textContent = result.message || result.error;
    return;
  }
  // Highlight every hit that happens to be in the drawn window; the rest are
  // reachable by clicking a result.
  matchedIds = new Set((result.nodes || []).map((node) => node.id));
  matchedRelTypes = new Set(result.relTypes || []);
  renderSearchResults(result, query);
  // The search covers the whole graph, the drawing only a window of it: a lone
  // hit from outside that window has to be fetched before the camera can
  // centre on it. Guarded so a pause in typing does not refetch the same node.
  const single = singleMatchId();
  if (single && !inDrawnWindow(single) && focusLoadedFor !== single) {
    focusLoadedFor = single;
    await loadGraph(single);
  }
  applyMatchHighlight();
}

el.graphSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = el.graphSearch.value;
  // Debounced: one request per pause in typing, not per keystroke.
  searchTimer = setTimeout(() => runSearch(query), 250);
});

el.graphSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    el.graphSearch.value = "";
    clearTimeout(searchTimer);
    runSearch("");
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    el.graphSearchResults.querySelector(".graph-search-hit")?.click();
  }
});

el.graphSearchClear.addEventListener("click", () => {
  el.graphSearch.value = "";
  clearTimeout(searchTimer);
  runSearch("");
  el.graphSearch.focus();
});

async function start() {
  let response;
  try {
    response = await fetch("/api/config", { cache: "no-store" });
  } catch (error) {
    el.graphStatus.textContent = `Backend unreachable: ${error.message}`;
    return;
  }
  // The session lives in the shared cookie: a signed-out tab gets the same
  // 403 the app uses to mean "show the login form".
  if (response.status === 403) {
    el.graphStatus.textContent = "Not signed in";
    el.graphHint.textContent = "Sign in on the Jarvis page first, then reload this tab.";
    return;
  }
  config = await response.json();
  el.graphUser.textContent = config.admin ? `${config.user} · admin (all users)` : `${config.user}`;
  if (!config.graphConfigured) {
    el.graphStatus.textContent = "Not configured on this server";
    el.graphHint.textContent = "The backend has no NEO4J_* settings, so there is no graph to show.";
    return;
  }
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(sizesStorageKey) || "null");
  } catch {
    // Unreadable storage: fall back to this view's 150% default.
  }
  for (const [key, slider] of [["node", el.graphNodeSize], ["text", el.graphTextSize]]) {
    const value = Number(saved?.[key]);
    slider.value = String(Number.isFinite(value) && value >= 50 && value <= 300 ? value : DEFAULT_SCALE_PERCENT);
  }
  graphScales.node = Number(el.graphNodeSize.value) / 100;
  graphScales.text = Number(el.graphTextSize.value) / 100;
  applyGraphScales();
  el.graphRefreshButton.disabled = false;
  setGraphView("3d");
  await loadGraph();
  setInterval(() => { if (!document.hidden) loadGraph(); }, 15000);
}

start();
