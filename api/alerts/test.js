const { parseAlertMessage } = require('../_lib/scraper');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const message = (req.body && req.body.message) || '🚨 TEST: ירי טילים מאיראן לעבר ישראל';
    const testAlert = {
        id: Date.now(),
        timestamp: Date.now(),
        source: 'manual-test',
        raw: message,
        parsed: parseAlertMessage(message),
    };

    res.json({ ok: true, alert: testAlert });
};
