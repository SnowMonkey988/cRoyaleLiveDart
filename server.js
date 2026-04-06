/**
 * China Royale Travels — Telegram Live Chat Backend
 * 
 * HOW IT WORKS:
 * 1. A visitor types in the chat widget on the website.
 * 2. The message is POSTed to this server → forwarded to your Telegram bot.
 * 3. Your admin reads and replies inside Telegram.
 * 4. This server receives the reply via webhook → stores it for the visitor.
 * 5. The website polls every 2.5s for new replies and displays them.
 *
 * SETUP STEPS:
 * 1. Create a Telegram bot via @BotFather → copy the Bot Token.
 * 2. Create a Telegram group for your support team → add the bot to it.
 * 3. Get the Group Chat ID (send a message to the group, then visit:
 *    https://api.telegram.org/bot<TOKEN>/getUpdates to find the chat.id).
 * 4. Fill in BOT_TOKEN, ADMIN_CHAT_ID, and WEBHOOK_SECRET below.
 * 5. Deploy this server (Railway, Render, Fly.io, or any Node host).
 * 6. Register the webhook: GET /setup-webhook (do this once after deploy).
 * 7. Update CHAT_API_URL in js/main.js with your deployed server URL.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ── CONFIGURATION ──────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.BOT_TOKEN      || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID  || 'YOUR_GROUP_OR_CHAT_ID';  // number as string e.g. '-1001234567890'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_this_to_a_random_secret';
const PORT           = process.env.PORT           || 3000;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '*').replace(/\/+$/, '');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// ───────────────────────────────────────────────────────────────────────────

app.options('*', cors());

// CORS — only allow your website origin in production
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // server-to-server / curl
    const normOrigin = origin.replace(/\/+$/, '');
    if (ALLOWED_ORIGIN === '*' || normOrigin === ALLOWED_ORIGIN) {
      return callback(null, true);
    }
    return callback(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST'],
  optionsSuccessStatus: 200
}));

/**
 * In-memory session store.
 * Structure: Map<sessionId, { telegramMessageId, replies: [{id, text, timestamp}], replyCounter }>
 * Note: This resets on server restart. For persistence, replace with a database (SQLite, Redis, etc.)
 */
const sessions = new Map();
// Map telegram message_id → sessionId (for routing replies)
const telegramMsgToSession = new Map();

// ── HELPERS ────────────────────────────────────────────────────────────────

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { telegramMessageId: null, replies: [], replyCounter: 0 });
  }
  return sessions.get(sessionId);
}

/**
 * Extract the real visitor IP, accounting for Railway's reverse proxy.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can be a comma-separated list; first entry is the client
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Parse OS and browser name from a User-Agent string without dependencies.
 */
function parseUserAgent(ua) {
  if (!ua) return { os: 'Unknown', browser: 'Unknown' };

  let os = 'Unknown';
  if (/Windows NT 10/i.test(ua))      os = 'Windows 10/11';
  else if (/Windows NT 6.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6.1/i.test(ua)) os = 'Windows 7';
  else if (/Windows/i.test(ua))        os = 'Windows';
  else if (/iPhone OS ([\.\d]+)/i.test(ua)) os = 'iOS ' + ua.match(/iPhone OS ([\.\d]+)/i)[1].replace(/_/g, '.');
  else if (/iPad.*OS ([\.\d]+)/i.test(ua))  os = 'iPadOS ' + ua.match(/iPad.*OS ([\.\d]+)/i)[1].replace(/_/g, '.');
  else if (/Android ([\d\.]+)/i.test(ua))   os = 'Android ' + ua.match(/Android ([\d\.]+)/i)[1];
  else if (/Mac OS X ([\d_\.]+)/i.test(ua)) os = 'macOS ' + ua.match(/Mac OS X ([\d_\.]+)/i)[1].replace(/_/g, '.');
  else if (/Linux/i.test(ua))          os = 'Linux';

  let browser = 'Unknown';
  if (/Edg\//i.test(ua))              browser = 'Edge ' + (ua.match(/Edg\/([\d\.]+)/i)||[])[1];
  else if (/OPR\//i.test(ua))         browser = 'Opera ' + (ua.match(/OPR\/([\d\.]+)/i)||[])[1];
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Browser ' + (ua.match(/SamsungBrowser\/([\d\.]+)/i)||[])[1];
  else if (/Chrome\/([\d\.]+)/i.test(ua) && !/Chromium/i.test(ua))
                                       browser = 'Chrome ' + ua.match(/Chrome\/([\d\.]+)/i)[1];
  else if (/Firefox\/([\d\.]+)/i.test(ua)) browser = 'Firefox ' + ua.match(/Firefox\/([\d\.]+)/i)[1];
  else if (/Safari\/([\d\.]+)/i.test(ua))  browser = 'Safari ' + (ua.match(/Version\/([\d\.]+)/i)||[])[1];
  else if (/Chromium/i.test(ua))       browser = 'Chromium';

  return { os, browser };
}

/**
 * Geolocate an IP using the free ip-api.com service (no API key needed).
 * Returns an object with city, region, country, isp, org, timezone, etc.
 */
async function geolocateIp(ip) {
  // Skip private/loopback addresses
  if (!ip || ip === 'unknown' || /^(127\.|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) {
    return { status: 'private', country: 'Local/Private', city: '-', isp: '-', timezone: '-', org: '-' };
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/**
 * Build the rich Telegram header card shown on the first visitor message.
 */
function buildVisitorCard(sessionId, firstMessage, clientIp, geo, vi) {
  const { os, browser } = parseUserAgent(vi ? vi.userAgent : null);

  const geoLine = geo && geo.status === 'success'
    ? `🌍 <b>Location:</b> ${geo.city}, ${geo.regionName}, ${geo.country} (${geo.countryCode})
🗺 <b>Coordinates:</b> ${geo.lat}, ${geo.lon}
🌐 <b>Timezone:</b> ${geo.timezone}
🏢 <b>ISP:</b> ${geo.isp}
🏛 <b>Org:</b> ${geo.org || '-'}`
    : `🌍 <b>Location:</b> Unable to resolve`;

  const deviceLines = vi
    ? `💻 <b>Device:</b> ${vi.deviceType} — ${os}
🌐 <b>Browser:</b> ${browser}
🗣 <b>Language:</b> ${vi.language}
🕐 <b>Local Time:</b> ${vi.localTime}
🕐 <b>Timezone:</b> ${vi.timezone}
📐 <b>Screen:</b> ${vi.screen} (viewport ${vi.viewport}, ${vi.colorDepth})
🔗 <b>Referrer:</b> ${vi.referrer}`
    : `💻 <b>Device:</b> Unknown`;

  return (
    `🌏 <b>NEW VISITOR CHAT</b>
` +
    `━━━━━━━━━━━━━━━━━━━━━━
` +
    `🔑 <b>Session:</b> <code>${sessionId}</code>
` +
    `🖥 <b>IP Address:</b> <code>${clientIp}</code>
` +
    `${geoLine}
` +
    `━━━━━━━━━━━━━━━━━━━━━━
` +
    `${deviceLines}
` +
    `📄 <b>Page:</b> ${vi ? vi.page : 'unknown'}
` +
    `━━━━━━━━━━━━━━━━━━━━━━
` +
    `👤 <b>Visitor says:</b> ${firstMessage}

` +
    `<i>↩️ Reply to THIS message to respond to the visitor.</i>`
  );
}

async function sendTelegramMessage(text, replyToMessageId = null) {
  const body = {
    chat_id: ADMIN_CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

/**
 * POST /api/chat
 * Receives a message from a website visitor and forwards it to Telegram.
 */
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, visitorInfo } = req.body;

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'Invalid session' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Empty message' });
  }

  const safeMessage = message.trim().slice(0, 1000);
  const clientIp = getClientIp(req);

  try {
    const session = getOrCreateSession(sessionId);

    let telegramText;
    if (!session.telegramMessageId) {
      // First message — build the full visitor card with geolocation
      const geo = await geolocateIp(clientIp);
      telegramText = buildVisitorCard(sessionId, safeMessage, clientIp, geo, visitorInfo || null);
    } else {
      // Follow-up message — keep it short and threaded
      telegramText = `👤 <b>Visitor:</b> ${safeMessage}`;
    }

    const sentMsg = await sendTelegramMessage(
      telegramText,
      session.telegramMessageId
    );

    if (!session.telegramMessageId) {
      session.telegramMessageId = sentMsg.message_id;
    }
    telegramMsgToSession.set(sentMsg.message_id, sessionId);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error sending to Telegram:', err.message);
    res.status(502).json({ error: 'Failed to forward message' });
  }
});

/**
 * GET /api/replies?sessionId=xxx&after=timestamp
 * Returns any new admin replies for a given session.
 */
app.get('/api/replies', (req, res) => {
  const { sessionId, after } = req.query;

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'Invalid session' });
  }

  const afterTs = parseInt(after) || 0;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ messages: [] });
  }

  const newMessages = session.replies.filter(m => m.timestamp > afterTs);
  res.json({ messages: newMessages });
});

/**
 * POST /webhook/:secret
 * Telegram calls this URL when the admin sends a message in the bot chat.
 */
app.post('/webhook/:secret', (req, res) => {
  // Validate the secret to ensure this is a genuine Telegram call
  if (req.params.secret !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Always respond 200 quickly to Telegram

  const update = req.body;
  if (!update || !update.message) return;

  const msg = update.message;

  // Only handle replies from the admin chat
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;

  // Must be a reply to a tracked message
  if (!msg.reply_to_message) return;

  const repliedToId = msg.reply_to_message.message_id;
  const sessionId = telegramMsgToSession.get(repliedToId);

  if (!sessionId) {
    // Try to find sessionId from text of the replied-to message (fallback)
    const text = msg.reply_to_message.text || '';
    const match = text.match(/Session: ([^\s\n]+)/);
    if (!match) return;
    const sid = match[1];
    if (!sessions.has(sid)) return;
    routeReplyToSession(sid, msg.text);
    return;
  }

  routeReplyToSession(sessionId, msg.text);
});

function routeReplyToSession(sessionId, text) {
  if (!text) return;
  const session = sessions.get(sessionId);
  if (!session) return;

  session.replyCounter += 1;
  session.replies.push({
    id: session.replyCounter,
    text: text,
    timestamp: Date.now()
  });

  // Keep only last 100 replies per session to avoid memory bloat
  if (session.replies.length > 100) {
    session.replies.shift();
  }
}

/**
 * GET /setup-webhook
 * Call this once after deployment to register the Telegram webhook.
 * Visit: https://your-server.com/setup-webhook in a browser.
 */
app.get('/setup-webhook', async (req, res) => {
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${protocol}://${host}/webhook/${WEBHOOK_SECRET}`;

  try {
    const response = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] })
    });
    const data = await response.json();
    res.json({ webhookUrl, telegramResponse: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`China Royale Chat Backend running on port ${PORT}`);
  console.log(`After deployment, visit /setup-webhook once to register the Telegram webhook.`);
});
