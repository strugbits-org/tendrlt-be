-- ============================================================
-- payout_csv_export_log didn't distinguish which non-bank export mode was
-- taken (records-only vs the newer full-review export, which additionally
-- leaves bank branch/address — PII-adjacent fields — out of the system).
-- Bot-reviewer-flagged: without this, the audit trail can't tell a routine
-- records pull apart from a full-field review export.
-- ============================================================
ALTER TABLE public.payout_csv_export_log
  ADD COLUMN IF NOT EXISTS export_mode TEXT NOT NULL DEFAULT 'records';

ALTER TABLE public.payout_csv_export_log
  ADD CONSTRAINT payout_csv_export_log_export_mode_check
  CHECK (export_mode IN ('records', 'full'));
