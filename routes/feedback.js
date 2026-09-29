const express = require('express');
const db = require('../db');
const { sendFeedbackNotification } = require('../lib/feedbackEmails');
const { requireTurnstile } = require('../lib/turnstile');

const router = express.Router();

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const VALID_CATS = ['feedback', 'bug', 'idea', 'other'];
const VALID_ROLES = ['client', 'provider', 'visitor', 'other'];

// ============================================================
// POST /api/feedback  (public — no auth, bot-protected by Turnstile)
// Stores a feedback submission and emails all admins.
// ============================================================
router.post('/', requireTurnstile, async (req, res) => {
  const cat = (req.body.cat || '').trim();
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const role = (req.body.role || '').trim();
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
  // Rating only applies to 'feedback'; store NULL otherwise or when 0/invalid.
  const rating = cat === 'feedback' && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

  try {
    const inserted = await db.query(
      `INSERT INTO public.feedback_submissions (cat, name, email, role, rating, follow_up, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [cat, name, email, safeRole, rating, followUp, message]
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

module.exports = router;
