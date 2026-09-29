const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('WARNING: DATABASE_URL is not set in .env! Database queries will fail.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,                     // stay under Supabase free-tier connection limit (25)
  idleTimeoutMillis: 30000,    // keep idle connections alive 30s
  connectionTimeoutMillis: 30000, // 30s — the network path to this Supabase region has been observed taking 7-10s+ to complete a handshake even when healthy, so 10s was killing borderline-slow (but otherwise fine) connections
});

pool.on('error', (err) => {
  console.error('Idle pool client error:', err.message);
});

/**
 * Plain query — runs as postgres superuser, bypasses RLS.
 * Use ONLY for auth operations: login, register, verify-email, resend-verification.
 */
const query = (text, params) => pool.query(text, params);

/**
 * User-scoped query — enforces RLS.
 *
 * Previously: 5 round trips (BEGIN + SET ROLE + SET USER + query + COMMIT).
 * Now:        3 round trips (BEGIN+SET+SET combined in one simple query + query + COMMIT).
 *
 * The three setup statements are sent as a single simple-protocol message so
 * Postgres processes them in one server round trip.
 *
 * @param {string} userId  - The authenticated user's UUID (req.user.id)
 * @param {string} text    - SQL query string
 * @param {Array}  params  - Query parameters
 */
const queryAsUser = async (userId, text, params) => {
  const client = await pool.connect();
  try {
    // One round trip: BEGIN + both SET LOCAL in a single simple query
    await client.query(
      `BEGIN; SET LOCAL ROLE tendrit_app; SET LOCAL "app.current_user_id" = '${userId}'`
    );
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Run multiple SQL statements inside a single user-scoped transaction.
 * Use instead of calling queryAsUser() N times when you need N queries
 * for the same user — saves (N-1) × 3 round trips.
 *
 * @param {string} userId
 * @param {Array<{text: string, params?: Array}>} queries
 * @returns {Promise<Array>}  one result object per query, in order
 */
const queryAsUserBatch = async (userId, queries) => {
  const client = await pool.connect();
  try {
    await client.query(
      `BEGIN; SET LOCAL ROLE tendrit_app; SET LOCAL "app.current_user_id" = '${userId}'`
    );
    const results = [];
    for (const { text, params } of queries) {
      results.push(await client.query(text, params || []));
    }
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, queryAsUser, queryAsUserBatch, pool };
