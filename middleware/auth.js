const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required.');
}

/**
 * Protect routes: Authenticates request and sets req.user.
 * Uses db.query (superuser, bypasses RLS) for the session lookup —
 * the JWT signature already proves the user's identity, so RLS is
 * not needed here and would block newly-created users whose row isn't
 * yet visible to the tendrit_app role.
 */
async function authenticate(req, res, next) {
  let token = null;

  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. No session token provided.' });
  }

  // Step 1: verify the JWT signature — pure CPU, no DB involved
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (jwtErr) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session token.' });
  }

  // Step 2: look up the user row — may fail due to DB connectivity
  try {
    const userRes = await db.query(
      'SELECT id, email, first_name, last_name, role, provider_service, avatar_url, is_email_verified, phone_number, parish FROM public.users WHERE id = $1',
      [decoded.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid session. User not found.' });
    }

    req.user = userRes.rows[0];
    next();
  } catch (dbErr) {
    // DB connection timeout or infrastructure error — NOT an auth failure.
    // Return 503 so the frontend knows to retry rather than log the user out.
    console.error('Authentication DB error:', dbErr.message);
    return res.status(503).json({ success: false, message: 'Service temporarily unavailable. Please try again.' });
  }
}

/**
 * Role authorization guard: restrict access to specific roles (e.g. 'admin')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Authentication required.' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Forbidden. Role '${req.user.role}' is not authorized to access this resource.` 
      });
    }

    next();
  };
}

module.exports = {
  authenticate,
  authorize
};
