const { scrapeChannel, CHANNEL_NAME } = require('./_lib/scraper');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const data = await scrapeChannel();
        res.json({
            ok: true,
            mode: 'vercel-serverless',
            channelName: CHANNEL_NAME,
            channelUrl: `https://t.me/s/${CHANNEL_NAME}`,
            alertCount: data.alerts.length,
            lastScrape: data.scrapeTime,
            cached: (Date.now() - data.timestamp) < 4000,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
