/**
 * Shared Claude API helper — thin wrapper over the Messages API using plain
 * fetch (no SDK dependency, matches the existing scripts/test-claude-key.js
 * pattern). Used by:
 *   - routes/chat.js       — the public "Ask TendrIt Anything" homepage bot
 *   - lib/aiModeration.js  — the AI fallback layer on homeowner/provider chat
 *
 * Cheapest + fastest model on purpose for both call sites: the homepage bot
 * answers short factual questions from a small grounded context, and the
 * moderation layer just needs a yes/no classification — neither benefits
 * from a slower/pricier model.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * @param {object} params
 * @param {string} [params.system]        System prompt.
 * @param {Array<{role: 'user'|'assistant', content: string}>} params.messages
 * @param {number} [params.maxTokens]     Defaults to 512.
 * @param {number} [params.timeoutMs]     Abort after this long. Defaults to 8000.
 * @returns {Promise<{ text: string, usage: object }>}
 */
async function askClaude({ system, messages, maxTokens = 512, timeoutMs = 8000 }) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('CLAUDE_API_KEY environment variable is required.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message || res.statusText;
    throw new Error(`[claude] API error ${res.status}: ${message}`);
  }

  const text = (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return { text, usage: data?.usage || null };
}

module.exports = { askClaude, MODEL };
