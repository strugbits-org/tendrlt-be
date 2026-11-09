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
const { PAYABLE_STATUSES } = require('../lib/payoutStatuses');

const router = express.Router();

router.use(authenticate, authorize('admin'));

// ISO weeks run Monday–Sunday (matches date_trunc('week', ...) below) — every
// weekStart this API accepts or returns must land on a Monday, or the
// detail/mark-paid/export-csv 7-day window would silently drift from the
// summary endpoint's week boundaries. Every date_trunc/range comparison on
// completed_at in this file is pinned to 'America/Jamaica' (not left on the
// DB session's own timezone, currently UTC) so a job completed in the
// evening Jamaica time isn't bucketed into the wrong day/week, and so this
// file's own endpoints and admin.js's fee-config/batch-log endpoint always
// agree on where a week starts.
//
// Deploy-cutover note: this shifts every week boundary by Jamaica's UTC-5
// offset versus the previous UTC-anchored version. A CSV downloaded under
// the old boundaries and a mark-paid run after this deploys could in theory
// disagree on which transactions belong to a given weekStart. Verified at
// the time this shipped that there were no open (unpaid) weeks on the
// shared dev/staging DB, so there was nothing to regroup. If this ever
// redeploys onto a DB with an open unpaid week, download fresh CSVs (under
// the new boundaries) before running mark-paid for that week rather than
// reusing a pre-deploy file.
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
        to_char(date_trunc('week', tx.completed_at AT TIME ZONE 'America/Jamaica'), 'YYYY-MM-DD') AS week_start,
        to_char(date_trunc('week', tx.completed_at AT TIME ZONE 'America/Jamaica') + INTERVAL '6 days', 'YYYY-MM-DD') AS week_end,
        EXTRACT(week FROM tx.completed_at AT TIME ZONE 'America/Jamaica')::int AS week_number,
        EXTRACT(isoyear FROM tx.completed_at AT TIME ZONE 'America/Jamaica')::int AS week_year,
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
        AND tx.completed_at >= ($2::date AT TIME ZONE 'America/Jamaica')
        AND tx.completed_at < (($2::date + INTERVAL '7 days') AT TIME ZONE 'America/Jamaica')
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
            AND completed_at >= ($1::date AT TIME ZONE 'America/Jamaica')
            AND completed_at < (($1::date + INTERVAL '7 days') AT TIME ZONE 'America/Jamaica')
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
// Generates a payout CSV, grouped by provider. Providers missing banking
// details are silently skipped (can't be paid by any of these files); the
// count is returned in the X-Skipped-Providers header so the frontend can
// warn before/after download.
//
// Default (no query param) is now the FULL review export: every field
// collected on the provider Payment Info form, not just the subset the
// bank-upload file's fixed 10-column layout actually uses, and it includes
// already-paid transactions (a review is pointless if it silently excludes
// them). This is the client's requested default so they can see everything
// currently collected and say what to drop — it is NOT meant for bank
// upload, and masks account/ABA numbers accordingly.
//
// ?bank=1 is the actual Scotiabank-bound EFT batch file — see the
// field-mapping comment below, a best-effort CSV wrapper over Jamaica's
// JCBA/ACH PPD Entry Detail fields (documentation/PAYMENTS_AND_JOB_WORKFLOW.md
// §3), NOT yet confirmed against Scotiabank's actual upload template. Its
// 10-column layout is kept exactly as before so adding a feature here can't
// be the thing that gets a real file rejected by the bank. UNPAID (status =
// 'completed') transactions only, so an admin can never re-upload a batch
// that was already paid and double-pay a provider; account numbers are left
// unmasked since this file is the actual bank submission. For the original
// "CSV is empty" case — a week that's already fully paid — this file is
// correctly empty; there's nothing left to pay. This is the only mode that
// lazily creates/updates the payout_batches row and links transactions to
// it, so an admin running a real payout must use ?bank=1, not the default.
//
// ?includePaid=1 (without ?bank=1) is a records-only export, included for
// backward compatibility — also includes already-paid transactions and
// masks the account number, but without the full set of extra fields.
// ============================================================
router.get('/:weekStart/export-csv', async (req, res) => {
  const { weekStart } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !isMonday(weekStart)) {
    return res.status(400).json({ success: false, message: 'weekStart must be a YYYY-MM-DD Monday.' });
  }
  const bankOnly = req.query.bank === '1';
  const fullReview = !bankOnly && req.query.includePaid !== '1';
  const includePaid = !bankOnly;
  const statuses = includePaid ? PAYABLE_STATUSES : ['completed'];
  try {
    const result = await db.query(`
      SELECT
        tx.provider_id,
        -- Only ever sums the still-payable (unpaid) portion, even in
        -- records mode, so Amount can never include money already sent.
        COALESCE(SUM(tx.provider_payout) FILTER (WHERE tx.status = 'completed'), 0)::bigint AS provider_payout_cents,
        bool_and(tx.status = 'paid') AS all_paid,
        bool_or(tx.status = 'paid') AS any_paid,
        pd.payee_first_name, pd.middle_initial, pd.payee_surname, pd.business_name, pd.account_ownership,
        pd.recipient_id, pd.bank_name, pd.transit_code, pd.account_type,
        pd.account_number_encrypted,
        pd.swift_code, pd.bank_branch, pd.bank_address, pd.currency, pd.aba_routing_encrypted
      FROM public.transactions tx
      LEFT JOIN public.provider_payment_details pd ON pd.provider_id = tx.provider_id
      WHERE tx.status = ANY($2::transaction_status[])
        AND tx.completed_at >= ($1::date AT TIME ZONE 'America/Jamaica')
        AND tx.completed_at < (($1::date + INTERVAL '7 days') AT TIME ZONE 'America/Jamaica')
      GROUP BY tx.provider_id, pd.payee_first_name, pd.middle_initial, pd.payee_surname,
               pd.business_name, pd.account_ownership, pd.recipient_id, pd.bank_name,
               pd.transit_code, pd.account_type, pd.account_number_encrypted,
               pd.swift_code, pd.bank_branch, pd.bank_address, pd.currency, pd.aba_routing_encrypted
    `, [weekStart, statuses]);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    // Records mode isn't a bank submission, so it has no need for the
    // full account number — only the bank-upload file (below) needs it
    // verbatim. Masking everything but the last 4 digits here limits
    // exposure if this file is ever shared/stored less carefully than
    // the actual bank file. Plain '*' rather than a UTF-8 bullet: this
    // CSV has no BOM, and Excel (which ignores the Content-Type charset
    // for a downloaded file) would otherwise render a multi-byte
    // character as mojibake.
    const mask = (digits) => (digits.length <= 4 ? digits : '*'.repeat(digits.length - 4) + digits.slice(-4));

    const rows = [];
    let skipped = 0;
    let alreadyPaidCount = 0;
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
      if (includePaid && accountNumber) {
        accountNumber = mask(String(accountNumber));
      }

      const payeeName = r.account_ownership === 'business' && r.business_name
        ? r.business_name
        : [r.payee_first_name, r.middle_initial, r.payee_surname].filter(Boolean).join(' ');

      if (r.all_paid) alreadyPaidCount++;

      const row = [
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
      ];
      if (includePaid) row.push(r.all_paid ? 'ALREADY PAID' : r.any_paid ? 'MIXED - PARTIALLY PAID' : 'UNPAID');

      if (fullReview) {
        // Same masking treatment as the account number — this file is for
        // review, not a real transfer, so neither banking identifier needs
        // to leave the system in full.
        let aba = '';
        if (r.aba_routing_encrypted) {
          try { aba = mask(String(paymentCrypto.decrypt(r.aba_routing_encrypted))); }
          catch (decErr) {
            console.error('Payout CSV review decrypt (ABA) failed for provider', r.provider_id, decErr.message);
            // A blank cell here would read identically to "no ABA on file" —
            // this file's whole purpose is showing what's actually collected,
            // so a decrypt failure needs its own distinguishable marker.
            aba = 'DECRYPT ERROR';
          }
        }
        row.push(
          r.account_ownership || '',
          r.business_name || '',
          r.swift_code || '',
          r.bank_branch || '',
          r.bank_address || '',
          aba,
          (r.currency || 'jmd').toUpperCase(),
        );
      }
      rows.push(row);
    }

    // Lazily create/update the payout_batches row so repeated downloads and
    // the mark-paid flow share one identity for this week. Records-mode
    // exports don't touch this — they're not a bank submission.
    if (!includePaid) {
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
            AND tx.completed_at >= ($1::date AT TIME ZONE 'America/Jamaica')
            AND tx.completed_at < (($1::date + INTERVAL '7 days') AT TIME ZONE 'America/Jamaica')
            AND tx.payout_batch_id IS NULL`,
        [weekStart, weekEnd.toISOString().slice(0, 10)]
      );
    } else {
      // Not a payout_batches write (this isn't a bank submission), but
      // still bank account data leaving the system — recorded durably
      // (payout_csv_export_log, see its migration) rather than only
      // console.log, which is lost on log rotation/restart. Best-effort:
      // a logging failure shouldn't block an admin from getting their
      // export, so it's caught and reported separately from the main
      // try/catch's "Failed to generate CSV" response.
      try {
        await db.query(
          `INSERT INTO public.payout_csv_export_log (week_start, admin_id, export_mode) VALUES ($1, $2, $3)`,
          [weekStart, req.user.id, fullReview ? 'full' : 'records']
        );
      } catch (logErr) {
        console.error('Failed to record payout_csv_export_log entry:', logErr.message);
      }
      console.log(`${fullReview ? 'Full-review' : 'Records-mode'} payout CSV exported for week ${weekStart} by admin ${req.user.id} at ${new Date().toISOString()}`);
    }

    const header = [
      'Payee Name', 'Individual ID (TRN)', 'Bank Name', 'Transit Code',
      'Account Type', 'Account Number', 'Amount', 'Currency', 'Reference', 'Payment Date',
    ];
    if (includePaid) header.push('Status');
    if (fullReview) {
      header.push(
        'Account Ownership', 'Business Name', 'SWIFT/BIC Code', 'Bank Branch',
        'Bank Branch Address', 'ABA/Routing Number', 'Account Currency'
      );
    }
    const csvLines = [header, ...rows].map((row) =>
      row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );
    if (includePaid) {
      // A clearer marker than the filename suffix alone: Amount is 0 for
      // fully-paid rows here and the Status column changes the layout, but
      // it's still easy to mistake for the bank file at a glance. This
      // banner is a harmless extra "column" to any real CSV parser/bank
      // template, since it never reaches the bank-upload path.
      csvLines.unshift(fullReview
        ? '"FOR INTERNAL REVIEW ONLY - EVERY COLLECTED FIELD - DO NOT UPLOAD TO BANK"'
        : '"FOR INTERNAL RECORDS ONLY - DO NOT UPLOAD TO BANK"');
    }
    const csv = csvLines.join('\r\n');

    const filenameSuffix = fullReview ? '-full-review' : (includePaid ? '-records' : '-bank-upload');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="tendrit-payout-${weekStart}${filenameSuffix}.csv"`);
    res.set('X-Skipped-Providers', String(skipped));
    res.set('X-Already-Paid-Providers', String(alreadyPaidCount));
    res.send(csv);
  } catch (err) {
    console.error('GET /api/admin/payouts/:weekStart/export-csv error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate CSV.' });
  }
});

module.exports = router;
