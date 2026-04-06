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
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // Set to your website domain in production e.g. 'https://chinaroyaletravels.com'

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// ───────────────────────────────────────────────────────────────────────────

// CORS — only allow your website origin in production
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST']
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
  const { sessionId, message, page } = req.body;

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ error: 'Invalid session' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Empty message' });
  }
  // Truncate extremely long messages
  const safeMessage = message.trim().slice(0, 1000);
  const safePage = (page || '').slice(0, 200);

  try {
    const session = getOrCreateSession(sessionId);

    let telegramText;
    if (!session.telegramMessageId) {
      // First message from this visitor — include context header
      telegramText =
        `🌏 <b>New visitor chat</b>\n` +
        `🔑 Session: <code>${sessionId}</code>\n` +
        `📄 Page: ${safePage}\n` +
        `─────────────────────\n` +
        `👤 <b>Visitor:</b> ${safeMessage}\n\n` +
        `<i>Reply to THIS message to respond to the visitor.</i>`;
    } else {
      // Follow-up message — thread it as a reply to keep context
      telegramText = `👤 <b>Visitor:</b> ${safeMessage}`;
    }

    const sentMsg = await sendTelegramMessage(
      telegramText,
      session.telegramMessageId // reply to first message to create a thread
    );

    // Store the first message_id as the thread anchor
    if (!session.telegramMessageId) {
      session.telegramMessageId = sentMsg.message_id;
    }
    // Always track latest visitor message so admin can reply to it
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
