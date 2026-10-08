-- ============================================================
-- feedback_submissions — add optional display fields for the public
-- homepage testimonials section (GET /api/feedback/public/testimonials).
--
-- The public feedback form never sets these — they're NULL for ordinary
-- submissions, and the testimonial endpoint falls back to a generic
-- role-based label ("Homeowner" / "Service Provider" / "TendrIt User")
-- when they're absent. They exist so a specific submission's public
-- byline can be curated (e.g. "Licensed Plumber · Portmore") without
-- collecting that level of detail from every submitter.
-- ============================================================

ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS display_role     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS display_location VARCHAR(100);
