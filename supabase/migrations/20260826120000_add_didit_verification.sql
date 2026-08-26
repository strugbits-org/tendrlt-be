-- ============================================================
-- Didit identity verification: automated ID + liveness + face-match
-- signal on provider_profiles, independent of the existing manual-review
-- verification_status column (20260617120000_add_provider_verification_fields.sql).
--
-- didit_check_summary intentionally stores only pass/fail + score per check —
-- never the PII Didit's decision payload also carries (document_number,
-- first_name, last_name, date_of_birth). That stays on Didit's side; we only
-- need the verdict. See DIDIT_VERIFICATION_PLAN.md.
-- ============================================================

ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS didit_session_id     TEXT,
  ADD COLUMN IF NOT EXISTS didit_status         TEXT NOT NULL DEFAULT 'not_started',
    -- not_started | pending | approved | declined
  ADD COLUMN IF NOT EXISTS didit_document_type  TEXT,   -- e.g. 'Passport', 'Identity Card', 'Driver License'
  ADD COLUMN IF NOT EXISTS didit_check_summary  JSONB,  -- { document_authentic, liveness_status, face_match_score }
  ADD COLUMN IF NOT EXISTS didit_verified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS didit_updated_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_provider_profiles_didit_status
  ON public.provider_profiles(didit_status);
