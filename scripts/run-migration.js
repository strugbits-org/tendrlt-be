// Runs a single SQL file from supabase/migrations/ against DATABASE_URL.
// Same connection pattern as db-init.js, just parameterized to one file
// instead of the whole schema — this project doesn't use `supabase db push`
// day to day, migrations are applied directly against the pooler URL.
//
// Usage:
//   node scripts/run-migration.js 20260826120000_add_didit_verification.sql
//   npm run migrate -- 20260826120000_add_didit_verification.sql

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function runMigration() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: node scripts/run-migration.js <migration-filename>');
    console.error('Example: node scripts/run-migration.js 20260826120000_add_didit_verification.sql');
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, '../supabase/migrations');
  const filePath = path.isAbsolute(fileArg) || fileArg.includes(path.sep)
    ? fileArg
    : path.join(migrationsDir, fileArg);

  if (!fs.existsSync(filePath)) {
    console.error(`Migration file not found: ${filePath}`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('ERROR: DATABASE_URL is missing in .env');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  });

  try {
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Running migration: ${path.basename(filePath)}`);
    await pool.query(sql);
    console.log('Migration applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
