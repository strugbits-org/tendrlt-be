const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const supabase = require('../lib/supabaseClient');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyChannel } = require('../lib/realtimeService');
const { sendNewProviderSubmittedEmail } = require('../lib/verificationEmails');
const paymentCrypto = require('../lib/paymentCrypto');
const { createVerificationSession } = require('../lib/didit');

const router = express.Router();

// Memory storage — file bytes held in RAM briefly, then streamed to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 104857600 }, // 100 MB max
});

// Map onboarding docType keys → Supabase bucket + Storage path prefix
const BUCKETS = {
  insurance:    'provider-documents',
  trade_cert:   'provider-documents',
  business_reg: 'provider-documents',
  gov_id:       'provider-documents',
  portfolio:    'provider-portfolio',
};

const VALID_DOC_TYPES = Object.keys(BUCKETS).filter(k => k !== 'portfolio');

// ============================================================
// GET /api/providers/me
// Returns full profile + services + parishes for the logged-in provider.
// Used on onboarding page mount to restore form state after refresh.
// ============================================================
router.get('/me', authenticate, authorize('provider'), async (req, res) => {
  try {
    // Single query + single transaction instead of 3 separate queryAsUser calls.
    // Before: 3 × 5 = 15 DB round trips.  After: 3 round trips total.
    // Wrap array_agg results in json_agg so pg parses them as JS arrays,
    // not raw PostgreSQL array strings (which happens inside scalar subqueries).
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        (SELECT to_json(p.*) FROM public.provider_profiles p WHERE p.provider_id = $1) AS profile,
        (
          SELECT COALESCE(json_agg(s.category::text ORDER BY s.created_at), '[]'::json)
          FROM public.provider_services s WHERE s.provider_id = $1
        ) AS services,
        (
          SELECT COALESCE(json_agg(pa.parish ORDER BY pa.created_at), '[]'::json)
          FROM public.provider_parishes pa WHERE pa.provider_id = $1
        ) AS parishes
    `, [req.user.id]);

    const row = result.rows[0];
    res.json({
      success: true,
      profile:  row.profile  || null,
      services: row.services || [],
      parishes: row.parishes || [],
      user: {
        first_name:       req.user.first_name,
        last_name:        req.user.last_name,
        phone_number:     req.user.phone_number,
        parish:           req.user.parish,
        provider_service: req.user.provider_service,
      },
    });
  } catch (err) {
    console.error('GET /api/providers/me error:', err);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// ============================================================
// POST /api/providers/verification/session
// Creates a hosted Didit verification session and stores the session id so
// the webhook can later match its update back to this provider. Returns the
// hosted URL for the frontend to redirect the provider to (full navigation,
// same pattern as the Google OAuth flow — see app/(auth)/auth/page.tsx).
// ============================================================
router.post('/verification/session', authenticate, authorize('provider'), async (req, res) => {
  try {
    const callbackUrl = `${process.env.FRONTEND_URL}/provider-onboarding?step=6`;
    const { sessionId, url } = await createVerificationSession({
      providerId: req.user.id,
      callbackUrl,
    });

    await db.queryAsUser(req.user.id,
      `INSERT INTO public.provider_profiles (provider_id, didit_session_id, didit_status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (provider_id) DO UPDATE
         SET didit_session_id = $2,
             didit_status     = 'pending',
             updated_at       = NOW()`,
      [req.user.id, sessionId]
    );

    res.json({ success: true, url });
  } catch (err) {
    console.error('POST /api/providers/verification/session error:', err);
    res.status(500).json({ success: false, message: 'Failed to start identity verification.' });
  }
});

// ============================================================
// PUT /api/providers/profile
// Upserts provider_profiles row.
// Uses COALESCE so partial updates (e.g. only portfolio_link) do not
// overwrite previously saved fields with null.
// Also updates users.phone_number if phone_number is provided.
// ============================================================
router.put('/profile', authenticate, authorize('provider'), async (req, res) => {
  const {
    bio,
    business_name,
    years_experience,
    typical_price_min,
    typical_price_max,
    portfolio_link,
    phone_number,
  } = req.body;

  try {
    await db.queryAsUser(req.user.id,
      `INSERT INTO public.provider_profiles
         (provider_id, bio, business_name, years_experience, typical_price_min, typical_price_max, portfolio_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_id) DO UPDATE
         SET bio                = COALESCE($2,   provider_profiles.bio),
             business_name      = COALESCE($3,   provider_profiles.business_name),
             years_experience   = COALESCE($4,   provider_profiles.years_experience),
             typical_price_min  = COALESCE($5,   provider_profiles.typical_price_min),
             typical_price_max  = COALESCE($6,   provider_profiles.typical_price_max),
             portfolio_link     = COALESCE($7,   provider_profiles.portfolio_link),
             updated_at         = NOW()`,
      [
        req.user.id,
        bio             ?? null,
        business_name   ?? null,
        years_experience ?? null,
        typical_price_min != null ? Number(typical_price_min) : null,
        typical_price_max != null ? Number(typical_price_max) : null,
        portfolio_link  ?? null,
      ]
    );

    if (phone_number) {
      await db.queryAsUser(req.user.id,
        `UPDATE public.users SET phone_number = $1, updated_at = NOW() WHERE id = $2`,
        [phone_number, req.user.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to save profile.' });
  }
});

// ============================================================
// PUT /api/providers/services
// Atomically replaces all services for this provider using a
// data-modifying CTE (DELETE + INSERT in one statement).
// ============================================================
// PUT /api/providers/services
// Accepts optional price range fields alongside categories so the frontend
// can save step 2 (services + price) in a single request instead of two.
router.put('/services', authenticate, authorize('provider'), async (req, res) => {
  const { categories, typical_price_min, typical_price_max } = req.body;

  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one service category is required.' });
  }

  const priceMin = typical_price_min != null ? Number(typical_price_min) : null;
  const priceMax = typical_price_max != null ? Number(typical_price_max) : null;

  try {
    // Three sequential statements in one transaction.
    // DELETE then INSERT as separate statements (not a CTE) so the INSERT
    // sees the committed DELETE — avoids unique-constraint conflicts when
    // re-saving a category that was already in the table.
    // DISTINCT on UNNEST guards against duplicate values in the input array.
    await db.queryAsUserBatch(req.user.id, [
      {
        text:   `DELETE FROM public.provider_services WHERE provider_id = $1`,
        params: [req.user.id],
      },
      {
        // categories are TEXT slugs from the frontend; cast to enum + join for service_type_id
        text: `INSERT INTO public.provider_services (provider_id, category, service_type_id)
               SELECT $1, cat::service_category, st.id
               FROM (SELECT DISTINCT UNNEST($2::text[]) AS cat) t
               JOIN public.service_types st ON st.slug = t.cat`,
        params: [req.user.id, categories],
      },
      {
        text: `INSERT INTO public.provider_profiles (provider_id, typical_price_min, typical_price_max)
               VALUES ($1, $2, $3)
               ON CONFLICT (provider_id) DO UPDATE
                 SET typical_price_min = COALESCE($2, provider_profiles.typical_price_min),
                     typical_price_max = COALESCE($3, provider_profiles.typical_price_max),
                     updated_at        = NOW()`,
        params: [req.user.id, priceMin, priceMax],
      },
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/services error:', err);
    res.status(500).json({ success: false, message: 'Failed to save services.' });
  }
});

// ============================================================
// PUT /api/providers/parishes
// Atomically replaces all parishes for this provider.
// ============================================================
router.put('/parishes', authenticate, authorize('provider'), async (req, res) => {
  const { parishes } = req.body;

  if (!Array.isArray(parishes) || parishes.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one parish is required.' });
  }

  try {
    await db.queryAsUserBatch(req.user.id, [
      {
        text:   `DELETE FROM public.provider_parishes WHERE provider_id = $1`,
        params: [req.user.id],
      },
      {
        text: `INSERT INTO public.provider_parishes (provider_id, parish)
               SELECT $1, parish FROM (SELECT DISTINCT UNNEST($2::text[]) AS parish) t`,
        params: [req.user.id, parishes],
      },
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/parishes error:', err);
    res.status(500).json({ success: false, message: 'Failed to save parishes.' });
  }
});

// ============================================================
// POST /api/providers/upload/document
// Accepts multipart/form-data with fields: file, docType
// Uploads to provider-documents bucket (private), stores path in
// provider_profiles.documents JSONB.
// ============================================================
router.post('/upload/document',
  authenticate,
  authorize('provider'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    const { docType } = req.body;
    if (!VALID_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ success: false, message: 'Invalid document type.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
    const storagePath = `${req.user.id}/${docType}/${Date.now()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('provider-documents')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return res.status(500).json({ success: false, message: 'File upload failed.' });
    }

    try {
      await db.queryAsUser(req.user.id,
        `INSERT INTO public.provider_profiles (provider_id, documents)
         VALUES ($1, jsonb_build_object($2::text, $3::text))
         ON CONFLICT (provider_id) DO UPDATE
           SET documents  = provider_profiles.documents || jsonb_build_object($2::text, $3::text),
               updated_at = NOW()`,
        [req.user.id, docType, storagePath]
      );

      res.json({ success: true, path: storagePath });
    } catch (err) {
      console.error('Document DB update error:', err);
      res.status(500).json({ success: false, message: 'Uploaded but failed to save path.' });
    }
  }
);

// ============================================================
// POST /api/providers/upload/portfolio
// Uploads a portfolio photo/video to the provider-portfolio bucket
// (public) and appends the path to provider_profiles.portfolio_paths.
// ============================================================
router.post('/upload/portfolio',
  authenticate,
  authorize('provider'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.bin';
    const storagePath = `${req.user.id}/portfolio/${Date.now()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('provider-portfolio')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error('Portfolio upload error:', uploadError);
      return res.status(500).json({ success: false, message: 'Portfolio upload failed.' });
    }

    try {
      await db.queryAsUser(req.user.id,
        `INSERT INTO public.provider_profiles (provider_id, portfolio_paths)
         VALUES ($1, ARRAY[$2::text])
         ON CONFLICT (provider_id) DO UPDATE
           SET portfolio_paths = array_append(provider_profiles.portfolio_paths, $2::text),
               updated_at      = NOW()`,
        [req.user.id, storagePath]
      );

      res.json({ success: true, path: storagePath });
    } catch (err) {
      console.error('Portfolio DB update error:', err);
      res.status(500).json({ success: false, message: 'Uploaded but failed to save path.' });
    }
  }
);

// ============================================================
// DELETE /api/providers/upload/portfolio
// Body: { path: 'provider-portfolio/...' }
// Removes file from storage and strips path from portfolio_paths.
// ============================================================
router.delete('/upload/portfolio', authenticate, authorize('provider'), async (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ success: false, message: 'path is required.' });
  }

  const { error: deleteError } = await supabase.storage
    .from('provider-portfolio')
    .remove([filePath]);

  if (deleteError) {
    console.error('Storage delete error:', deleteError);
    return res.status(500).json({ success: false, message: 'File delete failed.' });
  }

  try {
    await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
         SET portfolio_paths = array_remove(portfolio_paths, $1::text),
             updated_at      = NOW()
       WHERE provider_id = $2`,
      [filePath, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Portfolio delete DB error:', err);
    res.status(500).json({ success: false, message: 'Deleted from storage but failed to update DB.' });
  }
});

// ============================================================
// GET /api/providers/stats
// KPI counts for the provider dashboard header cards.
// ============================================================
router.get('/stats', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        -- Only live tenders: open, not admin-removed, not expired (matches Browse).
        (SELECT COUNT(*)::int FROM public.tenders
           WHERE status = 'open' AND trashed_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())) AS open_tenders,
        (SELECT COUNT(*)::int FROM public.tenders t
           WHERE t.status = 'open' AND t.trashed_at IS NULL
             AND (t.expires_at IS NULL OR t.expires_at > NOW())
             AND t.category IN (
               SELECT category FROM public.provider_services WHERE provider_id = $1
             )) AS matched_open_tenders,
        -- Quotes on admin-removed tenders are hidden, so exclude them (matches My Quotes).
        (SELECT COUNT(*)::int FROM public.quotes q
           JOIN public.tenders t ON t.id = q.tender_id
           WHERE q.provider_id = $1 AND t.trashed_at IS NULL) AS quotes_submitted,
        (SELECT COUNT(*)::int FROM public.quotes q
           JOIN public.tenders t ON t.id = q.tender_id
           WHERE q.provider_id = $1 AND q.status = 'accepted' AND t.trashed_at IS NULL) AS jobs_won,
        (SELECT ROUND(AVG(rating)::numeric, 1) FROM public.reviews WHERE provider_id = $1) AS avg_rating,
        (SELECT COUNT(*)::int FROM public.reviews WHERE provider_id = $1) AS review_count
    `, [req.user.id]);

    const row = result.rows[0];
    res.json({
      success: true,
      openTenders:         row.open_tenders         ?? 0,
      matchedOpenTenders:  row.matched_open_tenders  ?? 0,
      quotesSubmitted:     row.quotes_submitted      ?? 0,
      jobsWon:             row.jobs_won              ?? 0,
      avgRating:           row.avg_rating            ? parseFloat(row.avg_rating) : null,
      reviewCount:         row.review_count          ?? 0,
    });
  } catch (err) {
    console.error('GET /api/providers/stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

// ============================================================
// GET /api/providers/earnings
// Real earnings for the provider, sourced from public.transactions
// (created when a homeowner accepts a quote — WiPay deferred, status 'held').
// All amounts are JMD cents. Uses the superuser pool so we can join the
// homeowner's (masked) name; strictly filtered by provider_id = the caller.
// See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
// ============================================================
router.get('/earnings', authenticate, authorize('provider'), async (req, res) => {
  try {
    const uid = req.user.id;

    const agg = await db.query(`
      SELECT
        -- This month
        COALESCE(SUM(amount)          FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS gross_month,
        COALESCE(SUM(provider_fee)    FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS fee_month,
        COALESCE(SUM(provider_payout) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS net_month,
        COUNT(*)                      FILTER (WHERE created_at >= date_trunc('month', NOW()))::int      AS jobs_month,
        -- Last 3 months
        COALESCE(SUM(amount)          FILTER (WHERE created_at >= NOW() - INTERVAL '3 months'), 0)::int AS gross_last3,
        COALESCE(SUM(provider_fee)    FILTER (WHERE created_at >= NOW() - INTERVAL '3 months'), 0)::int AS fee_last3,
        COALESCE(SUM(provider_payout) FILTER (WHERE created_at >= NOW() - INTERVAL '3 months'), 0)::int AS net_last3,
        COUNT(*)                      FILTER (WHERE created_at >= NOW() - INTERVAL '3 months')::int      AS jobs_last3,
        -- This year
        COALESCE(SUM(amount)          FILTER (WHERE created_at >= date_trunc('year', NOW())), 0)::int  AS gross_year,
        COALESCE(SUM(provider_fee)    FILTER (WHERE created_at >= date_trunc('year', NOW())), 0)::int  AS fee_year,
        COALESCE(SUM(provider_payout) FILTER (WHERE created_at >= date_trunc('year', NOW())), 0)::int  AS net_year,
        COUNT(*)                      FILTER (WHERE created_at >= date_trunc('year', NOW()))::int       AS jobs_year,
        -- All time
        COALESCE(SUM(amount), 0)::int          AS gross_all,
        COALESCE(SUM(provider_fee), 0)::int    AS fee_all,
        COALESCE(SUM(provider_payout), 0)::int AS net_all,
        COUNT(*)::int                          AS jobs_all
      FROM public.transactions
      WHERE provider_id = $1
    `, [uid]);

    const txns = await db.query(`
      SELECT tx.id, tx.amount, tx.provider_fee, tx.provider_payout, tx.status, tx.created_at,
             t.parish,
             st.display_name AS service_name, st.emoji AS service_emoji,
             (cu.first_name || ' ' || LEFT(cu.last_name, 1) || '.') AS client_name
      FROM public.transactions tx
      JOIN public.tenders t ON t.id = tx.tender_id
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu ON cu.id = tx.client_id
      WHERE tx.provider_id = $1
      ORDER BY tx.created_at DESC
      LIMIT 50
    `, [uid]);

    const ratingResult = await db.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS avg_rating, COUNT(*)::int AS review_count
       FROM public.reviews WHERE provider_id = $1`,
      [uid]
    );

    const a = agg.rows[0];
    const mk = (g, f, n, j) => ({ grossCents: g, feeCents: f, netCents: n, jobs: j });

    res.json({
      success: true,
      periods: {
        month: mk(a.gross_month, a.fee_month, a.net_month, a.jobs_month),
        last3: mk(a.gross_last3, a.fee_last3, a.net_last3, a.jobs_last3),
        year:  mk(a.gross_year,  a.fee_year,  a.net_year,  a.jobs_year),
        all:   mk(a.gross_all,   a.fee_all,   a.net_all,   a.jobs_all),
      },
      avgRating:   ratingResult.rows[0].avg_rating ? parseFloat(ratingResult.rows[0].avg_rating) : null,
      reviewCount: ratingResult.rows[0].review_count ?? 0,
      transactions: txns.rows.map((t) => ({
        id: t.id,
        job: t.service_name || 'Job',
        emoji: t.service_emoji || '🛠',
        clientName: t.client_name,
        parish: t.parish,
        date: t.created_at,
        status: t.status,                 // 'held' | 'payout_queued' | 'completed' | ...
        amountCents: t.amount,
        payoutCents: t.provider_payout,
        feeCents: t.provider_fee,
      })),
    });
  } catch (err) {
    console.error('GET /api/providers/earnings error:', err);
    res.status(500).json({ success: false, message: 'Failed to load earnings.' });
  }
});

// ============================================================
// GET /api/providers/payment
// Returns the logged-in provider's saved payout details, MASKED.
// The full account number and ABA are NEVER returned here — only the last 4
// digits of the account number, so the UI can render "••••4321". To change
// the account number the provider must re-enter it.
// ============================================================
router.get('/payment', authenticate, authorize('provider'), async (req, res) => {
  try {
    const result = await db.queryAsUser(req.user.id,
      `SELECT account_ownership, business_name, payee_first_name, middle_initial, payee_surname,
              recipient_id, recipient_bank_type,
              contact_address_line1, contact_address_line2, contact_address_line3,
              contact_city, contact_country, contact_state, contact_zip,
              contact_phone, contact_email,
              bank_name, bank_branch, swift_code, transit_code, bank_address,
              bank_city, bank_country, bank_state, bank_zip,
              account_type, currency, account_number_last4,
              (aba_routing_encrypted IS NOT NULL) AS has_aba
         FROM public.provider_payment_details
        WHERE provider_id = $1`,
      [req.user.id]
    );

    const row = result.rows[0] || null;
    res.json({ success: true, payment: row });
  } catch (err) {
    console.error('GET /api/providers/payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to load payment details.' });
  }
});

// ============================================================
// PUT /api/providers/payment
// Upserts the provider's payout details. The account number and ABA/routing
// number are encrypted (AES-256-GCM) BEFORE they touch the database; only
// ciphertext + the last 4 digits are stored. All fields except ABA are required.
// ============================================================
router.put('/payment', authenticate, authorize('provider'), async (req, res) => {
  const {
    account_ownership,
    business_name,
    payee_first_name,
    middle_initial,
    payee_surname,
    recipient_id,
    contact_address_line1,
    contact_address_line2,
    contact_address_line3,
    contact_city,
    contact_country,
    contact_state,
    contact_zip,
    contact_phone,
    contact_email,
    bank_name,
    bank_branch,
    swift_code,
    transit_code,
    bank_address,
    bank_city,
    bank_country,
    bank_state,
    bank_zip,
    account_type,
    currency,
    account_number,   // raw — encrypted here, never stored in the clear
    aba_routing,      // raw, optional
  } = req.body;

  const ownership = account_ownership === 'business' ? 'business' : 'personal';
  const acctNumClean = account_number != null ? String(account_number).replace(/\s/g, '') : '';

  try {
    // Does a row already exist? Governs whether account_number may be omitted
    // (masked readback means the client re-enters the number only to change it).
    const existing = await db.queryAsUser(req.user.id,
      `SELECT 1 FROM public.provider_payment_details WHERE provider_id = $1`,
      [req.user.id]
    );
    const hasRow = existing.rows.length > 0;

    // ── Validation ──
    const errors = [];
    if (!payee_first_name || !String(payee_first_name).trim()) errors.push('payee first name');
    if (!payee_surname || !String(payee_surname).trim())       errors.push('payee surname');
    if (!recipient_id || !String(recipient_id).trim())         errors.push('recipient ID');
    if (!bank_name || !String(bank_name).trim())               errors.push('bank name');
    if (!account_type || !String(account_type).trim())         errors.push('account type');
    if (!acctNumClean && !hasRow)                              errors.push('account number');
    if (ownership === 'business' && (!business_name || !String(business_name).trim()))
      errors.push('registered business name');

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: `Please provide: ${errors.join(', ')}.`,
      });
    }

    const abaEnc = aba_routing && String(aba_routing).trim()
      ? paymentCrypto.encrypt(String(aba_routing).replace(/\s/g, ''))
      : null;

    const commonParams = [
      req.user.id,
      ownership,
      ownership === 'business' ? String(business_name).trim() : null,
      String(payee_first_name).trim(),
      ownership === 'personal' && middle_initial ? String(middle_initial).trim() : null,
      String(payee_surname).trim(),
      String(recipient_id).trim(),
      contact_address_line1 ? String(contact_address_line1).trim() : null,
      contact_address_line2 ? String(contact_address_line2).trim() : null,
      contact_address_line3 ? String(contact_address_line3).trim() : null,
      contact_city    ? String(contact_city).trim()    : null,
      contact_country ? String(contact_country).trim() : 'Jamaica',
      contact_state   ? String(contact_state).trim()   : null,
      contact_zip     ? String(contact_zip).trim()     : null,
      contact_phone   ? String(contact_phone).trim()   : null,
      contact_email   ? String(contact_email).trim()   : null,
      String(bank_name).trim(),
      bank_branch ? String(bank_branch).trim() : null,
      swift_code ? String(swift_code).trim() : null,
      transit_code ? String(transit_code).trim() : null,
      bank_address ? String(bank_address).trim() : null,
      bank_city    ? String(bank_city).trim()    : null,
      bank_country ? String(bank_country).trim() : 'Jamaica',
      bank_state   ? String(bank_state).trim()   : null,
      bank_zip     ? String(bank_zip).trim()     : null,
      String(account_type).trim(),
      currency ? String(currency).trim() : 'jmd',
      abaEnc,
    ];

    if (acctNumClean) {
      // New / changed account number → (re)encrypt it.
      const acctEnc = paymentCrypto.encrypt(acctNumClean);
      const last4   = paymentCrypto.last4(acctNumClean);
      await db.queryAsUser(req.user.id,
        `INSERT INTO public.provider_payment_details
           (provider_id, account_ownership, business_name, payee_first_name, middle_initial, payee_surname,
            recipient_id,
            contact_address_line1, contact_address_line2, contact_address_line3,
            contact_city, contact_country, contact_state, contact_zip, contact_phone, contact_email,
            bank_name, bank_branch, swift_code, transit_code, bank_address,
            bank_city, bank_country, bank_state, bank_zip,
            account_type, currency, aba_routing_encrypted,
            account_number_encrypted, account_number_last4)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
         ON CONFLICT (provider_id) DO UPDATE SET
            account_ownership        = EXCLUDED.account_ownership,
            business_name            = EXCLUDED.business_name,
            payee_first_name         = EXCLUDED.payee_first_name,
            middle_initial           = EXCLUDED.middle_initial,
            payee_surname            = EXCLUDED.payee_surname,
            recipient_id             = EXCLUDED.recipient_id,
            contact_address_line1    = EXCLUDED.contact_address_line1,
            contact_address_line2    = EXCLUDED.contact_address_line2,
            contact_address_line3    = EXCLUDED.contact_address_line3,
            contact_city             = EXCLUDED.contact_city,
            contact_country          = EXCLUDED.contact_country,
            contact_state            = EXCLUDED.contact_state,
            contact_zip              = EXCLUDED.contact_zip,
            contact_phone            = EXCLUDED.contact_phone,
            contact_email            = EXCLUDED.contact_email,
            bank_name                = EXCLUDED.bank_name,
            bank_branch              = EXCLUDED.bank_branch,
            swift_code               = EXCLUDED.swift_code,
            transit_code             = EXCLUDED.transit_code,
            bank_address             = EXCLUDED.bank_address,
            bank_city                = EXCLUDED.bank_city,
            bank_country             = EXCLUDED.bank_country,
            bank_state               = EXCLUDED.bank_state,
            bank_zip                 = EXCLUDED.bank_zip,
            account_type             = EXCLUDED.account_type,
            currency                 = EXCLUDED.currency,
            aba_routing_encrypted    = EXCLUDED.aba_routing_encrypted,
            account_number_encrypted = EXCLUDED.account_number_encrypted,
            account_number_last4     = EXCLUDED.account_number_last4,
            updated_at               = NOW()`,
        [...commonParams, acctEnc, last4]
      );
    } else {
      // No number supplied → update everything else, keep the stored ciphertext.
      await db.queryAsUser(req.user.id,
        `UPDATE public.provider_payment_details SET
            account_ownership     = $2,
            business_name         = $3,
            payee_first_name      = $4,
            middle_initial        = $5,
            payee_surname         = $6,
            recipient_id          = $7,
            contact_address_line1 = $8,
            contact_address_line2 = $9,
            contact_address_line3 = $10,
            contact_city          = $11,
            contact_country       = $12,
            contact_state         = $13,
            contact_zip           = $14,
            contact_phone         = $15,
            contact_email         = $16,
            bank_name             = $17,
            bank_branch           = $18,
            swift_code            = $19,
            transit_code          = $20,
            bank_address          = $21,
            bank_city             = $22,
            bank_country          = $23,
            bank_state            = $24,
            bank_zip              = $25,
            account_type          = $26,
            currency              = $27,
            aba_routing_encrypted = $28,
            updated_at            = NOW()
          WHERE provider_id = $1`,
        commonParams
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/providers/payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to save payment details.' });
  }
});

// ============================================================
// POST /api/providers/go-live
// Sets is_onboarding_complete = TRUE on the provider's profile.
// Only succeeds if a profile row already exists (step 1 must be saved first)
// AND the provider has saved payout details (required to receive payments).
// ============================================================
router.post('/go-live', authenticate, authorize('provider'), async (req, res) => {
  try {
    // Block re-submission for already-approved providers.
    const statusRow = await db.queryAsUser(req.user.id,
      `SELECT verification_status FROM public.provider_profiles WHERE provider_id = $1`,
      [req.user.id]
    );
    if (statusRow.rows[0]?.verification_status === 'approved') {
      return res.status(400).json({
        success: false,
        code: 'ALREADY_APPROVED',
        message: 'Your account is already verified. No resubmission is needed.',
      });
    }

    // Payment details are required to receive payouts — block go-live without them.
    const payRow = await db.queryAsUser(req.user.id,
      `SELECT 1 FROM public.provider_payment_details
        WHERE provider_id = $1 AND account_number_encrypted IS NOT NULL`,
      [req.user.id]
    );
    if (payRow.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_REQUIRED',
        message: 'Please add your payment details before going live.',
      });
    }

    // On (re)submission: mark onboarding complete and stamp submitted_at.
    // If the provider was previously REJECTED, flip them back to 'pending' and
    // stamp resubmitted_at so the application re-enters the admin queue.
    // The previous rejection_reason/notes are intentionally preserved so the
    // admin can see why it was rejected before. An approved provider re-saving
    // is never downgraded.
    const result = await db.queryAsUser(req.user.id,
      `UPDATE public.provider_profiles
         SET is_onboarding_complete = TRUE,
             submitted_at           = COALESCE(submitted_at, NOW()),
             resubmitted_at         = CASE WHEN verification_status = 'rejected'
                                           THEN NOW() ELSE resubmitted_at END,
             verification_status    = CASE WHEN verification_status = 'rejected'
                                           THEN 'pending'::public.verification_status
                                           ELSE verification_status END,
             updated_at             = NOW()
       WHERE provider_id = $1
       RETURNING id`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Profile not found. Please complete step 1 first.',
      });
    }

    res.json({ success: true });

    // Fire-and-forget: email all admins + broadcast Realtime.
    // Both run AFTER the response is already sent so they never delay the provider.
    try {
      const [providerRes, adminRes] = await Promise.all([
        db.query(
          `SELECT u.first_name, u.last_name,
                  (SELECT st.display_name
                     FROM public.provider_services ps
                     JOIN public.service_types st ON st.slug = ps.category::text
                    WHERE ps.provider_id = $1
                    LIMIT 1) AS service_name
             FROM public.users u
            WHERE u.id = $1`,
          [req.user.id]
        ),
        db.query(
          `SELECT email FROM public.users WHERE role = 'admin' AND is_email_verified = TRUE`
        ),
      ]);

      const p = providerRes.rows[0];
      const providerName = p ? `${p.first_name} ${p.last_name}`.trim() : 'A provider';
      const adminEmails = adminRes.rows.map((r) => r.email);

      await Promise.allSettled([
        sendNewProviderSubmittedEmail(providerName, p?.service_name || null, adminEmails),
        notifyChannel('admin-verifications', 'new-verification', {
          providerId: req.user.id,
          providerName,
        }),
      ]);
    } catch (notifyErr) {
      console.warn('POST /api/providers/go-live — admin notification failed:', notifyErr.message);
    }
  } catch (err) {
    console.error('POST /api/providers/go-live error:', err);
    res.status(500).json({ success: false, message: 'Failed to go live. Please try again.' });
  }
});

module.exports = router;
