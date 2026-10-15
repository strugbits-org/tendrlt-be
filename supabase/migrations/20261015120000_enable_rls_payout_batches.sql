-- ============================================================
-- Fix: payout_batches was the only table in the schema created without
-- RLS. Flagged by Supabase's scanner (rls_disabled_in_public) — the
-- frontend ships a public anon key (used for Realtime), and PostgREST
-- exposes every public-schema table by default unless RLS restricts it.
-- Admin-only table; the backend only reads/writes it via a superuser
-- connection that bypasses RLS regardless, so this only closes the public
-- PostgREST path.
-- ============================================================

-- No route uses tendrit_app for this table (admin routes use the
-- superuser connection) — revoke rather than grant standing privileges on
-- payout data that nothing currently needs. Explicit REVOKE because an
-- earlier version of this migration granted it, and was already applied
-- directly to the live DB (this project runs migrations that way, not via
-- a tracked/rollback-able CLI).
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payout_batches FROM tendrit_app;

ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;

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
