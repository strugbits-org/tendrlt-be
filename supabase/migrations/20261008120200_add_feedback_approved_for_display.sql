-- ============================================================
-- feedback_submissions — gate public testimonial display behind explicit
-- admin approval. Without this, any 4-5 star public submission (which only
-- needs to pass Turnstile's bot-check, not a human review) would appear on
-- the homepage automatically.
-- ============================================================

ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS approved_for_display BOOLEAN NOT NULL DEFAULT false;
