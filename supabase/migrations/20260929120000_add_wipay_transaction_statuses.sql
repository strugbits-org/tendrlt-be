-- ============================================================
-- WiPay integration — new transaction_status values for the real payment
-- escrow flow (previously WiPay was deferred; quotes were "accepted" with
-- no actual charge). See documentation/PAYMENTS_AND_JOB_WORKFLOW.md.
--
--   'awaiting_payment' — checkout initiated, WiPay hosted page in progress
--   'payment_failed'   — WiPay reported a non-success result, or our hash
--                         verification failed; homeowner may retry checkout
--
-- ALTER TYPE ... ADD VALUE must be committed before the new label can be
-- used anywhere, so this is its own migration file (kept separate from the
-- transactions table changes in the next migration).
-- ============================================================

ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'awaiting_payment';
ALTER TYPE transaction_status ADD VALUE IF NOT EXISTS 'payment_failed';
