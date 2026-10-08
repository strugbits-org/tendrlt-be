-- ============================================================
-- feedback_submissions — add the submitter's parish, collected directly
-- on the public Feedback form, so real submissions can carry a real
-- location for the public testimonials section (GET
-- /api/feedback/public/testimonials) without relying on the admin-curated
-- display_location field for every entry.
-- ============================================================

ALTER TABLE public.feedback_submissions
  ADD COLUMN IF NOT EXISTS parish VARCHAR(100);
