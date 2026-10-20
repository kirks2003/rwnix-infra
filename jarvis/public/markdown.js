// markdown.js — dependency-free, safe Markdown → HTML for the transcript.
//
// The brain's answer is not fully trusted (it can echo web-search or graph
// content), so this renderer (1) HTML-escapes every character of the source,
// (2) emits only a fixed whitelist of tags, and (3) allows link hrefs only for
// http/https/mailto. Arbitrary HTML or <script> in the output therefore renders
// as literal text and can never execute.
//
// Exports: renderMarkdown(src) -> HTML string (block-level <p>/<ul>/<pre>…).

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_HREF = /^(?:https?:|mailto:)/i;
// `escaped` is already HTML-escaped, so a passing value is a safe attribute.
function safeHref(escaped) {
  const h = escaped.trim();
  return SAFE_HREF.test(h) ? h : null;
}

// Inline formatting over already-escaped text. Returns escaped HTML.
function inline(escaped) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };

  // Code spans first, so their contents are never further formatted.
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => keep(`<code>${code}</code>`));

  // Images -> link (alt text is already escaped). An unsafe target keeps the
  // source verbatim (escaped) rather than becoming a clickable link.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${alt}</a>` : _m;
  });
  // Links.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : _m;
  });
  // Bold + italic.
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w_])_([^_\s][^_]*?)_(?![\w_])/g, "$1<em>$2</em>");

  // Restore stashed code spans.
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const isListItem = (line) => LIST_ITEM.test(line);

function parseList(lines, start) {
  const first = lines[start].match(LIST_ITEM);
  const ordered = /^\d/.test(first[2]);
  const baseIndent = first[1].length;
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      // Skip blank lines only if another item at >= baseIndent still follows.
      let j = i;
      while (j < n && /^\s*$/.test(lines[j])) j++;
      if (j < n) {
        const m = lines[j].match(LIST_ITEM);
        if (m && m[1].length >= baseIndent) { i = j; continue; }
      }
      break;
    }
    const m = line.match(LIST_ITEM);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    // A same-indent marker of a different kind starts a new list (ul <-> ol).
    if (indent === baseIndent && /^\d/.test(m[2]) !== ordered) break;
    if (indent > baseIndent) {
      // A deeper-indented run is a nested list belonging to the last item.
      const [nested, next] = parseList(lines, i);
      if (items.length) items[items.length - 1] += nested;
      i = next;
      continue;
    }
    items.push(inline(escapeHtml(m[3])));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
  return [open + items.map((it) => `<li>${it}</li>`).join("") + `</${tag}>`, i];
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const l = c.startsWith(":"), r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
  const rows = [];
  let i = start + 2;
  const n = lines.length;
  while (i < n && lines[i].includes("|") && !/^\s*$/.test(lines[i]) && !isListItem(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const style = (idx) => { const a = aligns[idx]; return a ? ` style="text-align:${a}"` : ""; };
  let html = "<table><thead><tr>";
  header.forEach((h, idx) => { html += `<th${style(idx)}>${inline(escapeHtml(h))}</th>`; });
  html += "</tr></thead><tbody>";
  for (const r of rows) {
    html += "<tr>";
    for (let idx = 0; idx < header.length; idx++) {
      html += `<td${style(idx)}>${inline(escapeHtml(r[idx] ?? ""))}</td>`;
    }
    html += "</tr>";
  }
  return [html + "</tbody></table>", i];
}

const paraStop = (l) =>
  /^\s*$/.test(l) || /^(`{3,}|~{3,})/.test(l) || /^#{1,6}\s/.test(l) ||
  /^\s{0,3}>/.test(l) || isListItem(l) || HR.test(l);

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = line.match(/^(`{3,}|~{3,})\s*([\w.+#-]*)\s*$/);
    if (fence) {
      const close = fence[1][0];
      const openLen = fence[1].length;
      const lang = fence[2];
      const buf = [];
      i++;
      while (i < n) {
        const cm = lines[i].match(/^(`{3,}|~{3,})\s*$/);
        if (cm && cm[1][0] === close && cm[1].length >= openLen) break;
        buf.push(lines[i]); i++;
      }
      if (i < n) i++; // skip closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inline(escapeHtml(heading[2].trim()))}</h${lvl}>`);
      i++;
      continue;
    }

    if (HR.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < n && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (isListItem(line)) {
      const [html, next] = parseList(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < n && TABLE_SEP.test(lines[i + 1])) {
      const [html, next] = parseTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    const buf = [line];
    i++;
    while (i < n && !paraStop(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p>${inline(escapeHtml(buf.join("\n"))).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("\n");
}
