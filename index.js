// index.js - Rolimons proxy (inventory limiteds summing with item details)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const cache = {};

// ---------- Helpers ----------
function normNumberString(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/[^\d,.\s\u00A0]/g, "").trim();
  if (!cleaned) return null;
  let tmp = cleaned.replace(/\u00A0/g, "").replace(/\s+/g, "");
  tmp = tmp.replace(/,/g, "");
  if ((tmp.match(/\./g) || []).length > 1) tmp = tmp.replace(/\./g, "");
  const n = parseInt(tmp, 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- Scraper ----------
function sumLimitedValuesFromHtml(html) {
  const $ = cheerio.load(html || "");

  const sections = [
    { key: "ugc", selector: "#inventoryugclimiteds" },
    { key: "limited", selector: "#inventorylimiteds" },
  ];

  const results = { items: [], total: 0 };

  for (const sec of sections) {
    const root = $(sec.selector);
    if (!root || !root.length) continue;

    // Item containers (Rolimons renders cards/divs/lis)
    root.find(".item-card, .card, .inventory-item, li, tr, div").each((i, el) => {
      const name = $(el).find(".item-name, strong, .name").first().text().trim();
      const valText = $(el).find(".value, .price, td, span").first().text().trim();
      const val = normNumberString(valText);

      if (val !== null && name) {
        results.items.push({ name, value: val, type: sec.key });
        results.total += val;
      }
    });
  }

  if (results.items.length === 0) return null;
  return results;
}

// Fallback: grab the largest number on page if nothing matched
function fallbackExtractTotalFromHtml(html) {
  const $ = cheerio.load(html || "");
  const bodyText = $("body").text() || "";
  const all = (bodyText.match(/[\d][\d,.\s\u00A0]{1,}/g) || [])
    .map(normNumberString)
    .filter(Boolean);
  all.sort((a, b) => b - a);
  return { total: all[0] || 0, candidates: all.slice(0, 10) };
}

async function fetchPlayerPage(userId) {
  const url = `https://www.rolimons.com/player/${userId}`;
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "AvatarValueProxy/limsum" },
    validateStatus: null,
  });
  return { url, status: resp.status, html: resp.data, headers: resp.headers };
}

// ---------- Endpoints ----------
app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  const nocache = req.query.nocache === "1" || req.query.nocache === "true";
  const debug = req.query.debug === "1" || req.query.debug === "true";

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const key = `u:${userId}`;
  const cached = cache[key];
  if (!nocache && cached && Date.now() - cached.ts < CACHE_TTL) {
    const out = { totalValue: cached.value, source: "cache" };
    if (debug && cached.debug) out.debug = cached.debug;
    return res.json(out);
  }

  // fetch page
  let page;
  try {
    page = await fetchPlayerPage(userId);
    if (!page || page.status !== 200) {
      const fb = fallbackExtractTotalFromHtml(page?.html || "");
      cache[key] = { value: fb.total, ts: Date.now(), debug: { fallback: true } };
      return res.json({ totalValue: fb.total, source: "fallback" });
    }
  } catch (e) {
    return res.status(502).json({ error: "fetch failed", reason: e.message });
  }

  // try section-sum
  const sectionResult = sumLimitedValuesFromHtml(page.html);
  if (sectionResult) {
    cache[key] = { value: sectionResult.total, ts: Date.now(), debug: sectionResult };
    const out = { totalValue: sectionResult.total, source: page.url };
    if (debug) out.debug = sectionResult;
    return res.json(out);
  }

  // fallback
  const fb = fallbackExtractTotalFromHtml(page.html);
  cache[key] = { value: fb.total, ts: Date.now(), debug: { method: "fallback", candidates: fb.candidates } };
  const out = { totalValue: fb.total, source: page.url };
  if (debug) out.debug = { method: "fallback", candidates: fb.candidates };
  return res.json(out);
});

app.get("/", (req, res) => res.json({ ok: true, msg: "rolimons-proxy alive" }));

app.listen(PORT, () => console.log("rolimons-proxy listening on port", PORT));

