// index.js - Rolimons proxy (scan .text-light.text-truncate inside inventory sections)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const cache = {};

// helper: parse numbers like "25,000" or "1 234" or "25.000"
function parseNumberToken(token) {
  if (!token || typeof token !== "string") return null;
  const cleaned = token.replace(/[^\d,.\s\u00A0]/g, "").trim();
  if (!cleaned) return null;
  let tmp = cleaned.replace(/\u00A0/g, "").replace(/\s+/g, "");
  // remove thousands separators commonly used (commas or dots) but keep decimal dots (Roblox uses integers)
  tmp = tmp.replace(/,/g, "");
  // if there are multiple dots treat them as thousand separators too
  if ((tmp.match(/\./g) || []).length > 1) tmp = tmp.replace(/\./g, "");
  // final digits-only
  const digits = tmp.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// sum all numbers from a cheerio root using the exact span selector
function sumSpansInRoot($, root, selector) {
  const out = { values: [], samples: [] };
  if (!root || !root.length) return out;
  root.find(selector).each((i, el) => {
    try {
      const txt = $(el).text() || "";
      const n = parseNumberToken(txt);
      if (n !== null) {
        out.values.push(n);
        if (out.samples.length < 12) out.samples.push({ value: n, snippet: txt.trim().slice(0,100) });
      }
    } catch (e) {}
  });
  return out;
}

// Try to fetch the player's Rolimons page
async function fetchPlayerHtml(userId) {
  const url = `https://www.rolimons.com/player/${userId}`;
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "AvatarValueProxy/scan-truncate" },
    validateStatus: null,
  });
  return { status: resp.status, url, html: resp.data };
}

app.get("/clearCache", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const key = `u:${userId}`;
  delete cache[key];
  return res.json({ ok: true, cleared: key });
});

app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  const nocache = req.query.nocache === "1" || req.query.nocache === "true";
  const debug = req.query.debug === "1" || req.query.debug === "true";

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const cacheKey = `u:${userId}`;
  const cached = cache[cacheKey];
  if (!nocache && cached && Date.now() - cached.ts < CACHE_TTL) {
    const out = { totalValue: cached.value, source: cached.source || "cache" };
    if (debug && cached.debug) out.debug = cached.debug;
    return res.json(out);
  }

  // fetch page
  let page;
  try {
    page = await fetchPlayerHtml(userId);
    if (!page || page.status !== 200) {
      return res.status(502).json({ error: "Failed to fetch Rolimons page", status: page ? page.status : null });
    }
  } catch (err) {
    return res.status(502).json({ error: "Fetch error", reason: err.message });
  }

  const $ = cheerio.load(page.html || "");
  const selector = "span.text-light.text-truncate";

  // prefer inventory sections
  const sections = [
    "#inventoryugclimiteds",
    "#inventorylimiteds",
    "div[id*='ugclimiteds']",
    "div[id*='inventorylimiteds']",
  ];

  let collected = { values: [], samples: [], from: "none", sourceSelector: null };

  for (const sel of sections) {
    const root = $(sel);
    if (root && root.length) {
      const r = sumSpansInRoot($, root, selector);
      if (r.values && r.values.length) {
        collected = { values: r.values, samples: r.samples, from: sel, sourceSelector: selector };
        break;
      }
    }
  }

  // if not found in sections, fallback to scanning entire document for that selector
  if (collected.values.length === 0) {
    const rAll = sumSpansInRoot($, $.root(), selector);
    if (rAll.values && rAll.values.length) {
      collected = { values: rAll.values, samples: rAll.samples, from: "document", sourceSelector: selector };
    }
  }

  // compute total
  let total = 0;
  if (collected.values.length) {
    for (const v of collected.values) total += v;
  } else {
    // nothing found — fallback: try to extract any large integer-like numbers from the body (best-effort)
    const bodyText = $("body").text() || "";
    const tokens = (bodyText.match(/[\d][\d,.\s\u00A0]{1,}/g) || []).map(t => parseNumberToken(t)).filter(Boolean);
    if (tokens.length) {
      // pick the largest one as fallback (not ideal, but better than zero)
      tokens.sort((a,b) => b - a);
      total = tokens[0] || 0;
      collected.samples = tokens.slice(0,12).map(v => ({ value: v, snippet: "fallback-body" }));
    } else {
      total = 0;
    }
  }

  // cache + response
  const debugObj = {
    method: "scan-truncate",
    collectedFrom: collected.from,
    selector: collected.sourceSelector,
    foundCount: (collected.values || []).length,
    samples: collected.samples || [],
  };

  cache[cacheKey] = { value: total, ts: Date.now(), source: page.url, debug: debugObj };

  const out = { totalValue: total, source: page.url };
  if (debug) out.debug = debugObj;
  return res.json(out);
});

app.get("/", (req, res) => res.json({ ok: true, msg: "rolimons-proxy scan-truncate alive" }));

app.listen(PORT, () => console.log(`rolimons-proxy listening on port ${PORT}`));

