/**
 * WiPay Plugins Payment Request API — hosted-page checkout for homeowner
 * payment collection (JMD, Jamaica platform). Per WiPay's own Payments API
 * docs (v1.0.8): there is no signed server-to-server webhook in this API —
 * confirmation arrives only as a browser redirect to `response_url` after
 * the Payor finishes the hosted page. See documentation/PAYMENTS_AND_JOB_WORKFLOW.md
 * for the reliability caveat that comes with that (no fallback reconciliation
 * path if the redirect never lands — unlike the Didit integration, WiPay's
 * classic API doesn't document a "check transaction status" endpoint to
 * poll as a backup).
 *
 * Sandbox vs live is controlled by WIPAY_ENVIRONMENT:
 *   - sandbox: account_number is ALWAYS the fixed WiPay test number
 *     (1234567890), and hash verification uses the fixed test API key ("123")
 *     — both per WiPay's docs, regardless of our own real account.
 *   - live: uses WIPAY_ACCOUNT_NUMBER / WIPAY_API_KEY (this merchant's real
 *     credentials from the WiPay developer dashboard).
 */

const crypto = require('crypto');

const WIPAY_API_URL = 'https://jm.wipayfinancial.com/plugins/payments/request';
const SANDBOX_ACCOUNT_NUMBER = '1234567890';
const SANDBOX_API_KEY = '123';
const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

const COUNTRY_CODE = process.env.WIPAY_COUNTRY_CODE || 'JM';
const CURRENCY = process.env.WIPAY_CURRENCY || 'JMD';

function isSandbox() {
  return (process.env.WIPAY_ENVIRONMENT || 'sandbox') !== 'live';
}

function getAccountNumber() {
  if (isSandbox()) return SANDBOX_ACCOUNT_NUMBER;
  const accountNumber = process.env.WIPAY_ACCOUNT_NUMBER;
  if (!accountNumber) throw new Error('WIPAY_ACCOUNT_NUMBER environment variable is required in live mode.');
  return accountNumber;
}

function getApiKey() {
  if (isSandbox()) return SANDBOX_API_KEY;
  const apiKey = process.env.WIPAY_API_KEY;
  if (!apiKey) throw new Error('WIPAY_API_KEY environment variable is required in live mode.');
  return apiKey;
}

/**
 * Request a WiPay hosted-page checkout URL.
 * @param {object} params
 * @param {number} params.total       Dollar amount (e.g. 1234.56), NOT cents.
 * @param {string} params.orderId     Our unique order id for this attempt. ad[1-16|1-48].
 * @param {string} params.responseUrl Our callback URL WiPay redirects the Payor's browser to.
 * @returns {Promise<{ url: string, transactionId: string|null }>}
 */
async function createPaymentRequest({ total, orderId, responseUrl }) {
  const body = new URLSearchParams({
    account_number: getAccountNumber(),
    country_code: COUNTRY_CODE,
    currency: CURRENCY,
    environment: isSandbox() ? 'sandbox' : 'live',
    fee_structure: 'merchant_absorb', // TendrIt absorbs WiPay's own processing fee — homeowner is only charged quote + our platform fee, not a third fee on top.
    method: 'credit_card',
    order_id: orderId,
    origin: 'TendrIt',
    response_url: responseUrl,
    total: total.toFixed(2),
  });

  let res;
  try {
    res = await fetch(WIPAY_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (err) {
    throw new Error(`[wipay] network error reaching WiPay: ${err.message}`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) {
    const message = data?.message || res.statusText;
    throw new Error(`[wipay] payment request failed (${res.status}): ${message}`);
  }

  return { url: data.url, transactionId: data.transaction_id || null };
}

/**
 * Verify a `response_url` callback's hash — the ONLY thing standing between
 * "a real WiPay success redirect" and "someone hand-crafted this querystring".
 * Per the docs: md5(transaction_id + total + api_key), no separators.
 *
 * Confirmed 2026-09-30 via staging: WiPay signs this hash using `total`
 * formatted to exactly 2 decimal places (e.g. "1344.00"), but the `total`
 * value it actually puts in the response querystring is trimmed of
 * trailing zeros/decimals (e.g. "1344"). Using the querystring value as-is
 * therefore always failed verification — reformat it the same way we
 * originally submitted it before hashing.
 * @param {{ transactionId: string, total: string, hash: string }} params
 */
function verifyResponseHash({ transactionId, total, hash }) {
  if (!transactionId || !total || !hash) return false;
  const apiKey = getApiKey();
  const normalizedTotal = Number(total).toFixed(2);
  const expected = crypto.createHash('md5').update(`${transactionId}${normalizedTotal}${apiKey}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(String(hash), 'utf8');
  const matches = expectedBuf.length === gotBuf.length && crypto.timingSafeEqual(expectedBuf, gotBuf);
  if (!matches) {
    // Safe to log: none of these values are secret (the api key here is
    // always the fixed public sandbox key "123" unless WIPAY_ENVIRONMENT=live).
    console.error(
      `[wipay hash] mismatch — transactionId=${transactionId} total="${total}" (normalized="${normalizedTotal}") ` +
      `environment=${isSandbox() ? 'sandbox' : 'live'} apiKeyUsed="${apiKey}" ` +
      `expected=${expected} got=${hash}`
    );
  }
  return matches;
}

/**
 * Verify a WiPay webhook (WAPI) delivery's signature.
 *
 * WiPay's webhook secret has a `whsec_` prefix — the exact convention used
 * by Svix and the related "Standard Webhooks" spec (https://www.standardwebhooks.com/),
 * which many webhook platforms build on. This is a well-founded guess, not
 * a documented fact — WiPay doesn't publish a payload/signature spec for
 * this product. If real deliveries don't carry `webhook-id`/`webhook-timestamp`/
 * `webhook-signature` (or the `svix-*` equivalents) headers, this will
 * reliably fail and log why, which is exactly the signal needed to correct it.
 *
 * Standard Webhooks scheme: signed content is `${id}.${timestamp}.${rawBody}`,
 * HMAC-SHA256'd with the base64-decoded secret (after stripping `whsec_`),
 * base64-encoded, compared against one of the space-separated `v1,<sig>`
 * values in the signature header.
 *
 * @param {Buffer} rawBody
 * @param {Record<string, string>} headers  req.headers (Express lowercases names).
 * @returns {boolean}
 */
function constantTimeStringEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.WIPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[wipay webhook] WIPAY_WEBHOOK_SECRET not set — rejecting webhook (fail closed)');
    return false;
  }

  const id = headers['webhook-id'] || headers['svix-id'] || headers['x-webhook-id'];
  const timestamp = headers['webhook-timestamp'] || headers['svix-timestamp'] || headers['x-webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'] || headers['svix-signature'] || headers['x-webhook-signature'];

  if (!id || !timestamp || !signatureHeader) {
    console.warn(
      '[wipay webhook] missing webhook-id/webhook-timestamp/webhook-signature (or svix-*/x-webhook-* equivalent) ' +
      'headers — got headers: ' + Object.keys(headers).join(', ')
    );
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_REPLAY_WINDOW_SECONDS) {
    console.warn('[wipay webhook] timestamp outside replay window');
    return false;
  }

  const secretSuffix = secret.replace(/^whsec_/, '');
  // The `whsec_` prefix only confirms a Svix-*flavored* naming convention —
  // it does NOT confirm the suffix is base64-encoded the way Svix normally
  // generates it. This secret's suffix is 64 lowercase hex characters (no
  // uppercase, no +/=), which strongly suggests a plain hex-encoded key
  // instead. Try every plausible interpretation rather than assume one.
  const candidateKeys = [Buffer.from(secretSuffix, 'hex'), Buffer.from(secretSuffix, 'utf8'), Buffer.from(secret, 'utf8'), Buffer.from(secretSuffix, 'base64')]
    .filter((buf) => buf.length > 0);

  const signedContent = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  // The header can carry multiple space-separated "v1,<sig>" candidates.
  const candidateSigs = signatureHeader
    .split(' ')
    .map((c) => (c.includes(',') ? c.slice(c.indexOf(',') + 1) : c))
    .filter(Boolean);

  for (const key of candidateKeys) {
    for (const encoding of ['base64', 'hex']) {
      const expected = crypto.createHmac('sha256', key).update(signedContent).digest(encoding);
      if (candidateSigs.some((sig) => constantTimeStringEqual(expected, sig))) return true;
    }
  }

  console.warn('[wipay webhook] signature did not match any key-encoding combination tried — envelope scheme still unconfirmed');
  return false;
}

module.exports = { createPaymentRequest, verifyResponseHash, verifyWebhookSignature, isSandbox };
