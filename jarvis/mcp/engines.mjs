// Pure helpers for the web-search engines: markup parsing, redirect-URL
// unwrapping and result merging. No network code here, so the unit tests run
// without internet (the MCP server in websearch.mjs owns the fetches).

export function cleanHtml(html) {
  return String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

// href attributes arrive HTML-encoded (&amp; and friends) before URL parsing.
function unescapeHref(href) {
  return String(href || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

// DuckDuckGo result links are redirect URLs like //duckduckgo.com/l/?uddg=<encoded>;
// unwrap them to the real target. Anything that stays on duckduckgo.com after
// the unwrap (ad links like duckduckgo.com/y.js?ad_..., failed redirects) is
// not a result and comes back as "".
export function decodeDuckDuckGoHref(href) {
  href = unescapeHref(href);
  if (!href) return "";
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    // Ads are double-wrapped: /l/?uddg=<encoded duckduckgo.com/y.js?ad_...>;
    // check the final target's hostname, not the redirect's.
    const finalUrl = url.searchParams.get("uddg") || url.toString();
    return new URL(finalUrl).hostname.endsWith("duckduckgo.com") ? "" : finalUrl;
  } catch {
    return "";
  }
}

// Bing result links are redirects like
// https://www.bing.com/ck/a?!&p=...&u=a1<base64url of the real target>;
// unwrap the u=a1... parameter to the real URL. Organic results are always
// wrapped, so a link that stays on bing.com is a failed unwrap and comes back
// as "".
export function decodeBingUrl(href) {
  href = unescapeHref(href);
  if (!href) return "";
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    const encoded = url.searchParams.get("u");
    if (encoded && encoded.startsWith("a1")) {
      const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      return Buffer.from(base64, "base64").toString("utf8");
    }
    return url.hostname.endsWith("bing.com") ? "" : url.toString();
  } catch {
    return "";
  }
}

// Dedupe key: same page from two engines (https://x.com/a/ and
// http://www.x.com/a) must not count twice.
export function normalizeUrlForDedupe(url) {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return `${host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(url || "").toLowerCase();
  }
}

// Merge the per-engine result sets into one deduplicated list. Round-robin
// across engines (first result of each, then second, ...) so no single source
// can crowd the others out of the top N; a URL already taken by an earlier
// depth is skipped. Each result keeps its engine tag for the brain.
export function mergeResults(sets, maxResults) {
  const queues = (sets || [])
    .map((set) => ({ engine: set.engine, results: (set.results || []).filter((result) => result && result.url) }))
    .filter((queue) => queue.results.length);
  const seen = new Set();
  const merged = [];
  for (let depth = 0; merged.length < maxResults; depth += 1) {
    let added = false;
    for (const queue of queues) {
      if (merged.length >= maxResults) break;
      const result = queue.results[depth];
      if (!result) continue;
      const key = normalizeUrlForDedupe(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...result, engine: queue.engine });
      added = true;
    }
    if (!added) break;
  }
  return merged;
}

// One text block for the brain: the instant answer (if any) first, then the
// merged results numbered, each tagged with its source engine.
export function formatSearchResults(merged, instant) {
  const sections = [];
  if (instant) sections.push(`Instant answer (DuckDuckGo):\n${instant}`);
  for (const [index, result] of (merged || []).entries()) {
    sections.push(`${index + 1}. [${result.engine}] ${result.title}\n${result.url}\n${result.snippet || ""}`);
  }
  return sections.join("\n\n");
}
