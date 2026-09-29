-- ============================================================
-- Chatbot content — admin-managed knowledge base for the public
-- "Ask TendrIt Anything" homepage assistant.
--
-- chatbot_settings: singleton row (id = 1) holding free-text company
--   info the assistant is grounded on (about, policies, extra notes).
-- chatbot_faqs: ordered list of Q&A pairs the admin curates.
--
-- Both are read publicly (no auth) by the chat endpoint building the
-- system prompt, and written only by admins.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chatbot_settings (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    company_name      VARCHAR(120)  NOT NULL DEFAULT 'TendrIt',
    tagline           VARCHAR(200),
    about             TEXT,             -- what TendrIt is, how it works
    policies          TEXT,             -- fees, escrow, disputes, verification, etc.
    extra_notes       TEXT,             -- anything else the assistant should know
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

INSERT INTO public.chatbot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.chatbot_faqs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question          TEXT NOT NULL,
    answer            TEXT NOT NULL,
    display_order     INTEGER NOT NULL DEFAULT 0,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL,
    updated_at        TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chatbot_faqs_active_order
  ON public.chatbot_faqs (display_order) WHERE is_active;

DROP TRIGGER IF EXISTS update_chatbot_settings_updated_at ON public.chatbot_settings;
CREATE TRIGGER update_chatbot_settings_updated_at
    BEFORE UPDATE ON public.chatbot_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_chatbot_faqs_updated_at ON public.chatbot_faqs;
CREATE TRIGGER update_chatbot_faqs_updated_at
    BEFORE UPDATE ON public.chatbot_faqs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Row Level Security — public read, admin write.
-- The app's own routes (chat.js / admin.js) use the superuser db.query
-- connection and bypass RLS entirely; these policies are defense-in-depth
-- in case anything ever queries these tables as tendrit_app.
-- ============================================================
GRANT SELECT ON public.chatbot_settings, public.chatbot_faqs TO tendrit_app;
GRANT INSERT, UPDATE, DELETE ON public.chatbot_settings, public.chatbot_faqs TO tendrit_app;

ALTER TABLE public.chatbot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_faqs     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chatbot_settings_select_public" ON public.chatbot_settings;
DROP POLICY IF EXISTS "chatbot_settings_write_admin"   ON public.chatbot_settings;
DROP POLICY IF EXISTS "chatbot_faqs_select_public"     ON public.chatbot_faqs;
DROP POLICY IF EXISTS "chatbot_faqs_write_admin"       ON public.chatbot_faqs;

CREATE POLICY "chatbot_settings_select_public" ON public.chatbot_settings
  FOR SELECT USING (true);

CREATE POLICY "chatbot_settings_write_admin" ON public.chatbot_settings
  FOR ALL USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');

CREATE POLICY "chatbot_faqs_select_public" ON public.chatbot_faqs
  FOR SELECT USING (true);

CREATE POLICY "chatbot_faqs_write_admin" ON public.chatbot_faqs
  FOR ALL USING (public.current_app_user_role() = 'admin')
  WITH CHECK (public.current_app_user_role() = 'admin');
