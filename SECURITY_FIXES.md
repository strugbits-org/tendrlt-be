# Security fixes — 2026-09-23

## 1. Code fixes applied (done)

| Issue | File | Fix |
|---|---|---|
| Admin account via `?role=admin` on Google sign-in | `routes/auth.js` | `/google` and `/google/callback` now validate the role against `ALLOWED_SIGNUP_ROLES = ['homeowner', 'provider']` instead of trusting the query string / OAuth `state` unchecked. Any other value silently falls back to `homeowner`. |
| JWT secret fell back to `'fallback-secret'` | `routes/auth.js`, `middleware/auth.js` | Fallback removed. The server now throws at startup if `JWT_SECRET` isn't set, so a missing env var is a loud crash instead of a silent, guessable signing key. |
| Provider could delete another provider's portfolio file | `routes/providers.js` (`DELETE /upload/portfolio`) | The storage path is namespaced as `${providerId}/portfolio/...`. The route now rejects any `path` that doesn't start with the caller's own `req.user.id`. |
| Bot protection failed open | `lib/turnstile.js` | Two behaviors changed: (1) if `TURNSTILE_SECRET_KEY` is missing, it now fails **closed** in production (only skips verification outside production, for local dev). (2) if the request to Cloudflare throws (network/outage), it now fails **closed** instead of waving the request through. |

These are committed to the working tree — review the diff and run your test suite / a manual login+signup+portfolio-upload pass before deploying.

### Trade-off to be aware of
Turnstile now fails closed on a Cloudflare outage, meaning **signup/login would be blocked** if Cloudflare's Turnstile service is down. That's the safer default for a security review, but if uptime of auth during a Cloudflare outage matters more to you than bot-protection strictness, this is a deliberate call you can revisit (e.g. re-open only in a documented incident, not silently in code).

## 2. The exposed Didit credentials in git history (not a code fix — needs action from you)

Scrubbing `.env.example` in a new commit (already done in commit `8ddcef1`, present on both `main` and `feat/payment-module`) **does not remove the old values from git history**. They still exist in commit `967c95b` and are fetchable by anyone with read access to the repo (`git show 967c95b:.env.example`, or via GitHub's "History" view), even though the current file looks clean. The same applies to the deleted KYC webhook log and committed agent-permissions file mentioned in that same cleanup commit.

**The only real fix is to treat those values as compromised and rotate them** — rewriting history is optional and mostly cosmetic once a value has been pushed to a shared remote (someone may already have cloned or forked it).

### Step 1 — Rotate the leaked secrets (do this regardless of anything else)
In the Didit dashboard (business.didit.me):
1. Regenerate the **API key** that was committed (`RN0d_5qy...`).
2. Regenerate/rotate the **webhook secret** (`2QiVitL9...`).
3. If workflow IDs can be regenerated/replaced, do the same for the workflow ID (`7f30dbe1-...`) — otherwise at least confirm it alone (without the API key) isn't sensitive on its own.
4. Update the real values in your actual deployment's env vars (Vercel/Render/whatever hosts the backend) — **not** in `.env.example`, which should only ever hold placeholders.

Also check for anything else that may have been committed for real at any point (search history, not just the current tree):
```bash
git log --all -p -- .env .env.local .env.production | less
git log --all --oneline -- .env .env.local .env.production
```
If anything else (DB password, Supabase service key, JWT secret, VAPID keys, payment encryption key) was ever committed with a real value, rotate that too — same reasoning applies.

### Step 2 — Purge the secrets from git history (optional, do after rotating)
Only do this if you actually want the old values gone from history (e.g. compliance requirement), since it rewrites commit hashes on every branch and requires everyone with a clone to re-clone or hard-reset.

Using `git filter-repo` (recommended over the older `BFG`/`filter-branch`):
```bash
# Install: pip install git-filter-repo   (or) brew install git-filter-repo
git filter-repo --path .env.example --invert-paths --force   # removes the file from ALL history
# Or, to keep the file but scrub only the secret strings from every commit:
git filter-repo --replace-text <(cat <<'EOF'
7f30dbe1-476d-4d6c-b685-da080b5631a3==>REDACTED
RN0d_5qyRlZiBjgJUf7aldQyARPBHCTbiO0_w-gM1MQ==>REDACTED
2QiVitL90wrUqtgbQQxRTfjaXSF_vxQZlNkeVstOkIU==>REDACTED
EOF
)
```
Then:
```bash
git push --force --all origin
git push --force --tags origin
```
**This force-pushes and rewrites history on every branch** — coordinate with anyone else who has the repo cloned; they'll need to re-clone or hard-reset their local copies, and any open PRs will likely need to be recreated. Don't do this without the team's buy-in.

If the repo is on GitHub, also check **Settings → Security → Secret scanning** — GitHub will have already flagged the exposed key/secret as a push-protection or secret-scanning alert if that's enabled; resolving those alerts after rotation closes the loop.

### Step 3 — Prevent recurrence
- Add a pre-commit secret scanner (e.g. [gitleaks](https://github.com/gitleaks/gitleaks) or GitHub's push protection) so a real credential can't be committed to `.env.example` (or anywhere) again.
- Enable GitHub secret scanning + push protection on the repo if not already on (Settings → Code security).
- Treat `.env.example` as documentation only — never copy a working `.env` into it "temporarily."

## 3. Summary of what's still manual
- [ ] Rotate `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET` (and `DIDIT_WORKFLOW_ID` if rotatable) in the Didit dashboard.
- [ ] Update those values in the actual deployment environment (not `.env.example`).
- [ ] Double check git history for any other real secrets ever committed, rotate those too.
- [ ] Decide whether to force-rewrite git history to purge the old values (optional, coordinate with team first).
- [ ] Turn on GitHub secret scanning / push protection and/or a pre-commit scanner like gitleaks.
