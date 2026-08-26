const db = require('../db');

/**
 * Gate a route on BOTH independent provider verification signals — neither
 * alone is enough:
 *   - verification_status = 'approved'  (existing admin manual document review)
 *   - didit_status        = 'approved'  (automated Didit ID + liveness + face-match check)
 *
 * See DIDIT_VERIFICATION_PLAN.md for why these are two separate columns
 * rather than one combined flag. Must run after `authenticate` (needs req.user.id).
 */
async function requireIdentityVerified(req, res, next) {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT verification_status, didit_status
      FROM public.provider_profiles
      WHERE provider_id = $1
    `, [req.user.id]);

    const profile = result.rows[0];
    if (!profile || profile.verification_status !== 'approved' || profile.didit_status !== 'approved') {
      return res.status(403).json({
        success: false,
        code: 'IDENTITY_VERIFICATION_REQUIRED',
        message: 'Complete identity verification before submitting quotes.',
      });
    }

    next();
  } catch (err) {
    console.error('requireIdentityVerified error:', err);
    res.status(500).json({ success: false, message: 'Failed to verify provider status.' });
  }
}

module.exports = { requireIdentityVerified };
