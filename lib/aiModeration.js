/**
 * AI fallback layer for chat message moderation — Layer 3 referenced in
 * lib/piiFilter.js. Regex (Layers 1-2) catches the vast majority of contact-
 * info / off-platform attempts cheaply and with zero latency; this exists
 * only to catch what regex structurally cannot: disguised or reworded
 * attempts to move the conversation off-platform that don't match any known
 * pattern (e.g. "the seven six eight four... you know the rest, same as my
 * insta", or a message that spells things out in a way that reads fine to a
 * human but was clearly built to route around the filter).
 *
 * Only called AFTER detectPII() already passed the message — this is a
 * fallback, not the primary gate. Uses the fastest/cheapest Claude model
 * with a tiny prompt and a short timeout so it doesn't meaningfully slow
 * down message sending.
 *
 * Fails OPEN on any error (timeout, API outage, bad response): the
 * authoritative regex filter already ran and passed, so a Claude outage
 * degrades this to "regex-only" protection rather than blocking all chat
 * messages platform-wide over a third-party dependency.
 */

const { askClaude } = require('./claude');

const SYSTEM_PROMPT = `You moderate one chat message between a homeowner and a service provider on a home-services marketplace. Off-platform contact info and payment arrangements are already blocked by a separate filter — your ONLY job is to catch attempts that filter would miss: contact details or payment requests disguised through misspelling, spacing, leetspeak, spelled-out characters, foreign scripts, coded phrasing, or references to "my other app"/"you know where to find me" style hints.
Reply with EXACTLY one word: "BLOCK" if the message is such a disguised attempt, or "ALLOW" if it is a normal, legitimate job-related message. No punctuation, no explanation.`;

/**
 * @param {string} text
 * @returns {Promise<{ blocked: boolean, failedOpen?: boolean }>}
 */
async function aiCheckMessage(text) {
  try {
    const { text: verdict } = await askClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      maxTokens: 5,
      timeoutMs: 4000,
    });
    return { blocked: /^BLOCK/i.test(verdict.trim()) };
  } catch (err) {
    console.error('[ai-moderation] check failed — failing open:', err.message);
    return { blocked: false, failedOpen: true };
  }
}

module.exports = { aiCheckMessage };
