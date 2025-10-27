// Vercel Serverless Function: /api/rss.xml
// ELI5: Fetch your blog page, find article links/titles, build RSS XML.

import * as cheerio from "cheerio";

const BLOG_LIST_URL = process.env.BLOG_LIST_URL || "https://tridentaccounting.com.au/blog";
const SITE_ORIGIN   = process.env.SITE_ORIGIN   || "https://tridentaccounting.com.au";
const FEED_TITLE    = process.env.FEED_TITLE    || "Trident Accounting Blog";
const FEED_DESC     = process.env.FEED_DESC     || "Insights and updates from Trident Accounting";
const FEED_LINK     = process.env.FEED_LINK     || "https://tridentaccounting.com.au/blog";

// Helper: safe absolute URL
function abs(u) {
  try {
    return new URL(u, SITE_ORIGIN).toString();
  } catch {
    return u;
  }
}

// Try to read <meta property="article:published_time"> or <time> from a post page
async function fetchPublishedDate(postUrl) {
  try {
    const r = await fetch(postUrl, { headers: { "user-agent": "trident-rss/1.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);

    const metaTime = $('meta[property="article:published_time"]').attr("content")
                   || $('meta[name="article:published_time"]').attr("content");
    if (metaTime) return new Date(metaTime);

    const timeText = $("time").first().attr("datetime") || $("time").first().text();
    if (timeText) {
      const d = new Date(timeText);
      if (!isNaN(d)) return d;
    }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  try {
    // 1) Fetch the blog list page
    const resp = await fetch(BLOG_LIST_URL, { headers: { "user-agent": "trident-rss/1.0" } });
    if (!resp.ok) {
      res.status(502).send("Upstream blog fetch failed");
      return;
    }
    const html = await resp.text();
    const $ = cheerio.load(html);

    // 2) Heuristics: find links that look like blog posts.
    // Works for typical Framer blog grids/cards.
    // - anchor href contains "/blog/"
    // - title text from the anchor or a child heading.
    const seen = new Set();
    const items = [];

    $("a[href*='/blog/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // skip the index page itself
      if (href === "/blog" || href === "/blog/") return;

      const url = abs(href);
      if (seen.has(url)) return;
      seen.add(url);

      // Title guess: anchor text or nested heading text
      let title = $(el).text().trim();
      if (!title) {
        title = $(el).find("h1,h2,h3,h4").first().text().trim();
      }
      if (!title) return;

      items.push({ title, url });
    });

    // 3) If nothing found, bail with empty RSS (valid, just no items)
    // Limit to 15 items to keep it fast/light
    const limited = items.slice(0, 15);

    // 4) Try to enrich with published dates (best-effort, parallel with cap)
    const concurrency = 5;
    let i = 0;
    async function worker() {
      while (i < limited.length) {
        const idx = i++;
        const it = limited[idx];
        const d = await fetchPublishedDate(it.url);
        it.pubDate = d ? d.toUTCString() : new Date().toUTCString(); // fallback: now
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    // 5) Build RSS 2.0 XML (basic but valid)
    const rssItemsXml = limited.map(it => {
      const guid = it.url;
      const pubDate = it.pubDate || new Date().toUTCString();
      // Minimal <item>: title, link, guid, pubDate
      return `
        <item>
          <title>${escapeXml(it.title)}</title>
          <link>${escapeXml(it.url)}</link>
          <guid>${escapeXml(guid)}</guid>
          <pubDate>${pubDate}</pubDate>
        </item>
      `;
    }).join("");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(FEED_LINK)}</link>
    <description>${escapeXml(FEED_DESC)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${rssItemsXml}
  </channel>
</rss>`;

    // 6) Return XML
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    // Cache for 15 minutes at the edge/CDN
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300");
    res.status(200).send(xml);
  } catch (e) {
    res.status(500).send("RSS generator error");
  }
}

function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
