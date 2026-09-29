const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { Resend } = require('resend');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { requireTurnstile } = require('../lib/turnstile');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';

const ALLOWED_SIGNUP_ROLES = ['homeowner', 'provider'];

const resend = new Resend(process.env.RESEND_API_KEY);

// Treat as production if NODE_ENV is set, OR if the frontend URL is https (catches missing NODE_ENV in deployments)
const isProduction = process.env.NODE_ENV === 'production' || FRONTEND_URL.startsWith('https://');

// Derive ".tendrit.com" from FRONTEND_URL so the cookie is visible on all
// subdomains (frontend middleware on staging.tendrit.com AND API calls back
// to api.tendrit.com).  Falls back to undefined (host-only) for localhost.
const getCookieDomain = () => {
  if (!isProduction) return undefined;
  try {
    const hostname = new URL(FRONTEND_URL).hostname;
    const parts = hostname.split('.');
    return parts.length >= 2 ? '.' + parts.slice(-2).join('.') : undefined;
  } catch (_) {
    return undefined;
  }
};
const COOKIE_DOMAIN = getCookieDomain();

const getCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {})
});

/**
 * Helper to generate JWT and set token cookie
 */
const setTokenCookie = (res, userId) => {
  const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.cookie('token', token, getCookieOptions());
  return token;
};

/**
 * Helper to send verification email via Resend
 */
const sendVerificationEmail = async (email, token, firstName) => {
  const verificationUrl = `${BACKEND_URL}/api/auth/verify-email?token=${token}`;

  const { error } = await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: email,
    subject: 'Verify your TendrIt account',
    html: `
      <!DOCTYPE html>
      <html>
        <body style="margin:0;padding:0;background:#f8f6f0;font-family:sans-serif;">
          <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(15,26,14,0.08);">
            <div style="background:#0f1a0e;padding:28px 36px;display:flex;align-items:center;gap:10px;">
              <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;">
                Tendr<span style="color:#7db885;">It</span>
              </span>
            </div>
            <div style="padding:36px;">
              <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#0f1a0e;">Hi ${firstName}, verify your email</h1>
              <p style="margin:0 0 24px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
                You're one step away from accessing your TendrIt account. Click the button below to verify your email address.
              </p>
              <a href="${verificationUrl}"
                style="display:inline-block;background:#3d6b45;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:100px;">
                Verify My Email
              </a>
              <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
                This link expires in <strong>24 hours</strong>. If you did not create a TendrIt account, you can safely ignore this email.
              </p>
              <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(15,26,14,0.07);font-size:12px;color:rgba(15,26,14,0.3);">
                Or paste this link in your browser:<br/>
                <span style="word-break:break-all;">${verificationUrl}</span>
              </div>
            </div>
          </div>
        </body>
      </html>
    `
  });
  // Resend returns errors instead of throwing — surface them so failures aren't silent.
  if (error) throw new Error(`Resend verification email failed: ${error.message || JSON.stringify(error)}`);
};

/**
 * Helper to send password reset email via Resend
 */
const sendPasswordResetEmail = async (email, token, firstName) => {
  const resetUrl = `${FRONTEND_URL}/forgot-password?token=${token}`;

  const { error } = await resend.emails.send({
    from: `TendrIt <${process.env.RESEND_FROM_EMAIL}>`,
    to: email,
    subject: 'Reset your TendrIt password',
    html: `
      <!DOCTYPE html>
      <html>
        <body style="margin:0;padding:0;background:#f8f6f0;font-family:sans-serif;">
          <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(15,26,14,0.08);">
            <div style="background:#0f1a0e;padding:28px 36px;">
              <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;">
                Tendr<span style="color:#7db885;">It</span>
              </span>
            </div>
            <div style="padding:36px;">
              <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#0f1a0e;">Hi ${firstName}, reset your password</h1>
              <p style="margin:0 0 24px;font-size:15px;color:rgba(15,26,14,0.55);line-height:1.7;">
                We received a request to reset the password for your TendrIt account. Click the button below to choose a new password.
              </p>
              <a href="${resetUrl}"
                style="display:inline-block;background:#3d6b45;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:100px;">
                Reset My Password
              </a>
              <p style="margin:24px 0 0;font-size:13px;color:rgba(15,26,14,0.35);line-height:1.6;">
                This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely ignore this email — your password won't change.
              </p>
              <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(15,26,14,0.07);font-size:12px;color:rgba(15,26,14,0.3);">
                Or paste this link in your browser:<br/>
                <span style="word-break:break-all;">${resetUrl}</span>
              </div>
            </div>
          </div>
        </body>
      </html>
    `
  });
  // Resend returns errors instead of throwing — surface them so failures aren't silent.
  if (error) throw new Error(`Resend password reset email failed: ${error.message || JSON.stringify(error)}`);
};

/**
 * POST /api/auth/register
 * Register a user via email/password — sends verification email
 */
router.post('/register', requireTurnstile, async (req, res) => {
  const { email, password, first_name, last_name, phone_number, parish, role, provider_service } = req.body;

  if (!email || !password || !first_name || !last_name || !phone_number || !parish || !role) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  if (!ALLOWED_SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid user role selected.' });
  }

  try {
    const userExist = await db.query('SELECT id FROM public.users WHERE email = $1', [email.toLowerCase()]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const insertQuery = `
      INSERT INTO public.users (
        email, password_hash, first_name, last_name, phone_number, parish, role, provider_service,
        is_email_verified, email_verification_token, email_verification_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)
      RETURNING id, email, first_name, last_name, role, provider_service, avatar_url, phone_number, parish;
    `;
    const result = await db.query(insertQuery, [
      email.toLowerCase(),
      passwordHash,
      first_name,
      last_name,
      phone_number,
      parish,
      role,
      role === 'provider' ? provider_service : null,
      verificationToken,
      verificationExpires
    ]);

    const user = result.rows[0];

    // Seed the provider's first service into provider_services so the
    // onboarding page can pre-fill step 2 from the DB on first load.
    if (role === 'provider' && provider_service) {
      try {
        await db.query(
          `INSERT INTO public.provider_services (provider_id, category, service_type_id)
           SELECT $1::uuid, st.slug::service_category, st.id
           FROM public.service_types st
           WHERE st.slug = $2
           ON CONFLICT (provider_id, category) DO NOTHING`,
          [user.id, provider_service]
        );
      } catch (seedErr) {
        // Non-fatal — user is created; they can set services from the onboarding page
        console.warn('provider_services seed on register failed:', seedErr.message);
      }
    }

    // Send verification email
    await sendVerificationEmail(email.toLowerCase(), verificationToken, first_name);

    return res.status(201).json({
      success: true,
      message: 'Account created. Please check your email to verify your account.',
      email: user.email,
      role: user.role,
      name: `${user.first_name} ${user.last_name}`
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during registration.' });
  }
});

/**
 * GET /api/auth/verify-email?token=xxx
 * Validates token, marks email verified, sets session cookie, redirects to frontend
 */
router.get('/verify-email', async (req, res) => {
  const verifyToken = req.query.token;

  if (!verifyToken) {
    return res.redirect(`${FRONTEND_URL}/verify?status=error`);
  }

  try {
    const result = await db.query(
      'SELECT * FROM public.users WHERE email_verification_token = $1',
      [verifyToken]
    );

    if (result.rows.length === 0) {
      return res.redirect(`${FRONTEND_URL}/verify?status=error`);
    }

    const user = result.rows[0];

    // Already verified — just log them in
    if (user.is_email_verified) {
      const authToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      const redirectPath = user.role === 'provider' ? '/provider-browse' : '/dashboard';
      return res.redirect(
        `${FRONTEND_URL}/api/auth/callback?token=${encodeURIComponent(authToken)}&next=${encodeURIComponent(redirectPath)}`
      );
    }

    // Check token expiry
    if (new Date() > new Date(user.email_verification_expires_at)) {
      return res.redirect(`${FRONTEND_URL}/verify?status=expired&email=${encodeURIComponent(user.email)}`);
    }

    // Mark verified and clear token
    await db.query(
      `UPDATE public.users
       SET is_email_verified = true, email_verification_token = NULL, email_verification_expires_at = NULL
       WHERE id = $1`,
      [user.id]
    );

    const authToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    const nameParam = encodeURIComponent(`${user.first_name} ${user.last_name}`);
    return res.redirect(
      `${FRONTEND_URL}/api/auth/callback?token=${encodeURIComponent(authToken)}&next=%2Fverify&status=verified&role=${user.role}&name=${nameParam}`
    );
  } catch (err) {
    console.error('Email verification error:', err);
    return res.redirect(`${FRONTEND_URL}/verify?status=error`);
  }
});

/**
 * POST /api/auth/resend-verification
 * Re-generates token and resends verification email
 */
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Don't reveal if email doesn't exist
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If this email is registered, a new verification link has been sent.' });
    }

    const user = result.rows[0];

    if (user.is_email_verified) {
      return res.status(400).json({ success: false, message: 'This email address is already verified.' });
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    const newExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      'UPDATE public.users SET email_verification_token = $1, email_verification_expires_at = $2 WHERE id = $3',
      [newToken, newExpires, user.id]
    );

    await sendVerificationEmail(user.email, newToken, user.first_name);

    return res.json({ success: true, message: 'Verification email sent. Check your inbox.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ success: false, message: 'Failed to resend verification email.' });
  }
});

/**
 * POST /api/auth/login
 * Sign in a user via email/password
 */
router.post('/login', requireTurnstile, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please enter both email and password.' });
  }

  try {
    const result = await db.query(
      'SELECT id, email, password_hash, first_name, last_name, role, provider_service, avatar_url, phone_number, parish, is_email_verified FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    if (!user.password_hash) {
      return res.status(400).json({
        success: false,
        message: 'This email is linked to a Google account. Please use "Continue with Google" to sign in.'
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    if (!user.is_email_verified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before signing in. Check your inbox for the verification link.',
        unverified: true,
        email: user.email
      });
    }

    setTokenCookie(res, user.id);
    delete user.password_hash;
    delete user.is_email_verified;

    return res.json({ success: true, message: 'Sign in successful.', user });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

/**
 * GET /api/auth/google
 * Redirect user to Google OAuth consent screen
 */
router.get('/google', (req, res) => {
  const role = ALLOWED_SIGNUP_ROLES.includes(req.query.role) ? req.query.role : 'homeowner';

  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.GOOGLE_CALLBACK_URL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),
    state: JSON.stringify({ role })
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

/**
 * GET /api/auth/google/callback
 * Handle Google OAuth redirection
 */
router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state ? JSON.parse(req.query.state) : { role: 'homeowner' };
  const roleFromState = ALLOWED_SIGNUP_ROLES.includes(state.role) ? state.role : 'homeowner';

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/auth?error=google_auth_failed`);
  }

  try {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const values = {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code'
    };

    const tokenRes = await axios.post(tokenUrl, new URLSearchParams(values).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token } = tokenRes.data;

    const profileRes = await axios.get(
      `https://www.googleapis.com/oauth2/v3/userinfo`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const googleUser = profileRes.data;

    let userRes = await db.query('SELECT * FROM public.users WHERE google_id = $1', [googleUser.sub]);
    let isNewUser = false;
    let user = null;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      userRes = await db.query('SELECT * FROM public.users WHERE email = $1', [googleUser.email.toLowerCase()]);

      if (userRes.rows.length > 0) {
        user = userRes.rows[0];
        await db.query(
          'UPDATE public.users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2), is_email_verified = true WHERE id = $3',
          [googleUser.sub, googleUser.picture, user.id]
        );
        user.google_id = googleUser.sub;
        if (!user.avatar_url) user.avatar_url = googleUser.picture;
      } else {
        isNewUser = true;
        const insertQuery = `
          INSERT INTO public.users (
            email, first_name, last_name, role, google_id, avatar_url, is_email_verified
          ) VALUES ($1, $2, $3, $4, $5, $6, true)
          RETURNING *;
        `;
        const newUserRes = await db.query(insertQuery, [
          googleUser.email.toLowerCase(),
          googleUser.given_name || googleUser.name || 'Google',
          googleUser.family_name || 'User',
          roleFromState,
          googleUser.sub,
          googleUser.picture
        ]);
        user = newUserRes.rows[0];
      }
    }

    // Generate JWT without setting it as a backend cookie.
    // In production the backend and frontend are on different domains, so a
    // cookie set here would be scoped to the API domain and invisible to the
    // Next.js middleware on the frontend domain.  Instead we pass the token
    // through the frontend /api/auth/callback handler which sets the cookie
    // on the correct domain.
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    const isProfileIncomplete = !user.phone_number || !user.parish;

    if (isProfileIncomplete || isNewUser) {
      const nameParam = encodeURIComponent(`${user.first_name} ${user.last_name}`);
      return res.redirect(
        `${FRONTEND_URL}/api/auth/callback?token=${encodeURIComponent(token)}&next=%2Fcomplete-profile&role=${user.role}&name=${nameParam}`
      );
    } else {
      const redirectPath = user.role === 'provider' ? '/provider-browse' : '/dashboard';
      return res.redirect(
        `${FRONTEND_URL}/api/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(redirectPath)}`
      );
    }
  } catch (err) {
    console.error('Google OAuth callback error:', err.response?.data || err.message);
    return res.redirect(`${FRONTEND_URL}/auth?error=google_auth_failed`);
  }
});

/**
 * POST /api/auth/complete-profile
 * Complete user profile (for Google OAuth users)
 */
router.post('/complete-profile', authenticate, async (req, res) => {
  const { phone_number, parish, role, provider_service } = req.body;

  if (!phone_number || !parish || !role) {
    return res.status(400).json({ success: false, message: 'Phone number, parish, and role are required.' });
  }

  if (!ALLOWED_SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role selected.' });
  }

  try {
    const updateQuery = `
      UPDATE public.users
      SET phone_number = $1, parish = $2, role = $3, provider_service = $4
      WHERE id = $5
      RETURNING id, email, first_name, last_name, role, provider_service, phone_number, parish, avatar_url;
    `;
    const result = await db.query(updateQuery, [
      phone_number,
      parish,
      role,
      role === 'provider' ? provider_service : null,
      req.user.id
    ]);

    const updatedUser = result.rows[0];

    // Seed the provider's first service into provider_services (same as register path)
    if (role === 'provider' && provider_service) {
      try {
        await db.query(
          `INSERT INTO public.provider_services (provider_id, category, service_type_id)
           SELECT $1::uuid, st.slug::service_category, st.id
           FROM public.service_types st
           WHERE st.slug = $2
           ON CONFLICT (provider_id, category) DO NOTHING`,
          [req.user.id, provider_service]
        );
      } catch (seedErr) {
        console.warn('provider_services seed on complete-profile failed:', seedErr.message);
      }
    }

    return res.json({ success: true, message: 'Profile completed successfully.', user: updatedUser });
  } catch (err) {
    console.error('Complete profile error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error completing profile.' });
  }
});

/**
 * POST /api/auth/forgot-password
 * Generate a reset token and email a reset link
 */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }

  try {
    const result = await db.query(
      'SELECT id, first_name, email FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return the same response to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      'UPDATE public.users SET password_reset_token = $1, password_reset_expires_at = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );

    await sendPasswordResetEmail(user.email, resetToken, user.first_name);

    return res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

/**
 * POST /api/auth/reset-password
 * Validate token and update password
 */
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ success: false, message: 'Token and password are required.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  try {
    const result = await db.query(
      'SELECT id, password_reset_expires_at FROM public.users WHERE password_reset_token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset link.', expired: true });
    }

    const user = result.rows[0];

    if (new Date() > new Date(user.password_reset_expires_at)) {
      return res.status(400).json({ success: false, message: 'This reset link has expired. Please request a new one.', expired: true });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await db.query(
      'UPDATE public.users SET password_hash = $1, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = $2',
      [passwordHash, user.id]
    );

    return res.json({ success: true, message: 'Password updated successfully. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

/**
 * GET /api/auth/me
 * Retrieve the current authenticated user profile
 */
router.get('/me', authenticate, (req, res) => {
  return res.json({ success: true, user: req.user });
});

/**
 * POST /api/auth/logout
 * Log out and clear session cookie
 */
router.post('/logout', (req, res) => {
  const { maxAge: _drop, ...clearOpts } = getCookieOptions();
  res.clearCookie('token', clearOpts);
  return res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;
