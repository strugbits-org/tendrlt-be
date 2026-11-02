const express = require('express');
const db = require('../db');
const { askClaude } = require('../lib/claude');

const router = express.Router();

const SYSTEM_PREAMBLE = `You are the "TendrIt Assistant", a help-widget on the TendrIt homepage. TendrIt is a home-services tendering marketplace: homeowners post jobs, verified providers submit quotes, the homeowner accepts one, payment is held in escrow, and it's released to the provider once the job is confirmed complete.

Answer ONLY questions about what TendrIt is, how it works, its fees, and its policies, using the CONTEXT below as your source of truth. If the CONTEXT doesn't cover something, say you're not sure and suggest the visitor use the Contact page — never guess or invent details (fees, policies, dates, numbers).
If asked about anything unrelated to TendrIt (general knowledge, other companies, personal advice, etc.), politely decline and steer back to TendrIt.
Keep answers short — 2-4 sentences, plain text, no markdown headers.`;

// ── Minimal in-memory per-IP rate limit ──────────────────────────────────
// This is a public, unauthenticated endpoint that costs real money per call
// (Claude API). No Redis/queue in this stack, so a simple in-process window
// is enough to blunt casual abuse — not meant to survive a real attack (a
// dedicated bad actor would need a proper WAF/rate-limit service in front).
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 15;
const hits = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  if (hits.size > 5000) hits.clear(); // crude cap so this can't grow unbounded
  return timestamps.length > RATE_LIMIT_MAX;
}

// Fee rates/minimums live in platform_fee_config and change over time (see
// routes/admin.js's fee-config endpoints); chatbot_settings.policies and
// chatbot_faqs are free text an admin typed once and will drift out of sync
// with the real rate whenever it's updated (confirmed: policies said
// "9.5%/12%" while live config was 12%/14.8%). Fee questions must always use
// the live table, not whatever an admin happened to type — so it's injected
// as its own authoritative block the model is told to prefer.
async function loadFeeFacts() {
  // Runs inside loadContext()'s Promise.all alongside the settings/FAQ
  // queries — an uncaught failure here would reject the whole thing and
  // take the entire chat endpoint down over a live-rate lookup, instead of
  // just losing the live-rate accuracy. Caught locally so a DB hiccup here
  // degrades to the old behaviour (chat still works, minus live fee facts).
  try {
    const { rows } = await db.query(
      `SELECT client_rate, provider_rate, min_client_fee, min_provider_fee, min_fee_enabled
         FROM public.platform_fee_config WHERE id = 1`
    );
    const fc = rows[0];
    // Number(null) is 0, not NaN — without this check a null rate would make
    // the bot confidently state a 0% fee instead of omitting the fact.
    if (!fc || fc.client_rate == null || fc.provider_rate == null) return null;
    const jmd = (cents) => `J$${Math.round(Number(cents) / 100).toLocaleString()}`;
    const lines = [
      `Homeowner/client platform fee: ${Number(fc.client_rate)}% of the job value.`,
      `Provider platform fee: ${Number(fc.provider_rate)}% deducted from the provider's payout.`,
    ];
    if (fc.min_fee_enabled) {
      lines.push(`A minimum fee floor applies: at least ${jmd(fc.min_client_fee)} (client side) / ${jmd(fc.min_provider_fee)} (provider side) per job, even if the percentage would work out lower.`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error('loadFeeFacts error (chat will fall back to static context):', err.message);
    return null;
  }
}

async function loadContext() {
  const [settingsRes, faqsRes, feeFacts] = await Promise.all([
    db.query('SELECT company_name, tagline, about, policies, extra_notes FROM public.chatbot_settings WHERE id = 1'),
    db.query(`SELECT question, answer FROM public.chatbot_faqs
                WHERE is_active = TRUE ORDER BY display_order ASC, created_at ASC`),
    loadFeeFacts(),
  ]);

  const settings = settingsRes.rows[0] || {};
  const faqs = faqsRes.rows;

  const parts = [];
  if (settings.company_name || settings.tagline) {
    parts.push(`${settings.company_name || 'TendrIt'}${settings.tagline ? ' — ' + settings.tagline : ''}`);
  }
  if (feeFacts) {
    parts.push(`LIVE FEE RATES (authoritative — current as of right now; use these exact numbers for any fee question and ignore any conflicting rate mentioned elsewhere in this context):\n${feeFacts}`);
  }
  if (settings.about) parts.push(`ABOUT:\n${settings.about}`);
  if (settings.policies) parts.push(`POLICIES:\n${settings.policies}`);
  if (settings.extra_notes) parts.push(`ADDITIONAL NOTES:\n${settings.extra_notes}`);
  if (faqs.length) {
    parts.push('FAQ:\n' + faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n'));
  }

  return parts.join('\n\n---\n\n') || 'No additional context has been configured yet.';
}

// ============================================================
// POST /api/chat/ask — PUBLIC. Body: { message, history? }
// "Ask TendrIt Anything" homepage assistant. Grounded on admin-managed
// content (chatbot_settings + chatbot_faqs) so answers reflect real,
// current company info instead of the model guessing.
// ============================================================
router.post('/ask', async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, message: 'Too many questions — please wait a few minutes and try again.' });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ success: false, message: 'Message is required.' });
  }
  if (message.length > 600) {
    return res.status(400).json({ success: false, message: 'Please keep your question under 600 characters.' });
  }

  // Short history only — a homepage FAQ bot needs a couple of turns of
  // context at most, not a full transcript (keeps token usage low).
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.text.slice(0, 600) }));

  try {
    const context = await loadContext();
    const { text } = await askClaude({
      system: `${SYSTEM_PREAMBLE}\n\nCONTEXT:\n${context}`,
      messages: [...history, { role: 'user', content: message }],
      maxTokens: 300,
    });

    res.json({ success: true, reply: text || "Sorry, I couldn't come up with an answer to that — try the Contact page for help." });
  } catch (err) {
    console.error('POST /api/chat/ask error:', err.message);
    res.status(502).json({ success: false, message: "Sorry, I'm having trouble answering right now. Please try again shortly." });
  }
});

module.exports = router;
