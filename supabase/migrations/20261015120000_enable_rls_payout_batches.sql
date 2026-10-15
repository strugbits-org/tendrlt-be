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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_batches TO tendrit_app;

ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payout_batches_admin_all" ON public.payout_batches;

CREATE POLICY "payout_batches_admin_all" ON public.payout_batches
  FOR ALL
  USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
