-- ============================================================
-- Fix: payout_batches was created (20261008130000) without RLS enabled —
-- the only table in the schema missing it. Flagged by Supabase's automated
-- security scanner ("Table publicly accessible" / rls_disabled_in_public),
-- since the frontend ships a public Supabase anon key (used for Realtime)
-- and PostgREST exposes every public-schema table by default unless RLS
-- restricts it. Admin-only table — the backend only ever reads/writes it
-- via the superuser db.query connection (bypasses RLS regardless), so this
-- closes the public PostgREST path without touching app behavior.
-- ============================================================

-- Least privilege, per review feedback: an earlier version of this
-- migration granted SELECT/INSERT/UPDATE/DELETE on this payout table to
-- tendrit_app "for consistency" with other tables, even though no current
-- route uses that role for payout_batches (admin routes use the superuser
-- connection). On a table holding payout data, forward-compatibility isn't
-- worth the extra standing privilege — revoking it now; a future migration
-- can grant exactly what's needed (even just SELECT) if/when a route
-- actually requires it. This REVOKE is here specifically to undo that
-- earlier GRANT on the already-applied database, since migrations in this
-- project are run directly against the live DB rather than tracked/rolled
-- back by a CLI — editing the GRANT line out of this file alone wouldn't
-- un-grant what was already applied.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payout_batches FROM tendrit_app;

ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payout_batches_admin_all" ON public.payout_batches;

-- No `TO` clause — applies to PUBLIC (every role), matching every other
-- admin-only policy in this schema, e.g. disputes_select_admin in
-- 20260609210006_enable_rls_all_tables.sql. Safe for anon/unauthenticated/
-- unmapped requests: current_app_user_role() (defined in
-- 20260605210000_enable_rls.sql, the very first migration, so it already
-- exists before this one in any full ordered replay, e.g. `supabase db
-- reset`) reads `current_setting('app.current_user_id', true)` — the
-- `true` flag means it returns NULL instead of erroring when that setting
-- was never set. A SQL function whose single SELECT matches zero rows
-- (NULL = any id) likewise returns NULL, never an error. A NULL result in
-- a USING/WITH CHECK clause is treated by Postgres as deny, not as an
-- accidental allow.
--
-- current_app_user_role() is also explicitly declared SECURITY DEFINER
-- (20260605210000_enable_rls.sql) — it runs with its owner's privileges,
-- not the calling role's, so its internal `SELECT role FROM public.users`
-- bypasses RLS on `users` entirely. It does not depend on the calling role
-- (e.g. tendrit_app under queryAsUser) having its own read access to
-- arbitrary user rows, so admin access through queryAsUser can't silently
-- see "no role" / be denied just because RLS on `users` would otherwise
-- block that lookup.
CREATE POLICY "payout_batches_admin_all" ON public.payout_batches
  FOR ALL
  USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
