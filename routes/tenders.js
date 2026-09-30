const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const db = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { notifyUser, notifyChannel } = require('../lib/realtimeService');
const { sendNewTenderEmail } = require('../lib/tenderEmails');
const { sendPushToUser }     = require('../lib/pushService');
const { sendDisputeAdminEmail, sendDisputeProviderEmail } = require('../lib/disputeEmails');
const { signedUrl, signedUrlMap, EMAIL_TTL_SECONDS } = require('../lib/storageUrls');
const { getActiveRates } = require('../lib/feeConfig');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 104857600 }, // 100 MB — matches Supabase Storage bucket limit
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const VALID_URGENCIES = ['emergency', 'urgent', 'soon', 'flexible', 'planning'];
const VALID_STATUSES  = ['draft', 'open'];
// Homeowner-chosen lifespan for a published tender. After this many days from
// publish, expires_at passes and the tender drops out of browse/explore.
const ALLOWED_EXPIRY_DAYS = [7, 14, 30, 60, 90];

// Fields that can be patched on a tender
const PATCHABLE = [
  'category', 'parish', 'description', 'urgency', 'urgency_note',
  'preferred_start_date', 'budget_min', 'budget_max',
  'contact_name', 'contact_phone', 'contact_email',
  'location_lat', 'location_lng',
];

// ============================================================
// notifyMatchedProviders
// Called (fire-and-forget) when a tender transitions to 'open'.
// Finds all providers who:
//   - cover the tender's parish (provider_parishes)
//   - offer the tender's service category (provider_services)
// Then sends each of them: in-app notification, realtime bell update,
// push notification, and email — all in parallel, all non-fatal.
//
// preServiceName / preServiceEmoji — pass these when the caller has
// already queried service_types so we avoid a redundant DB round-trip.
// ============================================================
async function notifyMatchedProviders(tender, preServiceName = null, preServiceEmoji = null) {
  // Superuser query — no RLS restriction needed; backend-only fan-out.
  const matchResult = await db.query(`
    SELECT DISTINCT u.id AS provider_id, u.email, u.first_name, u.last_name
    FROM public.provider_parishes pp
    JOIN public.users u        ON u.id = pp.provider_id
    JOIN public.provider_services ps ON ps.provider_id = pp.provider_id
    WHERE pp.parish    = $1
      AND ps.category  = $2::service_category
      AND u.role       = 'provider'
  `, [tender.parish, tender.category]);

  const providers = matchResult.rows;
  if (!providers.length) {
    console.log(`[tender-notify] No matched providers for tender ${tender.id} (parish=${tender.parish}, category=${tender.category})`);
    return;
  }

  console.log(`[tender-notify] Notifying ${providers.length} provider(s) for tender ${tender.id}`);

  // Use caller-supplied names or query them once
  let serviceName  = preServiceName;
  let serviceEmoji = preServiceEmoji;
  if (!serviceName) {
    const stRow = await db.query(
      `SELECT display_name, emoji FROM public.service_types WHERE slug = $1`,
      [tender.category]
    );
    serviceName  = stRow.rows[0]?.display_name || tender.category;
    serviceEmoji = stRow.rows[0]?.emoji ?? '🔧';
  }
  const tenderUrl = `/tender/${tender.id}`;

  await Promise.allSettled(providers.map(async (p) => {
    const providerName = `${p.first_name} ${p.last_name}`.trim() || 'there';

    // 1. Persistent in-app notification (shows in the bell dropdown)
    db.query(`
      INSERT INTO public.notifications (user_id, type, title, body, data)
      VALUES ($1, 'new_tender', $2, $3, $4::jsonb)
    `, [
      p.provider_id,
      `New ${serviceName} job in ${tender.parish}`,
      `A homeowner posted a ${serviceName} tender in ${tender.parish}. Be first to quote!`,
      JSON.stringify({ tenderId: tender.id, url: tenderUrl }),
    ]).catch(err => console.warn('[tender-notify] notification insert error:', err.message));

    // 2. Realtime — provider's bell badge increments immediately without page refresh
    notifyUser(p.provider_id, 'new-tender', {
      tenderId: tender.id,
      category: tender.category,
      parish:   tender.parish,
      url:      tenderUrl,
    }).catch(() => {});

    // 3. PWA push notification to all of this provider's subscribed devices
    sendPushToUser(p.provider_id, {
      title: `New ${serviceName} job in ${tender.parish} 🏡`,
      body:  `A homeowner needs ${serviceName} work done. Tap to view and submit a quote!`,
      url:   tenderUrl,
      type:  'new_tender',
      data:  { tender_id: tender.id },
    }).catch(() => {});

    // 4. Email
    sendNewTenderEmail(p.email, {
      providerName,
      serviceType: serviceName,
      parish:      tender.parish,
      tenderId:    tender.id,
    }).catch(err => console.warn('[tender-notify] email error:', err.message));
  }));
}

// ============================================================
// POST /api/tenders
// Creates a new tender (draft or open).
// status=draft  → minimal validation (category + parish required by DB NOT NULL)
// status=open   → full validation including contact fields
// ============================================================
router.post('/',
  authenticate,
  authorize('homeowner'),
  upload.array('photos', 20),
  async (req, res) => {
    const {
      category, parish, description, urgency, urgency_note,
      preferred_start_date, budget_min, budget_max,
      contact_name, contact_phone, contact_email,
      location_lat, location_lng, expiry_days,
      status = 'draft',
    } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    const expiryDaysVal =
      expiry_days !== undefined && expiry_days !== '' && expiry_days !== null
        ? parseInt(expiry_days, 10)
        : null;
    if (expiryDaysVal !== null && !ALLOWED_EXPIRY_DAYS.includes(expiryDaysVal)) {
      return res.status(400).json({ success: false, message: 'Invalid expiry period.' });
    }

    // category and parish are DB NOT NULL — required for both draft and open
    if (!category || !parish) {
      return res.status(400).json({ success: false, message: 'category and parish are required.' });
    }

    // Full validation only when submitting as open
    if (status === 'open') {
      if (!urgency || !contact_name || !contact_phone) {
        return res.status(400).json({
          success: false,
          message: 'urgency, contact_name, and contact_phone are required to publish a tender.',
        });
      }
      if (!expiryDaysVal) {
        return res.status(400).json({
          success: false,
          message: 'An expiry period (7, 14, 30, 60, or 90 days) is required to publish a tender.',
        });
      }
      if (!VALID_URGENCIES.includes(urgency)) {
        return res.status(400).json({ success: false, message: 'Invalid urgency value.' });
      }
      const cleanPhone = contact_phone.replace(/\D/g, '');
      if (cleanPhone.length < 7 || cleanPhone.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number.' });
      }
    }

    const cleanPhone = contact_phone ? contact_phone.replace(/\D/g, '') : null;
    const budgetMinCents = budget_min ? Math.round(parseFloat(budget_min) * 100) : null;
    const budgetMaxCents = budget_max ? Math.round(parseFloat(budget_max) * 100) : null;
    const lat = location_lat ? parseFloat(location_lat) : null;
    const lng = location_lng ? parseFloat(location_lng) : null;

    // Snapshot the client platform-fee rate in effect right now, so a later fee
    // change never re-prices this job. See PAYMENTS_AND_JOB_WORKFLOW.md.
    const { clientRate: clientFeeRate } = await getActiveRates();

    try {
      const insertResult = await db.queryAsUser(req.user.id, `
        INSERT INTO public.tenders (
          client_id, category, service_type_id, parish,
          description, urgency, urgency_note,
          preferred_start_date, budget_min, budget_max,
          contact_name, contact_phone, contact_email,
          location_lat, location_lng, status,
          expiry_days, client_fee_rate, terms_accepted_at, expires_at
        )
        SELECT
          $1, $2::service_category, st.id, $3,
          $4, $5::tender_urgency, $6,
          $7::date, $8, $9,
          $10, $11, $12,
          $13, $14, $15::tender_status,
          $16::smallint, $17,
          CASE WHEN $15::tender_status = 'open' THEN NOW() ELSE NULL END,
          CASE WHEN $15::tender_status = 'open' AND $16 IS NOT NULL
               THEN NOW() + ($16::int * INTERVAL '1 day') ELSE NULL END
        FROM public.service_types st
        WHERE st.slug = $2::text
        RETURNING *
      `, [
        req.user.id,
        category,
        parish,
        description || null,
        urgency || 'flexible',
        urgency_note || null,
        preferred_start_date || null,
        budgetMinCents,
        budgetMaxCents,
        contact_name ? contact_name.trim() : null,
        cleanPhone,
        contact_email || null,
        lat,
        lng,
        status,
        expiryDaysVal,
        clientFeeRate,
      ]);

      if (insertResult.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Invalid service category.' });
      }

      const tender = insertResult.rows[0];

      let newPhotos = [];
      if (req.files && req.files.length > 0) {
        newPhotos = await uploadPhotos(req.user.id, tender.id, req.files);
        tender.photos_count = newPhotos.length;
      }

      res.status(201).json({ success: true, tender, newPhotos });

      // Fire-and-forget: update the homeowner's own My Tenders view
      notifyUser(req.user.id, 'tenders-updated', { tenderId: tender.id }).catch(() => {});

      if (tender.status === 'open') {
        // Single service_types lookup shared by the broadcast and per-provider
        // notifications so we avoid two identical round-trips.
        db.query(
          `SELECT display_name, emoji FROM public.service_types WHERE slug = $1`,
          [tender.category]
        ).then(({ rows }) => {
          const svcName  = rows[0]?.display_name ?? tender.category;
          const svcEmoji = rows[0]?.emoji ?? '🔧';

          // Broadcast full card payload to tenders-feed so provider browse pages
          // can inject the new tender directly without an extra API call.
          notifyChannel('tenders-feed', 'tender-added', {
            tenderId:             tender.id,
            category:             tender.category,
            parish:               tender.parish,
            description:          tender.description,
            urgency:              tender.urgency,
            budget_min:           tender.budget_min,
            budget_max:           tender.budget_max,
            created_at:           tender.created_at,
            photos_count:         tender.photos_count || 0,
            preferred_start_date: tender.preferred_start_date,
            service_name:         svcName,
            service_emoji:        svcEmoji,
          }).catch(() => {});

          // Fan-out: email + in-app notification + push to matched providers
          notifyMatchedProviders(tender, svcName, svcEmoji).catch(err =>
            console.warn('[tender-notify] POST fan-out error:', err.message)
          );
        }).catch(() => {
          // Fallback if service lookup fails — minimal broadcast + regular notify
          notifyChannel('tenders-feed', 'tender-added', {
            tenderId: tender.id, category: tender.category, parish: tender.parish,
          }).catch(() => {});
          notifyMatchedProviders(tender).catch(() => {});
        });
      }
    } catch (err) {
      console.error('POST /api/tenders error:', err);
      res.status(500).json({ success: false, message: 'Failed to create tender.' });
    }
  }
);

// ============================================================
// PATCH /api/tenders/:id
// Partially updates an existing draft or open tender.
// If status='open' is included, runs full validation first.
// ============================================================
router.patch('/:id',
  authenticate,
  authorize('homeowner'),
  upload.array('photos', 20),
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // ── Quote guard ──────────────────────────────────────────────
    // An already-published (open) tender can only be edited while it has NO
    // quotes. Once a provider has quoted, the brief is locked. Drafts and the
    // draft→open publish step are unaffected (a draft has no quotes yet).
    let currentStatus;
    try {
      const guard = await db.queryAsUserBatch(req.user.id, [
        { text: `SELECT status, trashed_at FROM public.tenders WHERE id = $1 AND client_id = $2`, params: [id, req.user.id] },
        { text: `SELECT COUNT(*)::int AS n FROM public.quotes WHERE tender_id = $1`, params: [id] },
      ]);
      if (guard[0].rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Tender not found.' });
      }
      // A tender removed by an admin is read-only for the homeowner.
      if (guard[0].rows[0].trashed_at) {
        return res.status(409).json({
          success: false,
          code: 'TENDER_REMOVED',
          message: 'This tender was removed by an administrator and can no longer be edited.',
        });
      }
      currentStatus = guard[0].rows[0].status;
      const quoteCount = guard[1].rows[0].n;
      if (currentStatus === 'open' && quoteCount > 0) {
        return res.status(409).json({
          success: false,
          code: 'TENDER_HAS_QUOTES',
          message: 'This tender already has quotes and can no longer be edited.',
        });
      }
    } catch (guardErr) {
      console.error('PATCH /api/tenders/:id quote-guard error:', guardErr);
      return res.status(500).json({ success: false, message: 'Failed to update tender.' });
    }

    // Normalise + validate the (optional) expiry period.
    const expiryDaysVal =
      req.body.expiry_days !== undefined && req.body.expiry_days !== '' && req.body.expiry_days !== null
        ? parseInt(req.body.expiry_days, 10)
        : undefined;
    if (expiryDaysVal !== undefined && !ALLOWED_EXPIRY_DAYS.includes(expiryDaysVal)) {
      return res.status(400).json({ success: false, message: 'Invalid expiry period.' });
    }

    // Full validation when upgrading to open
    if (status === 'open') {
      const { category, parish, urgency, contact_name, contact_phone } = req.body;
      if (!category || !parish || !urgency || !contact_name || !contact_phone) {
        return res.status(400).json({
          success: false,
          message: 'category, parish, urgency, contact_name, and contact_phone are required to publish.',
        });
      }
      if (!expiryDaysVal) {
        return res.status(400).json({
          success: false,
          message: 'An expiry period (7, 14, 30, 60, or 90 days) is required to publish a tender.',
        });
      }
      if (!VALID_URGENCIES.includes(urgency)) {
        return res.status(400).json({ success: false, message: 'Invalid urgency value.' });
      }
      const phone = contact_phone.replace(/\D/g, '');
      if (phone.length < 7 || phone.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number.' });
      }
    }

    // Build SET clause from whitelisted fields that are present in the body
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    const addField = (col, val) => {
      setClauses.push(`${col} = $${paramIdx}`);
      params.push(val);
      paramIdx++;
    };

    if (req.body.category !== undefined) {
      // category update also requires refreshing service_type_id
      // handled via a subquery — skip for now, use a separate approach below
    }

    const simpleFields = {
      parish:               req.body.parish,
      description:          req.body.description || null,
      urgency_note:         req.body.urgency_note || null,
      preferred_start_date: req.body.preferred_start_date || null,
      contact_name:         req.body.contact_name ? req.body.contact_name.trim() : undefined,
      contact_phone:        req.body.contact_phone ? req.body.contact_phone.replace(/\D/g, '') : undefined,
      contact_email:        req.body.contact_email || null,
      location_lat:         req.body.location_lat ? parseFloat(req.body.location_lat) : undefined,
      location_lng:         req.body.location_lng ? parseFloat(req.body.location_lng) : undefined,
    };

    for (const [col, val] of Object.entries(simpleFields)) {
      if (val !== undefined) addField(col, val);
    }

    if (req.body.urgency !== undefined) {
      setClauses.push(`urgency = $${paramIdx}::tender_urgency`);
      params.push(req.body.urgency);
      paramIdx++;
    }

    if (req.body.budget_min !== undefined) {
      addField('budget_min', req.body.budget_min ? Math.round(parseFloat(req.body.budget_min) * 100) : null);
    }
    if (req.body.budget_max !== undefined) {
      addField('budget_max', req.body.budget_max ? Math.round(parseFloat(req.body.budget_max) * 100) : null);
    }

    if (status !== undefined) {
      setClauses.push(`status = $${paramIdx}::tender_status`);
      params.push(status);
      paramIdx++;
      // Record the exact moment the homeowner agreed to T&C and published
      if (status === 'open') {
        setClauses.push(`terms_accepted_at = NOW()`);
      }
    }

    // Persist the chosen expiry period.
    if (expiryDaysVal !== undefined) {
      setClauses.push(`expiry_days = $${paramIdx}::smallint`);
      params.push(expiryDaysVal);
      paramIdx++;
    }
    // (Re)start the expiry countdown from NOW whenever the tender is/goes open
    // and we have a period to apply. Editing an open tender is only permitted
    // with zero quotes, so restarting the clock here is safe.
    const willBeOpen = status === 'open' || (status === undefined && currentStatus === 'open');
    if (willBeOpen && expiryDaysVal !== undefined) {
      setClauses.push(`expires_at = NOW() + ($${paramIdx}::int * INTERVAL '1 day')`);
      params.push(expiryDaysVal);
      paramIdx++;
    }

    // Handle category change (requires re-joining service_types for service_type_id)
    if (req.body.category !== undefined) {
      setClauses.push(`category = $${paramIdx}::service_category`);
      params.push(req.body.category);
      paramIdx++;
      setClauses.push(
        `service_type_id = (SELECT id FROM public.service_types WHERE slug = $${paramIdx}::text)`
      );
      params.push(req.body.category);
      paramIdx++;
    }

    if (setClauses.length === 0 && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ success: false, message: 'No fields to update.' });
    }

    try {
      let tender;

      if (setClauses.length > 0) {
        params.push(id);
        const updateResult = await db.queryAsUser(req.user.id, `
          UPDATE public.tenders
          SET ${setClauses.join(', ')}, updated_at = NOW()
          WHERE id = $${paramIdx}
          RETURNING *
        `, params);

        if (updateResult.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Tender not found or not editable.' });
        }
        tender = updateResult.rows[0];
      } else {
        // Only photos being added
        const fetchResult = await db.queryAsUser(req.user.id, `SELECT * FROM public.tenders WHERE id = $1`, [id]);
        if (fetchResult.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Tender not found.' });
        }
        tender = fetchResult.rows[0];
      }

      let newPhotos = [];
      if (req.files && req.files.length > 0) {
        newPhotos = await uploadPhotos(req.user.id, tender.id, req.files);
        tender.photos_count = (tender.photos_count || 0) + newPhotos.length;
      }

      res.json({ success: true, tender, newPhotos });

      // Fire-and-forget: update the homeowner's own My Tenders view
      notifyUser(req.user.id, 'tenders-updated', { tenderId: id }).catch(() => {});

      // Draft → open: first publish. Fan-out to matched providers.
      if (status === 'open' && currentStatus === 'draft') {
        db.query(
          `SELECT display_name, emoji FROM public.service_types WHERE slug = $1`,
          [tender.category]
        ).then(({ rows }) => {
          const svcName  = rows[0]?.display_name ?? tender.category;
          const svcEmoji = rows[0]?.emoji ?? '🔧';

          notifyChannel('tenders-feed', 'tender-added', {
            tenderId:             tender.id,
            category:             tender.category,
            parish:               tender.parish,
            description:          tender.description,
            urgency:              tender.urgency,
            budget_min:           tender.budget_min,
            budget_max:           tender.budget_max,
            created_at:           tender.created_at,
            photos_count:         tender.photos_count || 0,
            preferred_start_date: tender.preferred_start_date,
            service_name:         svcName,
            service_emoji:        svcEmoji,
          }).catch(() => {});

          notifyMatchedProviders(tender, svcName, svcEmoji).catch(err =>
            console.warn('[tender-notify] PATCH fan-out error:', err.message)
          );
        }).catch(() => {
          notifyChannel('tenders-feed', 'tender-added', {
            tenderId: tender.id, category: tender.category, parish: tender.parish,
          }).catch(() => {});
          notifyMatchedProviders(tender).catch(() => {});
        });
      }
    } catch (err) {
      console.error('PATCH /api/tenders/:id error:', err);
      res.status(500).json({ success: false, message: 'Failed to update tender.' });
    }
  }
);

// ============================================================
// GET /api/tenders/mine
// Lists tenders for the current homeowner, newest first.
// Optional query params: ?status=open, ?limit=3
// JOINs service_types for display_name + emoji.
// ============================================================
router.get('/mine', authenticate, authorize('homeowner'), async (req, res) => {
  const { status, limit } = req.query;
  const params = [req.user.id];
  let extraWhere = '';
  let limitClause = '';

  if (status) {
    params.push(status);
    extraWhere = ` AND t.status = $${params.length}::tender_status`;
  }

  if (limit) {
    const n = parseInt(limit, 10);
    if (!isNaN(n) && n > 0 && n <= 100) {
      params.push(n);
      limitClause = `LIMIT $${params.length}`;
    }
  }

  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        t.id, t.display_code, t.status, t.category, t.parish, t.description,
        t.urgency, t.budget_min, t.budget_max, t.created_at,
        t.quotes_count, t.photos_count, t.expires_at,
        t.trashed_at, t.trashed_reason,
        (
          SELECT MIN(q.amount) FROM public.quotes q
          WHERE q.tender_id = t.id
        ) AS best_quote_price,
        EXISTS (
          SELECT 1 FROM public.quotes q
          WHERE q.tender_id = t.id AND q.status = 'accepted'
        ) AS has_accepted_quote,
        EXISTS (
          SELECT 1 FROM public.transactions tx
          JOIN public.disputes d ON d.transaction_id = tx.id
          WHERE tx.tender_id = t.id AND d.status = 'open'
        ) AS has_open_dispute,
        EXISTS (
          SELECT 1 FROM public.transactions tx
          WHERE tx.tender_id = t.id AND tx.provider_completed_at IS NOT NULL
        ) AS provider_marked_done,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.client_id = $1${extraWhere}
      ORDER BY t.created_at DESC
      ${limitClause}
    `, params);

    res.json({ success: true, tenders: result.rows });
  } catch (err) {
    console.error('GET /api/tenders/mine error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// ============================================================
// GET /api/tenders/browse
// Provider-facing: lists all open tenders with filters.
// Query params: category, parish, budgetMin, budgetMax, sort, search
// Never exposes location_lat/lng or contact fields.
// IMPORTANT: must be defined before GET /:id to avoid being swallowed
// by the homeowner-only wildcard route.
// ============================================================
router.get('/browse', authenticate, authorize('provider'), async (req, res) => {
  const { category, parish, budgetMin, budgetMax, sort, search, offset } = req.query;
  const PAGE_SIZE  = 20;
  const rowOffset  = Math.max(0, parseInt(offset, 10) || 0);
  const params = [req.user.id];
  // Live, non-expired, non-trashed tenders only.
  const conditions = ["t.status = 'open'", "t.trashed_at IS NULL", "(t.expires_at IS NULL OR t.expires_at > NOW())"];
  let paramIdx = 2;

  if (category) {
    conditions.push(`t.category = $${paramIdx}::service_category`);
    params.push(category);
    paramIdx++;
  }

  if (parish) {
    conditions.push(`t.parish = $${paramIdx}`);
    params.push(parish);
    paramIdx++;
  }

  if (budgetMin) {
    const minCents = Math.round(parseFloat(budgetMin) * 100);
    if (!isNaN(minCents)) {
      conditions.push(`t.budget_max >= $${paramIdx}`);
      params.push(minCents);
      paramIdx++;
    }
  }

  if (budgetMax) {
    const maxCents = Math.round(parseFloat(budgetMax) * 100);
    if (!isNaN(maxCents)) {
      conditions.push(`t.budget_min <= $${paramIdx}`);
      params.push(maxCents);
      paramIdx++;
    }
  }

  if (search) {
    conditions.push(`(t.description ILIKE $${paramIdx} OR st.display_name ILIKE $${paramIdx} OR t.parish ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderClause = 'ORDER BY t.created_at DESC';
  if (sort === 'budget_high') {
    orderClause = 'ORDER BY t.budget_max DESC NULLS LAST, t.created_at DESC';
  } else if (sort === 'nearby') {
    orderClause = `ORDER BY (
      EXISTS (SELECT 1 FROM public.provider_parishes pp WHERE pp.provider_id = $1 AND pp.parish = t.parish)
    ) DESC, t.created_at DESC`;
  }

  // Fetch PAGE_SIZE + 1 rows so we can tell whether more pages exist
  // without an extra COUNT query.
  params.push(PAGE_SIZE + 1);  // $paramIdx   → LIMIT
  const limitIdx = paramIdx++;
  params.push(rowOffset);       // $paramIdx   → OFFSET
  const offsetIdx = paramIdx++;

  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT
        t.id, t.display_code, t.category, t.parish, t.description, t.urgency,
        t.budget_min, t.budget_max, t.created_at, t.quotes_count,
        t.photos_count, t.preferred_start_date, t.expires_at,
        EXISTS (
          SELECT 1 FROM public.quotes q
          WHERE q.tender_id = t.id AND q.provider_id = $1
        ) AS has_quoted,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      ${whereClause}
      ${orderClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    const hasMore  = result.rows.length > PAGE_SIZE;
    const tenders  = hasMore ? result.rows.slice(0, PAGE_SIZE) : result.rows;

    res.json({ success: true, tenders, hasMore, offset: rowOffset });
  } catch (err) {
    console.error('GET /api/tenders/browse error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// ============================================================
// GET /api/tenders/browse/:id
// Provider-facing: single open tender detail.
// Location + contact ONLY revealed if this provider's quote is accepted.
// ============================================================
router.get('/browse/:id', authenticate, authorize('provider'), async (req, res) => {
  const { id } = req.params;
  try {
    const [tenderResult, photosResult] = await db.queryAsUserBatch(req.user.id, [
      {
        text: `
          SELECT
            t.id, t.display_code, t.category, t.parish, t.description, t.urgency, t.urgency_note,
            t.budget_min, t.budget_max, t.created_at, t.quotes_count,
            t.photos_count, t.preferred_start_date, t.status, t.expires_at,
            CASE WHEN EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2 AND q.status = 'accepted'
            ) THEN t.location_lat  ELSE NULL END AS location_lat,
            CASE WHEN EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2 AND q.status = 'accepted'
            ) THEN t.location_lng  ELSE NULL END AS location_lng,
            CASE WHEN EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2 AND q.status = 'accepted'
            ) THEN t.contact_name  ELSE NULL END AS contact_name,
            CASE WHEN EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2 AND q.status = 'accepted'
            ) THEN t.contact_phone ELSE NULL END AS contact_phone,
            CASE WHEN EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2 AND q.status = 'accepted'
            ) THEN t.contact_email ELSE NULL END AS contact_email,
            EXISTS (
              SELECT 1 FROM public.quotes q
              WHERE q.tender_id = t.id AND q.provider_id = $2
            ) AS has_quoted,
            (
              SELECT row_to_json(q_row)
              FROM (
                SELECT id, amount, timeline, preferred_start_date, message, what_is_included, status, created_at
                FROM public.quotes q
                WHERE q.tender_id = t.id AND q.provider_id = $2
                LIMIT 1
              ) q_row
            ) AS my_quote,
            (
              SELECT first_name || ' ' || LEFT(last_name, 1) || '.'
              FROM public.users WHERE id = t.client_id
            ) AS client_display_name,
            (
              SELECT COUNT(*)::int FROM public.tenders
              WHERE client_id = t.client_id AND status IN ('open', 'in_progress', 'completed')
            ) AS client_jobs_posted,
            st.display_name AS service_name,
            st.emoji        AS service_emoji
          FROM public.tenders t
          LEFT JOIN public.service_types st ON st.id = t.service_type_id
          WHERE t.id = $1 AND t.trashed_at IS NULL
            AND (
              -- Open & live for any provider to view/quote…
              (t.status = 'open' AND (t.expires_at IS NULL OR t.expires_at > NOW()))
              -- …or a provider who already quoted can still open it after it
              -- leaves 'open' (awarded/in-progress) — the winner sees revealed
              -- contact + location; losers see the read-only "not selected" view.
              OR EXISTS (
                SELECT 1 FROM public.quotes q
                WHERE q.tender_id = t.id AND q.provider_id = $2
              )
            )
        `,
        params: [id, req.user.id],
      },
      {
        text: `
          SELECT id, storage_path, display_order
          FROM public.tender_photos
          WHERE tender_id = $1
          ORDER BY display_order ASC
        `,
        params: [id],
      },
    ]);

    if (tenderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found or no longer open.' });
    }

    // Signed URLs — tender-media is a private bucket (never public URLs).
    const photoUrls = await signedUrlMap(supabase, 'tender-media', photosResult.rows.map((p) => p.storage_path));
    const photos = photosResult.rows.map((p) => ({
      id: p.id,
      storage_path: p.storage_path,
      url: photoUrls[p.storage_path] ?? null,
      type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(p.storage_path) ? 'video' : 'image',
    }));

    res.json({ success: true, tender: tenderResult.rows[0], photos });
  } catch (err) {
    console.error('GET /api/tenders/browse/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tender.' });
  }
});

// ============================================================
// PUBLIC ENDPOINTS (no auth)
// Read-only views of OPEN tenders for the public Explore page and
// public tender-detail page. These run as the superuser (db.query),
// hard-filter status='open', and NEVER expose contact/location PII.
// Declared BEFORE the '/:id' homeowner route so the literal '/public'
// path is not captured by the ':id' param.
// ============================================================
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

// GET /api/tenders/public — list open tenders with filters + sort + paging.
router.get('/public', async (req, res) => {
  const { category, parish, budgetMin, budgetMax, sort, search, offset, status } = req.query;
  const PAGE_SIZE = 20;
  const rowOffset = Math.max(0, parseInt(offset, 10) || 0);
  const params = [];
  // Live, non-expired, non-trashed tenders only.
  const conditions = ["t.status = 'open'", "t.trashed_at IS NULL", "(t.expires_at IS NULL OR t.expires_at > NOW())"];
  let paramIdx = 1;

  // UI "status" filter: only-open tenders are ever returned, so this narrows by
  // recency ('new' = posted today) or urgency ('urgent').
  if (status === 'new') {
    conditions.push(`t.created_at >= date_trunc('day', now())`);
  } else if (status === 'urgent') {
    conditions.push(`t.urgency IN ('emergency', 'urgent')`);
  }

  if (category) {
    conditions.push(`t.category = $${paramIdx}::service_category`);
    params.push(category);
    paramIdx++;
  }

  if (parish) {
    conditions.push(`t.parish = $${paramIdx}`);
    params.push(parish);
    paramIdx++;
  }

  if (budgetMin) {
    const minCents = Math.round(parseFloat(budgetMin) * 100);
    if (!isNaN(minCents)) {
      conditions.push(`t.budget_max >= $${paramIdx}`);
      params.push(minCents);
      paramIdx++;
    }
  }

  if (budgetMax) {
    const maxCents = Math.round(parseFloat(budgetMax) * 100);
    if (!isNaN(maxCents)) {
      conditions.push(`t.budget_min <= $${paramIdx}`);
      params.push(maxCents);
      paramIdx++;
    }
  }

  if (search) {
    conditions.push(`(t.description ILIKE $${paramIdx} OR st.display_name ILIKE $${paramIdx} OR t.parish ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  let orderClause = 'ORDER BY t.created_at DESC';
  if (sort === 'budget_high') {
    orderClause = 'ORDER BY t.budget_max DESC NULLS LAST, t.created_at DESC';
  } else if (sort === 'fewest_quotes') {
    orderClause = 'ORDER BY t.quotes_count ASC, t.created_at DESC';
  }

  params.push(PAGE_SIZE + 1);
  const limitIdx = paramIdx++;
  params.push(rowOffset);
  const offsetIdx = paramIdx++;

  try {
    const result = await db.query(`
      SELECT
        t.id, t.display_code, t.category, t.parish, t.description, t.urgency,
        t.budget_min, t.budget_max, t.created_at, t.quotes_count,
        t.photos_count, t.preferred_start_date, t.expires_at,
        COUNT(*) OVER() AS total_count,
        st.display_name AS service_name,
        st.emoji        AS service_emoji
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      ${whereClause}
      ${orderClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, params);

    const hasMore = result.rows.length > PAGE_SIZE;
    const rows    = hasMore ? result.rows.slice(0, PAGE_SIZE) : result.rows;
    const total   = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const tenders = rows.map(({ total_count, ...rest }) => rest);

    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ success: true, tenders, hasMore, offset: rowOffset, total });
  } catch (err) {
    console.error('GET /api/tenders/public error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tenders.' });
  }
});

// GET /api/tenders/public/stats — aggregate counts for hero + category sidebar.
router.get('/public/stats', async (req, res) => {
  try {
    const [totals, byCategory] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int                                                         AS open_tenders,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int   AS new_today,
          COUNT(DISTINCT parish)::int                                           AS parish_count,
          COUNT(DISTINCT category)::int                                         AS category_count
        FROM public.tenders
        WHERE status = 'open' AND trashed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
      `),
      // The `service_category` enum and `service_types.slug` disagree on two
      // values ('auto' vs 'auto_servicing', 'child_care' vs 'child_patient_care')
      // — map them here so the frontend's slug-keyed lookup doesn't silently
      // show 0 for those two categories forever.
      db.query(`
        SELECT
          CASE category
            WHEN 'auto' THEN 'auto_servicing'
            WHEN 'child_care' THEN 'child_patient_care'
            ELSE category::text
          END AS category,
          COUNT(*)::int AS count
        FROM public.tenders
        WHERE status = 'open' AND trashed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        GROUP BY category
      `),
    ]);

    const t = totals.rows[0] || {};
    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({
      success: true,
      openTenders:   t.open_tenders   ?? 0,
      newToday:      t.new_today      ?? 0,
      parishCount:   t.parish_count   ?? 0,
      categoryCount: t.category_count ?? 0,
      categoryCounts: byCategory.rows,
    });
  } catch (err) {
    console.error('GET /api/tenders/public/stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

// GET /api/tenders/public/:id — single open tender detail (no PII).
router.get('/public/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [tenderResult, photosResult] = await Promise.all([
      db.query(`
        SELECT
          t.id, t.display_code, t.category, t.parish, t.description, t.urgency, t.urgency_note,
          t.budget_min, t.budget_max, t.created_at, t.quotes_count,
          t.photos_count, t.preferred_start_date, t.status, t.expires_at,
          (
            SELECT first_name || ' ' || LEFT(last_name, 1) || '.'
            FROM public.users WHERE id = t.client_id
          ) AS client_display_name,
          (
            SELECT COUNT(*)::int FROM public.tenders
            WHERE client_id = t.client_id AND status IN ('open', 'in_progress', 'completed')
          ) AS client_jobs_posted,
          st.display_name AS service_name,
          st.emoji        AS service_emoji
        FROM public.tenders t
        LEFT JOIN public.service_types st ON st.id = t.service_type_id
        WHERE t.id = $1 AND t.status = 'open'
          AND t.trashed_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > NOW())
      `, [id]),
      db.query(`
        SELECT id, storage_path, display_order
        FROM public.tender_photos
        WHERE tender_id = $1
        ORDER BY display_order ASC
      `, [id]),
    ]);

    if (tenderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found or no longer open.' });
    }

    // Signed URLs — tender-media is a private bucket (never public URLs).
    const photoUrls = await signedUrlMap(supabase, 'tender-media', photosResult.rows.map((p) => p.storage_path));
    const photos = photosResult.rows.map((p) => ({
      id: p.id,
      storage_path: p.storage_path,
      url: photoUrls[p.storage_path] ?? null,
      type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(p.storage_path) ? 'video' : 'image',
    }));

    res.set('Cache-Control', PUBLIC_CACHE);
    res.json({ success: true, tender: tenderResult.rows[0], photos });
  } catch (err) {
    console.error('GET /api/tenders/public/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tender.' });
  }
});

// ============================================================
// GET /api/tenders/:id
// Returns a single tender for the current homeowner.
// Used by post-job page to pre-populate draft form.
// Also returns tender_photos rows with public Storage URLs.
// ============================================================
router.get('/:id', authenticate, authorize('homeowner'), async (req, res) => {
  try {
    const [tenderResult, photosResult] = await db.queryAsUserBatch(req.user.id, [
      {
        text: `
          SELECT
            t.*,
            st.display_name AS service_name,
            st.emoji        AS service_emoji,
            (SELECT COUNT(*)::int FROM public.quotes q WHERE q.tender_id = t.id) AS quote_count
          FROM public.tenders t
          LEFT JOIN public.service_types st ON st.id = t.service_type_id
          WHERE t.id = $1 AND t.client_id = $2
        `,
        params: [req.params.id, req.user.id],
      },
      {
        text: `
          SELECT id, storage_path, display_order
          FROM public.tender_photos
          WHERE tender_id = $1
          ORDER BY display_order ASC
        `,
        params: [req.params.id],
      },
    ]);

    if (tenderResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }

    // Signed URLs — tender-media is a private bucket (never public URLs).
    const photoUrls = await signedUrlMap(supabase, 'tender-media', photosResult.rows.map((p) => p.storage_path));
    const photos = photosResult.rows.map((p) => ({
      id: p.id,
      storage_path: p.storage_path,
      url: photoUrls[p.storage_path] ?? null,
      type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(p.storage_path) ? 'video' : 'image',
    }));

    res.json({ success: true, tender: tenderResult.rows[0], photos });
  } catch (err) {
    console.error('GET /api/tenders/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to load tender.' });
  }
});

// ============================================================
// PATCH /api/tenders/:id/complete
// Homeowner marks an in-progress job as complete. Transitions the tender
// in_progress → completed and settles the recorded transaction
// (held → completed). WiPay is deferred, so this is a status/data transition
// only — no real payout runs (see documentation/PAYMENTS_AND_JOB_WORKFLOW.md).
// Notifies the winning provider (realtime + bell + push) so their job moves
// from "Won / in progress" to "Completed" and earnings flip In Escrow → Paid.
// ============================================================
router.patch('/:id/complete', authenticate, authorize('homeowner'), async (req, res) => {
  const { id } = req.params;
  try {
    // Superuser read (bypasses RLS) — need the tender + winning provider + title.
    const check = await db.query(`
      SELECT t.id, t.client_id, t.status,
             st.display_name AS service_name,
             (SELECT provider_id FROM public.quotes q
                WHERE q.tender_id = t.id AND q.status = 'accepted' LIMIT 1) AS provider_id,
             (SELECT tx.provider_completed_at FROM public.transactions tx
                WHERE tx.tender_id = t.id ORDER BY tx.created_at DESC LIMIT 1) AS provider_completed_at
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      WHERE t.id = $1
    `, [id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found.' });
    }
    const row = check.rows[0];
    if (row.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    if (row.status !== 'in_progress') {
      return res.status(409).json({ success: false, message: 'Only an in-progress job can be marked complete.' });
    }
    // Two-step handshake: the provider must mark the job done first.
    if (!row.provider_completed_at) {
      return res.status(409).json({ success: false, message: 'The provider hasn’t marked this job done yet — you can confirm once they do.' });
    }

    await db.query(
      `UPDATE public.tenders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    // Settle the recorded transaction (held → completed). No real payout — WiPay deferred.
    await db.query(
      `UPDATE public.transactions
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE tender_id = $1 AND status = 'held'`,
      [id]
    );

    res.json({ success: true });

    // ── Fire-and-forget: tell the provider their job is complete ──────────
    if (row.provider_id) {
      const serviceName = row.service_name || 'your job';
      const title = 'Job marked complete ✅';
      const body  = `The homeowner marked "${serviceName}" complete. Your payout has been released to your earnings.`;
      Promise.allSettled([
        notifyUser(row.provider_id, 'job-completed', { tenderId: id }),
        db.query(`
          INSERT INTO public.notifications (user_id, type, title, body, data)
          VALUES ($1, 'job_completed', $2, $3, $4::jsonb)
        `, [row.provider_id, title, body, JSON.stringify({ tenderId: id })]),
        sendPushToUser(row.provider_id, {
          title, body, type: 'job_completed', url: '/earnings', data: { tender_id: id },
        }),
      ]).catch((err) => console.warn('PATCH /tenders/:id/complete — side-effect error:', err.message));
    }
  } catch (err) {
    console.error('PATCH /api/tenders/:id/complete error:', err);
    res.status(500).json({ success: false, message: 'Failed to complete the job.' });
  }
});

// ============================================================
// POST /api/tenders/:id/dispute   (multipart: image? + description)
// Homeowner opens a dispute on an in-progress job. Records a disputes row,
// flags the transaction 'disputed', and emails all admins (to review) + the
// provider (support-style heads-up with the 72h SLA). Optional evidence photo
// is stored in Supabase Storage. See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
// ============================================================
router.post('/:id/dispute', authenticate, authorize('homeowner'), upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  if (description.length < 15) {
    return res.status(400).json({ success: false, message: 'Please describe what went wrong (at least 15 characters).' });
  }
  try {
    const ctx = await db.query(`
      SELECT t.id, t.client_id, t.display_code,
             st.display_name AS service_name,
             (cu.first_name || ' ' || cu.last_name) AS homeowner_name,
             (SELECT tx.id     FROM public.transactions tx WHERE tx.tender_id = t.id ORDER BY tx.created_at DESC LIMIT 1) AS transaction_id,
             (SELECT tx.status FROM public.transactions tx WHERE tx.tender_id = t.id ORDER BY tx.created_at DESC LIMIT 1) AS transaction_status,
             (SELECT tx.provider_completed_at FROM public.transactions tx WHERE tx.tender_id = t.id ORDER BY tx.created_at DESC LIMIT 1) AS provider_completed_at,
             (SELECT q.provider_id FROM public.quotes q WHERE q.tender_id = t.id AND q.status = 'accepted' LIMIT 1) AS provider_id
      FROM public.tenders t
      LEFT JOIN public.service_types st ON st.id = t.service_type_id
      JOIN public.users cu ON cu.id = t.client_id
      WHERE t.id = $1
    `, [id]);

    if (ctx.rows.length === 0) return res.status(404).json({ success: false, message: 'Tender not found.' });
    const row = ctx.rows[0];
    if (row.client_id !== req.user.id) return res.status(403).json({ success: false, message: 'Forbidden.' });
    if (!row.transaction_id || !row.provider_id) {
      return res.status(409).json({ success: false, message: 'There is no active job to dispute.' });
    }
    if (row.transaction_status === 'completed') {
      return res.status(409).json({ success: false, message: 'This job is already completed and can no longer be disputed.' });
    }
    // Two-step handshake: disputes open only after the provider marks the job done.
    if (!row.provider_completed_at) {
      return res.status(409).json({ success: false, message: 'You can open a dispute once the provider marks the job done.' });
    }
    const existing = await db.query(
      `SELECT 1 FROM public.disputes WHERE transaction_id = $1 AND status = 'open' LIMIT 1`,
      [row.transaction_id]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'A dispute is already open for this job.' });
    }

    // Optional evidence photo → Supabase Storage (public tender-media bucket).
    let imagePath = null, imageUrl = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
      const rand = Math.random().toString(36).slice(2, 7);
      const storagePath = `disputes/${id}/${Date.now()}_${rand}${ext}`;
      const { error: upErr } = await supabase.storage
        .from('tender-media')
        .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (!upErr) {
        imagePath = storagePath;
        // Long-lived signed URL for the admin email (opened later); tender-media is private.
        imageUrl = await signedUrl(supabase, 'tender-media', storagePath, EMAIL_TTL_SECONDS);
      } else {
        console.warn('dispute image upload error:', upErr.message);
      }
    }

    const ins = await db.query(
      `INSERT INTO public.disputes
         (transaction_id, raised_by, client_id, provider_id, category, description, status, image_path)
       VALUES ($1,$2,$3,$4,'service_quality',$5,'open',$6)
       RETURNING id`,
      [row.transaction_id, req.user.id, row.client_id, row.provider_id, description, imagePath]
    );
    await db.query(
      `UPDATE public.transactions SET status = 'disputed', updated_at = NOW() WHERE id = $1`,
      [row.transaction_id]
    );

    res.status(201).json({ success: true, disputeId: ins.rows[0].id });

    // ── Fire-and-forget: email admins + provider, notify provider ─────────
    (async () => {
      const serviceName = row.service_name || 'the job';
      const [admins, prov] = await Promise.all([
        db.query(`SELECT email FROM public.users WHERE role = 'admin' AND email IS NOT NULL`),
        db.query(`SELECT email, (first_name || ' ' || last_name) AS name FROM public.users WHERE id = $1`, [row.provider_id]),
      ]);
      const providerName = prov.rows[0]?.name || 'the provider';
      const tasks = admins.rows.map((a) =>
        sendDisputeAdminEmail(a.email, {
          tenderTitle: serviceName, tenderCode: row.display_code,
          homeownerName: row.homeowner_name, providerName, description, imageUrl,
        })
      );
      tasks.push(sendDisputeProviderEmail(prov.rows[0]?.email, { providerName, tenderTitle: serviceName }));
      tasks.push(notifyUser(row.provider_id, 'dispute-opened', { tenderId: id }));
      tasks.push(db.query(
        `INSERT INTO public.notifications (user_id, type, title, body, data)
         VALUES ($1, 'dispute_opened', $2, $3, $4::jsonb)`,
        [row.provider_id, 'A dispute was opened on your job',
         `The homeowner raised a dispute on "${serviceName}". Our team will review within 72 hours and may contact you by phone or email.`,
         JSON.stringify({ tenderId: id })]
      ));
      tasks.push(notifyChannel('admin-disputes', 'dispute-opened', { tenderId: id }));
      await Promise.allSettled(tasks);
    })().catch((err) => console.warn('POST /tenders/:id/dispute — side-effect error:', err.message));
  } catch (err) {
    console.error('POST /api/tenders/:id/dispute error:', err);
    res.status(500).json({ success: false, message: 'Failed to open the dispute.' });
  }
});

// ============================================================
// DELETE /api/tenders/:tenderId/photos/:photoId
// Deletes a single photo: removes from tender_photos table AND
// from Supabase Storage. Tender must belong to the current user.
// ============================================================
router.delete('/:tenderId/photos/:photoId', authenticate, authorize('homeowner'), async (req, res) => {
  const { tenderId, photoId } = req.params;
  try {
    // Fetch the photo row, confirming it belongs to this user's tender
    const photoResult = await db.queryAsUser(req.user.id, `
      SELECT tp.id, tp.storage_path
      FROM public.tender_photos tp
      JOIN public.tenders t ON t.id = tp.tender_id
      WHERE tp.id = $1
        AND tp.tender_id = $2
        AND t.client_id = $3
    `, [photoId, tenderId, req.user.id]);

    if (photoResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Photo not found.' });
    }

    const { storage_path } = photoResult.rows[0];

    // Delete DB row + decrement counter in one transaction
    await db.queryAsUserBatch(req.user.id, [
      {
        text: `DELETE FROM public.tender_photos WHERE id = $1`,
        params: [photoId],
      },
      {
        text: `UPDATE public.tenders SET photos_count = GREATEST(photos_count - 1, 0) WHERE id = $1`,
        params: [tenderId],
      },
    ]);

    // Delete from Storage — best-effort (don't fail the whole request if storage errors)
    const { error: storageError } = await supabase.storage
      .from('tender-media')
      .remove([storage_path]);
    if (storageError) {
      console.error('Storage delete error (non-fatal):', storageError.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tenders/:tenderId/photos/:photoId error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete photo.' });
  }
});

// ============================================================
// DELETE /api/tenders/:id
// Deletes any tender owned by the current homeowner, provided no
// quote has been accepted for it (accepted quotes lock the tender).
// ============================================================
router.delete('/:id', authenticate, authorize('homeowner'), async (req, res) => {
  const { id } = req.params;
  try {
    // Guard: reject deletion if a quote has been accepted.
    const acceptedCheck = await db.queryAsUser(req.user.id, `
      SELECT EXISTS (
        SELECT 1 FROM public.quotes q
        WHERE q.tender_id = $1 AND q.status = 'accepted'
      ) AS has_accepted
    `, [id]);

    if (acceptedCheck.rows[0].has_accepted) {
      return res.status(409).json({
        success: false,
        code: 'QUOTE_ACCEPTED',
        message: 'This tender cannot be deleted because a quote has already been accepted.',
      });
    }

    const result = await db.queryAsUser(req.user.id, `
      DELETE FROM public.tenders
      WHERE id = $1 AND client_id = $2
      RETURNING id
    `, [id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Tender not found or cannot be deleted.' });
    }

    res.json({ success: true });
    // Notify the user's connected clients so the dashboard and My Tenders refetch.
    notifyUser(req.user.id, 'tenders-updated', { tenderId: id }).catch(() => {});
  } catch (err) {
    console.error('DELETE /api/tenders/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete tender.' });
  }
});

// ============================================================
// Helper: upload photos to Supabase Storage + insert tender_photos rows
// Returns array of { id, storage_path, url, type } for each uploaded file.
// ============================================================
async function uploadPhotos(userId, tenderId, files) {
  const photoInserts = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const rand = Math.random().toString(36).slice(2, 7);
    const storagePath = `${userId}/${tenderId}/${Date.now()}_${i}_${rand}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('tender-media')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      console.error(`Photo upload error (file ${i}):`, uploadError);
      continue;
    }
    photoInserts.push({ path: storagePath, order: i });
  }

  if (photoInserts.length === 0) return [];

  const photoValues = photoInserts
    .map((_, idx) => `($1, $${idx * 2 + 2}, $${idx * 2 + 3})`)
    .join(', ');
  const photoParams = [tenderId];
  photoInserts.forEach(p => photoParams.push(p.path, p.order));

  try {
    const results = await db.queryAsUserBatch(userId, [
      {
        text: `INSERT INTO public.tender_photos (tender_id, storage_path, display_order) VALUES ${photoValues} RETURNING id, storage_path`,
        params: photoParams,
      },
      {
        text: `UPDATE public.tenders SET photos_count = photos_count + $2 WHERE id = $1`,
        params: [tenderId, photoInserts.length],
      },
    ]);

    // Build response objects with signed URLs (tender-media is a private bucket)
    const uploadUrls = await signedUrlMap(supabase, 'tender-media', results[0].rows.map((r) => r.storage_path));
    return results[0].rows.map(row => ({
      id: row.id,
      storage_path: row.storage_path,
      url: uploadUrls[row.storage_path] ?? null,
      type: /\.(mp4|mov|webm|avi|mkv|wmv)$/i.test(row.storage_path) ? 'video' : 'image',
    }));
  } catch (err) {
    console.error('Photo DB insert error:', err);
    return [];
  }
}

module.exports = router;
