const express = require('express');
const db = require('../db');
const { verifyResponseHash } = require('../lib/wipay');
const { finalizeAcceptedQuote, markPaymentFailed } = require('../lib/quotePayments');

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ============================================================
// GET /api/payments/wipay/callback — PUBLIC. This is the `response_url`
// WiPay's hosted page redirects the Payor's own BROWSER to (a GET request
// with the transaction result appended as a querystring) — NOT a
// server-to-server webhook. See documentation/PAYMENTS_AND_JOB_WORKFLOW.md
// for why that matters — routes/webhooks.js's POST /wipay handler is the
// server-to-server backstop for when this redirect never lands.
//
// This is where a quote is ACTUALLY accepted — routes/quotes.js's
// PATCH /:id/accept only ever initiates the WiPay checkout.
// ============================================================
router.get('/wipay/callback', async (req, res) => {
  const { order_id: orderId, status, total, transaction_id: transactionId, message, hash } = req.query;

  if (!orderId) {
    console.warn('[wipay callback] missing order_id in response querystring');
    return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
  }

  try {
    if (status !== 'success') {
      const quoteId = await markPaymentFailed(orderId, { transactionId, message });
      if (!quoteId) return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
      return res.redirect(
        `${FRONTEND_URL}/quote-accept?quoteId=${quoteId}&payment=failed&message=${encodeURIComponent(message || 'Payment was not completed.')}`
      );
    }

    // Verify the hash BEFORE trusting anything — this is the only thing
    // stopping someone from hand-crafting a fake "success" redirect. The hash
    // covers transaction_id + total + our API key, so it also implicitly
    // guarantees `total` wasn't tampered with in the querystring.
    if (!verifyResponseHash({ transactionId, total, hash })) {
      console.error(`[wipay callback] HASH MISMATCH order_id=${orderId} transaction_id=${transactionId} — refusing to finalize`);
      const quoteId = await markPaymentFailed(orderId, { transactionId, message: 'hash verification failed' });
      if (!quoteId) return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
      return res.redirect(
        `${FRONTEND_URL}/quote-accept?quoteId=${quoteId}&payment=failed&message=${encodeURIComponent('Payment could not be verified. Please contact support.')}`
      );
    }

    // Belt-and-suspenders: confirm the charged total matches what we expect
    // for this transaction. Should never fire since the hash already covers
    // `total`, but cheap to check.
    const txnRow = await db.query('SELECT amount, client_fee FROM public.transactions WHERE wipay_order_id = $1', [orderId]);
    if (txnRow.rows[0]) {
      const expectedTotal = ((txnRow.rows[0].amount + txnRow.rows[0].client_fee) / 100).toFixed(2);
      if (total !== expectedTotal) {
        console.error(`[wipay callback] TOTAL MISMATCH order_id=${orderId} expected=${expectedTotal} got=${total}`);
        return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
      }
    }

    // Store the confirmed transaction_id, then finalize.
    await db.query(
      `UPDATE public.transactions SET wipay_transaction_id = $1, updated_at = NOW() WHERE wipay_order_id = $2`,
      [transactionId, orderId]
    );
    const outcome = await finalizeAcceptedQuote(orderId);
    if (!outcome.ok) {
      console.warn(`[wipay callback] no transaction found for order_id=${orderId}`);
      return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
    }

    res.redirect(`${FRONTEND_URL}/quote-accept?quoteId=${outcome.quoteId}&payment=success`);
  } catch (err) {
    console.error('GET /api/payments/wipay/callback error:', err);
    res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
  }
});

module.exports = router;
