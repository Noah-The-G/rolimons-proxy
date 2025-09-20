// index.js - minimal safe proxy starter
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

// Root route (so visiting the bare URL doesn't show "Cannot GET /")
app.get('/', (req, res) => {
  res.json({ ok: true, msg: 'rolimons-proxy alive' });
});

// Simple avatarValue endpoint (safe, returns cached/placeholder or calls Rolimons)
app.get('/avatarValue', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  // Quick, safe request to Rolimons HTML page (no heavy parsing here)
  try {
    const url = `https://www.rolimons.com/player/${userId}`;
    const resp = await axios.get(url, { timeout: 8000, validateStatus: null });
    if (resp.status === 200 && resp.data) {
      // Minimal extract: look for first number-like chunk as a fallback
      const body = String(resp.data);
      const match = body.match(/([\d]{2,3}(?:[,.\s]\d{3})*)/);
      const found = match ? match[1].replace(/[,\s]/g, '') : null;
      const totalValue = found ? parseInt(found, 10) : 0;
      return res.json({ totalValue: totalValue || 0, source: url });
    } else {
      return res.json({ totalValue: 0, source: url, note: 'Rolimons returned non-200' });
    }
  } catch (err) {
    return res.json({ totalValue: 0, error: 'fetch failed', reason: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`rolimons-proxy listening on port ${PORT}`);
});

