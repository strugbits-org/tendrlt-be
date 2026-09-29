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

async function loadContext() {
  const [settingsRes, faqsRes] = await Promise.all([
    db.query('SELECT company_name, tagline, about, policies, extra_notes FROM public.chatbot_settings WHERE id = 1'),
    db.query(`SELECT question, answer FROM public.chatbot_faqs
                WHERE is_active = TRUE ORDER BY display_order ASC, created_at ASC`),
  ]);

  const settings = settingsRes.rows[0] || {};
  const faqs = faqsRes.rows;

  const parts = [];
  if (settings.company_name || settings.tagline) {
    parts.push(`${settings.company_name || 'TendrIt'}${settings.tagline ? ' — ' + settings.tagline : ''}`);
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
