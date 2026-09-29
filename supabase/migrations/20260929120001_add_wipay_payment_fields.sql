-- ============================================================
-- WiPay integration — tracking columns on transactions.
--
-- Checkout flow: quote-accept now creates a transaction row in
-- 'awaiting_payment' with a wipay_order_id (our own generated order_id,
-- unique per checkout attempt) BEFORE redirecting the homeowner to WiPay's
-- hosted page. WiPay's response_url redirect (a browser redirect, not a
-- server-to-server webhook — see documentation/PAYMENTS_AND_JOB_WORKFLOW.md)
-- carries that same order_id back, letting routes/payments.js match the
-- callback to the right pending transaction and finalize (or fail) it.
-- ============================================================

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS wipay_order_id       TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS wipay_transaction_id  TEXT,
  ADD COLUMN IF NOT EXISTS wipay_last_message    TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_wipay_order_id ON public.transactions(wipay_order_id);
