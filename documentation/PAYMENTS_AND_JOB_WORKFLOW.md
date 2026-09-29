# Payments & Job Workflow

This is the reference doc that `routes/quotes.js` and `routes/tenders.js` already point to in comments ("See documentation/PAYMENTS_AND_JOB_WORKFLOW.md") — it didn't exist as a file until now. Written 2026-09-28.

## 1. The intended end-to-end workflow (per product decision)

1. **Homeowner creates a job** (tender).
2. **Provider submits a quote.**
3. **Homeowner accepts a quote and pays** — via **WiPay** — into TendrIt's admin/merchant WiPay account. Funds are **held in escrow**, not released yet.
4. **Provider marks the job done** (`PATCH /api/quotes/:id/mark-done`).
5. **Homeowner confirms completion** (`PATCH /api/tenders/:id/complete`) — or opens a dispute instead.
6. Once confirmed, the held transaction is **released** and money is owed to the provider (platform fee already deducted at quote-accept time — see §2).
7. **Providers are paid weekly, in a batch** — not per-job, per-transaction. Every Friday (or whatever cadence is chosen), the admin exports everyone's accumulated, released-but-unpaid earnings into **one bulk EFT batch file** and uploads it through **Scotiabank Jamaica's business banking portal**. That single upload pays every provider due that week in one shot.

So there are two separate money movements, on two separate rails:
- **Inbound** (homeowner → TendrIt): WiPay, per-transaction, at quote-accept time.
- **Outbound** (TendrIt → provider): Scotiabank batch EFT, weekly, aggregated across all of that provider's released transactions since the last payout run.

## 2. What's already built vs. what's still missing

### Built and working today
- **WiPay inbound payment collection (2026-09-29) — see §2b below for full detail.** `PATCH /api/quotes/:id/accept` now initiates a real WiPay hosted-page checkout instead of finalizing directly; the quote is only actually accepted once WiPay confirms payment via `GET /api/payments/wipay/callback`. Currently configured for **sandbox**.
- **Completion handshake**: two-step — provider marks done, then homeowner confirms (or disputes) — before a transaction is considered settled.
- **Provider banking capture**: fully built, see §4 below. Encrypted at rest (AES-256-GCM), masked on read-back, decrypt-on-demand only for the admin verification view.
- **Admin visibility**: `admin.js` `/verifications/:providerId/payment` lets an admin reveal a provider's decrypted banking details for verification (already reviewed and confirmed secure in an earlier session).

### NOT built yet (the actual gap)
- **WiPay is only in sandbox, not live** — see §2b for exactly what flipping to production requires.
- **No payout/batch-export mechanism.** Nothing currently reads `public.transactions` to produce a payment file. There is no "released but unpaid" query, no batch/run concept, no file generator, no admin UI to trigger or download a batch.
- **No reconciliation step** — once an admin uploads a batch to Scotiabank, nothing in TendrIt marks those transactions as `paid`/`payout_queued` → `completed`. That status transition needs to be built (manual "mark batch as sent" action at minimum; ideally also a way to record Scotiabank's confirmation/failed-item report back).

## 2b. WiPay inbound payment collection — implementation (2026-09-29)

**Flow**: homeowner clicks "Accept & Pay" on `/quote-accept` → `PATCH /api/quotes/:id/accept` computes `amount + client_fee` (same fee-snapshot logic as before, just moved earlier — now computed at checkout instead of at acceptance, since acceptance itself no longer happens synchronously), upserts a `public.transactions` row with the new `awaiting_payment` status, calls WiPay's Payments Request API (`lib/wipay.js`), and returns `{ url }` for the frontend to full-page-redirect to (`window.location.href`, same pattern as the Google OAuth and Didit redirects elsewhere in the app). The homeowner pays on WiPay's hosted page. WiPay then redirects their **browser** (not a server call) back to `GET /api/payments/wipay/callback` with the result in the querystring. That route verifies the response hash, and **only then** actually accepts the quote — rejects rival quotes, moves the tender to `in_progress`, flips the transaction to `held`, fires the provider notification fan-out (email/push/realtime) — before redirecting the browser back to `/quote-accept?payment=success|failed`.

**Files**:
- `lib/wipay.js` — `createPaymentRequest()` (starts checkout), `verifyResponseHash()` (md5 of `transaction_id + total + api_key`, per WiPay's docs — this is the ONLY thing preventing someone from hand-crafting a fake success redirect).
- `routes/quotes.js` `PATCH /:id/accept` — rewritten to initiate checkout only.
- `routes/payments.js` (new) `GET /wipay/callback` — the actual accept-finalization logic (moved here from the old direct-accept code).
- Migrations `20260929120000`/`20260929120001` — added `transaction_status` enum values `awaiting_payment` and `payment_failed`, plus `wipay_order_id` (unique, matches the callback to the right pending transaction), `wipay_transaction_id`, `wipay_last_message` columns on `public.transactions`.

**Sandbox vs. live** — controlled entirely by `WIPAY_ENVIRONMENT` in `.env`:
- **sandbox** (current setting): `lib/wipay.js` ignores whatever's in `WIPAY_ACCOUNT_NUMBER`/`WIPAY_API_KEY` and uses WiPay's own fixed test values (`account_number=1234567890`, hash key `123`) — this is required by WiPay's docs, not a choice we made. Test with the card numbers in WiPay's PDF (e.g. Mastercard `5111111111111111` = approved, `5111111111113333` = declined) to exercise both the success and failure paths through `/api/payments/wipay/callback`.
- **live**: flip `WIPAY_ENVIRONMENT=live`, and it uses the real merchant credentials already in `.env` (`WIPAY_ACCOUNT_NUMBER=4348595802`, from the WiPay Developer dashboard, registered to `www.tendrit.com`). **Before going live**: confirm `fee_structure` — currently set to `merchant_absorb` (TendrIt eats WiPay's own processing cut; the homeowner is only ever charged quote + TendrIt's platform fee, never a third WiPay fee on top) — this is a business call worth re-confirming, not something I decided unilaterally is definitely right long-term.

**Sandbox quirk observed 2026-09-29**: the shared sandbox merchant account (`1234567890`) displays as "WiPay Test" on the hosted page (expected — it's WiPay's shared demo account, not our real TendrIt profile) and appears to be **USD-only**, silently converting our submitted JMD total to its USD equivalent (e.g. a J$1,232 total showed as ~$7.95 USD — consistent with a ~155 JMD/USD rate). This should not appear once `WIPAY_ENVIRONMENT=live` uses the real, JM-registered TendrIt account. **This did surface a real bug**, now fixed: `routes/payments.js` had a redundant check asserting WiPay's returned `total` exactly matched our own JMD-computed amount, which would have **incorrectly rejected a legitimately successful sandbox payment** whenever this currency conversion kicked in. Removed the hard rejection — the cryptographic hash check (which authenticates whatever `total` WiPay actually reports, converted or not) is the correct and sufficient check; the amount comparison is now log-only. Worth re-confirming this entire question is moot once tested against the live account (no conversion expected there), but the code fix stands regardless.

**Known reliability gap — same lesson as the Didit integration, worse here**: WiPay's classic Payments API (the one documented in the PDF) has **no server-to-server webhook and no "check transaction status" endpoint to poll** — the *only* confirmation channel is the browser redirect to `response_url`. If a homeowner closes the tab or loses connection at exactly the wrong moment after paying, WiPay has their money but our DB never finds out, and unlike Didit there is currently no way to reconcile that automatically. **Partially closed — see §2c.**

## 2c. WiPay webhook (WAPI) — server-to-server backstop (2026-09-29)

The dashboard's "Create Webhook Endpoint" screen (not covered anywhere in the PDF) exposed the real event catalog for API Family **"Payments API"**: `payment.created`, `payment.success`, `payment.failed`, `payment.error`, `payment.refund_requested`, `payment.refund_rejected`, `payment.refunded`, `payment.chargeback_pending`, `payment.chargeback_processed`, `payment.chargeback_released`, `payment.fraud_confirmed`.

**Built**: `POST /api/webhooks/wipay` in `routes/webhooks.js`, using the shared `lib/quotePayments.js` (`finalizeAcceptedQuote`/`markPaymentFailed`) — the exact same finalize logic the browser-redirect callback uses, so a quote never gets accepted twice regardless of which channel's confirmation arrives first (or both).

**What's still genuinely unknown, and why this is built defensively**: WiPay's dashboard shows the *event catalog* but not the *payload/signature format* for this webhook product — no docs were available for it. Rather than guess at an unverifiable envelope-signing scheme (which could either wrongly reject real events, or worse, create false confidence in a check that isn't actually checking anything), this handler **only finalizes a `payment.success` event when the payload contains the SAME documented hash fields from the classic API** (`transaction_id` + `total` + `hash`, verified via the already-implemented `verifyResponseHash()`). If those fields aren't present in the real payload shape, the webhook safely no-ops and logs a warning — finalization still happens correctly via the browser redirect, it just doesn't get the webhook's reliability upgrade until this is tightened up against a real payload.

**What you need to do to finish closing this gap:**
1. **"Only public HTTPS endpoints are allowed"** (per the dashboard) — same constraint we hit with Didit's webhook. You cannot point this at `localhost` for sandbox testing; you'd need a tunnel (ngrok/Cloudflare Tunnel) exposing your local backend over HTTPS, or just wait until this is deployed with a real public URL. Target URL should be `https://<your-backend-domain>/api/webhooks/wipay`.
2. Once you create the endpoint and it delivers a **real** event (e.g. trigger a sandbox `payment.success`), **paste me the raw payload** (server logs will print it in full — `[wipay webhook] payload: ...`) so I can see the actual field names/shape and tighten the parsing (it currently guesses at `event`/`data.order_id`/etc. field names).
3. ~~If WiPay reveals a signing secret~~ **Done (2026-09-29)** — a `whsec_...` secret was issued and added to `.env` as `WIPAY_WEBHOOK_SECRET`. That prefix is the exact convention used by **Svix** and the related **Standard Webhooks spec** (https://www.standardwebhooks.com/) — a well-founded guess, still not WiPay-documented, but a strong signal. Implemented in `lib/wipay.js#verifyWebhookSignature()`: expects `webhook-id`/`webhook-timestamp`/`webhook-signature` headers (or the `svix-*` equivalents), HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the base64-decoded secret, base64-compared against the `v1,<sig>` value(s) in the signature header, with a 5-minute replay-timestamp tolerance (mirrors the Didit webhook's own replay protection). `routes/webhooks.js`'s `POST /wipay` now rejects (401) any delivery that fails this check, **before** parsing the body at all. The classic hash fields (`transaction_id`+`total`+`hash`) are still checked as a second, independent layer when present in the payload, but are no longer required once the signature passes.
   **This is unconfirmed against a real delivery** — if the first real webhook gets rejected with `[wipay webhook] missing webhook-id/webhook-timestamp/webhook-signature ... headers`, that tells us immediately the header names guessed are wrong (send me that log line's full header list and I'll adjust).
4. Recommended events to select when creating the endpoint: `Payment Success`, `Payment Failed`, `Payment Error` at minimum (these three are handled). The chargeback/refund events are received and logged loudly (`needs manual follow-up`) but have no automated handling yet — that's a separate, unbuilt piece of work (dispute/refund handling on the WiPay side, distinct from TendrIt's own homeowner-vs-provider dispute system).

## 3. Research: what file format does Scotiabank actually need?

I looked this up directly rather than assuming — two important findings, one of them a correction of the obvious assumption.

### ⚠️ The public "ScotiaConnect EFT Payments Reference Guide" is for CANADA, not Jamaica
I found and read Scotiabank's own EFT Payments Reference Guide (Jan 2026) end-to-end. It documents ScotiaConnect's EFT feature — but that product is **Canadian domestic EFT**: payments use a 3-digit **CPA code** (Canadian Payments Association standard) and the guide states explicitly *"Payment Currency: Select the currency for this payment. CAD and USD are the only options available."* This is not the product Scotiabank Jamaica business banking customers use for JMD payments. **Do not build against this format** — it would be the wrong file entirely. (I'm flagging this clearly because it's the first and most obvious thing search engines surface for "Scotiabank EFT batch file," and it's a trap.)

### The real rail: Jamaica's national ACH (JCBA), which all Jamaican banks (including Scotiabank Jamaica) settle through
Jamaica's interbank clearing for direct credits is run by the **Jamaica Clearing Bankers Association (JCBA)**, operated by Automated Payments Limited (APL) / J.E.T.S. Limited, under oversight of the **Bank of Jamaica**. I read the JCBA's *"Automated Clearing House (ACH) — Rules, Appendices & Technical Specifications"* document (dated Nov 2006, the version publicly hosted — this is the same family of standard NACHA-derived formats used across the industry, so structurally stable even though the doc is old). Key structure — a fixed-width flat file:

| Record | Type code | Purpose | Occurs |
|---|---|---|---|
| File Header | `1` | File-level: origin, destination, creation date/time, file ID | Once per file |
| Company/Batch Header | `5` | Identifies the originator (TendrIt / Scotiabank as ODFI), Standard Entry Class Code, effective entry date | Once per batch |
| Entry Detail | `6` | **One row per payment** — receiving bank routing (`TTTTAAAA`), DFI account number, amount, individual name/ID, transaction code | One or more per batch |
| Batch Control | `8`/`B` | Batch totals: entry count, entry hash, total credit $ | One per batch header |
| File Control | `9` | File totals: batch count, entry/addenda count, total credit $ | Once per file |

The relevant **Standard Entry Class Code is `PPD`** ("Prearranged Payment and Deposit Entry") — this is specifically the class used for crediting an *individual's personal bank account* (as opposed to `CCD`, business-to-business). That matches paying individual providers exactly.

### What this means practically
Scotiabank Jamaica's actual business-banking bulk-payment upload almost certainly either (a) accepts this JCBA/NACHA-style fixed-width file directly, or (b) wraps it in their own simplified CSV/template that maps 1:1 onto these same fields before their system converts it internally. **I could not access Scotiabank Jamaica's own current business-banking file template** — that documentation lives behind an authenticated business-banking portal / is handed to you by a relationship manager once you set up a business account, and isn't publicly indexed. 

**Action item: contact Scotiabank Jamaica Business Banking / Cash Management directly and ask for their current bulk-payment/EFT upload template** before writing any file-generation code. Bring this document's field mapping (§4) to that conversation — it'll make it a quick "does this map cleanly onto your template" conversation rather than starting from zero.

### Corroborating research on jm.scotiabank.com (Jamaica's own site, not the Canadian one)
Checked Scotiabank Jamaica's actual site directly (not the Canadian ScotiaConnect guide) to confirm the above rather than rely on the Canadian doc alone. Findings:

- Jamaica's own **"ScotiaConnect"** (Jamaica's business banking platform — same brand name as Canada's product, but a separate Jamaica-specific product) is described as supporting **"batch payments"** and a step-by-step guide for "3rd party transfers, wires and batch payments" — confirming batch payment capability exists for JM business customers. ([ScotiaConnect | Scotiabank Jamaica](https://jm.scotiabank.com/corporate-commercial/banking-and-investing/scotia-online-for-business-scotiabank-jamaica.html))
- Their **Direct Deposit** service (under Cash Management Services) is explicitly the payroll/disbursement product — and its own page **confirms it can pay accounts at OTHER Jamaican banks, not just Scotiabank**, stating this "is dependent on established Automated Clearing House (ACH) processing times." This directly confirms the JCBA ACH rail (§3 above) is the actual mechanism underneath, not a Scotiabank-only proprietary network. ([Direct Deposits | Scotiabank Jamaica](https://jm.scotiabank.com/corporate-commercial/cash-management-services/direct-deposits.html))
- The small-business version of the same page says to **"Use your accounting or payroll system for generating payment files"** — i.e. Scotiabank doesn't publish the file spec publicly; it expects the file to come from standard payroll/accounting software or be arranged directly with the bank. No format, field list, or upload mechanism is published anywhere on the public site. ([Direct Deposit for Small Business | Scotiabank Jamaica](https://jm.scotiabank.com/small-business/cash-management-services/direct-deposit.html))
- No page publishes the actual file layout — every page redirects to a human contact for setup.

**Net effect: this confirms rather than changes the conclusion above.** The public site independently corroborates (a) batch/EFT payment capability exists for Jamaica business customers, (b) it rides on the national ACH rail (matches the JCBA spec I read), and (c) the concrete file template is not public — you have to get it from the bank directly.

**Concrete contact info found, to use for the action item above:**
- Cash Management / Business Banking: **888-429-5087**, or **bnsj.businessbanking@scotiabank.com**
- General business banking: **888-4-SCOTIA (726842)**
- Small business Direct Deposit specifically: **(876) 946-6272** (Mon–Fri)
- Or: your assigned Scotiabank Relationship Manager, if TendrIt already has one from opening the business account — they're explicitly who every one of these pages defers to for the actual file template/setup.

## 3b. Recipients vs. one-shot batch payments — do you have to register a payee first?

Answered from the same Canadian ScotiaConnect EFT guide/help pages (§3) — the underlying software platform, not confirmed field-for-field for Jamaica, but the **workflow model** is almost certainly identical since it's the same ScotiaConnect product with a different local rail underneath. ScotiaConnect actually supports **three distinct paths**, and you don't have to pick just one:

1. **One-Time EFT Payment Import** (import file `Type: "EO"`) — a single row has EVERYTHING: institution, transit, account, amount, due date, payee name/address, CPA-equivalent code. **This creates and pays in one step — no pre-registered recipient needed.** This is the closest match to "just upload a batch file and it pays."
2. **Recipient Import** (Appendix A CSV — `PayeeRef, PayeeName, InstitutionCode, Transit, Account, ...`) — this only populates a reusable "address book" entry. It does **not** move money by itself.
3. **EFT Payments from Templates** (import file `Type: "ET"`) — references an already-saved recipient/template by ID; only amount + due date need to be supplied per run.

**So: you do not strictly need to pre-register recipients** — path 1 lets a single batch file both define the payee and execute the payment. Recipient/template registration (paths 2+3) exists purely as a **convenience for repeat payees** — since your providers get paid the *same* bank details *every* week, using the template/recipient model would mean future weekly batches only need `TemplateID + Amount`, which is simpler and less error-prone than resending full bank details every single week. For a first sandbox test, path 1 (one-time, no registration) is simplest; for the real weekly production flow once it's running, path 3 (register each provider once, then just push amounts weekly) is the better long-term design.

**Confirm this with the bank once they respond** — the specific question to ask: *"Does Jamaica's ScotiaConnect batch upload support a one-time payment file with full beneficiary + amount in a single row, or must every payee be registered as a recipient first?"* That's a single yes/no question that resolves this completely for their actual Jamaica implementation.

## 3c. Client's fallback plan if the bank stays unresponsive (noted for later phase)

Scotiabank's business banking representative has been unresponsive so far. The client's proposed fallback, once the rest of the platform flow is working end-to-end: build a **test file with a best-guess field set** (derived from this doc's research) and run a **small self-transfer test** — a transaction from the admin's own Scotiabank account back to the admin's own account — to empirically verify whether a given file format is accepted. If it fails, iterate the field set and retry. This is a reasonable, low-risk way to reverse-engineer the accepted format without bank cooperation, since a self-to-self transfer can't cause customer-facing harm even if the file is malformed or misrouted. **This is explicitly a later-phase task** — not to be started until the rest of the flow (onboarding, WiPay sandbox) is confirmed working first.

## 4. Is the data collected during onboarding accurate/sufficient for this?

**Data model: yes, essentially sufficient.** `provider_payment_details` (see `supabase/migrations/20260713120000_create_provider_payment_details.sql` + the recipient/contact fields added later) already has a field for every piece of information an ACH/EFT credit entry needs:

| ACH/EFT concept | Our field | Notes |
|---|---|---|
| Individual Name | `payee_first_name`, `middle_initial`, `payee_surname` | ✓ |
| Individual Identification Number | `recipient_id` | ✓ (TRN or similar) |
| Receiving bank + branch (routing) | `bank_name` + `transit_code` | ⚠️ see gap below |
| DFI Account Number | `account_number_encrypted` (AES-256-GCM) | ✓ — decrypted server-side only when needed |
| Account type | `account_type` | ✓ |
| Currency | `currency` (defaults `'jmd'`) | ✓ — matches domestic JMD ACH |
| SWIFT/BIC, ABA routing | `swift_code`, `aba_routing_encrypted` | Only relevant for international wire, not domestic ACH — harmless extra fields |

**Data quality: NOT currently reliable, and this is the actual finding worth acting on.** In `app/provider-onboarding/page.tsx` (Payment Info step), **`bank_name`, `bank_branch`, and `transit_code` are all plain free-text `<input>` fields** — the provider just types them in. Meanwhile the codebase already contains `lib/bankData.ts`, an accurate, sourced directory of Jamaican banks with real Bank-of-Jamaica ACH transit codes per branch (its own header comment says *"Transit codes: Bank of Jamaica ACH Financial Institution List... the authoritative Jamaica ACH directory"*) — **but it's never wired into the onboarding form.** It's currently only used on the admin side (`bankLabel()` in the Verification tab) to pretty-print a bank name, and even that only works if the stored value happens to match one of the known slugs, which free-typed input generally won't.

Net effect: a provider could easily mistype their transit code, pick the wrong branch's code, or just make something up — and nothing catches it. A wrong transit code is exactly the kind of error that causes a real EFT credit to bounce or land in the wrong branch's queue. **This should be fixed before batch payouts go live**: turn Bank Name into a `<select>` from `BANK_OPTIONS`, and Bank Branch into a dependent `<select>` from `BANK_DATA[bank].branches`, auto-filling `transit_code` (and `swift_code`/`bank_address`) from the chosen branch instead of letting any of it be typed freehand.

## 5. Can this data + research actually produce the batch EFT file?

**Yes, once two things happen:**
1. Scotiabank Jamaica confirms their actual current upload template (§3 action item).
2. The bank-selection data-quality gap above is closed, so `transit_code`/`bank_name` are guaranteed valid rather than freehand text.

At that point, generating a batch is mechanically straightforward given what already exists:
- Query `public.transactions` for rows that are released/completed and not yet paid out, grouped by `provider_id`, summed into one payout amount per provider for the run.
- For each provider, decrypt `account_number_encrypted` server-side (same pattern already used in `routes/admin.js`'s payment-reveal endpoint) just long enough to write it into the file — never persist plaintext.
- Write one Entry Detail row per provider into whatever format Scotiabank confirms (fixed-width JCBA-style, or their own CSV wrapper).
- Mark those transactions as `payout_queued` (the status already exists as a concept per `EarningsClient.tsx`'s status labels) once the file is generated, and `completed` once the admin confirms Scotiabank processed the batch successfully.

## 5b. Current testing plan (2026-09-28)

Agreed order of operations before touching WiPay or Scotiabank at all:
1. **Fix and test the Provider Onboarding flow fully** first — including confirming identity verification is actually mandatory before a provider can quote on any job.
2. Then move to **WiPay homeowner payment collection in a sandbox environment**.
3. Scotiabank batch EFT work (§3) is explicitly **last**, and only after the above two are solid.

### Clarified: what actually gates quoting
`middleware/verification.js` (`requireIdentityVerified`, used by `POST /api/quotes`) originally shipped checking only `verification_status = 'approved'` (admin manual review). An earlier planning doc (`DIDIT_VERIFICATION_PLAN.md`) had specified an AND rule requiring `didit_status = 'approved'` too, and a prior pass in this doc briefly "fixed" the code to match that AND rule — but that turned out to be the **wrong** rule. **Confirmed business rule: only admin approval (`verification_status = 'approved'`) gates quoting.** `didit_status` is informational only — it's the automated ID/liveness/face-match signal shown on the admin Verification tab to help the admin decide, not an independent gate. The code has been reverted to checking `verification_status` alone, and `DIDIT_VERIFICATION_PLAN.md` has been annotated as superseded on this point. Test case to confirm: an admin-approved provider should be able to quote regardless of their `didit_status`.

## 6. Open questions / next steps (for whoever picks this up next)

- [ ] Get Scotiabank Jamaica's actual bulk-payment file template from their business banking team (contacts in §3) — don't build blind against the JCBA spec alone.
- [ ] Fix the onboarding Bank Name/Branch/Transit fields to use `lib/bankData.ts` as dropdowns instead of free text (data-integrity fix, should happen regardless of payout timeline).
- [ ] Decide the weekly batch cadence/cutoff (e.g. "every Friday, transactions released as of Thursday 11:59pm") and who triggers it (manual admin action vs. scheduled job like the existing `lib/feeScheduler.js` pattern).
- [ ] Design the transaction status lifecycle fully: `held` → `completed` (homeowner confirms) → `payout_queued` (batch generated) → `paid` (admin confirms bank processed it) → handle `returned`/`rejected` entries from the bank's response file.
- [x] ~~WiPay integration itself (inbound side)~~ — built 2026-09-29, sandbox only. See §2b.
- [ ] Test the full sandbox flow end-to-end (post job → quote → accept & pay with a WiPay test card → confirm `/quote-accept` shows success and the tender moves to `in_progress`; separately test a declined test card and confirm the homeowner can retry).
- [x] ~~Get WiPay's WAPI/Webhooks documentation~~ — no separate docs found, but the dashboard's "Create Webhook Endpoint" screen exposed the real event catalog for API Family "Payments API": `payment.created`, `payment.success`, `payment.failed`, `payment.error`, `payment.refund_requested`, `payment.refund_rejected`, `payment.refunded`, `payment.chargeback_pending`, `payment.chargeback_processed`, `payment.chargeback_released`, `payment.fraud_confirmed`. Built `POST /api/webhooks/wipay` (2026-09-29) against this — see §2c.
- [ ] Before flipping `WIPAY_ENVIRONMENT` to `live`: re-confirm the `fee_structure = 'merchant_absorb'` choice in `lib/wipay.js`, and update `BACKEND_URL`/`response_url` to the real deployed backend domain (the local sandbox flow works with `localhost` only because this specific redirect is browser-side, not server-to-server — unlike the Didit webhook, this doesn't need a tunnel for local testing, but it does still need the real public URL once deployed).
