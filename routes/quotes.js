const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { requireIdentityVerified } = require('../middleware/verification');
const { notifyUser, notifyChannel } = require('../lib/realtimeService');
const { sendNewQuoteEmail, sendQuoteAcceptedEmail } = require('../lib/quoteEmails');
const { sendPushToUser } = require('../lib/pushService');
const { detectPII } = require('../lib/piiFilter');
const supabase = require('../lib/supabaseClient');
const { signedUrlMap } = require('../lib/storageUrls');
const { getActiveRates, getMinFees } = require('../lib/feeConfig');

const router = express.Router();

const VALID_TIMELINES = ['same_day', 'next_day', '2_3_days', 'within_1_week', '1_2_weeks', '2_4_weeks'];

// ============================================================
// POST /api/quotes
// Provider submits a quote for an open tender.
// Body: { tender_id, amount, timeline, preferred_start_date, message, what_is_included }
// ============================================================
router.post('/', authenticate, authorize('provider'), requireIdentityVerified, async (req, res) => {
  const { tender_id, amount, timeline, preferred_start_date, message, what_is_included } = req.body;

  if (!tender_id) return res.status(400).json({ success: false, message: 'tender_id is required.' });
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'A valid amount is required.' });
  }
  if (!timeline || !VALID_TIMELINES.includes(timeline)) {
    return res.status(400).json({ success: false, message: 'A valid timeline is required.' });
  }
  if (!message || message.trim().length < 20) {
    return res.status(400).json({ success: false, message: 'Message must be at least 20 characters.' });
  }

  const amountCents = Math.round(Number(amount) * 100);

  try {
    // Step 1: verify tender exists and is accessible to this provider.
    // Do NOT JOIN public.users here — provider RLS (users_select_own) only allows
    // reading the provider's own user row, so a JOIN to the homeowner's row returns
    // 0 rows and makes the whole query look like "Tender not found".
    const tenderCheck = await db.queryAsUser(req.user.id, `
      SELECT t.id, t.client_id, t.status,
             st.display_name AS service_name
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.id = $1
    `, [tender_id]);

    if (tenderCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }

    const tender = tenderCheck.rows[0];

    // Step 2: fetch homeowner contact info using the superuser pool (bypasses RLS).
    // This is safe — it's a backend-only operation never exposed to the client.
    const ownerResult = await db.query(
      `SELECT email, (first_name || ' ' || last_name) AS client_name FROM public.users WHERE id = $1`,
      [tender.client_id]
    );
    tender.client_email = ownerResult.rows[0]?.email ?? null;
    tender.client_name  = ownerResult.rows[0]?.client_name ?? 'Homeowner';

    if (tender.status !== 'open') {
      return res.status(409).json({ success: false, message: 'This tender is no longer accepting quotes.' });
    }

    if (tender.client_id === req.user.id) {
      return res.status(403).json({ success: false, message: 'You cannot quote on your own tender.' });
    }

    // Snapshot the provider service-fee rate in effect now, so a later fee
    // change never re-prices this quote's payout. See PAYMENTS_AND_JOB_WORKFLOW.md.
    const { providerRate: providerFeeRate } = await getActiveRates();

    // Insert the quote — unique constraint will catch duplicates
    const insertResult = await db.queryAsUser(req.user.id, `
      INSERT INTO public.quotes (
        tender_id, provider_id, amount, timeline,
        preferred_start_date, message, what_is_included, provider_fee_rate
      ) VALUES ($1, $2, $3, $4::quote_timeline, $5::date, $6, $7, $8)
      RETURNING *
    `, [
      tender_id,
      req.user.id,
      amountCents,
      timeline,
      preferred_start_date || null,
      message.trim(),
      what_is_included ? what_is_included.trim() : null,
      providerFeeRate,
    ]);

    const quote = insertResult.rows[0];

    // Bump the tender's quotes_count using superuser pool — provider RLS blocks
    // tenders UPDATE (tenders_update_own requires client_id = current_user_id).
    await db.query(
      `UPDATE public.tenders SET quotes_count = quotes_count + 1, updated_at = NOW() WHERE id = $1`,
      [tender_id]
    );

    res.status(201).json({ success: true, quote });

    // Fire-and-forget side effects — must not block the response
    const providerName = `${req.user.first_name} ${req.user.last_name}`.trim();

    Promise.allSettled([
      // Realtime toast to the homeowner
      notifyUser(tender.client_id, 'quote-submitted', {
        tenderId: tender_id,
        quoteId: quote.id,
        providerName,
        amount: amountCents,
      }),

      // Notify the provider's own channel so their stats update
      notifyUser(req.user.id, 'quote-submitted', { tenderId: tender_id, quoteId: quote.id }),

      // Email the homeowner
      sendNewQuoteEmail(tender.client_email, {
        homeownerName: tender.client_name,
        providerName,
        tenderTitle: tender.service_name || 'your job',
        amount: amountCents,
      }),

      // Insert a notification row for the homeowner
      db.query(`
        INSERT INTO public.notifications (user_id, type, title, body, data)
        VALUES ($1, 'quote_received', $2, $3, $4::jsonb)
      `, [
        tender.client_id,
        `New quote from ${providerName}`,
        `${providerName} submitted a quote of $${Math.round(amountCents / 100).toLocaleString()} on your ${tender.service_name || 'job'} tender.`,
        JSON.stringify({ tenderId: tender_id, quoteId: quote.id }),
      ]),

      // Web Push to homeowner's devices
      sendPushToUser(tender.client_id, {
        title: `New quote from ${providerName}`,
        body:  `$${Math.round(amountCents / 100).toLocaleString()} for your ${tender.service_name || 'job'} — tap to review`,
        type:  'new_quote',
        url:   '/dashboard',
        data:  { tender_id, quote_id: quote.id },
      }),
    ]).catch((err) => {
      console.warn('POST /api/quotes — side-effect error:', err.message);
    });

  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_QUOTED',
        message: 'You have already submitted a quote for this tender.',
      });
    }
    console.error('POST /api/quotes error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit quote.' });
  }
});

// ============================================================
// GET /api/quotes/received
// Returns all quotes on the homeowner's tenders.
// Optional query param: ?tender_id=<uuid> to filter by tender.
// ============================================================
router.get('/received', authenticate, authorize('homeowner'), async (req, res) => {
  const { tender_id } = req.query;
  try {
    const params = [req.user.id];
    let extra = '';
    if (tender_id) {
      params.push(tender_id);
      extra = ` AND q.tender_id = $2`;
    }
    const result = await db.query(`
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        u.id         AS provider_id,
        u.first_name AS provider_first_name,
        u.last_name  AS provider_last_name,
        st.display_name AS tender_title,
        st.emoji        AS tender_emoji
      FROM public.quotes q
      JOIN public.tenders t  ON t.id  = q.tender_id
      JOIN public.users   u  ON u.id  = q.provider_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.client_id = $1 AND t.trashed_at IS NULL${extra}
      ORDER BY q.created_at DESC
    `, params);
    res.json({ success: true, quotes: result.rows });
  } catch (err) {
    console.error('GET /api/quotes/received error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quotes.' });
  }
});

// ============================================================
// PATCH /api/quotes/:id/accept
// Homeowner accepts a quote; all other quotes on the same tender
// are set to 'rejected'.
// ============================================================
router.patch('/:id/accept', authenticate, authorize('homeowner'), async (req, res) => {
  const { id } = req.params;
  try {
    // Superuser query (bypasses RLS) so we can read the winning provider's
    // contact + the quote amount + service name in one shot.
    const check = await db.query(`
      SELECT q.id, q.tender_id, q.provider_id, q.amount, q.status AS quote_status,
             q.provider_fee_rate,
             t.client_id, t.client_fee_rate,
             st.display_name AS service_name,
             pr.email AS provider_email,
             (pr.first_name || ' ' || pr.last_name) AS provider_name
      FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users pr ON pr.id = q.provider_id
      WHERE q.id = $1
    `, [id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quote not found.' });
    }
    const row = check.rows[0];
    if (row.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    // Reject every other quote on the tender; capture the losing providers so we
    // can push them a realtime event (their "My Quotes" flips to "Not selected").
    const rejected = await db.query(
      `UPDATE public.quotes SET status = 'rejected', updated_at = NOW()
       WHERE tender_id = $1 AND id != $2 RETURNING id, provider_id`,
      [row.tender_id, id]
    );
    await db.query(
      `UPDATE public.quotes SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // ── Real-world workflow starts here (WiPay deferred) ──────────────────
    // 1. Record a real transaction so payment/revenue numbers become live.
    //    No money moves yet — status 'held' (escrow-held) until WiPay exists.
    //    Fees are LOCKED at creation time: the client rate snapshotted on the
    //    tender when it was posted, and the provider rate snapshotted on the
    //    quote when it was submitted. A later fee change never re-prices this
    //    job. Fall back to the live config only for pre-snapshot (legacy) rows.
    //    See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
    let clientRate   = row.client_fee_rate   != null ? parseFloat(row.client_fee_rate)   : null;
    let providerRate = row.provider_fee_rate != null ? parseFloat(row.provider_fee_rate) : null;
    if (clientRate == null || providerRate == null) {
      const live = await getActiveRates();
      if (clientRate == null)   clientRate   = live.clientRate;
      if (providerRate == null) providerRate = live.providerRate;
    }
    const amount       = row.amount;                              // JMD cents
    let clientFee      = Math.round((amount * clientRate) / 100);
    let providerFee    = Math.round((amount * providerRate) / 100);
    // Minimum-fee floor (guardrail on low-value jobs): if the % fee falls below
    // the configured minimum, charge the minimum instead. Applied from the
    // current active config at accept time. See PAYMENTS_AND_JOB_WORKFLOW.md.
    const minFees = await getMinFees();
    if (minFees.enabled) {
      clientFee = Math.max(clientFee, minFees.minClientFee);
      // Provider floor clamped to the job amount so the payout can't go negative.
      providerFee = Math.min(Math.max(providerFee, minFees.minProviderFee), amount);
    }
    const providerPayout = amount - providerFee;
    const platformFee    = clientFee + providerFee;

    await db.query(
      `INSERT INTO public.transactions
         (quote_id, tender_id, client_id, provider_id, amount,
          client_fee, provider_fee, client_fee_rate, provider_fee_rate,
          platform_fee, provider_payout, status, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'held',NOW())
       ON CONFLICT (quote_id) DO NOTHING`,
      [id, row.tender_id, row.client_id, row.provider_id, amount,
       clientFee, providerFee, clientRate, providerRate,
       platformFee, providerPayout]
    );

    // 2. Move the tender into the active/in-progress workflow. This also hides
    //    it from other providers' browse (which filters status = 'open').
    await db.query(
      `UPDATE public.tenders SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [row.tender_id]
    );

    res.json({ success: true });

    // ── Fire-and-forget fan-out ───────────────────────────────────────────
    const serviceName = row.service_name || 'your job';
    const winnerTitle  = 'Your quote was accepted 🎉';
    const winnerBody   = `${serviceName} — the job is starting. Open the tender for the homeowner's contact details & location.`;

    Promise.allSettled([
      // Winner realtime event (existing behaviour — drives toast + My Quotes).
      notifyUser(row.provider_id, 'quote-accepted', { quoteId: id, tenderId: row.tender_id }),
      // Winner persistent bell notification.
      db.query(`
        INSERT INTO public.notifications (user_id, type, title, body, data)
        VALUES ($1, 'quote_accepted', $2, $3, $4::jsonb)
      `, [row.provider_id, winnerTitle, winnerBody, JSON.stringify({ tenderId: row.tender_id })]),
      // Winner email.
      sendQuoteAcceptedEmail(row.provider_email, {
        providerName: row.provider_name || 'there',
        tenderTitle: serviceName,
        amount,
      }),
      // Winner web push → deep-links to the tender detail (SW 'view_job' action).
      sendPushToUser(row.provider_id, {
        title: winnerTitle,
        body: winnerBody,
        type: 'quote_accepted',
        url: `/tender/${row.tender_id}`,
        data: { tender_id: row.tender_id },
      }),
      // Losing providers: realtime only (no email/push/bell, per product decision).
      ...rejected.rows.map((r) =>
        notifyUser(r.provider_id, 'quote-rejected', { quoteId: r.id, tenderId: row.tender_id })
      ),
    ]).catch((err) => {
      console.warn('PATCH /api/quotes/:id/accept — side-effect error:', err.message);
    });
  } catch (err) {
    console.error('PATCH /api/quotes/:id/accept error:', err);
    res.status(500).json({ success: false, message: 'Failed to accept quote.' });
  }
});

// ============================================================
// PATCH /api/quotes/:id/mark-done
// Step 1 of the two-step completion handshake: the WINNING PROVIDER marks
// their job done. This only records provider_completed_at on the transaction —
// the tender stays 'in_progress' until the homeowner confirms (or disputes).
// Notifies the homeowner so they can confirm completion / open a dispute.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
// ============================================================
router.patch('/:id/mark-done', authenticate, authorize('provider'), async (req, res) => {
  const { id } = req.params;
  try {
    const check = await db.query(`
      SELECT q.id, q.provider_id, q.status AS quote_status, q.tender_id,
             t.client_id, t.status AS tender_status,
             st.display_name AS service_name,
             tx.id AS transaction_id, tx.status AS transaction_status, tx.provider_completed_at
      FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      LEFT JOIN public.transactions tx ON tx.quote_id = q.id
      WHERE q.id = $1
    `, [id]);

    if (check.rows.length === 0) return res.status(404).json({ success: false, message: 'Quote not found.' });
    const row = check.rows[0];
    if (row.provider_id !== req.user.id) return res.status(403).json({ success: false, message: 'Forbidden.' });
    if (row.quote_status !== 'accepted' || !row.transaction_id) {
      return res.status(409).json({ success: false, message: 'This job is not active.' });
    }
    if (row.transaction_status === 'completed') {
      return res.status(409).json({ success: false, message: 'This job is already completed.' });
    }
    if (row.provider_completed_at) {
      return res.status(409).json({ success: false, message: 'You already marked this job done — awaiting the homeowner.' });
    }

    await db.query(
      `UPDATE public.transactions SET provider_completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.transaction_id]
    );

    res.json({ success: true });

    // ── Notify the homeowner: confirm or dispute ──────────────────────────
    const serviceName = row.service_name || 'your job';
    const title = 'Provider marked the job done ✅';
    const body  = `The provider marked "${serviceName}" as done. Review the work, then confirm completion or open a dispute.`;
    Promise.allSettled([
      notifyUser(row.client_id, 'job-marked-done', { tenderId: row.tender_id }),
      db.query(`
        INSERT INTO public.notifications (user_id, type, title, body, data)
        VALUES ($1, 'job_marked_done', $2, $3, $4::jsonb)
      `, [row.client_id, title, body, JSON.stringify({ tenderId: row.tender_id })]),
      sendPushToUser(row.client_id, {
        title, body, type: 'job_marked_done', url: '/my-tenders', data: { tender_id: row.tender_id },
      }),
    ]).catch((err) => console.warn('PATCH /api/quotes/:id/mark-done — side-effect error:', err.message));
  } catch (err) {
    console.error('PATCH /api/quotes/:id/mark-done error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark the job done.' });
  }
});

// ============================================================
// GET /api/quotes/mine
// Returns all quotes submitted by the current provider.
// ============================================================
router.get('/mine', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        q.provider_fee_rate,
        t.parish, t.urgency, t.category, t.status AS tender_status,
        tx.provider_completed_at,
        disp.description   AS dispute_description,
        disp.image_path    AS dispute_image_path,
        disp.created_at    AS dispute_created_at,
        (disp.id IS NOT NULL) AS has_open_dispute,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.quotes q
      JOIN public.tenders t ON t.id = q.tender_id
      LEFT JOIN public.transactions tx ON tx.quote_id = q.id
      LEFT JOIN LATERAL (
        SELECT d.id, d.description, d.image_path, d.created_at
        FROM public.disputes d
        WHERE d.transaction_id = tx.id AND d.status = 'open'
        ORDER BY d.created_at DESC LIMIT 1
      ) disp ON true
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE q.provider_id = $1
        AND t.trashed_at IS NULL   -- hide quotes on admin-removed tenders (restored if the tender is restored)
      ORDER BY q.created_at DESC
    `, [req.user.id]);

    // Sign any dispute evidence images (private tender-media bucket) in one batch.
    const disputeImagePaths = result.rows.map((r) => r.dispute_image_path).filter(Boolean);
    const disputeUrls = await signedUrlMap(supabase, 'tender-media', disputeImagePaths);

    const quotes = result.rows.map((r) => {
      const { dispute_description, dispute_image_path, dispute_created_at, ...q } = r;
      // NUMERIC → number for the client.
      q.provider_fee_rate = q.provider_fee_rate != null ? parseFloat(q.provider_fee_rate) : null;
      q.dispute = r.has_open_dispute
        ? {
            description: dispute_description,
            createdAt: dispute_created_at,
            imageUrl: dispute_image_path ? (disputeUrls[dispute_image_path] ?? null) : null,
          }
        : null;
      return q;
    });

    res.json({ success: true, quotes });
  } catch (err) {
    console.error('GET /api/quotes/mine error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quotes.' });
  }
});

// ============================================================
// GET /api/quotes/:id
// Returns full details of a single quote.
// Must come AFTER all static paths (/received, /mine) so the
// wildcard /:id does not shadow them.
// Access: homeowner who owns the tender, OR provider who submitted the quote.
// ============================================================
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`
      SELECT
        q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
        q.message, q.what_is_included, q.status, q.created_at,
        q.provider_fee_rate,
        u.id         AS provider_id,
        u.first_name AS provider_first_name,
        u.last_name  AS provider_last_name,
        st.display_name AS tender_title,
        st.emoji        AS tender_emoji,
        t.client_id, t.client_fee_rate
      FROM public.quotes q
      JOIN public.tenders t  ON t.id  = q.tender_id
      JOIN public.users   u  ON u.id  = q.provider_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE q.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quote not found.' });
    }

    const row = result.rows[0];
    const isHomeowner = req.user.role === 'homeowner' && row.client_id === req.user.id;
    const isProvider  = req.user.role === 'provider'  && row.provider_id === req.user.id;

    if (!isHomeowner && !isProvider) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const { client_id: _omit, ...quote } = row;
    // NUMERIC columns come back as strings — send real numbers to the client.
    quote.client_fee_rate   = quote.client_fee_rate   != null ? parseFloat(quote.client_fee_rate)   : null;
    quote.provider_fee_rate = quote.provider_fee_rate != null ? parseFloat(quote.provider_fee_rate) : null;
    res.json({ success: true, quote });
  } catch (err) {
    console.error('GET /api/quotes/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load quote.' });
  }
});

// ============================================================
// CHAT — messages scoped to a quote (provider ↔ tender owner)
// ============================================================

/**
 * Load a quote with the data needed to authorize chat, and resolve which user
 * is "me" and which is the "other" party. Returns null if the quote is missing
 * or the requester is not one of the two parties.
 */
async function loadChatContext(quoteId, reqUser) {
  const result = await db.query(`
    SELECT
      q.id, q.tender_id, q.amount, q.timeline, q.preferred_start_date,
      q.status, q.provider_id,
      u.first_name AS provider_first_name,
      u.last_name  AS provider_last_name,
      st.display_name AS tender_title,
      st.emoji        AS tender_emoji,
      t.client_id,
      cu.first_name   AS client_first_name,
      cu.last_name    AS client_last_name
    FROM public.quotes q
    JOIN public.tenders t ON t.id = q.tender_id
    JOIN public.users   u ON u.id = q.provider_id
    JOIN public.users   cu ON cu.id = t.client_id
    LEFT JOIN public.service_types st ON st.id = t.service_type_id
    WHERE q.id = $1
  `, [quoteId]);

  if (result.rows.length === 0) return { notFound: true };

  const row = result.rows[0];
  const isHomeowner = reqUser.role === 'homeowner' && row.client_id === reqUser.id;
  const isProvider  = reqUser.role === 'provider'  && row.provider_id === reqUser.id;
  if (!isHomeowner && !isProvider) return { forbidden: true };

  const otherUserId = isProvider ? row.client_id : row.provider_id;
  const otherName = isProvider
    ? `${row.client_first_name} ${row.client_last_name}`.trim()
    : `${row.provider_first_name} ${row.provider_last_name}`.trim();

  return { row, isProvider, otherUserId, otherName };
}

// GET /api/quotes/:id/messages — full conversation + header; marks incoming read.
router.get('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const ctx = await loadChatContext(id, req.user);
    if (ctx.notFound)  return res.status(404).json({ success: false, message: 'Quote not found.' });
    if (ctx.forbidden) return res.status(403).json({ success: false, message: 'Forbidden.' });

    const messages = await db.queryAsUser(req.user.id, `
      SELECT id, quote_id, sender_id, recipient_id, body, read, created_at
      FROM public.messages
      WHERE quote_id = $1
      ORDER BY created_at ASC
    `, [id]);

    // Mark messages addressed to me as read (best-effort).
    db.queryAsUser(req.user.id, `
      UPDATE public.messages SET read = true
      WHERE quote_id = $1 AND recipient_id = $2 AND read = false
    `, [id, req.user.id]).catch(() => {});

    const { row } = ctx;
    res.json({
      success: true,
      messages: messages.rows,
      meId: req.user.id,
      quote: {
        id: row.id,
        tender_id: row.tender_id,
        amount: row.amount,
        timeline: row.timeline,
        preferred_start_date: row.preferred_start_date,
        status: row.status,
        tender_title: row.tender_title,
        tender_emoji: row.tender_emoji,
        other_name: ctx.otherName,
        other_role: ctx.isProvider ? 'homeowner' : 'provider',
      },
    });
  } catch (err) {
    console.error('GET /api/quotes/:id/messages error:', err);
    res.status(500).json({ success: false, message: 'Failed to load messages.' });
  }
});

// POST /api/quotes/:id/messages { body } — send a message (PII-blocked).
router.post('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!body) {
    return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
  }
  if (body.length > 2000) {
    return res.status(400).json({ success: false, message: 'Message is too long (max 2000 characters).' });
  }

  // Server-authoritative PII / off-platform block.
  const pii = detectPII(body);
  if (pii.blocked) {
    return res.status(422).json({
      success: false,
      code: 'PII_BLOCKED',
      label: pii.label,
      message: `For your safety, sharing a ${pii.label} is not allowed. Keep the conversation on TendrIt.`,
    });
  }

  try {
    const ctx = await loadChatContext(id, req.user);
    if (ctx.notFound)  return res.status(404).json({ success: false, message: 'Quote not found.' });
    if (ctx.forbidden) return res.status(403).json({ success: false, message: 'Forbidden.' });

    const inserted = await db.queryAsUser(req.user.id, `
      INSERT INTO public.messages (quote_id, sender_id, recipient_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING id, quote_id, sender_id, recipient_id, body, read, created_at
    `, [id, req.user.id, ctx.otherUserId, body]);

    const message = inserted.rows[0];
    res.status(201).json({ success: true, message });

    // ── Fire-and-forget fan-out ──────────────────────────────────
    const senderName = `${req.user.first_name} ${req.user.last_name}`.trim();
    const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;

    // 1. Broadcast to the per-quote channel → both open chat windows update live
    notifyChannel(`quote-chat-${id}`, 'message', { message }).catch(() => {});
    // 2. Directed event → recipient's bell/toast when they're not in the chat
    notifyUser(ctx.otherUserId, 'chat-message', { quoteId: id, messageId: message.id }).catch(() => {});
    // 3. Persistent notification row
    db.query(`
      INSERT INTO public.notifications (user_id, type, title, body, data)
      VALUES ($1, 'new_message', $2, $3, $4::jsonb)
    `, [
      ctx.otherUserId,
      `New message from ${senderName}`,
      preview,
      JSON.stringify({ quoteId: id }),
    ]).catch(err => console.warn('[chat] notification insert error:', err.message));
    // 4. Web push
    sendPushToUser(ctx.otherUserId, {
      title: `New message from ${senderName} 💬`,
      body: preview,
      url: `/chat?quoteId=${id}`,
      type: 'new_message',
      data: { quoteId: id },
    }).catch(() => {});
  } catch (err) {
    console.error('POST /api/quotes/:id/messages error:', err);
    res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
});

module.exports = router;
