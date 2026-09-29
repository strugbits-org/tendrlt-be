-- ============================================================
-- provider_payment_details — add recipient/contact/bank-address fields
-- to match the bank's "Create Recipient" form (Business + Individual).
--
-- New nullable at the DB level (existing rows predate these fields);
-- the API layer enforces which ones are required going forward.
-- ============================================================

ALTER TABLE public.provider_payment_details
    ADD COLUMN IF NOT EXISTS recipient_id          VARCHAR(60),   -- required going forward (bank's "Recipient ID")
    ADD COLUMN IF NOT EXISTS middle_initial         VARCHAR(10),   -- individual recipients only
    ADD COLUMN IF NOT EXISTS recipient_bank_type    VARCHAR(20)  NOT NULL DEFAULT 'domestic',

    -- Recipient's own contact information
    ADD COLUMN IF NOT EXISTS contact_address_line1  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS contact_address_line2  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS contact_address_line3  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS contact_city           VARCHAR(100),
    ADD COLUMN IF NOT EXISTS contact_country         VARCHAR(100) DEFAULT 'Jamaica',
    ADD COLUMN IF NOT EXISTS contact_state           VARCHAR(100),
    ADD COLUMN IF NOT EXISTS contact_zip             VARCHAR(20),
    ADD COLUMN IF NOT EXISTS contact_phone           VARCHAR(30),
    ADD COLUMN IF NOT EXISTS contact_email           VARCHAR(255),

    -- Bank branch address detail (beyond the existing bank_address free-text line)
    ADD COLUMN IF NOT EXISTS bank_city              VARCHAR(100),
    ADD COLUMN IF NOT EXISTS bank_country            VARCHAR(100) DEFAULT 'Jamaica',
    ADD COLUMN IF NOT EXISTS bank_state              VARCHAR(100),
    ADD COLUMN IF NOT EXISTS bank_zip                VARCHAR(20);
