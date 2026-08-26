const crypto = require('crypto');

/**
 * Didit hosted identity verification — session creation + webhook signature
 * verification. Docs: https://docs.didit.me
 *
 * Unlike lib/turnstile.js (which fails OPEN on a missing secret because it's
 * only bot mitigation), signature verification here fails CLOSED: an
 * unverifiable webhook is a KYC integrity risk, not a UX nuisance, and must
 * be rejected rather than trusted.
 */

const DIDIT_BASE_URL = process.env.DIDIT_BASE_URL || 'https://verification.didit.me';
const REPLAY_WINDOW_SECONDS = 300; // matches Didit's own recommended tolerance

/**
 * Create a hosted verification session for a provider and return the URL to
 * redirect them to.
 * @param {{ providerId: string, callbackUrl: string }} params
 * @returns {Promise<{ sessionId: string, url: string }>}
 */
async function createVerificationSession({ providerId, callbackUrl }) {
  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.DIDIT_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workflow_id: process.env.DIDIT_WORKFLOW_ID,
      vendor_data: providerId,
      callback: callbackUrl,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[didit] session create failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return { sessionId: data.session_id, url: data.url };
}

/**
 * Verify a Didit webhook is authentic and fresh. Fails closed: any missing
 * secret, missing header, stale timestamp, or mismatched signature returns
 * false — never assume trust.
 *
 * Uses the `X-Signature` header (HMAC-SHA256 over the exact raw request
 * bytes as Didit sent them) rather than `X-Signature-V2` (which signs a
 * re-canonicalized form of the JSON and would require reproducing Didit's
 * exact serialization). Since our webhook route captures the untouched raw
 * body via express.raw(), X-Signature needs no re-serialization step.
 *
 * @param {Buffer} rawBody       Untouched request body bytes.
 * @param {Record<string, string>} headers  req.headers (Express lowercases names).
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[didit] DIDIT_WEBHOOK_SECRET not set — rejecting webhook (fail closed)');
    return false;
  }

  const timestamp = headers['x-timestamp'];
  const signature = headers['x-signature'];
  if (!timestamp || !signature) {
    console.warn('[didit] webhook missing X-Timestamp or X-Signature header');
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) {
    console.warn('[didit] webhook timestamp outside replay window');
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== gotBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

module.exports = { createVerificationSession, verifyWebhookSignature };
