const express = require('express');
const db = require('../db');
const { verifyWebhookSignature, mapDiditStatus, extractCheckSummary } = require('../lib/didit');
const { verifyResponseHash, verifyWebhookSignature: verifyWipaySignature } = require('../lib/wipay');
const { finalizeAcceptedQuote, markPaymentFailed } = require('../lib/quotePayments');

const router = express.Router();

// ============================================================
// POST /api/webhooks/didit
// No `authenticate` middleware — Didit calls this directly, not a logged-in
// user. Mounted in index.js BEFORE the global express.json() so the body
// arrives here as an untouched Buffer — required to verify the signature
// over the exact bytes Didit sent.
// ============================================================
router.post('/didit', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body; // Buffer
  console.log(`[didit webhook] received — ${rawBody?.length ?? 0} bytes`);

  if (!verifyWebhookSignature(rawBody, req.headers)) {
    // verifyWebhookSignature already logs the specific reason (missing
    // secret, missing header, stale timestamp, mismatch) — this just marks
    // the request-level outcome so a rejected webhook is never silent.
    console.warn('[didit webhook] rejected — signature verification failed (401)');
    return res.status(401).json({ success: false, message: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[didit webhook] rejected — body is not valid JSON:', err.message);
    return res.status(400).json({ success: false, message: 'Invalid JSON.' });
  }

  const { session_id: sessionId, vendor_data: providerId, status, decision } = payload;
  console.log(`[didit webhook] session=${sessionId} provider=${providerId} status="${status}"`);
  console.log(`[didit webhook] decision=${JSON.stringify(decision)}`);

  if (!sessionId || !providerId || !status) {
    console.warn('[didit webhook] rejected — missing session_id, vendor_data, or status');
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const diditStatus = mapDiditStatus(status);
  if (!diditStatus) {
    // Non-terminal status update — nothing to persist yet.
    console.log(`[didit webhook] status="${status}" is non-terminal — acknowledged, no DB write`);
    return res.status(200).json({ success: true });
  }

  // Sanitized summary only. `decision.id_verifications[0]` also carries
  // document_number, full_name, date_of_birth, nationality, address, and
  // signed URLs to the portrait/ID/selfie/liveness-video images — all
  // deliberately left unread here. `warnings[].risk` codes and the
  // ip_analyses booleans below are failure-reason / fraud-signal metadata,
  // not PII, so those are worth keeping. See DIDIT_VERIFICATION_PLAN.md.
  const { documentType, checkSummary } = extractCheckSummary(decision);

  console.log(
    `[didit webhook] writing provider=${providerId} didit_status=${diditStatus} ` +
    `document_type=${documentType ?? 'null'} check_summary=${JSON.stringify(checkSummary)}`
  );

  try {
    // The session-id match guards against a stale/replayed session updating
    // a newer one (e.g. a provider who retried and started a fresh session).
    const result = await db.query(
      `UPDATE public.provider_profiles
         SET didit_status        = $1,
             didit_check_summary = $2::jsonb,
             didit_document_type = $3,
             didit_verified_at   = CASE WHEN $1 = 'approved' THEN NOW() ELSE didit_verified_at END,
             didit_updated_at    = NOW()
       WHERE provider_id = $4 AND didit_session_id = $5`,
      [diditStatus, JSON.stringify(checkSummary), documentType, providerId, sessionId]
    );

    if (result.rowCount === 0) {
      // provider_id/session_id didn't match any row — most likely the
      // provider started a newer session after this one, or vendor_data
      // didn't round-trip correctly. Not fatal (still ack 200 so Didit
      // doesn't retry), but silent data loss otherwise, so log it loudly.
      console.warn(
        `[didit webhook] no matching row for provider=${providerId} session=${sessionId} — ` +
        `update was a no-op (stale/mismatched session?)`
      );
    } else {
      console.log(`[didit webhook] provider=${providerId} updated to didit_status=${diditStatus}`);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[didit webhook] DB update failed for provider=${providerId} session=${sessionId}:`, err);
    res.status(500).json({ success: false });
  }
});

// ============================================================
// POST /api/webhooks/wipay
// Server-to-server backstop for the browser-redirect confirmation in
// routes/payments.js. Signature verification uses the Standard Webhooks/
// Svix scheme (see lib/wipay.js#verifyWebhookSignature) — a well-founded
// guess based on the `whsec_` secret prefix, not documented by WiPay, so
// this is ALSO backed by the classic API's own documented hash fields
// (transaction_id + total + api_key) as a second, independent check before
// finalizing a payment.success event — belt and suspenders while the
// envelope scheme is unconfirmed against a real delivery.
//
// Payload field names are defensive/best-guess (event name + a data/payload
// object) since we've only seen the event catalog in the dashboard UI, not
// a payload spec. First real delivery should be inspected (this logs the
// full body) and this handler tightened up once the actual shape is known.
// ============================================================
router.post('/wipay', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body; // Buffer
  console.log(`[wipay webhook] received — ${rawBody?.length ?? 0} bytes`);

  if (!verifyWipaySignature(rawBody, req.headers)) {
    console.warn('[wipay webhook] rejected — signature verification failed (401)');
    return res.status(401).json({ success: false, message: 'Invalid signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[wipay webhook] rejected — body is not valid JSON:', err.message);
    return res.status(400).json({ success: false, message: 'Invalid JSON.' });
  }

  console.log('[wipay webhook] payload:', JSON.stringify(payload));

  const eventType = payload.event || payload.type || payload.event_type;
  const data = payload.data || payload.payload || payload;
  const orderId = data.order_id || data.orderId;
  const transactionId = data.transaction_id || data.transactionId;
  const total = data.total;
  const hash = data.hash;

  if (!eventType || !orderId) {
    console.warn('[wipay webhook] missing event type or order_id — acknowledged, no action taken');
    return res.status(200).json({ success: true });
  }

  try {
    if (eventType === 'payment.success') {
      // Signature is already verified above. The classic hash fields are an
      // extra check when present, but not required to trust this event now
      // that the envelope itself is signature-verified.
      if (hash && !verifyResponseHash({ transactionId, total, hash })) {
        console.error(`[wipay webhook] payment.success for order_id=${orderId} — hash present but INVALID, refusing to finalize`);
        return res.status(200).json({ success: true });
      }
      const outcome = await finalizeAcceptedQuote(orderId);
      console.log(`[wipay webhook] payment.success order_id=${orderId} → ${outcome.ok ? (outcome.alreadyDone ? 'already finalized' : 'finalized') : outcome.reason}`);
    } else if (eventType === 'payment.failed' || eventType === 'payment.error') {
      const quoteId = await markPaymentFailed(orderId, { transactionId, message: eventType });
      console.log(`[wipay webhook] ${eventType} order_id=${orderId} quote=${quoteId ?? 'not found'}`);
    } else {
      // Chargebacks/refunds — dispute/refund handling isn't built yet.
      // Logged loudly so these are never silently lost; needs manual
      // follow-up until a proper handler exists.
      console.warn(`[wipay webhook] unhandled event "${eventType}" for order_id=${orderId} — needs manual follow-up`);
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[wipay webhook] processing failed for order_id=${orderId}:`, err);
    // Still 200 — WiPay would otherwise retry indefinitely on a bug we need
    // to fix server-side, not on their end.
    res.status(200).json({ success: false });
  }
});

module.exports = router;
