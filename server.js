const express = require('express');
const cors = require('cors');
const path = require('path');

// ─── CONFIG ───
const PORT = process.env.PORT || 3001;
const CHANNEL_NAME = process.env.TELEGRAM_CHANNEL || 'beforeredalert';
const SCRAPE_INTERVAL_MS = 5000; // check every 5 seconds

// ─── STATE ───
const alerts = [];
const MAX_ALERTS = 200;
const seenMessageIds = new Set();
let lastScrapeTime = null;
let scrapeErrors = 0;
let totalScrapes = 0;
let initialLoadDone = false;

// ─── EXPRESS SERVER ───
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// API: Get alerts
app.get('/api/alerts', (req, res) => {
    const since = req.query.since ? parseInt(req.query.since) : 0;
    const filtered = alerts.filter(a => a.timestamp > since);
    res.json({
        alerts: filtered,
        total: alerts.length,
        connected: lastScrapeTime !== null,
        channelName: CHANNEL_NAME,
        lastScrape: lastScrapeTime,
        scrapeErrors,
    });
});

// API: Get latest alert
app.get('/api/alerts/latest', (req, res) => {
    if (alerts.length === 0) {
        return res.json({ alert: null });
    }
    res.json({ alert: alerts[alerts.length - 1] });
});

// API: Post a manual test alert
app.post('/api/alerts/test', (req, res) => {
    const testAlert = {
        id: Date.now(),
        timestamp: Date.now(),
        source: 'manual-test',
        raw: req.body.message || '🚨 TEST: ירי טילים מאיראן לעבר ישראל',
        parsed: parseAlertMessage(req.body.message || '🚨 TEST: ירי טילים מאיראן לעבר ישראל'),
    };
    addAlert(testAlert);
    res.json({ ok: true, alert: testAlert });
});

// API: Server status
app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        mode: 'telegram-scrape',
        channelName: CHANNEL_NAME,
        channelUrl: `https://t.me/s/${CHANNEL_NAME}`,
        alertCount: alerts.length,
        seenMessages: seenMessageIds.size,
        lastScrape: lastScrapeTime,
        scrapeErrors,
        totalScrapes,
        uptime: process.uptime(),
    });
});

// ─── ALERT PARSING ───
function parseAlertMessage(text) {
    const isMissileAlert =
        /missile|rocket|launch|ballistic|incoming|threat|alert|צבע אדום|טיל|שיגור|אזעקה|ירי|רקטות|חדירה|🚀|🚨|⚠️/i.test(text);

    // Detect origin
    let origin = 'Unknown';
    if (/iran|tehran|טהרן|איראן/i.test(text)) origin = 'Iran';
    else if (/yemen|houthi|תימן|חות/i.test(text)) origin = 'Yemen';
    else if (/iraq|עיראק/i.test(text)) origin = 'Iraq';
    else if (/lebanon|hezbollah|לבנון|חיזבאללה/i.test(text)) origin = 'Lebanon';
    else if (/gaza|hamas|עזה|חמאס/i.test(text)) origin = 'Gaza';
    else if (/syria|סוריה/i.test(text)) origin = 'Syria';

    // Detect target
    let target = 'Israel';
    if (/tel.?aviv|תל.?אביב|גוש.?דן/i.test(text)) target = 'Tel Aviv';
    else if (/jerusalem|ירושלים/i.test(text)) target = 'Jerusalem';
    else if (/haifa|חיפה/i.test(text)) target = 'Haifa';
    else if (/beer.?sheva|באר.?שבע|נגב/i.test(text)) target = 'Beer Sheva';
    else if (/eilat|אילת/i.test(text)) target = 'Eilat';
    else if (/ashkelon|אשקלון/i.test(text)) target = 'Ashkelon';
    else if (/ashdod|אשדוד/i.test(text)) target = 'Ashdod';
    else if (/netanya|נתניה/i.test(text)) target = 'Netanya';
    else if (/rishon|ראשון/i.test(text)) target = 'Rishon LeZion';
    else if (/center|מרכז|שרון|שפלה/i.test(text)) target = 'Central Israel';
    else if (/north|צפון|גליל/i.test(text)) target = 'Northern Israel';
    else if (/south|דרום/i.test(text)) target = 'Southern Israel';

    // Extract ETA
    let etaMinutes = null;
    const etaMatch = text.match(/(\d+)\s*(?:min|minutes|דקות)/i);
    if (etaMatch) etaMinutes = parseInt(etaMatch[1]);
    const secMatch = text.match(/(\d+)\s*(?:שניות|seconds|sec)/i);
    if (!etaMinutes && secMatch) etaMinutes = Math.ceil(parseInt(secMatch[1]) / 60);

    // Count
    let count = 1;
    const countMatch = text.match(/(\d+)\s*(?:missiles?|rockets?|טילים|רקטות)/i);
    if (countMatch) count = parseInt(countMatch[1]);

    // Detect interception
    const isIntercepted = /יורט|intercept|הופל|נחסם|כיפת ברזל|חץ|iron dome|arrow|shot down|neutralized/i.test(text);

    return { isMissileAlert, isIntercepted, origin, target, etaMinutes, count, rawText: text };
}

function addAlert(alert) {
    alerts.push(alert);
    if (alerts.length > MAX_ALERTS) alerts.shift();

    // Only log new messages after initial load
    if (initialLoadDone) {
        console.log(`\n🚨 NEW ALERT [${new Date(alert.timestamp).toLocaleTimeString()}]`);
        console.log(`   Origin: ${alert.parsed.origin} → Target: ${alert.parsed.target}`);
        console.log(`   Missile alert: ${alert.parsed.isMissileAlert}`);
        if (alert.parsed.etaMinutes) console.log(`   ETA: ${alert.parsed.etaMinutes} min`);
        console.log(`   Text: ${alert.raw.substring(0, 120)}`);
    }
}

// ─── TELEGRAM PUBLIC CHANNEL SCRAPER ───
async function scrapeChannel() {
    totalScrapes++;
    try {
        const url = `https://t.me/s/${CHANNEL_NAME}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        lastScrapeTime = Date.now();

        // Parse messages from the HTML
        const messages = [];

        // Extract message blocks — each has data-post="channelname/12345"
        const msgRegex = /data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
        let match;

        while ((match = msgRegex.exec(html)) !== null) {
            const postId = match[1]; // e.g. "beforeredalert/12345"
            let messageHtml = match[2];

            // Strip HTML tags to get plain text
            let text = messageHtml
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&nbsp;/g, ' ')
                .trim();

            if (text && postId) {
                messages.push({ postId, text });
            }
        }

        // Extract timestamps
        const timeRegex = /data-post="([^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/g;
        const timestamps = {};
        while ((match = timeRegex.exec(html)) !== null) {
            timestamps[match[1]] = new Date(match[2]).getTime();
        }

        // Process new messages
        let newCount = 0;
        for (const msg of messages) {
            if (!seenMessageIds.has(msg.postId)) {
                seenMessageIds.add(msg.postId);
                newCount++;

                const alert = {
                    id: msg.postId,
                    timestamp: timestamps[msg.postId] || Date.now(),
                    source: `telegram:@${CHANNEL_NAME}`,
                    raw: msg.text,
                    parsed: parseAlertMessage(msg.text),
                    postUrl: `https://t.me/${msg.postId}`,
                };

                addAlert(alert);
            }
        }

        if (!initialLoadDone) {
            initialLoadDone = true;
            console.log(`✅ Initial load: found ${messages.length} messages, ${seenMessageIds.size} indexed`);
            if (alerts.length > 0) {
                console.log(`📋 Latest message: "${alerts[alerts.length - 1].raw.substring(0, 80)}..."`);
            }
        } else if (newCount > 0) {
            console.log(`📡 ${newCount} new message(s) from @${CHANNEL_NAME}`);
        }

        scrapeErrors = 0;

    } catch (err) {
        scrapeErrors++;
        if (scrapeErrors <= 3 || scrapeErrors % 20 === 0) {
            console.error(`❌ Scrape error (#${scrapeErrors}): ${err.message}`);
        }
    }
}

// ─── START ───
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║        🚀 Wolt Rocket Tracker — Server           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Web UI:    http://localhost:${PORT}                  ║`);
    console.log(`║  API:       http://localhost:${PORT}/api              ║`);
    console.log(`║  Status:    http://localhost:${PORT}/api/status       ║`);
    console.log(`║  Channel:   https://t.me/s/${CHANNEL_NAME.padEnd(21)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`📡 Scraping @${CHANNEL_NAME} every ${SCRAPE_INTERVAL_MS / 1000}s...\n`);

    // Initial scrape
    scrapeChannel();

    // Periodic scrape
    setInterval(scrapeChannel, SCRAPE_INTERVAL_MS);
});
