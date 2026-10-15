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

-- GRANT rationale: this is NOT covered by the one-time
-- `GRANT ... ON ALL TABLES IN SCHEMA public TO tendrit_app` in
-- 20260605210000_enable_rls.sql — that only applied to tables that existed
-- at that time. Every table created afterward adds its own explicit GRANT
-- in its own migration (see provider_payment_details in
-- 20260713120000_create_provider_payment_details.sql, and
-- chatbot_settings/chatbot_faqs in 20260924120000_create_chatbot_content.sql)
-- — this follows that same established convention. tendrit_app is the role
-- `db.queryAsUser()` connects as elsewhere in the app; no current route uses
-- it for payout_batches specifically (admin routes use the superuser
-- connection instead), so this grant isn't exercised by any code path
-- today — kept for consistency/forward-compatibility, same reasoning as
-- the two examples above.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_batches TO tendrit_app;

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
CREATE POLICY "payout_batches_admin_all" ON public.payout_batches
  FOR ALL
  USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
