// index.js - Rolimons proxy (sums limiteds + ugc limiteds)
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const cache = {};

async function fetchPlayerPage(userId) {
  const url = `https://www.rolimons.com/player/${userId}`;
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { "User-Agent": "AvatarValueProxy/limsum" },
    validateStatus: null,
  });
  return { url, status: resp.status, html: resp.data };
}

function extractInventoryJson(html) {
  // Find <script> that initializes window variables
  const match = html.match(/window\.profile\s*=\s*(\{.*?\});/s);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (e) {
    console.error("JSON parse failed:", e.message);
    return null;
  }
}

function sumInventoryValue(profileJson) {
  if (!profileJson || !profileJson.inventory_data) return 0;

  let total = 0;
  const items = profileJson.inventory_data;

  for (const [assetId, item] of Object.entries(items)) {
    // Rolimons gives value under "value" or "rap"
    if (item.value && typeof item.value === "number") {
      total += item.value;
    } else if (item.rap && typeof item.rap === "number") {
      total += item.rap;
    }
  }

  return total;
}

app.get("/avatarValue", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const key = `u:${userId}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ totalValue: cached.value, source: "cache" });
  }

  try {
    const page = await fetchPlayerPage(userId);
    if (page.status !== 200) {
      return res.status(502).json({ error: "Rolimons fetch failed", status: page.status });
    }

    const profileJson = extractInventoryJson(page.html);
    if (!profileJson) {
      return res.status(500).json({ error: "Could not extract inventory JSON" });
    }

    const total = sumInventoryValue(profileJson);
    cache[key] = { value: total, ts: Date.now() };

    return res.json({ totalValue: total, source: page.url });
  } catch (e) {
    return res.status(500).json({ error: "Server error", reason: e.message });
  }
});

app.get("/", (req, res) =>
  res.json({ ok: true, msg: "rolimons-proxy inventory summing alive" })
);

app.listen(PORT, () =>
  console.log("rolimons-proxy listening on port", PORT)
);

