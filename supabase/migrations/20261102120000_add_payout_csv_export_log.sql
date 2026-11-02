-- ============================================================
-- Durable audit trail for the records-mode payout CSV export
-- (GET /api/admin/payouts/:weekStart/export-csv?includePaid=1).
--
-- That export decrypts and includes provider bank account numbers (masked
-- to the last 4 digits, but still leaving the system) and, unlike the
-- bank-upload export, never touches payout_batches — so until now it had
-- no record anywhere except a console.log line, which is lost on log
-- rotation/restart. This table gives it the same kind of durable trail the
-- bank-upload path already gets via payout_batches.csv_downloaded_at.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.payout_csv_export_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start  DATE NOT NULL,
  admin_id    UUID REFERENCES public.users(id),
  exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_csv_export_log_week_start ON public.payout_csv_export_log(week_start);

-- Same reasoning as 20261015120000_enable_rls_payout_batches.sql: admin-only
-- table, written/read exclusively via the backend's superuser connection
-- (routes/adminPayouts.js uses db.query, never queryAsUser/tendrit_app), so
-- this only closes the public PostgREST path for the anon/authenticated
-- Supabase platform roles.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tendrit_app') THEN
    REVOKE ALL ON public.payout_csv_export_log FROM tendrit_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.payout_csv_export_log FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.payout_csv_export_log FROM authenticated;
  END IF;
END $$;

ALTER TABLE public.payout_csv_export_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payout_csv_export_log_admin_all" ON public.payout_csv_export_log;

CREATE POLICY "payout_csv_export_log_admin_all" ON public.payout_csv_export_log
  FOR ALL
  USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
