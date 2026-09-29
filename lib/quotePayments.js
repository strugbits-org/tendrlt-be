/**
 * Shared "finalize an accepted quote" / "mark payment failed" logic for
 * WiPay payment confirmation. Used by BOTH confirmation channels:
 *   - routes/payments.js  GET /wipay/callback  — the Payor's browser redirect
 *   - routes/webhooks.js  POST /wipay          — WiPay's server-to-server
 *     webhook (WAPI), when configured — a reliability upgrade over the
 *     browser redirect alone (see documentation/PAYMENTS_AND_JOB_WORKFLOW.md)
 *
 * Both channels call the same functions here so a quote is never accepted
 * twice and the notification fan-out never fires twice, no matter which
 * channel's confirmation lands first.
 */

const db = require('../db');
const { notifyUser } = require('./realtimeService');
const { sendQuoteAcceptedEmail } = require('./quoteEmails');
const { sendPushToUser } = require('./pushService');

const TERMINAL_STATUSES = ['held', 'payout_queued', 'completed'];

/**
 * @param {string} orderId  Our own wipay_order_id (matches the checkout attempt).
 * @returns {Promise<{ok: true, alreadyDone: boolean, quoteId: string} | {ok: false, reason: string}>}
 */
async function finalizeAcceptedQuote(orderId) {
  const result = await db.query(`
    SELECT t.id, t.quote_id, t.tender_id, t.provider_id, t.amount, t.client_fee, t.status,
           st.display_name AS service_name,
           pr.email AS provider_email,
           (pr.first_name || ' ' || pr.last_name) AS provider_name
    FROM public.transactions t
    JOIN public.tenders tn ON tn.id = t.tender_id
    LEFT JOIN public.service_types st ON st.id = tn.service_type_id
    JOIN public.users pr ON pr.id = t.provider_id
    WHERE t.wipay_order_id = $1
  `, [orderId]);

  const row = result.rows[0];
  if (!row) return { ok: false, reason: 'no_matching_transaction' };

  if (TERMINAL_STATUSES.includes(row.status)) {
    return { ok: true, alreadyDone: true, quoteId: row.quote_id };
  }

  const rejected = await db.query(
    `UPDATE public.quotes SET status = 'rejected', updated_at = NOW()
     WHERE tender_id = $1 AND id != $2 RETURNING id, provider_id`,
    [row.tender_id, row.quote_id]
  );
  await db.query(`UPDATE public.quotes SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [row.quote_id]);
  await db.query(
    `UPDATE public.transactions
       SET status = 'held', collected_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [row.id]
  );
  await db.query(`UPDATE public.tenders SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [row.tender_id]);

  const serviceName = row.service_name || 'your job';
  const winnerTitle  = 'Your quote was accepted 🎉';
  const winnerBody   = `${serviceName} — the job is starting. Open the tender for the homeowner's contact details & location.`;

  Promise.allSettled([
    notifyUser(row.provider_id, 'quote-accepted', { quoteId: row.quote_id, tenderId: row.tender_id }),
    db.query(`
      INSERT INTO public.notifications (user_id, type, title, body, data)
      VALUES ($1, 'quote_accepted', $2, $3, $4::jsonb)
    `, [row.provider_id, winnerTitle, winnerBody, JSON.stringify({ tenderId: row.tender_id })]),
    sendQuoteAcceptedEmail(row.provider_email, {
      providerName: row.provider_name || 'there',
      tenderTitle: serviceName,
      amount: row.amount,
    }),
    sendPushToUser(row.provider_id, {
      title: winnerTitle,
      body: winnerBody,
      type: 'quote_accepted',
      url: `/tender/${row.tender_id}`,
      data: { tender_id: row.tender_id },
    }),
    ...rejected.rows.map((r) => notifyUser(r.provider_id, 'quote-rejected', { quoteId: r.id, tenderId: row.tender_id })),
  ]).catch((err) => console.warn('[finalizeAcceptedQuote] side-effect error:', err.message));

  return { ok: true, alreadyDone: false, quoteId: row.quote_id };
}

/**
 * @param {string} orderId
 * @param {{ transactionId?: string, message?: string }} [details]
 */
async function markPaymentFailed(orderId, { transactionId, message } = {}) {
  const result = await db.query(
    `UPDATE public.transactions
       SET status = 'payment_failed', wipay_transaction_id = COALESCE($1, wipay_transaction_id),
           wipay_last_message = $2, updated_at = NOW()
     WHERE wipay_order_id = $3 AND status NOT IN ('held', 'payout_queued', 'completed')
     RETURNING quote_id`,
    [transactionId || null, message || null, orderId]
  );
  return result.rows[0]?.quote_id || null;
}

module.exports = { finalizeAcceptedQuote, markPaymentFailed };
