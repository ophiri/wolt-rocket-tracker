const { scrapeChannel } = require('./_lib/scraper');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const data = await scrapeChannel();
        const since = req.query.since ? parseInt(req.query.since) : 0;
        const filtered = data.alerts.filter(a => a.timestamp > since);

        res.json({
            alerts: filtered,
            total: data.alerts.length,
            connected: data.scrapeTime !== null,
            channelName: 'beforeredalert',
            lastScrape: data.scrapeTime,
            scrapeErrors: 0,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
