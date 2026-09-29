/**
 * Cloudflare Turnstile verification — bot prevention on signup + signin.
 *
 * The frontend widget produces a single-use token; we verify it server-side
 * with our secret key before trusting the request. Tokens expire (~5 min) and
 * cannot be reused, so the client must fetch a fresh one per submit.
 *
 * Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token with Cloudflare.
 * @param {string} token   The cf-turnstile-response token from the widget.
 * @param {string} [remoteip]  The end-user's IP (optional but recommended).
 * @returns {Promise<{ success: boolean, errorCodes: string[] }>}
 */
async function verifyTurnstileToken(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // If no secret is configured, only fail open on non-production boxes (e.g. a
  // dev machine without keys). In production, missing config must not silently
  // disable bot protection — fail closed instead.
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[turnstile] TURNSTILE_SECRET_KEY not set in production — rejecting request');
      return { success: false, errorCodes: ['missing-secret-config'] };
    }
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification');
    return { success: true, errorCodes: ['skipped-no-secret'] };
  }

  if (!token) {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);
    if (remoteip) form.append('remoteip', remoteip);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const data = await res.json();
    return {
      success: data.success === true,
      errorCodes: data['error-codes'] || [],
    };
  } catch (err) {
    console.error('[turnstile] verification request failed:', err.message);
    // Network/Cloudflare outage — fail closed. Failing open here would let
    // anyone bypass bot protection simply by racing/blocking the outbound
    // request to Cloudflare.
    return { success: false, errorCodes: ['verify-request-failed'] };
  }
}

/**
 * Express middleware — blocks the request unless the Turnstile token verifies.
 * Reads the token from `turnstileToken` (preferred) or `cf-turnstile-response`
 * in the JSON body.
 */
async function requireTurnstile(req, res, next) {
  const token = req.body?.turnstileToken || req.body?.['cf-turnstile-response'];
  const remoteip =
    (req.headers['cf-connecting-ip']) ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress;

  const result = await verifyTurnstileToken(token, remoteip);
  if (!result.success) {
    console.warn('[turnstile] verification failed:', result.errorCodes.join(', '));
    return res.status(400).json({
      success: false,
      code: 'TURNSTILE_FAILED',
      message: 'Bot verification failed. Please try again.',
    });
  }
  next();
}

module.exports = { verifyTurnstileToken, requireTurnstile };
