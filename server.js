const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const cache = {};

async function getRolimonsValue(userId) {
    // Here you would fetch Rolimons data
    // For now, return a unique dummy value per user:
    return 1000 + Number(userId) % 1000; 
}

app.get('/avatarValue', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.json({ totalValue: 0 });

    // Check cache
    if (cache[userId] && Date.now() - cache[userId].ts < 60 * 1000) {
        return res.json({ totalValue: cache[userId].value, source: 'cache' });
    }

    const totalValue = await getRolimonsValue(userId);
    cache[userId] = { value: totalValue, ts: Date.now() };

    res.json({ totalValue, source: 'fresh' });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
