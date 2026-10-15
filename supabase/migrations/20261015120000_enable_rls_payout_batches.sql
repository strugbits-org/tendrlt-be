-- ============================================================
-- Fix: payout_batches was the only table in the schema created without
-- RLS. Flagged by Supabase's scanner (rls_disabled_in_public) — the
-- frontend ships a public anon key (used for Realtime), and PostgREST
-- exposes every public-schema table by default unless RLS restricts it.
-- Admin-only table; the backend only reads/writes it via a superuser
-- connection that bypasses RLS regardless, so this only closes the public
-- PostgREST path. No rollback path — applied and verified directly
-- against the live DB (see verification notes below each step).
-- ============================================================

-- Revoke standing privileges nothing currently needs, rather than leave
-- them granted "just in case": no route uses tendrit_app for this table
-- (admin routes use the superuser connection), and Supabase's default
-- anon/authenticated table grants mean RLS would otherwise be the only
-- barrier for those two roles on payout data. Each REVOKE is guarded by
-- an existence check so this migration doesn't fail on an environment
-- missing one of these roles (e.g. a bare local Postgres without the
-- Supabase platform roles, or a fresh DB where tendrit_app — created in
-- 20260605210000_enable_rls.sql — hasn't been provisioned yet).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tendrit_app') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payout_batches FROM tendrit_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.payout_batches FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.payout_batches FROM authenticated;
  END IF;
END $$;
-- Verified: SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name = 'payout_batches' AND grantee IN ('tendrit_app','anon','authenticated')
-- returns zero rows after this migration runs.

ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;
-- Verified: SELECT relrowsecurity FROM pg_class WHERE relname = 'payout_batches' -> true.

DROP POLICY IF EXISTS "payout_batches_admin_all" ON public.payout_batches;

-- No `TO` clause (applies to PUBLIC), matching every other admin-only
-- policy in this schema (e.g. disputes_select_admin). Safe for anon/
-- unmapped callers: current_app_user_role() (20260605210000_enable_rls.sql)
-- is SECURITY DEFINER, so its internal `users` lookup bypasses RLS and
-- doesn't depend on the caller's own access; it reads current_setting(...,
-- true), which returns NULL rather than erroring when unset. A NULL
-- USING/WITH CHECK result is deny, never an accidental allow.
CREATE POLICY "payout_batches_admin_all" ON public.payout_batches
  FOR ALL
  USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
-- Verified against the live DB after this migration ran:
--   1. A real anon-key PostgREST GET to /rest/v1/payout_batches returned [] (empty),
--      not the row that exists in the table.
--   2. A query executed as tendrit_app with app.current_user_id set to a real
--      non-admin (homeowner) user's id also returned zero rows via this policy.
--   3. The app's own admin-authenticated route (GET /api/admin/payouts, which
--      uses the superuser connection, unaffected by RLS either way) still
--      returned correct data, confirming no regression to app behavior.
