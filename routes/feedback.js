const express = require('express');
const db = require('../db');
const { sendFeedbackNotification } = require('../lib/feedbackEmails');
const { requireTurnstile } = require('../lib/turnstile');

const router = express.Router();

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const VALID_CATS = ['feedback', 'bug', 'idea', 'other'];
const VALID_ROLES = ['client', 'provider', 'visitor', 'other'];
const VALID_PARISHES = [
  'Kingston', 'St. Andrew', 'St. Thomas', 'Portland', 'St. Mary', 'St. Ann',
  'Trelawny', 'St. James', 'Hanover', 'Westmoreland', 'St. Elizabeth',
  'Manchester', 'Clarendon', 'St. Catherine',
];

// ============================================================
// POST /api/feedback  (public — no auth, bot-protected by Turnstile)
// Stores a feedback submission and emails all admins.
// ============================================================
router.post('/', requireTurnstile, async (req, res) => {
  const cat = (req.body.cat || '').trim();
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const role = (req.body.role || '').trim();
  const parish = (req.body.parish || '').trim();
  const message = (req.body.message || '').trim();
  const followUp = req.body.follow_up !== false;
  const ratingRaw = parseInt(req.body.rating, 10);

  if (!VALID_CATS.includes(cat)) {
    return res.status(400).json({ success: false, message: 'Invalid feedback type.' });
  }
  if (!name || !email || !message) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  }
  if (message.length < 10) {
    return res.status(400).json({ success: false, message: 'Please write a message (at least 10 characters).' });
  }
  if (name.length > 150 || message.length > 5000) {
    return res.status(400).json({ success: false, message: 'One or more fields are too long.' });
  }
  const safeRole = VALID_ROLES.includes(role) ? role : null;
  const safeParish = VALID_PARISHES.includes(parish) ? parish : null;
  // Rating only applies to 'feedback'; store NULL otherwise or when 0/invalid.
  const rating = cat === 'feedback' && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

  try {
    const inserted = await db.query(
      `INSERT INTO public.feedback_submissions (cat, name, email, role, parish, rating, follow_up, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [cat, name, email, safeRole, safeParish, rating, followUp, message]
    );
    const id = inserted.rows[0].id;

    res.status(201).json({ success: true, message: 'Thank you — your submission has been received.' });

    (async () => {
      try {
        const admins = await db.query(`SELECT email FROM public.users WHERE role = 'admin' AND email IS NOT NULL`);
        const adminEmails = admins.rows.map((r) => r.email).filter(Boolean);
        if (!adminEmails.length) {
          console.warn('[feedback] No admin users found — submission stored but no notification sent.');
          return;
        }
        await sendFeedbackNotification(adminEmails, { id, cat, name, email, role: safeRole, rating, follow_up: followUp, message });
      } catch (err) {
        console.error('[feedback] admin notification error:', err.message);
      }
    })();
  } catch (err) {
    console.error('POST /api/feedback error:', err.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ============================================================
// GET /api/feedback/public/testimonials  (public — no auth)
// Up to 3 real, positively-rated "feedback" submissions for the homepage
// "Clients & Providers Both Love TendrIt" section. Only cat='feedback'
// (never bug/idea/other) with rating >= 4, newest-and-highest first.
// Declared before any '/:id'-style route would be added to this file.
// ============================================================
const DISPLAY_ROLE_FALLBACK = { client: 'Homeowner', provider: 'Service Provider', visitor: 'TendrIt User', other: 'TendrIt User' };

router.get('/public/testimonials', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, role, parish, display_role, display_location, message
      FROM public.feedback_submissions
      WHERE cat = 'feedback' AND rating >= 4 AND trashed = false AND approved_for_display = true
      ORDER BY rating DESC, created_at DESC
      LIMIT 3
    `);

    const testimonials = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.display_role || DISPLAY_ROLE_FALLBACK[r.role] || 'TendrIt User',
      // display_location lets an admin curate a specific entry's byline;
      // otherwise fall back to the parish the submitter actually selected.
      location: r.display_location || r.parish || null,
      quote: r.message,
    }));

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.json({ success: true, testimonials });
  } catch (err) {
    console.error('GET /api/feedback/public/testimonials error:', err);
    res.status(500).json({ success: false, message: 'Failed to load testimonials.' });
  }
});

module.exports = router;
