// index.js - Rolimons proxy (improved 2.0 - structured JSON + labeled-neighborhood extraction + debug)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

const cache = {};

const ENDPOINTS = [
  id => `https://api.rolimons.com/player/${id}`,
  id => `https://www.rolimons.com/api/player/${id}`,
  id => `https://www.rolimons.com/player/${id}`,
  id => `https://www.rolimons.com/ajax/player/${id}`
];

function normNumberString(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/[^\d,.\s\u00A0]/g, "").trim();
  if (!cleaned) return null;
  let tmp = cleaned.replace(/\u00A0/g, "").replace(/\s+/g, "");
  tmp = tmp.replace(/,/g, "");
  // remove multiple dots
  if ((tmp.match(/\./g) || []).length > 1) tmp = tmp.replace(/\./g, "");
  const n = parseInt(tmp, 10);
  return Number.isFinite(n) ? n : null;
}

function searchJsonRec(obj) {
  if (obj == null) return [];
  const out = [];
  if (typeof obj === "number" && Number.isFinite(obj)) out.push(obj);
  if (typeof obj === "string") {
    const n = normNumberString(obj);
    if (n !== null) out.push(n);
  }
  if (typeof obj === "object") {
    // prefer keys that look like value/total/account/robux
    const keys = Object.keys(obj || {});
    for (const k of keys) {
      try {
        if (/value|total|account|worth|robux|inventory|price/i.test(k)) {
          out.push(...searchJsonRec(obj[k]));
        }
      } catch(e){}
    }
    // fallback scan
    for (const k of keys) {
      try { out.push(...searchJsonRec(obj[k])); } catch(e){}
    }
  }
  return out;
}

function extractFromHtml(html) {
  const $ = cheerio.load(html || "");
  const candidates = [];

  // 1) try structured JSON first: __NEXT_DATA__ or ld+json
  try {
    const next = $("#__NEXT_DATA__");
    if (next && next.length) {
      const js = JSON.parse(next.text());
      candidates.push(...searchJsonRec(js));
    }
  } catch (e){}

  $("script[type='application/ld+json']").each((i, el) => {
    try {
      const js = JSON.parse($(el).text());
      candidates.push(...searchJsonRec(js));
    } catch(e){}
  });

  // 2) other <script> blocks that contain JSON-like blobs
  $("script").each((i, el) => {
    try {
      const txt = $(el).html() || "";
      if (txt.length > 50 && (/value|player|account|inventory|robux/i.test(txt))) {
        // try to extract JSON object inside
        const m = txt.match(/(\{[\s\S]*\})/m);
        if (m && m[1]) {
          try {
            const j = JSON.parse(m[1]);
            candidates.push(...searchJsonRec(j));
          } catch(e){}
        }
      }
    } catch(e){}
  });

  // 3) labeled neighborhood scan: look for nodes with label text then nearby numbers
  const labelRx = /(?:Total Value|Inventory Value|Account Value|Value Worth|Value|Worth|Robux)/i;
  $("*").each((i, el) => {
    try {
      const text = $(el).text() || "";
      if (labelRx.test(text)) {
        // search the element and immediate siblings for numeric fragments
        const neighborhood = ($(el).text() || "") + " " + ($(el).next().text() || "") + " " + ($(el).parent().text() || "");
        const matches = neighborhood.match(/[\d][\d,.\s\u00A0]{0,20}/g) || [];
        for (const m of matches) {
          const n = normNumberString(m);
          if (n !== null) candidates.push(n);
        }
      }
    } catch(e){}
  });

  // 4) fallback: collect all number-like substrings from body and return top candidates
  const bodyText = $("body").text() || "";
  const allMatches = (bodyText.match(/[\d][\d,.\s\u00A0]{1,}/g) || []).map(normNumberString).filter(Boolean);
  candidates.push(...allMatches);

  // dedupe and sort by value desc
  const uniq = Array.from(new Set(candidates.filter(x => typeof x === "number" && x >= 0)));
  uniq.sort((a,b) => b - a);
  return uniq; // ranked list of candidates (largest first)
}

async function fetchFromRolimons(userId) {
  for (let i=0;i<ENDPOINTS.length;i++) {
    const url = ENDPOINTS[i](userId);
    try {
      const resp = await axios.get(url, { timeout: 10000, validateStatus: null, headers: { 'User-Agent': 'AvatarValueProxy/2.0' } });
      const ct = (resp.headers['content-type'] || "").toLowerCase();
      if (resp.status === 200 && ct.includes("application/json")) {
        const data = resp.data;
        const nums = searchJsonRec(data);
        if (nums.length) {
          nums.sort((a,b)=>b-a);
          return { total: nums[0], source: url, candidates: nums };
        } else {
          return { total: null, source: url, rawJson: data };
        }
      } else if (resp.status === 200 && ct.includes("text/html")) {
        const html = resp.data;
        const candidates = extractFromHtml(html);
        if (candidates && candidates.length) {
          return { total: candidates[0], source: url, candidates, rawSnippet: html.slice(0,20000) };
        } else {
          return { total: null, source: url, rawSnippet: html.slice(0,20000) };
        }
      }
    } catch (e) {
      // try next endpoint
      continue;
    }
  }
  return null;
}

app.get("/clearCache", (req, res) => {
  const id = req.query.userId;
  if (!id) return res.status(400).json({ error: "Missing userId" });
  const key = `u:${id}`;
  delete cache[key];
  return res.json({ ok:true, cleared: key });
});

app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  const nocache = req.query.nocache === "1" || req.query.nocache === "true";
  const debug = req.query.debug === "1" || req.query.debug === "true";

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const key = `u:${userId}`;
  if (!nocache && cache[key] && (Date.now() - cache[key].ts) < CACHE_TTL) {
    const c = cache[key];
    return res.json({ totalValue: c.value, source: c.source, cached: true });
  }

  const result = await fetchFromRolimons(userId);
  if (!result) {
    return res.status(502).json({ totalValue: 0, source: null, note: "No usable response" });
  }

  if (result.total !== null && typeof result.total === "number") {
    cache[key] = { value: result.total, ts: Date.now(), source: result.source };
    const out = { totalValue: result.total, source: result.source };
    if (debug) { out.candidates = result.candidates || []; if (result.rawSnippet) out.rawSnippet = result.rawSnippet; }
    return res.json(out);
  }

  // couldn't find numeric
  cache[key] = { value: 0, ts: Date.now(), source: result.source };
  const out = { totalValue: 0, source: result.source, note: "Could not extract numeric value" };
  if (debug) out.rawSnippet = result.rawSnippet || result.rawJson;
  return res.json(out);
});

app.get("/", (req, res) => res.json({ ok: true, msg: "rolimons-proxy v2 alive" }));

app.listen(PORT, ()=> console.log("rolimons-proxy v2 listening on port", PORT));

