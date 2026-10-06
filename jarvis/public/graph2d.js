// Static 2D view of the knowledge graph, shared by the app's graph panel and
// the full-size /graph.html page. Small force-directed layout in plain JS (no
// dependencies): repulsion, link springs and centering, then static SVG.
// Bounded to keep it cheap. The caller owns the <svg> and its viewBox; width
// and height are that viewBox's user-unit box, so the same drawing scales to
// any element size.
import { relationLabel } from "./relLabel.js";

const TYPE_COLORS = {
  person: "var(--green)",
  place: "var(--amber)",
  organization: "var(--blue)",
  event: "var(--purple)",
  topic: "var(--cyan)",
  thing: "var(--muted)",
};

export function renderGraph2d(svg, subgraph, { nodeScale = 1, userName = null, onNodeClick, width = 640, height = 320, highlight = null } = {}) {
  // A search highlight ({ nodeIds, relTypes }) fades everything it does not
  // match, so the drawing reads as filtered without the layout moving.
  const active = Boolean(highlight && (highlight.nodeIds?.size || highlight.relTypes?.size));
  const byRelType = new Set();
  if (active && highlight.relTypes?.size) {
    for (const edge of subgraph.edges || []) {
      if (!highlight.relTypes.has(edge.type)) continue;
      byRelType.add(edge.source);
      byRelType.add(edge.target);
    }
  }
  const nodeMatched = (id) => !active || highlight.nodeIds?.has(id) || byRelType.has(id);
  const edgeMatched = (edge) => !active
    || highlight.relTypes?.has(edge.type)
    || highlight.nodeIds?.has(edge.source)
    || highlight.nodeIds?.has(edge.target);
  svg.replaceChildren();
  const nodes = (subgraph.nodes || []).slice(0, 80);
  if (!nodes.length) return;
  const ids = new Set(nodes.map((node) => node.id));
  const edges = (subgraph.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)).slice(0, 160);
  const position = new Map();
  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2;
    position.set(node.id, {
      x: width / 2 + Math.cos(angle) * (90 + (index % 5) * 24),
      y: height / 2 + Math.sin(angle) * (70 + (index % 4) * 18),
    });
  });
  for (let step = 0; step < 90; step += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = position.get(nodes[i].id);
        const b = position.get(nodes[j].id);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(12, Math.hypot(dx, dy));
        const force = 1400 / (distance * distance);
        a.x -= (dx / distance) * force;
        a.y -= (dy / distance) * force;
        b.x += (dx / distance) * force;
        b.y += (dy / distance) * force;
      }
    }
    for (const edge of edges) {
      const a = position.get(edge.source);
      const b = position.get(edge.target);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = ((distance - 70) / distance) * 0.04;
      a.x += dx * force;
      a.y += dy * force;
      b.x -= dx * force;
      b.y -= dy * force;
    }
    for (const node of nodes) {
      const point = position.get(node.id);
      point.x += (width / 2 - point.x) * 0.015;
      point.y += (height / 2 - point.y) * 0.015;
      point.x = Math.min(width - 24, Math.max(24, point.x));
      point.y = Math.min(height - 24, Math.max(24, point.y));
    }
  }
  const NS = "http://www.w3.org/2000/svg";
  // Parallel edges between the same pair share a midpoint; stack their
  // labels so they do not paint on top of each other.
  const pairCount = new Map();
  const pairIndex = new Map();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("~");
    const index = pairCount.get(key) || 0;
    pairIndex.set(edge, index);
    pairCount.set(key, index + 1);
  }
  for (const edge of edges) {
    const a = position.get(edge.source);
    const b = position.get(edge.target);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.style.stroke = edgeMatched(edge) ? "rgba(66, 217, 255, 0.25)" : "rgba(66, 217, 255, 0.05)";
    line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    // The relation in plain words (with the negative form), so a link reads
    // like a sentence with its two node labels ("Mila" —likes→ "Lego").
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String((a.x + b.x) / 2));
    label.setAttribute("y", String((a.y + b.y) / 2 - 3 - pairIndex.get(edge) * 10));
    label.setAttribute("class", edgeMatched(edge) ? "edge-label" : "edge-label dimmed");
    label.textContent = relationLabel(edge.type, edge.negative === true);
    svg.appendChild(label);
  }
  for (const node of nodes) {
    // :User nodes carry no type: the account the knowledge belongs to, so
    // render them distinctly instead of as an untyped grey blob.
    const isUser = !node.type;
    const point = position.get(node.id);
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    // The "Entities" slider scales the node (the :User node stays larger).
    circle.setAttribute("r", String(isUser ? 9 * nodeScale : 7 * nodeScale));
    circle.style.fill = isUser ? "var(--cyan)" : (TYPE_COLORS[node.type] || "var(--muted)");
    // An isolated mention (owned, but no fact edge touches it) is drawn
    // dimmed — what the brain's list-my-knowledge reports is what the panel
    // shows, just visually marked as "known, nothing stored about it".
    const matched = nodeMatched(node.id);
    circle.style.fillOpacity = matched ? (node.isolated ? "0.35" : "0.65") : "0.08";
    // Click a node to re-centre the view on its neighbourhood.
    circle.addEventListener("click", () => onNodeClick?.(node.id));
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(point.x));
    // The node name follows the "Entities" slider (font and offset), so it
    // tracks the scaled node.
    label.setAttribute("y", String(point.y - 11 * nodeScale));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", String(10 * nodeScale));
    label.style.fill = "var(--muted)";
    label.style.opacity = matched ? "1" : "0.15";
    const suffix = isUser && userName === node.name ? " (you)" : "";
    // In the admin view every owner's copy of an entity is drawn; the owner
    // suffix keeps same-named copies (two "Lego") tellable apart. For a
    // regular user this never fires: their own entities carry owner === them
    // and account markers carry no owner.
    const ownerSuffix = node.owner && node.owner !== userName ? ` (${node.owner})` : "";
    label.textContent = `${String(node.name || node.type).slice(0, 24)}${ownerSuffix}${suffix}`;
    svg.appendChild(circle);
    svg.appendChild(label);
  }
}
