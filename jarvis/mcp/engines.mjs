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
    .replace(/&apos;/g, "'")
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

// --- News (the web_news tool) -------------------------------------------------
//
// Free, keyless RSS/Atom feeds per interest area. Unlike the HTML search
// endpoints, feeds are built for machine consumers, so they survive
// datacenter IPs (DuckDuckGo HTML does not — measured from the production
// server: see DEPLOYMENT.md, "Live web news"). Every feed below was
// verified reachable from the live server without a bot wall.
export const INTEREST_FEEDS = {
  // German tech press.
  technik: [
    { source: "heise online", url: "https://www.heise.de/rss/heise-atom.xml", lang: "de" },
    { source: "Golem", url: "https://rss.golem.de/rss.php?feed=RSS2.0", lang: "de" },
  ],
  // English tech press.
  it: [
    { source: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", lang: "en" },
    { source: "The Verge", url: "https://www.theverge.com/rss/index.xml", lang: "en" },
    { source: "TechCrunch", url: "https://techcrunch.com/feed/", lang: "en" },
  ],
  finance: [
    { source: "CNBC Top News", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", lang: "en" },
    { source: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories/", lang: "en" },
    { source: "Financial Times", url: "https://www.ft.com/rss/home", lang: "en" },
  ],
  geek: [
    { source: "Hacker News front page", url: "https://hnrss.org/frontpage", lang: "en" },
    { source: "Lobsters", url: "https://lobste.rs/rss", lang: "en" },
  ],
  nerd: [
    { source: "r/programming", url: "https://www.reddit.com/r/programming/.rss", lang: "en" },
    { source: "Hacker News front page", url: "https://hnrss.org/frontpage", lang: "en" },
    { source: "Lobsters", url: "https://lobste.rs/rss", lang: "en" },
  ],
};

// Interest-area spellings the user (or the brain) is likely to use.
const TOPIC_ALIASES = {
  technik: "technik", technologie: "technik", "tech news": "technik",
  it: "it", "it news": "it", itnews: "it", informatik: "it", tech: "it",
  finance: "finance", finanzen: "finance", "finance news": "finance",
  geek: "geek", geeks: "geek",
  nerd: "nerd", nerds: "nerd",
};

// Maps a topic to an interest-area key; a concrete topic (e.g. "Home
// Assistant") comes back as null and is searched as free text.
export function normalizeTopic(topic) {
  return TOPIC_ALIASES[String(topic || "").trim().toLowerCase()] || null;
}

// One <tag>…</tag> value from a feed block (first match), CDATA unwrapped.
function feedTag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}

// <link href="…"/> (Atom) or <link>https://…</link> (RSS), skipping the
// feed-plumbing links (self/edit/hub/enclosure).
function feedLink(block) {
  const selfless = block.replace(/<link[^>]+rel="(?:self|edit|hub|enclosure)"[^>]*\/?>/g, "");
  const href = selfless.match(/<link[^>]+href="([^"]+)"/);
  if (href) return unescapeHref(href[1]);
  const text = selfless.match(/<link[^>]*>([^<]+)<\/link>/);
  return text ? unescapeHref(text[1].trim()) : "";
}

// Parses one RSS 2.0 or Atom feed into news items. Tolerant by design: items
// without a title or link are skipped, markup/CDATA in titles and snippets is
// stripped, and a missing date comes back as 0 (sorts to the end).
export function parseFeedItems(xml, source) {
  const text = String(xml || "");
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/g) || text.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  const items = [];
  for (const block of blocks) {
    const title = feedTag(block, "title");
    const url = feedLink(block);
    if (!title || !url) continue;
    const snippet = cleanHtml(feedTag(block, "description") || feedTag(block, "summary") || feedTag(block, "content")).slice(0, 200);
    const rawDate = feedTag(block, "pubDate") || feedTag(block, "published") || feedTag(block, "updated") || feedTag(block, "dc:date");
    const time = Date.parse(rawDate);
    items.push({ title: cleanHtml(title), url, snippet, source, date: Number.isNaN(time) ? 0 : time });
  }
  return items;
}

// One text block for the brain: newest first, numbered, with source, date and
// URL per item.
export function formatNewsItems(items) {
  return [...(items || [])]
    .sort((a, b) => b.date - a.date)
    .map((item, index) => {
      const when = item.date ? ` (${new Date(item.date).toISOString().slice(0, 10)})` : "";
      return `${index + 1}. ${item.title} — ${item.source}${when}\n${item.url}\n${item.snippet || ""}`;
    })
    .join("\n\n");
}
