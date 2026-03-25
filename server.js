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

// Strip the standard channel footer that appears in every message
function stripFooter(text) {
    return text
        .replace(/\u200f/g, '')  // remove RTL marks
        .replace(/\n?\.?\s*🚨לקבלת עדכונים על שיגורים.*$/s, '')
        .replace(/\n?\.?\s*🚨.*פקער.*$/s, '')
        .replace(/https?:\/\/t\.me\/[^\s]*/g, '')
        .replace(/Forwarded from .*/i, '')
        .trim();
}

// Check if a message is spam/promo rather than a real alert
function isSpamMessage(cleanText, fullText) {
    // Ads/promos keywords
    if (/מחסנים|מחירי|מלאי|הזמנה|פרסום|פרסומות|#תוכןשיווקי|עליאקספרס|בוט|הצטרפו|עוקבים יקרים/i.test(cleanText)) return true;
    // Channel promo: join our channel
    if (/ערוץ.*חדשות|ערוץ שלנו|ליצירת קשר/i.test(cleanText)) return true;
    // Very long text (real alerts are short, ads are long)
    if (cleanText.length > 120) return true;
    // Contains only a forwarded tag
    if (/^Forwarded from/i.test(fullText)) return true;
    return false;
}

function parseAlertMessage(text) {
    const cleanText = stripFooter(text);

    // First: is this spam?
    const spam = isSpamMessage(cleanText, text);
    if (spam) {
        return { isMissileAlert: false, isIntercepted: false, isRelevant: false, origin: null, target: null, etaMinutes: null, count: 0, cleanText };
    }

    // Real alert keywords on the CLEAN text (not footer which always has 🚀🚨)
    const alertKeywords = /שיגור|טיל|מצרר|ירי|רקט|אזעקה|מתחיל|זוהו|מיקוד|חדירה|missile|rocket|launch|ballistic|incoming/i;
    const isMissileAlert = alertKeywords.test(cleanText);

    // ETA keywords (these are standalone messages like "חצי דקה" or "5 דקות")
    const isEtaMessage = /דקות|דקה|שניות|min/i.test(cleanText) && cleanText.length < 40;

    // Target names are also standalone alerts: "אילת.." "גם מרכז.."
    const isTargetMessage = /אילת|מרכז|נגב|דימונה|צפון|דרום/i.test(cleanText) && cleanText.length < 40;

    const isRelevant = isMissileAlert || isEtaMessage || isTargetMessage;

    // Detect interception
    const isIntercepted = /יורט|הופל|נחסם|כיפת ברזל|חץ|iron dome|arrow|intercept|shot down|neutralized/i.test(cleanText);

    // Detect origin
    let origin = 'Unknown';
    if (/iran|tehran|טהרן|איראן/i.test(cleanText)) origin = 'Iran';
    else if (/yemen|houthi|תימן|חות/i.test(cleanText)) origin = 'Yemen';
    else if (/iraq|עיראק/i.test(cleanText)) origin = 'Iraq';
    else if (/lebanon|hezbollah|לבנון|חיזבאללה/i.test(cleanText)) origin = 'Lebanon';
    else if (/gaza|hamas|עזה|חמאס/i.test(cleanText)) origin = 'Gaza';
    else if (/syria|סוריה/i.test(cleanText)) origin = 'Syria';

    // Detect target
    let target = 'Israel';
    if (/tel.?aviv|תל.?אביב|גוש.?דן/i.test(cleanText)) target = 'Tel Aviv';
    else if (/jerusalem|ירושלים/i.test(cleanText)) target = 'Jerusalem';
    else if (/haifa|חיפה/i.test(cleanText)) target = 'Haifa';
    else if (/beer.?sheva|באר.?שבע|נגב/i.test(cleanText)) target = 'Beer Sheva';
    else if (/eilat|אילת/i.test(cleanText)) target = 'Eilat';
    else if (/דימונה/i.test(cleanText)) target = 'Dimona';
    else if (/מרכז|שרון|שפלה/i.test(cleanText)) target = 'Central Israel';
    else if (/צפון|גליל/i.test(cleanText)) target = 'Northern Israel';
    else if (/דרום/i.test(cleanText)) target = 'Southern Israel';

    // Extract ETA — handle "5.5 דקות", "פחות מ2 דקות", "חצי דקה"
    let etaMinutes = null;
    const etaMatch = cleanText.match(/(\d+\.?\d*)\s*(?:min|minutes|דקות)/i);
    if (etaMatch) etaMinutes = parseFloat(etaMatch[1]);
    if (!etaMinutes && /פחות ?מ?(\d+\.?\d*)/.test(cleanText)) {
        etaMinutes = parseFloat(cleanText.match(/פחות ?מ?(\d+\.?\d*)/)[1]);
    }
    if (!etaMinutes && /חצי דקה/i.test(cleanText)) etaMinutes = 0.5;

    // Count
    let count = 1;
    const countMatch = cleanText.match(/(\d+)\s*(?:missiles?|rockets?|טילים|רקטות|מצררים|טילי)/i);
    if (countMatch) count = parseInt(countMatch[1]);

    return { isMissileAlert: isRelevant, isIntercepted, isRelevant, origin, target, etaMinutes, count, cleanText };
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
    console.log('║        🚀 Rocket Tracker — Server                 ║');
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
