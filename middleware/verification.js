const db = require('../db');

/**
 * Gate a route on admin approval — the ONLY thing that unlocks quoting is
 * verification_status = 'approved' (the admin's manual decision).
 *
 * didit_status is informational only: it surfaces automated ID/liveness/
 * face-match signals on the admin Verification tab to help the admin decide,
 * but it is not an independent gate — an admin can approve a provider
 * regardless of what Didit says. Must run after `authenticate` (needs
 * req.user.id).
 */
async function requireIdentityVerified(req, res, next) {
  try {
    const result = await db.queryAsUser(req.user.id, `
      SELECT verification_status
      FROM public.provider_profiles
      WHERE provider_id = $1
    `, [req.user.id]);

    const profile = result.rows[0];
    if (!profile || profile.verification_status !== 'approved') {
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
