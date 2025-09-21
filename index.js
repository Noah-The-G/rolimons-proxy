// ndex.js - Rolimons proxy (improved extraction + debug + cache control)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

// In-memory cache
// cache['u:<userId>'] = { value: Number, ts: Date.now(), source: string, rawSnippet?: string }
const cache = {};

// Candidate endpoints to try
const CANDIDATE_ENDPOINTS = [
  userId => `https://api.rolimons.com/player/${userId}`,         // sometimes 404
  userId => `https://www.rolimons.com/api/player/${userId}`,
  userId => `https://www.rolimons.com/player/${userId}`,         // HTML page (scrape)
  userId => `https://www.rolimons.com/ajax/player/${userId}`,
];

// Helpers
function parseNumberString(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/[^\d,.\s\u00A0]/g, "").trim();
  if (!cleaned) return null;
  let noSpaces = cleaned.replace(/\u00A0/g, "").replace(/\s+/g, "");
  const dotCount = (noSpaces.match(/\./g) || []).length;
  if (dotCount > 1) noSpaces = noSpaces.replace(/\./g, "");
  const digitsOnly = noSpaces.replace(/,/g, "");
  if (!digitsOnly.match(/\d{1,}/)) return null;
  const n = parseInt(digitsOnly, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function searchNumericInJson(obj) {
  // Recursively search for numeric keys / numeric-looking strings that plausibly represent "value"
  if (obj === null || obj === undefined) return null;
  if (typeof obj === "number" && Number.isFinite(obj) && obj >= 0) {
    return obj;
  }
  if (typeof obj === "string") {
    const n = parseNumberString(obj);
    if (n !== null) return n;
    return null;
  }
  if (typeof obj === "object") {
    // Favor keys with 'value', 'total', 'worth', 'robux', 'inventory'
    const preferKeys = Object.keys(obj).filter(k => /value|total|worth|robux|inventory|price|account/i.test(k));
    for (const k of preferKeys) {
      try {
        const v = obj[k];
        const found = searchNumericInJson(v);
        if (found !== null) return found;
      } catch (e) {}
    }
    // Otherwise scan all children
    for (const k of Object.keys(obj)) {
      try {
        const v = obj[k];
        const found = searchNumericInJson(v);
        if (found !== null) return found;
      } catch (e) {}
    }
  }
  return null;
}

function extractValueFromHtml(html) {
  const $ = cheerio.load(html || "");
  // 1) JSON-LD scripts
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const txt = $(scripts[i]).text();
    try {
      const j = JSON.parse(txt);
      const found = searchNumericInJson(j);
      if (found !== null) return found;
    } catch (e) {}
  }

  // 2) Next/React style JSON in <script id="__NEXT_DATA__"> or large script blocks
  const nextScript = $('#__NEXT_DATA__');
  if (nextScript && nextScript.length) {
    try {
      const j = JSON.parse(nextScript.text());
      const found = searchNumericInJson(j);
      if (found !== null) return found;
    } catch (e) {}
  }
  // try scanning other script tags for JSON-looking content
  $('script').each((i, el) => {
    try {
      const txt = $(el).html();
      if (!txt || txt.length < 40) return;
      // naive heuristic: string starts with "{" or "[" and contains "value" or "player"
      if (/^\s*[\{\[]/.test(txt) && /value|player|account|inventory|total/i.test(txt)) {
        try {
          const j = JSON.parse(txt);
          const found = searchNumericInJson(j);
          if (found !== null) throw { found }; // use exception to break out
        } catch (e) {
          if (e && e.found) throw e; // bubble up
        }
      }
    } catch (e) {
      if (e && e.found) return e.found;
    }
  });

  // 3) Label-based search (look for text containing 'Value' or 'Total Value' then extract numbers nearby)
  const labelRx = /(?:Total Value|Account Value|Inventory Value|Value|Worth|Robux|R\$|R\.)/i;
  const candidates = [];
  $('*').each((i, el) => {
    try {
      const text = $(el).text();
      if (!text || text.length < 1) return;
      if (!labelRx.test(text)) {
        const parentText = $(el).parent().text() || '';
        const nextText = $(el).next().text() || '';
        const prevText = $(el).prev().text() || '';
        if (!labelRx.test(parentText) && !labelRx.test(nextText) && !labelRx.test(prevText)) return;
      }
      // try to find a number fragment in element or sibling
      const m = text.match(/([\d][\d,.\s\u00A0]{0,20})/);
      if (m && m[1]) {
        const n = parseNumberString(m[1]);
        if (n !== null) candidates.push({ n, snippet: text.trim().slice(0,200) });
      } else {
        const neigh = $(el).next().text() || $(el).parent().text() || '';
        const ms = neigh.match(/([\d][\d,.\s\u00A0]{0,20})/);
        if (ms && ms[1]) {
          const n2 = parseNumberString(ms[1]);
          if (n2 !== null) candidates.push({ n: n2, snippet: (neigh||'').trim().slice(0,200) });
        }
      }
    } catch (e) {}
  });

  if (candidates.length) {
    candidates.sort((a,b) => b.n - a.n);
    return candidates[0].n;
  }

  // 4) final fallback: largest integer-like substring in body (but conservative)
  const bodyText = $('body').text() || '';
  const allNumbers = (bodyText.match(/[\d][\d,\. \u00A0]{1,}/g) || []).map(s => parseNumberString(s)).filter(Boolean);
  if (allNumbers.length) {
    allNumbers.sort((a,b)=>b-a);
    // return the largest but not absurdly large (safety)
    const top = allNumbers[0];
    if (top > 0 && top < 1e10) return top;
  }

  return null;
}

// Try endpoints and return { totalValue, source, rawHtml/rawJson }
async function tryRolimonsEndpoints(userId) {
  for (let i = 0; i < CANDIDATE_ENDPOINTS.length; i++) {
    const url = CANDIDATE_ENDPOINTS[i](userId);
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'AvatarValueProxy/1.0' },
        validateStatus: null
      });

      const ct = (resp.headers['content-type'] || '').toLowerCase();

      if (resp.status === 200 && ct.includes('application/json')) {
        const data = resp.data;
        const found = searchNumericInJson(data);
        if (found !== null) return { totalValue: found, source: url, rawJson: data };
        return { totalValue: null, source: url, rawJson: data };
      } else if (resp.status === 200 && ct.includes('text/html')) {
        const html = resp.data;
        const found = extractValueFromHtml(html);
        if (found !== null) return { totalValue: found, source: url, rawHtml: html.slice(0,20000) };
        return { totalValue: null, source: url, rawHtml: html.slice(0,20000) };
      } else {
        // continue trying
        continue;
      }
    } catch (err) {
      // try next endpoint
      continue;
    }
  }
  return null;
}

// Routes

// Clear cache for a user
app.get("/clearCache", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  const key = `u:${userId}`;
  delete cache[key];
  return res.json({ ok: true, cleared: key });
});

// Main endpoint
app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  const nocache = req.query.nocache === '1' || req.query.nocache === 'true';
  const debug = req.query.debug === '1' || req.query.debug === 'true';

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const cacheKey = `u:${userId}`;
  const cached = cache[cacheKey];
  if (!nocache && cached && (Date.now() - cached.ts) < CACHE_TTL) {
    // return cached quickly
    return res.json({ totalValue: cached.value, source: "cache" });
  }

  const result = await tryRolimonsEndpoints(userId);
  if (!result) {
    return res.status(502).json({ error: "No usable Rolimons response", totalValue: 0 });
  }

  if (result.totalValue && typeof result.totalValue === "number") {
    cache[cacheKey] = { value: result.totalValue, ts: Date.now(), source: result.source };
    return res.json({ totalValue: result.totalValue, source: result.source });
  }

  // Couldn't extract clean numeric value.
  const rawSnippet = result.rawHtml || result.rawJson || null;
  if (debug) {
    return res.json({
      totalValue: 0,
      source: result.source,
      note: "Could not automatically extract numeric totalValue. rawSnippet included for debugging.",
      rawSnippet: (typeof rawSnippet === 'string') ? rawSnippet.slice(0,20000) : rawSnippet
    });
  }

  // store null result to avoid rapid retries, but keep value=0
  cache[cacheKey] = { value: 0, ts: Date.now(), source: result.source };
  return res.json({
    totalValue: 0,
    source: result.source,
    note: "Could not extract totalValue automatically."
  });
});

app.get("/", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`AvatarValueProxy (improved) listening on port ${PORT}`));

