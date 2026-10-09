-- ============================================================
-- Weekly provider payout batches (admin Payments page).
-- See documentation/PAYMENTS_AND_JOB_WORKFLOW.md for the full design —
-- this closes the "no payout/batch-export mechanism" gap documented there.
--
-- Lifecycle: a transaction becomes payable once the homeowner confirms
-- completion (status = 'completed', completed_at set). An admin groups
-- payable transactions by ISO week, downloads a Scotiabank EFT CSV (which
-- lazily creates/updates the payout_batches row + stamps csv_downloaded_at),
-- then — once the bank batch is actually processed — marks the week (or
-- individual providers within it) as paid, which flips those transactions'
-- status to the new terminal 'paid' value and stamps paid_at.
-- ============================================================

-- New terminal status: funds released to the provider via the Scotiabank
-- batch, confirmed by an admin. Added in its own statement — Postgres
-- forbids using a brand-new enum value inside the same (implicit)
-- transaction it was added in, so no other statement here references it.
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'paid';

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

-- One row per week an admin has generated a CSV for and/or marked paid.
CREATE TABLE IF NOT EXISTS public.payout_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start        DATE NOT NULL,
  week_end          DATE NOT NULL,
  created_by        UUID REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  csv_downloaded_at TIMESTAMPTZ,
  UNIQUE (week_start, week_end)
);

-- transactions.payout_batch_id existed as an unused free-text stub (never
-- written anywhere in the codebase) — repoint it at the new table as a
-- real FK. All existing rows are NULL, so this cast is lossless.
ALTER TABLE public.transactions
  ALTER COLUMN payout_batch_id TYPE UUID USING NULLIF(payout_batch_id, '')::uuid;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_payout_batch_id_fkey
  FOREIGN KEY (payout_batch_id) REFERENCES public.payout_batches(id);

CREATE INDEX IF NOT EXISTS idx_transactions_payout_batch_id ON public.transactions(payout_batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_completed_at ON public.transactions(completed_at) WHERE completed_at IS NOT NULL;
