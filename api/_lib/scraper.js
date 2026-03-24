// Shared Telegram scraper with warm-instance cache
const CHANNEL_NAME = process.env.TELEGRAM_CHANNEL || 'beforeredalert';

let cache = { alerts: [], timestamp: 0, scrapeTime: null };
const CACHE_TTL = 4000; // 4 seconds (client polls every 3s)

function parseAlertMessage(text) {
    const isMissileAlert =
        /missile|rocket|launch|ballistic|incoming|threat|alert|צבע אדום|טיל|שיגור|אזעקה|ירי|רקטות|חדירה|🚀|🚨|⚠️/i.test(text);

    let origin = 'Unknown';
    if (/iran|tehran|טהרן|איראן/i.test(text)) origin = 'Iran';
    else if (/yemen|houthi|תימן|חות/i.test(text)) origin = 'Yemen';
    else if (/iraq|עיראק/i.test(text)) origin = 'Iraq';
    else if (/lebanon|hezbollah|לבנון|חיזבאללה/i.test(text)) origin = 'Lebanon';
    else if (/gaza|hamas|עזה|חמאס/i.test(text)) origin = 'Gaza';
    else if (/syria|סוריה/i.test(text)) origin = 'Syria';

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

    let etaMinutes = null;
    const etaMatch = text.match(/(\d+)\s*(?:min|minutes|דקות)/i);
    if (etaMatch) etaMinutes = parseInt(etaMatch[1]);
    const secMatch = text.match(/(\d+)\s*(?:שניות|seconds|sec)/i);
    if (!etaMinutes && secMatch) etaMinutes = Math.ceil(parseInt(secMatch[1]) / 60);

    let count = 1;
    const countMatch = text.match(/(\d+)\s*(?:missiles?|rockets?|טילים|רקטות)/i);
    if (countMatch) count = parseInt(countMatch[1]);

    const isIntercepted = /יורט|intercept|הופל|נחסם|כיפת ברזל|חץ|iron dome|arrow|shot down|neutralized/i.test(text);

    return { isMissileAlert, isIntercepted, origin, target, etaMinutes, count, rawText: text };
}

async function scrapeChannel() {
    // Return cache if fresh
    if (cache.alerts.length > 0 && (Date.now() - cache.timestamp) < CACHE_TTL) {
        return cache;
    }

    try {
        const url = `https://t.me/s/${CHANNEL_NAME}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
            },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();

        const messages = [];
        const msgRegex = /data-post="([^"]+)"[\s\S]*?<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
        let match;

        while ((match = msgRegex.exec(html)) !== null) {
            const postId = match[1];
            let text = match[2]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&nbsp;/g, ' ')
                .trim();

            if (text && postId) messages.push({ postId, text });
        }

        const timeRegex = /data-post="([^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/g;
        const timestamps = {};
        while ((match = timeRegex.exec(html)) !== null) {
            timestamps[match[1]] = new Date(match[2]).getTime();
        }

        const alerts = messages.map(msg => ({
            id: msg.postId,
            timestamp: timestamps[msg.postId] || Date.now(),
            source: `telegram:@${CHANNEL_NAME}`,
            raw: msg.text,
            parsed: parseAlertMessage(msg.text),
            postUrl: `https://t.me/${msg.postId}`,
        }));

        cache = { alerts, timestamp: Date.now(), scrapeTime: Date.now() };
        return cache;
    } catch (err) {
        // Return stale cache on error
        if (cache.alerts.length > 0) return cache;
        return { alerts: [], timestamp: Date.now(), scrapeTime: null, error: err.message };
    }
}

module.exports = { scrapeChannel, parseAlertMessage, CHANNEL_NAME };
