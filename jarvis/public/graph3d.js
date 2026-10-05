// Live 3D view of the knowledge graph (the panel's default view). A
// continuously animated 3D force layout rendered with three.js (vendored, no
// build step): nodes are spheres (coloured by type, the :User account node
// larger and in the accent colour), links are one dynamic LineSegments object,
// and labels are DOM elements projected onto the canvas every frame so they
// stay crisp at any zoom. The camera orbits on drag, zooms on wheel and
// eases back into a slow auto-rotate after a few idle seconds; every data
// update re-heats the layout so new nodes and links settle into place live.
import * as THREE from "./vendor/three.module.min.js";
import { relationLabel } from "./relLabel.js";

// Same palette as the 2D view (style.css custom properties, as hex).
const TYPE_COLORS = {
  person: 0x2dffbf,
  place: 0xffc04d,
  organization: 0x4d8dff,
  event: 0xb088ff,
  topic: 0x42d9ff,
  thing: 0x77a9bf,
};
const USER_COLOR = 0x42d9ff;
const EDGE_COLOR = 0x42d9ff;
const BACKGROUND = 0x02050b;
const MAX_NODES = 80;
const MAX_EDGES = 160;
// The 2D layout's physics constants, reused so both views settle similarly.
const REPULSION = 1400;
const SPRING_LENGTH = 70;
const SPRING_STIFFNESS = 0.04;
const CENTERING = 0.015;
// Force application fades from 1 (fresh data) toward a small floor so the
// layout settles but the view keeps a gentle, living motion.
const ALPHA_DECAY_PER_FRAME = 0.008;
const ALPHA_FLOOR = 0.02;
const AUTO_ROTATE_AFTER_MS = 5000;

export function createGraph3D(stage, { userName = null, onNodeClick, onFallback, nodeScale = 1 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Knowledge graph visualization (3D)");
  const labelLayer = document.createElement("div");
  labelLayer.className = "graph-3d-labels";
  stage.append(canvas, labelLayer);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    cleanupDom();
    if (onFallback) onFallback();
    return null;
  }
  renderer.setClearColor(BACKGROUND);

  function cleanupDom() {
    labelLayer.remove();
    canvas.remove();
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BACKGROUND, 280, 560);
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 2000);
  scene.add(new THREE.AmbientLight(0x88aacc, 0.9));
  // decay 0: constant falloff, so the light behaves the same across three.js
  // versions (physical light units would need a very high intensity).
  const keyLight = new THREE.PointLight(0xffffff, 1.2, 0, 0);
  scene.add(keyLight);

  const sphereGeometry = new THREE.SphereGeometry(1, 20, 14);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.25 });
  let edgeLines = null;
  const raycaster = new THREE.Raycaster();

  // id -> { mesh, label, pos }
  const nodeState = new Map();
  // `${source}->${target}` -> { label, source, target, offset }; the offset
  // stacks the labels of parallel edges that share a midpoint.
  const edgeLabels = new Map();
  let edges = [];
  let alpha = 0;
  let disposed = false;
  // The panel's "Entities" slider: multiplies the base sphere scale of every
  // node (set live via setNodeScale while the view is open).
  let nodeScaleFactor = nodeScale;

  const orbit = {
    // Spherical camera position; target* is where the drag/zoom is aiming,
    // current lerps toward it for a smooth feel.
    target: { theta: 0.6, phi: 1.15, radius: 175 },
    current: { theta: 0.6, phi: 1.15, radius: 175 },
    lastInteraction: 0,
  };

  function nodeColor(node) {
    return node.type ? TYPE_COLORS[node.type] ?? TYPE_COLORS.thing : USER_COLOR;
  }

  function makeLabel(node) {
    const label = document.createElement("span");
    const suffix = !node.type && userName && node.name === userName ? " (you)" : "";
    // Admin view: every owner's copy of an entity is drawn, so same-named
    // copies (two "Lego") need the owner in the label. For a regular user
    // this never fires (own entities have owner === them; markers have none).
    const ownerSuffix = node.owner && node.owner !== userName ? ` (${node.owner})` : "";
    label.textContent = `${String(node.name || node.type).slice(0, 24)}${ownerSuffix}${suffix}`;
    if (!node.type) label.classList.add("user");
    if (node.isolated) label.classList.add("isolated");
    label.addEventListener("click", () => onNodeClick?.(node.id));
    labelLayer.appendChild(label);
    return label;
  }

  function removeNode(id) {
    const entry = nodeState.get(id);
    if (!entry) return;
    scene.remove(entry.mesh);
    entry.mesh.material.dispose();
    entry.label.remove();
    nodeState.delete(id);
  }

  // Diff the subgraph against the scene: keep positions of surviving nodes so
  // the view does not jump on every poll, spawn new ones near an existing
  // neighbour when there is one, and rebuild the line buffer.
  function update(subgraph) {
    if (disposed) return;
    const incoming = (subgraph.nodes || []).slice(0, MAX_NODES);
    const incomingIds = new Set(incoming.map((node) => node.id));
    for (const id of [...nodeState.keys()]) {
      if (!incomingIds.has(id)) removeNode(id);
    }
    for (const node of incoming) {
      let entry = nodeState.get(node.id);
      if (!entry) {
        // Isolated mentions (owned, no fact edge) render dimmed, like the
        // 2D view; transparent from the start so the opacity can flip later
        // when a fact edge appears.
        const mesh = new THREE.Mesh(sphereGeometry, new THREE.MeshLambertMaterial({ color: nodeColor(node), transparent: true, opacity: node.isolated ? 0.35 : 1 }));
        const pos = new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
        ).multiplyScalar(40 + Math.random() * 50);
        // The :User account node renders distinctly, like the 2D view.
        entry = { mesh, label: makeLabel(node), pos, baseScale: node.type ? 1.7 : 2.7 };
        mesh.scale.setScalar(entry.baseScale * nodeScaleFactor);
        mesh.userData.nodeId = node.id;
        scene.add(mesh);
        nodeState.set(node.id, entry);
      }
      entry.mesh.material.color.setHex(nodeColor(node));
      entry.mesh.material.opacity = node.isolated ? 0.35 : 1;
      entry.label.classList.toggle("isolated", Boolean(node.isolated));
    }
    const byId = nodeState;
    edges = (subgraph.edges || [])
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .slice(0, MAX_EDGES);
    // Relation-type labels, diffed like the nodes so the view keeps them
    // between updates.
    // The id carries the relation type: a pair can carry several edges at
    // once (Mila -KNOWS-> Lego AND Mila -LIKES-> Lego) and each needs its
    // own label.
    const pairCount = new Map();
    const incomingEdgeIds = new Set();
    for (const edge of edges) {
      const id = `${edge.source}->${edge.target}:${edge.type}`;
      const key = [edge.source, edge.target].sort().join("~");
      const index = pairCount.get(key) || 0;
      pairCount.set(key, index + 1);
      incomingEdgeIds.add(id);
      // The negative flag changes the wording ("likes" -> "doesn't like");
      // the text refresh below picks polarity changes up between polls.
      const text = relationLabel(edge.type, edge.negative === true);
      const existing = edgeLabels.get(id);
      if (existing) {
        existing.offset = index;
        if (existing.label.textContent !== text) existing.label.textContent = text;
      } else {
        const label = document.createElement("span");
        label.className = "edge";
        label.textContent = text;
        labelLayer.appendChild(label);
        edgeLabels.set(id, { label, source: edge.source, target: edge.target, offset: index });
      }
    }
    for (const id of [...edgeLabels.keys()]) {
      if (!incomingEdgeIds.has(id)) {
        edgeLabels.get(id).label.remove();
        edgeLabels.delete(id);
      }
    }
    if (edgeLines) {
      scene.remove(edgeLines);
      edgeLines.geometry.dispose();
      edgeLines = null;
    }
    if (edges.length) {
      const positions = new Float32Array(edges.length * 6);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      edgeLines = new THREE.LineSegments(geometry, edgeMaterial);
      scene.add(edgeLines);
    }
    // New structure: let the layout re-settle, but gently.
    alpha = Math.max(alpha, 1);
  }

  // The panel's "Entities" slider: rescale every sphere in place (the
  // layout keeps its positions, so the view does not jump).
  function setNodeScale(scale) {
    nodeScaleFactor = scale;
    for (const entry of nodeState.values()) entry.mesh.scale.setScalar(entry.baseScale * nodeScaleFactor);
  }

  // One force pass (repulsion + link springs + centering), applied scaled by
  // `alpha` so fresh data settles quickly and the settled view only drifts
  // gently. Same constants as the 2D layout, in three dimensions.
  function stepPhysics() {
    const entries = [...nodeState.values()];
    for (const entry of entries) { entry.dx = 0; entry.dy = 0; entry.dz = 0; }
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dz = b.pos.z - a.pos.z;
        const distance = Math.max(12, Math.hypot(dx, dy, dz));
        const force = REPULSION / (distance * distance);
        a.dx -= (dx / distance) * force;
        a.dy -= (dy / distance) * force;
        a.dz -= (dz / distance) * force;
        b.dx += (dx / distance) * force;
        b.dy += (dy / distance) * force;
        b.dz += (dz / distance) * force;
      }
    }
    for (const edge of edges) {
      const a = nodeState.get(edge.source);
      const b = nodeState.get(edge.target);
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dz = b.pos.z - a.pos.z;
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const force = ((distance - SPRING_LENGTH) / distance) * SPRING_STIFFNESS;
      a.dx += dx * force;
      a.dy += dy * force;
      a.dz += dz * force;
      b.dx -= dx * force;
      b.dy -= dy * force;
      b.dz -= dz * force;
    }
    for (const entry of entries) {
      entry.dx += -entry.pos.x * CENTERING;
      entry.dy += -entry.pos.y * CENTERING;
      entry.dz += -entry.pos.z * CENTERING;
      entry.pos.x += entry.dx * alpha;
      entry.pos.y += entry.dy * alpha;
      entry.pos.z += entry.dz * alpha;
    }
  }

  // Project node positions onto the screen for the labels.
  const projected = new THREE.Vector3();
  function updateLabels(width, height) {
    for (const entry of nodeState.values()) {
      projected.copy(entry.pos).project(camera);
      if (projected.z > 1) {
        entry.label.style.display = "none";
        continue;
      }
      entry.label.style.display = "";
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      // The second translate keeps the label centred above its node (the
      // inline transform replaces the CSS one every frame).
      entry.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -160%)`;
    }
  }

  function updateEdgePositions() {
    if (!edgeLines) return;
    const attribute = edgeLines.geometry.getAttribute("position");
    for (let i = 0; i < edges.length; i += 1) {
      const a = nodeState.get(edges[i].source).pos;
      const b = nodeState.get(edges[i].target).pos;
      attribute.setXYZ(i * 2, a.x, a.y, a.z);
      attribute.setXYZ(i * 2 + 1, b.x, b.y, b.z);
    }
    attribute.needsUpdate = true;
  }

  // Project link midpoints onto the screen for the relation-type labels.
  function updateEdgeLabels(width, height) {
    for (const entry of edgeLabels.values()) {
      const a = nodeState.get(entry.source);
      const b = nodeState.get(entry.target);
      if (!a || !b) continue;
      projected
        .set((a.pos.x + b.pos.x) / 2, (a.pos.y + b.pos.y) / 2, (a.pos.z + b.pos.z) / 2)
        .project(camera);
      if (projected.z > 1) {
        entry.label.style.display = "none";
        continue;
      }
      entry.label.style.display = "";
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height - entry.offset * 10;
      entry.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    }
  }

  function updateCamera(deltaMs) {
    const now = performance.now();
    if (now - orbit.lastInteraction > AUTO_ROTATE_AFTER_MS) {
      orbit.target.theta += (deltaMs / 1000) * 0.12;
    }
    orbit.current.theta += (orbit.target.theta - orbit.current.theta) * 0.08;
    orbit.current.phi += (orbit.target.phi - orbit.current.phi) * 0.08;
    orbit.current.radius += (orbit.target.radius - orbit.current.radius) * 0.12;
    const { theta, phi, radius } = orbit.current;
    camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    );
    keyLight.position.copy(camera.position);
    camera.lookAt(0, 0, 0);
  }

  // --- interaction -----------------------------------------------------------

  let dragState = null;
  canvas.addEventListener("pointerdown", (event) => {
    orbit.lastInteraction = performance.now();
    dragState = { x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
    dragState.x = event.clientX;
    dragState.y = event.clientY;
    orbit.target.theta -= dx * 0.005;
    orbit.target.phi = Math.min(Math.PI - 0.15, Math.max(0.15, orbit.target.phi + dy * 0.005));
    orbit.lastInteraction = performance.now();
  });
  canvas.addEventListener("pointerup", (event) => {
    const wasDrag = dragState?.moved;
    dragState = null;
    orbit.lastInteraction = performance.now();
    if (wasDrag) return;
    // Click (not drag): pick the node under the cursor and re-centre on it.
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...nodeState.values()].map((entry) => entry.mesh));
    if (hits.length) onNodeClick?.(hits[0].object.userData.nodeId);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    orbit.lastInteraction = performance.now();
    orbit.target.radius = Math.min(420, Math.max(70, orbit.target.radius * (1 + event.deltaY * 0.001)));
  }, { passive: false });

  // --- sizing / loop ----------------------------------------------------------

  function resize() {
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    return { width, height };
  }
  const observer = new ResizeObserver(() => resize());
  observer.observe(stage);

  let frame = 0;
  let lastTime = performance.now();
  function tick() {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    // The panel may be on the 2D view (or the page hidden): skip the work.
    if (stage.hidden || document.hidden) {
      lastTime = performance.now();
      return;
    }
    const now = performance.now();
    const deltaMs = Math.min(100, now - lastTime);
    lastTime = now;
    alpha = Math.max(ALPHA_FLOOR, alpha * (1 - ALPHA_DECAY_PER_FRAME * (deltaMs / 16.7)));
    if (nodeState.size) {
      stepPhysics();
      for (const entry of nodeState.values()) entry.mesh.position.copy(entry.pos);
    }
    updateEdgePositions();
    updateCamera(deltaMs);
    updateLabels(stage.clientWidth, stage.clientHeight);
    updateEdgeLabels(stage.clientWidth, stage.clientHeight);
    renderer.render(scene, camera);
  }
  resize();
  tick();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const id of [...nodeState.keys()]) removeNode(id);
    if (edgeLines) {
      edgeLines.geometry.dispose();
      edgeLines = null;
    }
    edgeMaterial.dispose();
    sphereGeometry.dispose();
    renderer.dispose();
    cleanupDom();
  }

  return { update, dispose, setNodeScale };
}
