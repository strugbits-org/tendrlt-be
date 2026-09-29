/**
 * AI fallback layer for chat message moderation — Layer 3 referenced in
 * lib/piiFilter.js. Regex (Layers 1-2) catches the vast majority of contact-
 * info / off-platform attempts cheaply and with zero latency; this exists
 * only to catch what regex structurally cannot: disguised or reworded
 * attempts to move the conversation off-platform that don't match any known
 * pattern.
 *
 * Only called AFTER detectPII() already passed the message — this is a
 * fallback, not the primary gate. Uses the fastest/cheapest Claude model
 * with a tiny prompt, a short output cap, and a tight timeout so it adds as
 * little latency as possible to message sending.
 *
 * Fails OPEN on any error (timeout, API outage, bad response): the
 * authoritative regex filter already ran and passed, so a Claude outage
 * degrades this to "regex-only" protection rather than blocking all chat
 * messages platform-wide over a third-party dependency.
 */

const { askClaude } = require('./claude');

const SYSTEM_PROMPT = `You are a strict security filter for one chat message between a homeowner and a service provider on a home-services marketplace app. All communication MUST stay on this platform. A separate regex filter already blocks the obvious cases — your job is to catch what it structurally cannot: a message DESIGNED to get contact info or an off-platform meetup past a filter while still reading as innocent to a human skimmer.

Treat the message as a BLOCK if it contains ANY of the following, however disguised:
- A phone number or part of one, in ANY form: digits with unusual spacing/punctuation, spelled-out digits ("seven six eight four"), digit words in another language, leetspeak/letter-for-digit substitutions, digits hidden inside unrelated words or emoji, a number split across multiple sentences, or a partial number with "you know the rest" / "same as always" style completion.
- An email address or fragment of one, including "at" / "dot" spelled out, or with extra symbols/spacing inserted to dodge pattern matching.
- A URL, shortened link, or "search for X" instruction that would let the other party find them off-platform.
- ANY social media, messaging, or contact platform — named directly, abbreviated, described by a nickname or emoji (e.g. "the app with the ghost", "gram", "IG", "TT", "WA"), or implied without being named at all.
- A bare handle/username (e.g. "@something123") even with no platform stated.
- An invitation to "look me up", "check my profile", "find me on [anything]", "same name everywhere", "add me", "friend me", "follow me", or similar indirect self-identification meant to be searched for elsewhere.
- A suggestion to move the conversation off-platform for ANY stated reason (faster replies, "easier to call", "for verification", "just this once", "in case the app is down", etc.) — the reason given is irrelevant; the intent is what matters.
- A request or offer to pay/receive payment outside the platform, including vague references to a payment app by nickname rather than name.
- A physical meetup or address exchange offered specifically as a way to bypass sharing contact info digitally.
- Reversed, rotated (e.g. ROT13-style), or character-substituted (homoglyph) text hiding any of the above.

If genuinely uncertain whether something is an obfuscation attempt versus ordinary job-related conversation (e.g. discussing a job address for the actual service location, or a price that happens to contain digits), lean toward BLOCK only when there is a clear pattern of evasion — do not block plain, legitimate scheduling or service talk that merely contains numbers (dates, prices, quantities, room counts, etc.) with no attempt to share a contact method.

Reply with EXACTLY one word and nothing else: BLOCK or ALLOW.`;

/**
 * @param {string} text
 * @returns {Promise<{ blocked: boolean, failedOpen?: boolean }>}
 */
async function aiCheckMessage(text) {
  try {
    const { text: verdict } = await askClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
      maxTokens: 6,
      timeoutMs: 3000,
    });
    return { blocked: /^BLOCK/i.test(verdict.trim()) };
  } catch (err) {
    console.error('[ai-moderation] check failed — failing open:', err.message);
    return { blocked: false, failedOpen: true };
  }
}

module.exports = { aiCheckMessage };
