# Didit identity verification for provider onboarding

## Context

We found that `POST /api/quotes` only checks `role === 'provider'` — there is no
identity-verification gate anywhere on quoting. Investigating further, we
found a **shelved plan for exactly this**: `app/provider-onboarding/page.tsx`
has a fully-built-but-commented-out "Step 6: Identity" for a vendor called
Sumsub, abandoned with the note *"Sumsub SDK will be integrated here when
account access is available"*. No Sumsub code, keys, or SDK exist anywhere
else in either repo — it was never wired up.

You want to revive this using **Didit** instead of Sumsub (broad Jamaica/
230+-country document coverage, 500 free verifications/month, hosted-session
flow that's simpler to integrate than Sumsub's embedded WebSDK), and you want
**two independent verification signals** on a provider, not one:

- `is_verified` / `verification_status` — the **existing** manual flow where
  an admin reviews uploaded documents (`routes/admin.js` approve/reject).
  Unchanged by this work.
- a **new** automated identity signal from Didit (ID document + liveness +
  face match), stored separately.

This plan wires up the Didit side end-to-end (session creation → hosted
redirect → signed webhook → status stored → onboarding UI reflects it), adds
the two independent columns you described, **and** gates `POST /api/quotes`
on both of them. Confirmed rule: **AND** — a provider needs
`verification_status = 'approved'` (admin manual review) **and**
`didit_status = 'approved'` (automated Didit check) before they can submit a
quote. Either one alone is not enough.

## Design decisions (from codebase investigation)

- **New columns, not a new enum value.** `verification_status` is a fixed
  Postgres enum (`'pending'|'approved'|'rejected'`) used by the existing
  admin approve/reject flow (`routes/admin.js:268-378`) and by
  `routes/providers.js` go-live (`providers.js:685-698`). Reusing it for
  Didit would mean `ALTER TYPE ... ADD VALUE` migrations sprinkled across
  every cast site. Instead: new plain-`TEXT` columns on `provider_profiles`,
  fully independent of the admin flow.
- **Webhook writes use `db.query` (superuser), not `queryAsUser`.** A webhook
  request has no authenticated user, so it can't go through the RLS-scoped
  helper (`db.js:43-59` requires a real `userId`). This mirrors how
  `feeConfig.js` and admin's read-only aggregations already use the
  superuser pool. No RLS policy changes are needed — `provider_profiles`
  policies are row-level, and any new column is automatically covered.
- **Fail closed on signature verification — the opposite of `turnstile.js`.**
  `lib/turnstile.js` intentionally fails *open* (missing secret / network
  error → let the request through) because it's bot mitigation. A KYC
  webhook is the opposite risk: an unverifiable signature must be rejected
  (401), never trusted. This is a deliberate divergence from the closest
  existing precedent, called out explicitly so it isn't "fixed" later by
  someone copying the turnstile pattern.
- **Raw body required for HMAC.** `index.js:30-31` currently applies
  `express.json()` globally before any route mounts, which would consume the
  webhook body before we can verify its signature over raw bytes. The Didit
  webhook route needs `express.raw({ type: 'application/json' })` mounted
  **ahead of** the global JSON parser, isolated to that one path.
- **Hosted-redirect flow, no client SDK** — matches the existing Google OAuth
  pattern (`app/(auth)/auth/page.tsx` → `window.location.href` out,
  `app/api/auth/callback/route.ts` handles the return leg). Didit's flow is
  the same shape: leave the page, come back with a query param, refetch
  status.
- **`GET /api/providers/me` needs no route-code change** to surface the new
  fields — it already does `SELECT to_json(p.*) FROM provider_profiles p`
  (`providers.js:41-52`), so any new column appears in the response
  automatically. Only the frontend needs to read the new fields.

## Backend changes (`tendrlt-be`)

**1. Migration** — `supabase/migrations/<timestamp>_add_didit_verification.sql`
```sql
ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS didit_session_id   TEXT,
  ADD COLUMN IF NOT EXISTS didit_status        TEXT NOT NULL DEFAULT 'not_started',
    -- not_started | pending | approved | declined
  ADD COLUMN IF NOT EXISTS didit_decision      JSONB,   -- last raw webhook payload, for admin audit
  ADD COLUMN IF NOT EXISTS didit_verified_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS didit_updated_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_provider_profiles_didit_status
  ON public.provider_profiles(didit_status);
```
(Mirrors the style of `20260617120000_add_provider_verification_fields.sql`.)

**2. `lib/didit.js`** (new) — same shape as `lib/turnstile.js` (plain
functions, `[didit]`-prefixed logging, JSDoc), but fail-closed:
- `createVerificationSession({ providerId, firstName, lastName, callbackUrl })`
  → POSTs to Didit's session-create endpoint (exact path/header names —
  `verification.didit.me/v3/session/`, likely `Authorization`/`x-api-key`
  header — confirmed against `docs.didit.me/reference/api-full-flow` at
  implementation time, not guessed), passing `vendor_data: providerId` so the
  webhook can map straight back to a provider without a join. Returns
  `{ sessionId, url }`.
- `verifyWebhookSignature(rawBody, headers)` → HMAC check using
  `DIDIT_WEBHOOK_SECRET`, preferring `X-Signature-V2` per Didit's docs
  (falls back to `X-Signature-Simple` only if V2 header absent). Returns
  boolean. No secret configured → returns `false` (fail closed), logged loudly.

**3. `routes/providers.js`** — two new authenticated endpoints, alongside
the existing `/me`, `/upload/document`, `/go-live`:
- `POST /verification/session` (`authenticate, authorize('provider')`) —
  calls `lib/didit.js#createVerificationSession`, stores
  `didit_session_id` + `didit_status = 'pending'` via `queryAsUser`, returns
  `{ url }` for the frontend to redirect to.
- (no separate status endpoint needed — `GET /me` already returns it)

**4. `routes/webhooks.js`** (new) — `POST /didit`, no `authenticate`
middleware (Didit calls this, not a logged-in user):
1. Verify signature via `lib/didit.js#verifyWebhookSignature` over the raw
   body → 401 on failure, no DB touch.
2. Parse `vendor_data` (= `provider_id`) and `session_id` from the payload.
3. `db.query` (superuser) —
   `UPDATE provider_profiles SET didit_status=$1, didit_decision=$2::jsonb, didit_verified_at=CASE WHEN $1='approved' THEN NOW() ELSE didit_verified_at END, didit_updated_at=NOW() WHERE provider_id=$3 AND didit_session_id=$4`
   (the session-id match guards against a stale/replayed session updating a
   newer one).
4. Respond 200 immediately; no fire-and-forget side effects needed yet
   (badge is read live via `/me`), though a future add could notify the
   provider via `notifyUser`/push same as other flows.

**5. `index.js`** — mount the raw-body webhook route **before** the global
`express.json()`/`express.urlencoded()` lines:
```js
app.use('/api/webhooks', require('./routes/webhooks')); // raw body, own parser inside
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
...
```
(`routes/webhooks.js` applies `express.raw({ type: 'application/json' })`
itself, scoped to just its own router.)

**6. `.env.example`** — add:
```
DIDIT_API_KEY=your-didit-api-key
DIDIT_WEBHOOK_SECRET=your-didit-webhook-secret
DIDIT_WORKFLOW_ID=your-didit-workflow-id
DIDIT_BASE_URL=https://verification.didit.me
```

**7. `routes/quotes.js`** — gate `POST /` (currently `routes/quotes.js:21`,
only `authenticate, authorize('provider')`) on both signals, checked right
after `authorize('provider')` and before the existing tender-lookup step:
```js
const verCheck = await db.queryAsUser(req.user.id, `
  SELECT verification_status, didit_status
  FROM public.provider_profiles
  WHERE provider_id = $1
`, [req.user.id]);

const profile = verCheck.rows[0];
if (!profile || profile.verification_status !== 'approved' || profile.didit_status !== 'approved') {
  return res.status(403).json({
    success: false,
    code: 'IDENTITY_VERIFICATION_REQUIRED',
    message: 'Complete identity verification before submitting quotes.',
  });
}
```
(`code: 'IDENTITY_VERIFICATION_REQUIRED'` follows the same
`code`-field-for-the-frontend-to-branch-on convention as `PAYMENT_REQUIRED`
in `providers.js:672-676`.) No RLS change needed — `provider_profiles` is
already readable by its own `provider_id` row via `queryAsUser`.

## Frontend changes (`tendrlt-fe`)

**`app/provider-onboarding/page.tsx`** — re-enable Step 6 per the file's own
documented recipe:
1. Uncomment the `{ n: 6, label: 'Identity', sub: 'ID verification' }` entry
   in `STEPS` (line 78).
2. Add `6` back into `STEP_FLOW` (line 84) between `5` and `7`.
3. Uncomment the JSX block (lines 1293-1352) and replace its placeholder
   "Take Selfie" button with the real flow:
   - On click: `POST ${env.apiUrl}/api/providers/verification/session` →
     `window.location.href = data.url` (full navigation out, same pattern as
     `handleGoogleAuth` in `app/(auth)/auth/page.tsx:265-268`).
   - Read `profile.didit_status` (now present on the `/me` payload) to
     render one of: not started (current placeholder), pending (Didit is
     processing — poll or just show "check back shortly"), approved (green
     confirmation, matches `isApproved` styling elsewhere), declined (retry
     button, same tone as the existing `isRejected` UI for doc review).
4. Add a return-leg handler: Didit's `callbackUrl` points back at
   `/provider-onboarding?step=6`; on mount, if that query param is present,
   refetch `/api/providers/me` to pick up the fresh `didit_status` (same
   `useSearchParams`-inside-`Suspense` idiom as `app/(auth)/auth/page.tsx:155-162`,
   `page.tsx:648-654`).
5. Fix the pre-existing "Step X of 6" labels (lines 1148, 1232, 1303, 1358)
   to "of 8" now that we're touching this numbering — cosmetic leftover from
   before Payment/Go-Live existed as separate steps, unrelated to Didit but
   directly adjacent to the code being edited.

No new frontend env vars needed — the Didit session is created backend-side;
the frontend only ever talks to the Express API it already calls everywhere
else (`credentials: 'include'`, no `lib/api.ts` wrapper exists, so this
follows the same raw-`fetch` convention as every other call site).

## Explicitly out of scope (follow-up, not this change)

- Binding the hardcoded "Identity Verified" trust-badge copy in
  `app/(provider-dash)/provider-profile/page.tsx:515-521` to the real
  `didit_status` — currently static marketing copy, unrelated to any data.
- Any new transactional email in `lib/verificationEmails.js` for a Didit
  decline — not required for the core flow to work; can reuse the toast/UI
  state instead, add later if you want an email too.

## Verification plan

1. `npm run dev` on both repos; sign up a fresh provider account, walk
   onboarding to Step 6.
2. Click "Take Selfie" (renamed appropriately) → confirm redirect to a real
   Didit-hosted URL with the session's `vendor_data` matching the logged-in
   provider's id (inspect the outbound request/session payload).
3. Complete a test verification in Didit's sandbox (or decline it) → confirm
   the webhook fires, `didit_status`/`didit_decision`/`didit_verified_at`
   update in `provider_profiles`, and the browser reflects the new status
   after landing back on `/provider-onboarding?step=6`.
4. Send a forged/unsigned request to `POST /api/webhooks/didit` directly
   (e.g. via `curl`) → confirm 401, confirm the DB row is untouched.
5. Confirm `GET /api/providers/me` includes the new fields with no other
   route touched, and that the existing admin manual-review flow
   (`/admin/verification`) is completely unaffected by any of this.
6. As a provider missing either signal (e.g. `verification_status='pending'`
   or `didit_status='not_started'`), call `POST /api/quotes` → confirm 403
   with `code: 'IDENTITY_VERIFICATION_REQUIRED'`, no row inserted into
   `quotes`. Then get both signals to `'approved'` (admin-approve in
   `/admin/verification` + complete a passing Didit session) and confirm the
   same request now succeeds.
