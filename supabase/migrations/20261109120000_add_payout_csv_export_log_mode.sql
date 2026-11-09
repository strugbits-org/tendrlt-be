-- ============================================================
-- payout_csv_export_log didn't distinguish which non-bank export mode was
-- taken (records-only vs the newer full-review export, which additionally
-- causes bank branch/address — PII-adjacent fields — to leave the system,
-- not just the account/ABA numbers records mode already exports).
-- Bot-reviewer-flagged: without this, the audit trail can't tell a routine
-- records pull apart from a full-field review export.
--
-- 'bank' is included in the CHECK even though the current code never logs
-- that mode to this table (it's tracked via payout_batches instead), so a
-- future change that does start logging it here doesn't need another
-- migration just to widen this constraint.
-- ============================================================
ALTER TABLE public.payout_csv_export_log
  ADD COLUMN IF NOT EXISTS export_mode TEXT NOT NULL DEFAULT 'records';

-- DROP + ADD (rather than a guarded ADD) so this is both idempotent and
-- able to pick up the constraint's definition changing (e.g. 'bank' being
-- added here) on a re-run, instead of silently keeping a stale version.
ALTER TABLE public.payout_csv_export_log
  DROP CONSTRAINT IF EXISTS payout_csv_export_log_export_mode_check;

ALTER TABLE public.payout_csv_export_log
  ADD CONSTRAINT payout_csv_export_log_export_mode_check
  CHECK (export_mode IN ('records', 'full', 'bank'));
