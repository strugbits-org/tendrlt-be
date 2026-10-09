// ============================================================
// Admin weekly provider payout batches — the admin Payments page.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md for the full design,
// including the §3 research into Jamaica's national ACH (JCBA) rail that
// the CSV export below is modeled on, and the open item to confirm the
// exact field layout with Scotiabank Jamaica Business Banking before the
// first real batch is uploaded.
//
// A transaction becomes "payable" once the homeowner confirms completion
// (status = 'completed', completed_at set) — not merely 'held' in escrow.
// Admins group payable transactions by ISO week, optionally export a CSV
// for the Scotiabank EFT upload (which lazily creates/updates a
// payout_batches row), then mark the week — or individual providers within
// it — as paid once the bank batch has actually been processed. That flips
// the relevant transactions to the terminal 'paid' status.
// ============================================================
const express = require('express');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const paymentCrypto = require('../lib/paymentCrypto');

const router = express.Router();

router.use(authenticate, authorize('admin'));

const PAYABLE_STATUSES = ['completed', 'paid'];

// ISO weeks run Monday–Sunday (matches date_trunc('week', ...) below) — every
// weekStart this API accepts or returns must land on a Monday, or the
// detail/mark-paid/export-csv 7-day window would silently drift from the
// summary endpoint's week boundaries.
const isMonday = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
};

const deriveStatus = (paidCount, totalCount) => {
  if (totalCount === 0) return 'pending';
  if (paidCount === totalCount) return 'paid';
  if (paidCount === 0) return 'pending';
  return 'partial';
};

// ============================================================
// GET /api/admin/payouts — weekly summary table.
// One row per ISO week that has at least one payable transaction, newest
// first, capped to the last 26 weeks (~6 months) so the page stays light.
// ============================================================
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        to_char(date_trunc('week', tx.completed_at), 'YYYY-MM-DD') AS week_start,
        to_char(date_trunc('week', tx.completed_at) + INTERVAL '6 days', 'YYYY-MM-DD') AS week_end,
        EXTRACT(week FROM tx.completed_at)::int AS week_number,
        EXTRACT(isoyear FROM tx.completed_at)::int AS week_year,
        COUNT(DISTINCT tx.provider_id)::int AS provider_count,
        COUNT(*)::int AS job_count,
        COALESCE(SUM(tx.amount), 0)::bigint AS gross_cents,
        COALESCE(SUM(tx.provider_payout), 0)::bigint AS provider_payout_cents,
        COALESCE(SUM(tx.provider_fee), 0)::bigint AS provider_fee_cents,
        COUNT(*) FILTER (WHERE tx.status = 'paid')::int AS paid_count,
        MAX(tx.paid_at) AS last_paid_at,
        MAX(pb.csv_downloaded_at) AS csv_downloaded_at
      FROM public.transactions tx
      LEFT JOIN public.payout_batches pb ON pb.id = tx.payout_batch_id
      WHERE tx.status = ANY($1::transaction_status[])
        AND tx.completed_at IS NOT NULL
      GROUP BY 1, 2, 3, 4
      ORDER BY week_start DESC
      LIMIT 26
    `, [PAYABLE_STATUSES]);

    const weeks = result.rows.map((r) => ({
      weekStart: r.week_start,
      weekEnd: r.week_end,
      weekNumber: r.week_number,
      weekYear: r.week_year,
      providerCount: r.provider_count,
      jobCount: r.job_count,
      grossCents: Number(r.gross_cents),
      providerPayoutCents: Number(r.provider_payout_cents),
      providerFeeCents: Number(r.provider_fee_cents),
      status: deriveStatus(r.paid_count, r.job_count),
      paidAt: r.last_paid_at,
      csvDownloadedAt: r.csv_downloaded_at,
    }));

    res.json({ success: true, weeks });
  } catch (err) {
    console.error('GET /api/admin/payouts error:', err);
    res.status(500).json({ success: false, message: 'Failed to load payout weeks.' });
  }
});

// ============================================================
// GET /api/admin/payouts/:weekStart — per-provider breakdown for one week.
// ============================================================
router.get('/:weekStart', async (req, res) => {
  const { weekStart } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !isMonday(weekStart)) {
    return res.status(400).json({ success: false, message: 'weekStart must be a YYYY-MM-DD Monday.' });
  }
  try {
    const result = await db.query(`
      SELECT
        tx.provider_id,
        (u.first_name || ' ' || u.last_name) AS provider_name,
        COUNT(*)::int AS job_count,
        COALESCE(SUM(tx.amount), 0)::bigint AS gross_cents,
        COALESCE(SUM(tx.provider_payout), 0)::bigint AS provider_payout_cents,
        COALESCE(SUM(tx.provider_fee), 0)::bigint AS provider_fee_cents,
        COUNT(*) FILTER (WHERE tx.status = 'paid')::int AS paid_count,
        COUNT(*)::int AS total_count,
        EXISTS (
          SELECT 1 FROM public.provider_payment_details pd
          WHERE pd.provider_id = tx.provider_id
            AND pd.account_number_encrypted IS NOT NULL
            AND pd.bank_name IS NOT NULL AND pd.transit_code IS NOT NULL
        ) AS has_payment_details,
        array_agg(tx.id) AS transaction_ids
      FROM public.transactions tx
      JOIN public.users u ON u.id = tx.provider_id
      WHERE tx.status = ANY($1::transaction_status[])
        AND tx.completed_at >= $2::date
        AND tx.completed_at < ($2::date + INTERVAL '7 days')
      GROUP BY tx.provider_id, u.first_name, u.last_name
      ORDER BY provider_name
    `, [PAYABLE_STATUSES, weekStart]);

    const providers = result.rows.map((r) => ({
      providerId: r.provider_id,
      providerName: r.provider_name,
      jobCount: r.job_count,
      grossCents: Number(r.gross_cents),
      providerPayoutCents: Number(r.provider_payout_cents),
      providerFeeCents: Number(r.provider_fee_cents),
      status: deriveStatus(r.paid_count, r.total_count),
      hasPaymentDetails: r.has_payment_details,
      transactionIds: r.transaction_ids,
    }));

    res.json({ success: true, weekStart, providers });
  } catch (err) {
    console.error('GET /api/admin/payouts/:weekStart error:', err);
    res.status(500).json({ success: false, message: 'Failed to load week detail.' });
  }
});

// ============================================================
// PATCH /api/admin/payouts/mark-paid
// body: { items: [{ weekStart, providerIds?: string[] }] }
// providerIds omitted/null marks the WHOLE week as paid; present marks only
// those providers' transactions for that week (used by the detail view's
// own "Mark Selected as Paid").
// ============================================================
router.patch('/mark-paid', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, message: 'items must be a non-empty array.' });
  }
  for (const item of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.weekStart || '') || !isMonday(item.weekStart)) {
      return res.status(400).json({ success: false, message: 'Each item needs a weekStart (YYYY-MM-DD Monday).' });
    }
    if (item.providerIds != null && !Array.isArray(item.providerIds)) {
      return res.status(400).json({ success: false, message: 'providerIds must be an array when present.' });
    }
  }

  try {
    let updated = 0;
    for (const item of items) {
      const providerIds = item.providerIds && item.providerIds.length > 0 ? item.providerIds : null;
      const result = await db.query(
        `UPDATE public.transactions
            SET status = 'paid', paid_at = NOW()
          WHERE status = 'completed'
            AND completed_at >= $1::date
            AND completed_at < ($1::date + INTERVAL '7 days')
            AND ($2::uuid[] IS NULL OR provider_id = ANY($2::uuid[]))
          RETURNING id`,
        [item.weekStart, providerIds]
      );
      updated += result.rowCount;
    }
    res.json({ success: true, updated });
  } catch (err) {
    console.error('PATCH /api/admin/payouts/mark-paid error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark as paid.' });
  }
});

// ============================================================
// GET /api/admin/payouts/:weekStart/export-csv
// Generates a Scotiabank-bound EFT batch CSV for a week's still-unpaid
// payable transactions, grouped by provider. See the field-mapping comment
// below — this is a best-effort CSV wrapper over Jamaica's JCBA/ACH PPD
// Entry Detail fields (documentation/PAYMENTS_AND_JOB_WORKFLOW.md §3), NOT
// yet confirmed against Scotiabank's actual upload template. Providers
// missing banking details are silently skipped (can't be paid by this
// file); the count is returned in the X-Skipped-Providers header so the
// frontend can warn before/after download.
// ============================================================
router.get('/:weekStart/export-csv', async (req, res) => {
  const { weekStart } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !isMonday(weekStart)) {
    return res.status(400).json({ success: false, message: 'weekStart must be a YYYY-MM-DD Monday.' });
  }
  try {
    const result = await db.query(`
      SELECT
        tx.provider_id,
        COALESCE(SUM(tx.provider_payout), 0)::bigint AS provider_payout_cents,
        pd.payee_first_name, pd.middle_initial, pd.payee_surname, pd.business_name, pd.account_ownership,
        pd.recipient_id, pd.bank_name, pd.transit_code, pd.account_type,
        pd.account_number_encrypted
      FROM public.transactions tx
      LEFT JOIN public.provider_payment_details pd ON pd.provider_id = tx.provider_id
      WHERE tx.status = 'completed'
        AND tx.completed_at >= $1::date
        AND tx.completed_at < ($1::date + INTERVAL '7 days')
      GROUP BY tx.provider_id, pd.payee_first_name, pd.middle_initial, pd.payee_surname,
               pd.business_name, pd.account_ownership, pd.recipient_id, pd.bank_name,
               pd.transit_code, pd.account_type, pd.account_number_encrypted
    `, [weekStart]);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const rows = [];
    let skipped = 0;
    for (const r of result.rows) {
      const hasBanking = r.account_number_encrypted && r.bank_name && r.transit_code;
      if (!hasBanking) { skipped++; continue; }

      let accountNumber;
      try {
        accountNumber = paymentCrypto.decrypt(r.account_number_encrypted);
      } catch (decErr) {
        console.error('Payout CSV decrypt failed for provider', r.provider_id, decErr.message);
        skipped++;
        continue;
      }

      const payeeName = r.account_ownership === 'business' && r.business_name
        ? r.business_name
        : [r.payee_first_name, r.middle_initial, r.payee_surname].filter(Boolean).join(' ');

      rows.push([
        payeeName,
        r.recipient_id || '',
        r.bank_name || '',
        r.transit_code || '',
        r.account_type || '',
        accountNumber || '',
        (Number(r.provider_payout_cents) / 100).toFixed(2),
        'JMD',
        `TendrIt Payout WK${weekStart}`,
        weekStart,
      ]);
    }

    // Lazily create/update the payout_batches row so repeated downloads and
    // the mark-paid flow share one identity for this week.
    await db.query(
      `INSERT INTO public.payout_batches (week_start, week_end, created_by, csv_downloaded_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (week_start, week_end) DO UPDATE SET csv_downloaded_at = NOW()`,
      [weekStart, weekEnd.toISOString().slice(0, 10), req.user.id]
    );
    // Link this week's payable transactions to the batch for traceability
    // (does not change their status — only mark-paid does that).
    await db.query(
      `UPDATE public.transactions tx
          SET payout_batch_id = pb.id
         FROM public.payout_batches pb
        WHERE pb.week_start = $1 AND pb.week_end = $2
          AND tx.status IN ('completed', 'paid')
          AND tx.completed_at >= $1::date AND tx.completed_at < ($1::date + INTERVAL '7 days')
          AND tx.payout_batch_id IS NULL`,
      [weekStart, weekEnd.toISOString().slice(0, 10)]
    );

    const header = [
      'Payee Name', 'Individual ID (TRN)', 'Bank Name', 'Transit Code',
      'Account Type', 'Account Number', 'Amount', 'Currency', 'Reference', 'Payment Date',
    ];
    const csvLines = [header, ...rows].map((row) =>
      row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );
    const csv = csvLines.join('\r\n');

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tendrit-payout-${weekStart}.csv"`);
    res.set('X-Skipped-Providers', String(skipped));
    res.send(csv);
  } catch (err) {
    console.error('GET /api/admin/payouts/:weekStart/export-csv error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate CSV.' });
  }
});

module.exports = router;
