// Shared Telegram scraper with warm-instance cache
const CHANNEL_NAME = process.env.TELEGRAM_CHANNEL || 'beforeredalert';

let cache = { alerts: [], timestamp: 0, scrapeTime: null };
const CACHE_TTL = 4000; // 4 seconds (client polls every 3s)

function stripFooter(text) {
    return text
        .replace(/\u200f/g, '')
        .replace(/\n?\.?\s*🚨לקבלת עדכונים על שיגורים.*$/s, '')
        .replace(/\n?\.?\s*🚨.*פקער.*$/s, '')
        .replace(/https?:\/\/t\.me\/[^\s]*/g, '')
        .replace(/Forwarded from .*/i, '')
        .trim();
}

function isSpamMessage(cleanText, fullText) {
    if (/מחסנים|מחירי|מלאי|הזמנה|פרסום|פרסומות|#תוכןשיווקי|עליאקספרס|בוט|הצטרפו|עוקבים יקרים/i.test(cleanText)) return true;
    if (/ערוץ.*חדשות|ערוץ שלנו|ליצירת קשר/i.test(cleanText)) return true;
    if (cleanText.length > 120) return true;
    if (/^Forwarded from/i.test(fullText)) return true;
    return false;
}

function parseAlertMessage(text) {
    const cleanText = stripFooter(text);

    const spam = isSpamMessage(cleanText, text);
    if (spam) {
        return { isMissileAlert: false, isIntercepted: false, isRelevant: false, origin: null, target: null, etaMinutes: null, count: 0, cleanText };
    }

    const alertKeywords = /שיגור|טיל|מצרר|ירי|רקט|אזעקה|מתחיל|זוהו|מיקוד|חדירה|missile|rocket|launch|ballistic|incoming/i;
    const isMissileAlert = alertKeywords.test(cleanText);

    const isEtaMessage = /דקות|דקה|שניות|min/i.test(cleanText) && cleanText.length < 40;
    const isTargetMessage = /אילת|מרכז|נגב|דימונה|צפון|דרום/i.test(cleanText) && cleanText.length < 40;

    const isRelevant = isMissileAlert || isEtaMessage || isTargetMessage;

    const isIntercepted = /יורט|הופל|נחסם|כיפת ברזל|חץ|iron dome|arrow|intercept|shot down|neutralized/i.test(cleanText);

    let origin = 'Unknown';
    if (/iran|tehran|טהרן|איראן/i.test(cleanText)) origin = 'Iran';
    else if (/yemen|houthi|תימן|חות/i.test(cleanText)) origin = 'Yemen';
    else if (/iraq|עיראק/i.test(cleanText)) origin = 'Iraq';
    else if (/lebanon|hezbollah|לבנון|חיזבאללה/i.test(cleanText)) origin = 'Lebanon';
    else if (/gaza|hamas|עזה|חמאס/i.test(cleanText)) origin = 'Gaza';
    else if (/syria|סוריה/i.test(cleanText)) origin = 'Syria';

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

    let etaMinutes = null;
    const etaMatch = cleanText.match(/(\d+\.?\d*)\s*(?:min|minutes|דקות)/i);
    if (etaMatch) etaMinutes = parseFloat(etaMatch[1]);
    if (!etaMinutes && /פחות ?מ?(\d+\.?\d*)/.test(cleanText)) {
        etaMinutes = parseFloat(cleanText.match(/פחות ?מ?(\d+\.?\d*)/)[1]);
    }
    if (!etaMinutes && /חצי דקה/i.test(cleanText)) etaMinutes = 0.5;

    let count = 1;
    const countMatch = cleanText.match(/(\d+)\s*(?:missiles?|rockets?|טילים|רקטות|מצררים|טילי)/i);
    if (countMatch) count = parseInt(countMatch[1]);

    return { isMissileAlert: isRelevant, isIntercepted, isRelevant, origin, target, etaMinutes, count, cleanText };
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
